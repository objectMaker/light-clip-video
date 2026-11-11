//! Standalone server for testing the HTTP API without the Tauri shell.
//!
//!   cargo run -p clip-server --example serve -- 8765
//!
//! Then open http://127.0.0.1:8765/ in a browser.

use std::path::PathBuf;

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(8765);
    let web_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web");
    let (ffmpeg_bin, ffprobe_bin) =
        clip_server::ffmpeg::resolve_bins(std::path::Path::new("."), None, None);
    let cfg = clip_server::ServerConfig {
        host: "127.0.0.1".into(),
        port,
        web_dir,
        ffmpeg_bin,
        ffprobe_bin,
        autosave_dir: home().join(".clip-video").join("autosave"),
        out_dir: home().join(".clip-video").join("output"),
    };
    println!("clip-video server on http://127.0.0.1:{port}/");
    clip_server::run(cfg).unwrap();
}
