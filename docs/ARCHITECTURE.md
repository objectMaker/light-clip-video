# 架构与核心不变量

面向开发者。改代码前请先读完「核心不变量」——这些是历史踩坑总结，违反会直接造成音画不同步。

## 分层

```
┌────────────────────────────────────────────────────────────┐
│  web/  (React + Vite + shadcn/ui，构建产物 web/dist/)        │
│  通过 fetch('/api/...') 访问本地服务                         │
└───────────────▲────────────────────────────────────────────┘
                │ HTTP (127.0.0.1:<随机端口>)
┌───────────────┴────────────────────────────────────────────┐
│  src-tauri/  桌面外壳                                        │
│  - 绑定随机端口，起 clip-server                              │
│  - WebView 指向 http://127.0.0.1:<port>                     │
│  - 定位 ffmpeg/ffprobe sidecar                               │
└───────────────▲────────────────────────────────────────────┘
                │ 进程内调用
┌───────────────┴────────────────────────────────────────────┐
│  clip-server/  内嵌 HTTP 服务                                │
│  - 路由 / 状态 / 自动保存 / 导出编排                          │
│  - ffmpeg.rs：唯一调用 ffmpeg/ffprobe 的地方                  │
└───────────────▲────────────────────────────────────────────┘
                │ 纯函数调用
┌───────────────┴────────────────────────────────────────────┐
│  core/  纯领域逻辑（无网络 / 无进程 / 无 IO）                 │
│  model · srt · cues · remap · paths · presets · probe ·     │
│  checks · plan                                              │
└────────────────────────────────────────────────────────────┘
```

设计原则：`core` 不依赖任何框架、网络或进程，方便单测，也方便将来 1:1 翻译成别的语言（如 Tauri 的手机端或别的壳）。所有进程调用集中在 `clip-server/src/ffmpeg.rs`。

## 数据模型（`core/src/model.rs`）

```rust
Project { name, sources, tracks, clips, output, cue_edits }
Source  { id, path, duration_ms, fps, bitrate_bps, keyframes_ms }
SubTrack{ id, source_id, group_id, label, lang, path, cues, enabled }
Cue     { start_ms, end_ms, lines, index }
Clip    { id, source_id, start: Boundary, end: Boundary, track_ids, label }
```

**`Boundary` 是表达式，不是定值：**

```rust
Boundary { kind: Time | Cue, ms, cue_ref: Option<CueRef>, padding_ms }
CueRef   { track_id, cue_index, edge: Start | End }
```

- `Time` 是冻结的毫秒值；
- `Cue` 指向「某条字幕的起点或终点 + 留白」，**在使用时才解析**。所以字幕时间被校准后，引用它的片段切点会自动跟着动，不需要手动重设。

## 单一坐标系（最重要的不变量）

`core/src/remap.rs::build_segments()` 是**唯一**把 `Clip` 变成实际切点的地方：

```text
in  = resolve(start boundary)     # 无损模式下先吸附到关键帧
out = resolve(end boundary)
duration = out - in
offset  += duration               # 下一段在成片里的起点
```

字幕映射（`remap_cues`）用的是**同一份** `Segment`：

```text
cue' = offset + (clamp(cue, in, out) - in)
```

因此：

- **视频切点和字幕平移永远读同一个 `[in_ms, out_ms]`**，预览（`preview_state`）和导出（`export_project`）都走这条路径。
- 字幕公式永远是简单的 `t - in + offset`。**禁止**「导出后 ffprobe 回读视频、算偏差、再补偿字幕」——历史上这么干造成过 9.4 秒漂移。
- 想加新的导出行为，必须继续复用 `build_segments()`，不要另起一套坐标。

## 无损模式的硬性规则（`core/src/plan.rs` + `clip-server/src/ffmpeg.rs`）

