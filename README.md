# Light Clip Video

一个本地「视频 + 字幕」同步剪辑工具：在时间轴上选点、按字幕行选点，**字幕时间轴随剪辑自动重映射**。视频与字幕共用同一份 `[in, out]` 边界，预览与导出走同一套逻辑——不需要事后回读视频，也不需要给字幕单独算偏差。

本仓库是原 Python 版本（标准库 + 浏览器前端）的 **Tauri 2 桌面移植版**：核心领域逻辑用 Rust 1:1 重写，`ffmpeg` / `ffprobe` 作为 sidecar 打包进应用。前端是 **React + Vite + Tailwind + shadcn/ui**（`web/`，构建产物在 `web/dist/`，由内嵌服务提供）。

- 运行形态：一个原生窗口（Tauri 2），内部启动一个本地 HTTP 服务，WebView 加载它。
- 产物：`light-clip-video.exe`（单文件，可自带 ffmpeg）。
- 无需联网、无需数据库，所有工程数据保存在本机。

## 功能一览

- **两种选点方式**：时间轴拖拽选点、按字幕行选点；拖拽自动吸附字幕边界
- **片段边界可编辑**：拖动左/右手柄只改一端、拖动中间整体平移，卡片里也能精确输入时间
- **字幕时间校准工作台**：单句循环、迷你时间条拖拽、逐句 ± 微调、整轨偏移；源 `.srt` **只读**，改动立即生效
- **自动字幕重映射**：剪辑后字幕按同一 `[in,out]` 平移，预览与导出完全一致
- **两种导出模式**
  - 精确模式：帧级准确，回填原片位深 / profile / level / 色彩标签 / GOP / B 帧 / 音频参数
  - 无损模式：`-c copy` 流拷贝，画质逐字节一致，起点吸附关键帧
- **三档转码方案**：沿用原片 / 720p 省体积 / 自定义（含实时警告与体积预估）
- **自动匹配字幕**：同目录同名 `.srt` / `.vtt`，以及 `片名.语言.srt` 多语言文件
- **工程自动保存 + 断电恢复**（磁盘快照 `~/.clip-video/autosave/`）
- **导出永不覆盖**：默认输出到 `<源片目录>/<片名>_剪辑/`，重名自动编号 `_2` / `_3`

## 快速开始（Windows）

### 前置

| 依赖 | 说明 |
| --- | --- |
| Rust + GNU 工具链 | `rustup` 安装 `stable-x86_64-pc-windows-gnu` |
| MinGW-w64 | 提供 `gcc` / `ld` / `windres` / `dlltool`，放在 `C:\mingw64` 并加入 `PATH` |
| WebView2 Runtime | Windows 10/11 一般已内置 |
| ffmpeg / ffprobe | 可打包进 exe，也可直接用系统 `PATH` 里的 |

> 为什么用 GNU 而不是 MSVC：本项目在没有管理员权限、装不了 MSVC Build Tools 的环境下开发，因此改用 GNU + MinGW。**如果你有 Visual Studio C++ Build Tools，用默认 MSVC 工具链也能构建**（忽略下面的 linker 配置即可）。

GNU 工具链配置（`~/.cargo/config.toml`）：

```toml
[target.x86_64-pc-windows-gnu]
linker = "C:\\mingw64\\bin\\x86_64-w64-mingw32-gcc.exe"
```

### 构建 / 运行

```cmd
:: 0) 前端：先安装依赖并构建（产物在 web/dist/，服务与 Tauri 都读它）
cd web && npm install && npm run build && cd ..

:: 1) 复制系统 ffmpeg/ffprobe 到 src-tauri\bin（打包用；不做也能运行，会回退到 PATH）
powershell -ExecutionPolicy Bypass -File scripts\fetch_ffmpeg.ps1

:: 2) 开发运行（打开桌面窗口）
cargo run -p light-clip-video

:: 3) 只起 HTTP 服务，用浏览器调试
cargo run -p clip-server --example serve -- 8765
::  然后打开 http://127.0.0.1:8765/

:: 4) 发布
cargo build --release -p light-clip-video
::  产物: target\release\light-clip-video.exe
```

