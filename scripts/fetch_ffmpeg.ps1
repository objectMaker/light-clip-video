# Copy ffmpeg / ffprobe from the system PATH into src-tauri/bin so that
# `cargo build --release` (or `cargo tauri build`) bundles them into the app.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\fetch_ffmpeg.ps1
$ErrorActionPreference = "Stop"

$bin = Join-Path (Split-Path -Parent $PSScriptRoot) "src-tauri\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

foreach ($name in @("ffmpeg", "ffprobe")) {
    $cmd = Get-Command "$name.exe" -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command $name -ErrorAction SilentlyContinue }
    if (-not $cmd) {
        Write-Host "找不到 $name，请先安装 ffmpeg 并把它加入 PATH（例如: winget install Gyan.FFmpeg）。" -ForegroundColor Red
        exit 1
    }
    $dest = Join-Path $bin "$name.exe"
    Copy-Item $cmd.Source $dest -Force
    Write-Host "已复制 $($cmd.Source)  ->  $dest" -ForegroundColor Green
}

Write-Host ""
Write-Host "完成。现在运行 cargo build --release 或 cargo tauri build，ffmpeg/ffprobe 会被打包进 exe。" -ForegroundColor Cyan
Write-Host "如果不打包，运行时也会自动回退到系统 PATH 里的 ffmpeg。" -ForegroundColor Cyan
