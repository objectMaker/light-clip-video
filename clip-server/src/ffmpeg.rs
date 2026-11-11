//! ffmpeg / ffprobe process execution: the only place that shells out.
//!
//! Pure parsing lives in `clip_core::probe` / `clip_core::plan`; this module
//! runs the binaries, parses progress, and assembles the export result.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;

use clip_core::model::Project;
use clip_core::plan::ExportPlan;
use clip_core::presets::resolve_profile;
use clip_core::remap::preview_state;
use serde_json::Value;

pub type Progress = dyn Fn(i64, &str);

/// Spawn a child process WITHOUT flashing a console window on Windows.
///
/// The Python original set `creationflags=CREATE_NO_WINDOW`. Without it, every
/// ffprobe/ffmpeg call (initial probe, 8 thumbnails, 1 waveform, export steps)
/// pops a black cmd window — which is exactly the "dozens of windows" flashing
/// seen when loading a video.
fn quiet(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Run ffprobe and parse its JSON output.
fn probe_json(ffprobe: &Path, args: &[&str]) -> Result<Value, String> {
    let out = quiet(ffprobe)
        .args(args)
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("无法运行 ffprobe: {e}"))?;
    if !out.status.success() {
        return Err("ffprobe 执行失败".to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe 输出解析失败: {e}"))
}

pub fn probe_source(ffprobe: &Path, path: &str, source_id: &str) -> Result<clip_core::model::Source, String> {
    let json = probe_json(
        ffprobe,
        &["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
    )?;
    Ok(clip_core::probe::parse_source(&json, Some(source_id), path))
}

pub fn probe_encode_params(
    ffprobe: &Path,
    path: &str,
) -> Result<clip_core::probe::EncodeParams, String> {
    let json = probe_json(
        ffprobe,
        &["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    )?;
    Ok(clip_core::probe::parse_encode_params(&json))
}

pub fn list_keyframes(ffprobe: &Path, path: &str) -> Vec<i64> {
    let out = quiet(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=pts_time,best_effort_timestamp_time",
            "-of",
            "csv=p=0",
            path,
        ])
        .stderr(Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            clip_core::probe::parse_keyframes_csv(&String::from_utf8_lossy(&o.stdout))
        }
        _ => Vec::new(),
    }
}

/// `(video_bps, audio_bps)` in bytes-per-second, with container fallback.
pub fn probe_bitrates(ffprobe: &Path, path: &str) -> (i64, i64) {
    let json = match probe_json(
        ffprobe,
        &["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    ) {
        Ok(j) => j,
        Err(_) => return (0, 0),
    };
    let streams = json
        .get("streams")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let v = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("video"));
    let a = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));
    let vb = v.and_then(|s| s.get("bit_rate")).and_then(|b| b.as_i64()).unwrap_or(0);
    let ab = a.and_then(|s| s.get("bit_rate")).and_then(|b| b.as_i64()).unwrap_or(0);
    let total = json
        .get("format")
        .and_then(|f| f.get("bit_rate"))
        .and_then(|b| b.as_i64())
        .unwrap_or(0);
    let mut video_bps = vb;
    let mut audio_bps = ab;
    if video_bps == 0 && total > 0 {
        video_bps = (total - audio_bps).max(1);
    }
    if audio_bps == 0 && total > 0 && video_bps > 0 {
        audio_bps = (total - video_bps).max(1);
    }
    (video_bps, audio_bps)
}

/// Run one ffmpeg command, streaming `-progress pipe:1` into `on_progress`.
fn run_ffmpeg_progress(
    ffmpeg: &Path,
    args: &[String],
    total_ms: i64,
    seg_start: f64,
    seg_span: f64,
    on_progress: &Progress,
) -> Result<(), String> {
    let mut cmd = quiet(ffmpeg);
    for a in &args[1..] {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法运行 ffmpeg: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel::<String>();
    let stderr_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let mut r = stderr;
        let _ = r.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if let Some(rest) = line.strip_prefix("out_time_ms=") {
            if let Ok(ms) = rest.trim().parse::<i64>() {
                let frac = (ms as f64 / total_ms.max(1) as f64).clamp(0.0, 1.0);
                let pct = (seg_start + seg_span * frac).round() as i64;
                on_progress(pct, "正在导出视频片段");
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr_out = rx.recv().unwrap_or_default();
    let _ = stderr_thread.join();
    if !status.success() {
        let tail = &stderr_out[stderr_out.len().saturating_sub(1500)..];
        return Err(format!(
            "ffmpeg 失败（退出码 {}）:\n{}",
            status.code().unwrap_or(-1),
            tail
        ));
    }
    Ok(())
}

fn safe_group(group: &str) -> String {
    let cleaned: String = group
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "sub".to_string()
    } else {
        cleaned
    }
}

/// Run `plan.build_export_plan` then execute every ffmpeg step. Assembles the
/// same result dict the Python `export_project` returns.
pub fn execute_export(
    project: &Project,
    output_path: &str,
    ffmpeg: &Path,
    ffprobe: &Path,
    on_progress: &Progress,
) -> Result<Value, String> {
    if project.clips.is_empty() {
        return Err("没有可导出的片段".to_string());
    }
    for s in &project.sources {
        if !Path::new(&s.path).is_file() {
            return Err(format!("源视频不存在: {}", s.path));
        }
    }

    let mut info_by_source: HashMap<String, clip_core::probe::EncodeParams> = HashMap::new();
    let mut bitrate_by_source: HashMap<String, (i64, i64)> = HashMap::new();
    for s in &project.sources {
        let info = probe_encode_params(ffprobe, &s.path)?;
        let (vb, ab) = probe_bitrates(ffprobe, &s.path);
        info_by_source.insert(s.id.clone(), info);
        bitrate_by_source.insert(s.id.clone(), (vb, ab));
    }

    let workdir = std::env::temp_dir().join(format!("clipvideo_{}", std::process::id()));
    std::fs::create_dir_all(&workdir).map_err(|e| e.to_string())?;
    let workdir_str = workdir.to_string_lossy().to_string();
    let ffmpeg_str = ffmpeg.to_string_lossy().to_string();

    let plan: ExportPlan = clip_core::plan::build_export_plan(
        project,
        output_path,
        &workdir_str,
        &ffmpeg_str,
        &info_by_source,
        &bitrate_by_source,
    )?;

    let segments = clip_core::remap::build_segments(project).map_err(|e| e.to_string())?;
    let n = plan.segment_commands.len().max(1) as f64;

    let mut warnings = plan.warnings.clone();

    for (i, cmd) in plan.segment_commands.iter().enumerate() {
        let dur = if i < segments.len() {
            segments[i].duration_ms
        } else {
            1
        };
        let start = (i as f64 / n * 85.0).round() as i64;
        let span = (85.0 / n).round() as i64;
        on_progress(
            start,
            &format!("正在导出片段 {}/{}", i + 1, plan.segment_commands.len()),
        );
        run_ffmpeg_progress(ffmpeg, cmd, dur, start as f64, span as f64, on_progress)?;
    }

    // Concatenation (single segment still needs a copy pass for the final path).
    if plan.segment_commands.len() > 1 {
        let list_path = workdir.join("_concat_list.txt");
        let mut content = String::new();
        for cmd in &plan.segment_commands {
            if let Some(dest) = cmd.last() {
                content.push_str(&format!("file '{}'\n", dest.replace('\\', "/")));
            }
        }
        std::fs::write(&list_path, content).map_err(|e| e.to_string())?;
    }
    on_progress(86, "正在合并片段");
    run_ffmpeg_progress(ffmpeg, &plan.concat_command, 1, 86.0, 14.0, on_progress)?;

    // Write the remapped subtitle files.
    let base = Path::new(&plan.output_video)
        .with_extension("")
        .to_string_lossy()
        .to_string();
    let sub_fmt = plan.subtitle_format.clone();
    let mut subtitle_paths: HashMap<String, String> = HashMap::new();
    for (group, text) in &plan.subtitles {
        let path = format!("{}.{}.{}", base, safe_group(group), sub_fmt);
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        subtitle_paths.insert(group.clone(), path);
    }

    // Optional subtitle embedding (always from the remapped SRT).
    let profile = resolve_profile(
        &project.output.profile_mode,
        &project.output.encode,
        &project.output.preset,
        project.output.embed_subtitles,
    );
    let mut final_video = plan.output_video.clone();
    if profile.embed_subtitles {
        let st = preview_state(project).map_err(|e| e.to_string())?;
        if !st.srt.is_empty() {
            let embed_src = workdir.join("embed.srt");
            let first_group = st.srt.keys().next().unwrap();
            std::fs::write(&embed_src, &st.srt[first_group]).map_err(|e| e.to_string())?;
            let ext = Path::new(&final_video)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("mp4")
                .to_lowercase();
            let subtitle_codec = if ext == "mkv" { "srt" } else { "mov_text" };
            let embedded = Path::new(&final_video)
                .with_extension("")
                .to_string_lossy()
                .to_string()
                + "_sub."
                + &ext;
            let cmd = vec![
                ffmpeg_str.clone(),
                "-y".into(),
                "-v".into(),
                "error".into(),
                "-i".into(),
                final_video.clone(),
                "-i".into(),
                embed_src.to_string_lossy().to_string(),
                "-map".into(),
                "0".into(),
                "-map".into(),
                "1".into(),
                "-c".into(),
                "copy".into(),
                "-c:s".into(),
                subtitle_codec.into(),
                embedded.clone(),
            ];
            if run_ffmpeg_progress(ffmpeg, &cmd, 1, 99.0, 1.0, on_progress).is_ok() {
                final_video = embedded;
            } else {
                warnings.push("字幕封装失败，已保留外挂字幕。".to_string());
            }
        }
    }

    on_progress(100, "导出完成");
    let st = preview_state(project).map_err(|e| e.to_string())?;
    let segments_json = serde_json::to_value(&st.segments).unwrap_or(Value::Null);
    Ok(serde_json::json!({
        "video": final_video,
        "output_path": final_video,
        "output_dir": Path::new(&final_video).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "subtitles": subtitle_paths,
        "subtitle_format": sub_fmt,
        "srt": st.srt,
        "vtt": st.vtt,
        "segments": segments_json,
        "total_ms": st.total_ms,
        "warnings": warnings,
        "workdir": workdir_str,
    }))
}

/// JPEG thumbnail at `seconds` (used by the timeline scrubber).
pub fn thumb_jpeg(ffmpeg: &Path, path: &str, seconds: f64) -> Option<Vec<u8>> {
    let secs = seconds.max(0.0);
    let out = quiet(ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-ss",
            &format!("{secs:.3}"),
            "-i",
            path,
            "-frames:v",
            "1",
            "-vf",
            "scale=180:-1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-",
        ])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if out.status.success() && !out.stdout.is_empty() {
        Some(out.stdout)
    } else {
        None
    }
}

/// Waveform preview image.
pub fn waveform_png(ffmpeg: &Path, path: &str) -> Option<Vec<u8>> {
    let out = quiet(ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-i",
            path,
            "-filter_complex",
            "showwavespic=s=1600x120:colors=0x378ADD",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-",
        ])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if out.status.success() && !out.stdout.is_empty() {
        Some(out.stdout)
    } else {
        None
    }
}

/// Resolve ffmpeg/ffprobe, preferring a bundled sidecar, then PATH / env.
pub fn resolve_bins(resource_dir: &Path, ffmpeg_env: Option<&str>, ffprobe_env: Option<&str>) -> (PathBuf, PathBuf) {
    let sidecar_ffmpeg = resource_dir.join("bin").join("ffmpeg.exe");
    let sidecar_ffprobe = resource_dir.join("bin").join("ffprobe.exe");
    let ffmpeg = ffmpeg_env
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| if sidecar_ffmpeg.exists() { Some(sidecar_ffmpeg) } else { None })
        .unwrap_or_else(|| PathBuf::from("ffmpeg"));
    let ffprobe = ffprobe_env
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| if sidecar_ffprobe.exists() { Some(sidecar_ffprobe) } else { None })
        .unwrap_or_else(|| PathBuf::from("ffprobe"));
    (ffmpeg, ffprobe)
}
