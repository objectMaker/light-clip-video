//! Dev-only test server: serves the built frontend + API on 127.0.0.1:8765
//! so the API/browser verification scripts can run without the Tauri shell.
//! Not part of the shipped app. Usage: `cargo run -p clip-server --example dev_server`
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let (ffmpeg_bin, ffprobe_bin) = clip_server::ffmpeg::resolve_bins(&root, None, None);
    let home = std::env::temp_dir().join("lcv-test").join("server-home");
    let cfg = clip_server::ServerConfig {
        host: "127.0.0.1".to_string(),
        port: 8765,
        web_dir: root.join("web").join("dist"),
        ffmpeg_bin,
        ffprobe_bin,
        autosave_dir: home.join("autosave"),
        out_dir: home.join("output"),
    };
    eprintln!("dev server on http://127.0.0.1:8765/ ffmpeg={:?}", cfg.ffmpeg_bin);
    clip_server::run(cfg).unwrap();
}