### 测试

```cmd
cargo test -p clip-core
```

## 目录结构

```
light-clip-video/
├─ core/            # 纯领域逻辑（无网络、无进程、无 IO），带单元测试
│  └─ src/
│     ├─ model.rs    # Project / Clip / Boundary / Segment 等数据结构
│     ├─ srt.rs      # SRT / WebVTT 解析与序列化
│     ├─ cues.rs     # 字幕时间矫正（移动 / 设精确时间 / 整轨偏移 / 审计日志）
│     ├─ remap.rs    # 时间轴重映射：唯一的 [in,out] 与字幕坐标来源
│     ├─ paths.rs    # 导出命名与"永不覆盖"编号
│     ├─ presets.rs  # 三档方案（沿用原片 / 720p / 自定义）
│     ├─ probe.rs    # ffprobe JSON 解析（纯函数）
│     ├─ checks.rs   # 转码参数检查与体积预估（UI 与导出共用）
│     └─ plan.rs     # 构造精确/无损模式下的 ffmpeg 命令
├─ clip-server/     # 内嵌 HTTP 服务，复刻原 server.py 的 /api/*
│  └─ src/
│     ├─ lib.rs      # 路由、状态、自动保存、导出编排
│     └─ ffmpeg.rs   # 唯一调用 ffmpeg/ffprobe 的地方（带 CREATE_NO_WINDOW）
├─ src-tauri/       # Tauri 2 桌面外壳（启动服务 + 打开窗口）
│  ├─ src/main.rs
│  ├─ tauri.conf.json
│  └─ bin/           # ffmpeg/ffprobe sidecar（gitignore，构建前用脚本复制）
├─ web/             # 前端：React 19 + Vite + Tailwind + shadcn/ui（src/ 按模块拆分）
│  └─ dist/          # 构建产物（npm run build 生成，服务与 Tauri 都读它，不进仓库）
├─ scripts/         # 图标生成、ffmpeg 复制
└─ docs/            # 使用 / 架构 / API / 开发文档（见下）
```

## 文档

| 文档 | 面向 | 内容 |
| --- | --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | 使用者 | 从打开媒体到导出的完整操作流程、快捷键、常见问题 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 开发者 | 模块职责、数据流、**必须遵守的核心不变量** |
| [docs/API.md](docs/API.md) | 开发者 | 全部 `/api/*` 接口的请求/响应 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发者 | 工具链、构建、加功能流程、踩坑清单 |

## 设计要点（为什么这样做）

- **单一坐标系**：每个片段只有一份 `[in_ms, out_ms]`，视频切点和字幕平移都读它；字幕公式永远是 `t - in + offset`。**禁止**导出后回读视频再补偿字幕（历史上这造成过 9.4s 漂移）。
- **边界是表达式**：`Boundary = Time(ms) | CueRef(track,index,edge,padding)`，延迟到使用时才解析，所以字幕改时间后切点自动联动。
- **无损模式只吸附一次关键帧**：起点吸附到最近的关键帧（向下取整到毫秒），吸附后的 `in_ms` 就是唯一真源；命令必须是 `-ss <in> -i <src> -t <dur> -c copy`，禁止 `-avoid_negative_ts` / `-fflags +genpts`。
- **为什么内嵌 HTTP 而不是 `invoke`**：前端约 20 个接口，缩略图 / 波形 / 视频播放都依赖 HTTP 流式与 Range 请求。保持 HTTP 契约可以让前端改版风险最低。
- **ffmpeg 一律 `CREATE_NO_WINDOW`**：否则加载一个视频会弹几十个黑框。

## 许可证

MIT，见 [LICENSE](LICENSE)。
