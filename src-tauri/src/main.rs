#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn home() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Locate the bundled `web/dist/` directory (Vite build output). In
/// development it lives next to the crate; in the packaged app it is copied
/// into the resource dir.
fn find_web_dir(resource_dir: &Path) -> PathBuf {
    let candidates = [
        resource_dir.join("web/dist"),
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/dist")),
        std::env::current_dir().unwrap_or_default().join("web/dist"),
        // Legacy fallback: a plain (unbuilt) web/ directory.
        resource_dir.join("web"),
        PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../web")),
        std::env::current_dir().unwrap_or_default().join("web"),
    ];
    for c in candidates.iter() {
        if c.join("index.html").is_file() {
            return c.clone();
        }
    }
    resource_dir.join("web/dist")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());

            let web_dir = find_web_dir(&resource_dir);
            let (ffmpeg_bin, ffprobe_bin) =
                clip_server::ffmpeg::resolve_bins(&resource_dir, None, None);

            // Bind the port here so the webview can be pointed at it with no
            // readiness race.
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();

            let cfg = clip_server::ServerConfig {
                host: "127.0.0.1".to_string(),
                port,
                web_dir,
                ffmpeg_bin,
                ffprobe_bin,
                autosave_dir: home().join(".clip-video").join("autosave"),
                out_dir: home().join(".clip-video").join("output"),
            };
            std::thread::spawn(move || {
                let _ = clip_server::run_with_listener(listener, cfg);
            });

            let url = format!("http://127.0.0.1:{}/", port);
            let parsed = tauri::Url::parse(&url)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("Light Clip Video")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running light-clip-video");
}
