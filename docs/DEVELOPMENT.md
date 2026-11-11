# 开发指南

## 环境准备

### 方案 A：MSVC（当前默认，Windows 构建用它）

```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc
rustup default stable-x86_64-pc-windows-msvc
```

- 安装 MSVC Build Tools 2022（含 C++ 工作负载与 Windows 10 SDK），或完整 Visual Studio。
- 确保 `~/.cargo/config.toml` 里**没有** `[target.x86_64-pc-windows-gnu]` 的 linker 配置（有就删掉），否则会按 GNU 链接。
- 构建产物在 `target\release\light-clip-video.exe`；ffmpeg/ffprobe 打包进 `src-tauri\bin\`（见「打包发布」）。

### 方案 B：GNU + MinGW（无管理员权限时的备选）

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup default stable-x86_64-pc-windows-gnu
```

- 安装 MinGW-w64（例如 8.1.0 posix-seh），解压到 `C:\mingw64`，把 `C:\mingw64\bin` 加入 `PATH`。需要 `gcc`、`ld`、`windres`、`dlltool`、`as`。
- `~/.cargo/config.toml`：
  ```toml
  [target.x86_64-pc-windows-gnu]
  linker = "C:\\mingw64\\bin\\x86_64-w64-mingw32-gcc.exe"
  ```
- Tauri 2 在 `x86_64-pc-windows-gnu` 上可以正常构建（`tao` / `webview2-com` 都通过）。两种工具链构建结果一致；日常开发用方案 A 即可。

### 其它依赖

- **WebView2 Runtime**（Win10/11 通常自带）。
- **ffmpeg / ffprobe**：开发时可以直接用 `PATH` 里的；打包前用 `scripts/fetch_ffmpeg.ps1` 复制到 `src-tauri/bin/`。

## 常用命令

```cmd
cargo run -p light-clip-video                 :: 打开桌面窗口（开发）
cargo test -p clip-core                       :: 领域逻辑单测（43 项）
cargo run -p clip-server --example serve -- 8765   :: 只起 HTTP 服务，浏览器调试（先 npm run build，前端在 web/dist/）
cd web && npm run build                       :: 前端构建（TypeScript + Vite）
cd web && npm run dev                         :: 前端开发服务（代理 /api 到 8765）
```

## 代码结构与"加功能"的正确姿势

改动几乎总是按 `core → clip-server → web` 的顺序：

1. **`core/`**：先写纯逻辑 + 单测。任何涉及时间轴、字幕、命名、参数检查的规则都应该落在这里，而不是塞进 HTTP 层或前端。
2. **`clip-server/`**：如果是新能力，加一个 `/api/*` 路由调用 core；涉及进程的放到 `ffmpeg.rs`。
3. **`web/`**：前端 `fetch` 新接口、渲染。

**不要做的事**：
- 不要在 `clip-server` 里重复实现 core 已有的规则（尺寸预估、警告、命名编号等）。
- 不要为了某个导出问题去「回读视频再补偿字幕」——这违反单一坐标系，见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 不要让前端自己算字幕时间或导出路径；后端返回什么就用什么。

## 测试

- `cargo test -p clip-core`：覆盖 SRT 解析、字幕矫正、重映射、命名编号、参数检查、命令构造。
- 前端验证：`cd web && npm run build`（TypeScript + Vite 必须通过），再起 `serve` example，用浏览器验证。
- 手工联调：起 `serve` example，用 `curl --noproxy '*'` 或浏览器验证。

## 打包发布

```cmd
powershell -ExecutionPolicy Bypass -File scripts\fetch_ffmpeg.ps1   :: 复制 ffmpeg/ffprobe 到 src-tauri\bin
cargo build --release -p light-clip-video
:: 产物: target\release\light-clip-video.exe
```

- `src-tauri/bin/*.exe` 已被 `.gitignore` 忽略（ffmpeg 全量包约 230MB×2，不能进仓库）。
- 如果目标机器没有 ffmpeg，运行时会回退到 `PATH`；要完全自带就把二进制放进 `src-tauri/bin/`。
- 想生成安装包可以装 `cargo-tauri` 后执行 `cargo tauri build`；仅要绿色 exe 用上面的 `cargo build --release` 即可。
- `tauri.conf.json` 的 `bundle.resources` 会在构建时校验 `bin/ffmpeg.exe` / `bin/ffprobe.exe` 是否存在——没有就先跑一次 fetch 脚本。

## 踩坑清单（都是实际踩过的）

1. **控制台黑框乱闪**：每个 `ffmpeg`/`ffprobe` 子进程都必须走 `ffmpeg.rs::quiet()`（Windows `creation_flags(0x08000000)` = `CREATE_NO_WINDOW`）。加载一个视频会触发约 11 次子进程，漏一个就是一片黑框。
2. **`protocol.duration` 是十进制字符串**：ffprobe 返回 `"3.000000"`，必须用浮点解析（`as_f64`），否则 `duration_ms` 会变成 0。
3. **`std::fs::canonicalize` 会加 `\\?\` 前缀**：所有给前端展示 / 拼路径的地方都要用 `clean_abs()` 去掉，否则路径和界面对不上。
4. **导出空文件名丢扩展名**：`resolve_export_target` 里必须是 `ext = typed_ext or default_ext`，别只取用户输入。
5. **无损模式命令**：`-ss` 必须在 `-i` 前面、`-c copy`、不要 `-avoid_negative_ts` / `-fflags +genpts`；关键帧时间向下取整到毫秒。详见 ARCHITECTURE。
6. **端口**：`main.rs` 先 `TcpListener::bind("127.0.0.1:0")` 拿到随机端口再交给服务，避免端口冲突和就绪竞态。
7. **旧进程残留**：Tauri 进程可能残留并占着旧端口，导致你以为"新代码没生效"。验证前先确认 `Get-Process light-clip-video` 数量为 0 再启动。
8. **本机代理**：`HTTP(S)_PROXY` 会拦截本地请求，`curl` 测 `127.0.0.1` 要加 `--noproxy '*'`。另外代理可能只放行 `api.github.com` 而 502 掉 `github.com`，此时 `git push` 会失败——可以改用 `gh api` 手动上传 blob/tree/commit 再 PATCH ref（见下）。
9. **Tauri 的 `resource_dir`**：开发/未安装时可能指向 `target/<profile>`；`find_web_dir()` 会依次尝试 `resource_dir/web`、`CARGO_MANIFEST_DIR/../web`、`current_dir/web`，保证开发与打包都能找到前端。

### 代理挡住 `git push` 时的临时办法

如果 `git push` 报 `CONNECT tunnel failed, response 502` 但 `gh api` 能用：

1. 用 `gh api repos/<owner>/<repo>/git/blobs` 上传每个改动文件（base64）；
2. 用父提交的 tree 作为 `base_tree` 调 `git/trees`（只改动的文件）；
3. 调 `git/commits`（复刻 author/committer/date/message 可得到与本地一致的 SHA）；
4. `PATCH git/refs/heads/main` 更新分支。

## 调试技巧

- 前端有 `CLIP_VERBOSE` 环境变量时才打印请求日志；需要时在 `clip-server` 里临时加 `println!`。
- 单独测后端最快：`cargo run -p clip-server --example serve -- 8765`。
- 需要构造测试素材：用 `ffmpeg` 生成几秒测试片 + 手写 `.srt`（见 `tests/fixtures/`，该目录被 gitignore）。