1. **只吸附一次关键帧**：把起点吸附到「不超过它的最近关键帧」。吸附后的 `in_ms` 就是视频和字幕的唯一真源。
2. 关键帧时间必须**向下取整到毫秒**（`snap_down` / `parse_keyframes_csv`）：帧 pts 不是整毫秒，向上取整会让 `-ss` 比真实关键帧晚不到 1ms，ffmpeg 就会跳过该 I 帧、从 B 帧开头。
3. 命令必须是 **输入 seek + 裸拷贝**：
   ```
   ffmpeg -ss <in> -i <src> -t <dur> -map 0:v:0 -map 0:a? -c copy <out>
   ```
   禁止 `-avoid_negative_ts make_zero`（会把上一个 GOP 拖进来）、禁止 `-fflags +genpts`、禁止把 `-ss` 放到 `-i` 之后（输出 seek 配 stream copy 会跳过吸附的关键帧，导致视频比音频晚几秒、有声音但画面静止）。
4. 只 copy 视频和音频流，**排除源内嵌字幕流**（其旧时间轴会和重映射后的 SRT 冲突）。
5. 多段合并时无损模式会有累积漂移（每段尾部约多 0.2s），**建议多段用精确模式**；不要靠回读补偿去"修"。

## 精确模式要点

- `-ss` 放在 `-i` 之后，重新编码（libx264/aac）→ 帧级准确。
- **回填原片编码参数**：位深、profile、level、fps、B 帧数、GOP、色彩标签、音频采样率/声道，避免「10-bit 源被静默压成 8-bit」。
- 这是**二次压缩**，画质极接近但**不是逐字节一致**；只有 `-c copy`（无损模式）才 bit-exact。
- 位深与 H.264 profile 必须匹配，`compatible_profile()` 负责纠正；H.265 忽略 H.264 的 profile/level。

## 转码参数：单一真源

- `EncodeCfg`（扁平参数）+ `OutputCfg.profile_mode`（source / builtin_720p / custom）。
- `core/src/presets.rs::resolve_profile()` 是 **UI 预览、参数检查、ffmpeg 命令** 三者共用的唯一入口。后端不依赖前端传参。
- `core/src/checks.rs::evaluate_encode()` 是**警告与体积预估的唯一真源**，设置页实时检查和导出前确认弹窗都调它，禁止前端另写一套规则。
- 真正决定体积/画质的只有三个：**分辨率、CRF、峰值码率上限（maxrate/bufsize）**；其余是兼容性与封装。

## 码率决策：单一真源（`core/src/rate.rs`）

- `plan_rate()` 是**设置页体积预估与 ffmpeg 命令共用的唯一决策入口**。`checks.rs::evaluate_encode()` 和 `plan.rs::build_export_plan()` 都调它，不允许任何一处另算码率。
- `probe.rs::source_bitrates()` 是**唯一读取源片码率的函数**。`EncodeParams` 保留 `video_bps` / `audio_bps` 精确值，`ffprobe` 的 `bit_rate` 绝大多数是**字符串**（`"677123"`），必须走兼容字符串/数字的 `as_i64()`；缺失时依次回落到 `video_kbps × 1000`、`format.bitrate`（或 `size / duration`）。
- **历史坑**：曾经设置页用兼容字符串的解析器、导出却另用 `Value::as_i64()`，后者永远拿到 0，于是 `plan.rs` 静默回落到 CRF 18，低码率片源输出膨胀到源片 4.28 倍。现在导出路径**没有 CRF 18 兜底**：读不到码率时改保守 CRF 23 + 按分辨率推导的峰值上限，并给 warn。
- 锁定方案（`source` / `builtin_720p`）的峰值上限取 `min(配方值, 源片视频码率)`，`bufsize` 随上限按配方比例缩放（720p 配方 1800/1000 → 1.8 倍），保证「越剪越大」不再发生；`custom` 尊重用户显式参数，只在超源片码率时警告。
- `codec_class()` 把源片分为 Legacy / H264Like / Efficient（HEVC、VP9、AV1）/ Mezzanine。Efficient 源按源码率重编码成 H.264 必然掉画质，会明确提示「不剪辑就用无损模式；要更接近原片画质只能提高码率、接受体积变大」。**交付编码固定 H.264**：用户明确不接受 H.265（网页/旧设备兼容性不足），所以不把 H.265 作为推荐方案；自定义面板仍保留该选项，但选中时给 warn 级提示。Mezzanine（ProRes 等或 >50 Mbps）目标码率上限 25 Mbps，避免沿用中间格式码率白占空间。
- 音频不再只认 AAC：Opus / Vorbis / MP3 的采样率、声道、码率同样会被读取与回填。

