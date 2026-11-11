# Light Clip Video

一个本地「视频 + 字幕」同步剪辑工具：可视化时间轴选点、按字幕行选点，字幕时间轴随剪辑**自动重映射**。视频与字幕共用同一份 `[in, out]` 边界，预览与导出走同一套逻辑，不需要事后回读视频、也不给字幕算偏差。

本仓库是原 Python 版本（标准库 + 浏览器前端）的 **Tauri 2 桌面移植版**：核心逻辑用 Rust 1:1 重写，前端保持原样，`ffmpeg` / `ffprobe` 作为 sidecar 一并打包。

## 功能

- **时间轴拖拽选点** 与 **字幕行选点** 两种方式，都收敛到同一片段模型；拖拽自动吸附字幕边界
- 已有片段的边界可直接在时间轴上拖动编辑（左右手柄各改一端、中间整体平移），卡片里也能精确输入时间
- **字幕时间校准工作台**：单句循环播放边听边改、迷你时间条拖拽两端、整轨偏移、逐句微调；**源 `.srt` 只读**，改动立即对时间轴 / 预览 / 切点 / 导出生效
- 剪辑后字幕自动重映射，`预览成片` 与导出完全同一坐标
- **两种导出模式**
  - 精确模式：帧级准确，回填原片位深 / profile / level / 色彩标签 / GOP / B 帧 / 音频参数
  - 无损模式：`-c copy` 流拷贝、起点吸附关键帧（画质逐字节一致）
- **三档转码方案**：沿用原片 / 720p 省体积 / 自定义，含实时警告与体积预估
- 工程自动保存 + 断电恢复（磁盘快照 `~/.clip-video/autosave/`）
- 默认导出到 `<源片目录>/<片名>_剪辑/`，**永不覆盖**（自动编号 `_2` / `_3`）

## 架构

| 目录 | 作用 |
| --- | --- |
| `core/` | 纯逻辑：模型、SRT 解析、字幕矫正、时间轴重映射、导出命名、编码检查、ffmpeg 命令构造。无网络、无进程、无 IO，带单元测试。 |
| `clip-server/` | 内嵌 HTTP 服务，完整复刻原 `server.py` 的 `/api/*` 契约；负责 ffmpeg/ffprobe 执行与导出编排。 |
| `src-tauri/` | Tauri 2 外壳：启动内嵌服务，打开 WebView 指向 `http://127.0.0.1:<port>`。 |
| `web/` | 原前端（HTML / JS / CSS），**零改动**直接复用。 |

之所以由 Rust 内嵌一个本地 HTTP 服务、再让 WebView 加载它，而不是把每个接口改成 `invoke`：前端有约 20 个接口，且时间轴缩略图、波形、视频播放都依赖 HTTP 流式与 Range 请求，保持 HTTP 契约可以让 128 KB 前端一行不改。

## 环境要求（Windows）

- Rust + **GNU 工具链**（`x86_64-pc-windows-gnu`）与 **MinGW-w64**（提供 `gcc` / `ld` / `windres` / `dlltool`）
- WebView2 Runtime（Windows 10/11 通常已内置）
- `ffmpeg` / `ffprobe`（可打包进 exe，也可直接用系统 PATH 里的）

> 说明：Windows 上 Tauri 官方推荐 MSVC 工具链。本仓库是在**无管理员权限**、装不了 MSVC Build Tools 的环境下，用 GNU + MinGW 完成的编译；若你有 Visual Studio C++ Build Tools，直接用默认 MSVC 工具链也能构建。

### 安装工具链（GNU + MinGW，非管理员可用）

```powershell
# 1) Rust GNU 工具链
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu

# 2) MinGW-w64：解压到 C:\mingw64，并把 C:\mingw64\bin 加入 PATH

# 3) 让 cargo 使用 MinGW 的链接器（~/.cargo/config.toml）
# [target.x86_64-pc-windows-gnu]
# linker = "C:\\mingw64\\bin\\x86_64-w64-mingw32-gcc.exe"
```

## 构建 / 运行

```cmd
:: 1) 把系统 ffmpeg / ffprobe 复制到 src-tauri\bin（打包用；不打包则运行时会回退到 PATH）
powershell -ExecutionPolicy Bypass -File scripts\fetch_ffmpeg.ps1

:: 2) 开发运行（Tauri 桌面窗口）
cargo run -p light-clip-video

:: 3) 只起 HTTP 服务，用浏览器调试
cargo run -p clip-server --example serve -- 8765
::  然后打开 http://127.0.0.1:8765/

:: 4) 发布
cargo build --release -p light-clip-video
::  产物: target\release\light-clip-video.exe
```

## 测试

```cmd
cargo test -p clip-core
```

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `,` / `.` | 当前字幕句整体前移 / 后移一个步长 |
| `↑` / `↓` | 上一句 / 下一句 |
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+S` | 保存工程 |
| `Ctrl+E` | 只导出字幕 |

## 与 Python 原版的差异

- 原版 `python server.py` 启动本地服务并打开浏览器；本版把同一套服务内嵌进 Tauri 进程，WebView 直接加载。
- 核心算法、HTTP 契约、前端完全一致；`core/` 是 1:1 Rust 重写，并有 30+ 单元测试覆盖。

## License

MIT
