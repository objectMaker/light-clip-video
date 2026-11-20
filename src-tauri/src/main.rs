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

#[cfg(windows)]
fn ensure_webview2_proxy_bypass() {
    let current_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let bypass_arg = "--proxy-bypass-list=<-loopback>;<local>;*.localhost;tauri.localhost;127.0.0.1;localhost";
    if current_args.is_empty() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", bypass_arg);
    } else if !current_args.contains("--proxy-bypass-list") {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("{} {}", current_args, bypass_arg),
        );
    }
}

fn main() {
    #[cfg(windows)]
    ensure_webview2_proxy_bypass();

    clip_server::ffmpeg::init_process_job_object();
    let clip_home = home().join(".clip-video");
    clip_server::ffmpeg::cleanup_stale_workdirs(&clip_home);
    clip_server::ffmpeg::cleanup_stale_workdirs(&clip_home.join("output"));

    let args: Vec<String> = std::env::args().collect();
    let is_headless = args.iter().any(|a| a == "--headless");
    let requested_port: Option<u16> = args.iter().skip(1).find_map(|a| {
        if a.starts_with("--port=") {
            a.trim_start_matches("--port=").parse::<u16>().ok()
        } else {
            a.parse::<u16>().ok().filter(|&p| p > 0)
        }
    }).or_else(|| {
        std::env::var("CLIP_SERVER_PORT").ok().and_then(|p| p.parse().ok())
    });

    if is_headless {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        let web_dir = find_web_dir(&exe_dir);
        let (ffmpeg_bin, ffprobe_bin) =
            clip_server::ffmpeg::resolve_bins(&exe_dir, None, None);

        let target_port = requested_port.unwrap_or(8765);
        let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", target_port))
            .or_else(|_| std::net::TcpListener::bind("127.0.0.1:0"))
            .expect("Failed to bind TCP listener");
        let port = listener.local_addr().unwrap().port();

        let cfg = clip_server::ServerConfig {
            host: "127.0.0.1".to_string(),
            port,
            web_dir,
            ffmpeg_bin,
            ffprobe_bin,
            autosave_dir: home().join(".clip-video").join("autosave"),
            out_dir: home().join(".clip-video").join("output"),
        };
        clip_server::run_with_listener(listener, cfg).expect("error running headless server");
        return;
    }

    tauri::Builder::default()
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                clip_server::ffmpeg::abort_active_export();
            }
        })
        .setup(move |app| {
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());

            let web_dir = find_web_dir(&resource_dir);
            let (ffmpeg_bin, ffprobe_bin) =
                clip_server::ffmpeg::resolve_bins(&resource_dir, None, None);

            // Bind to requested port (default 8765) so pipeline can discover it directly,
            // falling back to ephemeral port if already in use.
            let target_port = requested_port.unwrap_or(8765);
            let listener = std::net::TcpListener::bind(format!("127.0.0.1:{}", target_port))
                .or_else(|_| std::net::TcpListener::bind("127.0.0.1:0"))?;
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