## 导出命名与防覆盖（`core/src/paths.rs`）

- 第一个源片决定名字：`<源片目录>/<片名>_剪辑/<片名>_剪辑.mp4`，字幕同源同目录。
- `resolve_export_target()` 同时供「预览默认路径」和「真实导出」使用；**整批编号**（视频 + 所有字幕 + 封装版一起检查），默认永不覆盖。
- 即使 `overwrite=true`，也**绝不覆盖源视频**。

## 持久化

- 服务端 `Project` 常驻内存（`clip-server::State`）。
- 每次变更写磁盘快照：`~/.clip-video/autosave/<hash>.json`，原子写（tmp → rename）。
- 恢复时校验源视频仍存在；字幕已内嵌在工程里，`.srt` 移动不影响。
- 前端另有 `localStorage` 副本与「最近工程」，重启后优先本地副本，失败再回退磁盘快照。

## 前端样式系统（`web/`）

- `web/src/index.css` 是**唯一的 CSS 文件**，只放 Tailwind v4 入口、亮/暗两套 CSS 变量、`@theme` 设计令牌（含字号刻度）和少量无法用工具类表达的基础规则（滚动条、选区、全高容器）。组件样式一律写在 TSX 的 Tailwind 工具类里，没有旧的 `style.css` / `app.js` 单文件。
- **字号单一真源**：`@theme` 里覆盖 `--text-xs` / `--text-sm` / `--text-base` 等令牌。想整体调大或调小字号只改这里，不要再写 `text-[11px]` 之类的任意值。
- **主题单一真源**：`hooks/useTheme.ts` 用 `useSyncExternalStore` 维护 `light / dark / system`，把 `.dark` 类挂到 `<html>`，写 `localStorage['clip-video.theme.v1']`，并监听系统外观变化；`web/index.html` 的内联脚本在 React 挂载前先刷一次，避免启动时白屏闪烁。新增颜色一律用 `--color-*` 令牌或 `dark:` 变体，不要写死浅色值。
- 基础控件（`components/ui/*`）集中定义尺寸与焦点态，业务面板只组合它们；`cn()`（clsx + tailwind-merge）负责合并调用方传入的 className。

## ffmpeg 调用

- 全部集中在 `clip-server/src/ffmpeg.rs`，且必须走 `quiet()`（Windows `CREATE_NO_WINDOW`），否则会弹控制台黑框。
- 二进制解析顺序：`FFMPEG_BIN`/`FFPROBE_BIN` 环境变量 → `resource_dir/bin/`（打包的 sidecar）→ `PATH` 里的 `ffmpeg`/`ffprobe`。

## 关键函数索引

| 位置 | 作用 |
| --- | --- |
| `core::remap::build_segments` | 唯一的片段切点 / offset 计算 |
| `core::remap::remap_cues` | 字幕映射到成片时间轴 |
| `core::remap::preview_state` | 预览与导出共用的一次性结果 |
| `core::plan::build_export_plan` | 构造精确/无损的 ffmpeg 命令 |
| `core::cues::shift_cues / set_cue_times` | 字幕时间矫正（纯函数） |
| `core::probe::source_bitrates` | 唯一的源片精确码率读取入口 |
| `core::rate::plan_rate` | 码率控制决策（预估与命令共用） |
| `core::checks::evaluate_encode` | 参数警告 + 体积预估 |
| `core::paths::resolve_export_target` | 导出路径 + 防覆盖编号 |
| `clip-server::open_media` | 打开视频/字幕、探测参数、自动匹配 |
| `clip-server::start_export` | 后台导出与进度 |
| `clip-server::ffmpeg::execute_export` | 实际执行各段 + 合并 + 写字幕 + 封装 |
