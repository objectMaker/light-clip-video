//! Embedded HTTP server that exposes the exact same API the existing web UI
//! already talks to (`/api/open`, `/api/project`, `/api/cues/shift`, ...).
//!
//! This is a faithful port of the Python `server.py`. Keeping the HTTP contract
//! identical means the 128 KB frontend needs no changes at all: the Tauri
//! window simply loads `http://127.0.0.1:<port>` and everything works.

pub mod ffmpeg;

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use clip_core::cues as cue_ops;
use clip_core::model::{EncodeCfg, ExportMode, OutputCfg, Project, SubTrack};
use clip_core::paths;
use clip_core::presets::{profile_catalog, resolve_profile};
use clip_core::remap::preview_state;
use clip_core::srt::read_srt_file;
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

const VIDEO_EXT: &[&str] = &[".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts", ".flv", ".wmv"];
const SUB_EXT: &[&str] = &[".srt", ".vtt", ".ass", ".ssa"];

pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub web_dir: PathBuf,
    pub ffmpeg_bin: PathBuf,
    pub ffprobe_bin: PathBuf,
    pub autosave_dir: PathBuf,
    pub out_dir: PathBuf,
}

#[derive(Clone)]
struct Task {
    status: String,
    percent: i64,
    message: String,
    result: Option<Value>,
    error: Option<String>,
}

struct State {
    project: Mutex<Project>,
    tasks: Mutex<HashMap<String, Task>>,
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn uuid_like() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", now_nanos(), n)
}

/// UTC ISO-8601 without pulling in a date crate.
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}+00:00")
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn respond_json(req: Request, value: &Value, status: u16) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let mut resp = Response::from_data(body).with_status_code(status);
    resp.add_header(header("Content-Type", "application/json; charset=utf-8"));
    resp.add_header(header("Cache-Control", "no-store"));
    let _ = req.respond(resp);
}

fn respond_err(req: Request, msg: &str, status: u16) {
    respond_json(req, &json!({ "error": msg }), status);
}

fn respond_bytes(req: Request, data: Vec<u8>, ctype: &str) {
    let mut resp = Response::from_data(data).with_status_code(200);
    resp.add_header(header("Content-Type", ctype));
    let _ = req.respond(resp);
}

/// Absolute path without the Windows `\\?\` verbatim prefix that
/// `std::fs::canonicalize` adds (Python's `os.path.abspath` never does).
fn clean_abs(p: &str) -> String {
    let c = std::fs::canonicalize(p)
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string());
    if let Some(rest) = c.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = c.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        c
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_url(url: &str) -> (String, HashMap<String, String>) {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p.to_string(), q),
        None => (url.to_string(), ""),
    };
    let mut params = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        params.insert(percent_decode(k), percent_decode(v));
    }
    (path, params)
}

fn read_body(req: &mut Request) -> Value {
    let mut buf = Vec::new();
    let _ = req.as_reader().read_to_end(&mut buf);
    if buf.is_empty() {
        return Value::Null;
    }
    serde_json::from_slice(&buf).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Autosave / recovery
// ---------------------------------------------------------------------------

fn autosave_path(project: &Project, dir: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let joined = project
        .sources
        .iter()
        .map(|s| s.path.as_str())
        .collect::<Vec<_>>()
        .join("|");
    let mut h = std::collections::hash_map::DefaultHasher::new();
    joined.hash(&mut h);
    let key = format!("{:016x}", h.finish());
    dir.join(format!("{}.json", &key[..12]))
}

fn save_project_disk(project: &Project, dir: &Path) {
    if project.sources.is_empty() {
        return;
    }
    let payload = json!({
        "version": 2,
        "app": "light-clip-video",
        "saved_at": iso_now(),
        "project": project,
    });
    let _ = std::fs::create_dir_all(dir);
    let target = autosave_path(project, dir);
    let tmp = target.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_string(&payload).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &target);
    }
}

fn recover_project(dir: &Path) -> Option<Value> {
    if !dir.is_dir() {
        return None;
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
    files.reverse();
    for file in files.into_iter().take(8) {
        let data: Value = match std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(d) => d,
            None => continue,
        };
        let project: Project = match data
            .get("project")
            .and_then(|p| serde_json::from_value(p.clone()).ok())
        {
            Some(p) => p,
            None => continue,
        };
        if project.sources.is_empty() || project.sources.iter().any(|s| !Path::new(&s.path).is_file()) {
            continue;
        }
        let st = match preview_state(&project) {
            Ok(s) => s,
            Err(_) => continue,
        };
        return Some(json!({
            "project": project,
            "state": st,
            "saved_at": data.get("saved_at").cloned().unwrap_or(Value::Null),
            "file": file.to_string_lossy(),
        }));
    }
    None
}

// ---------------------------------------------------------------------------
// Business handlers
// ---------------------------------------------------------------------------

fn allowed_media(project: &Project, path: &str) -> bool {
    let p = clean_abs(path);
    project.sources.iter().any(|s| clean_abs(&s.path) == p)
}

fn export_batch_info(project: &Project) -> (Vec<String>, String, bool) {
    let st = match preview_state(project) {
        Ok(s) => s,
        Err(_) => {
            let profile = resolve_profile(
                &project.output.profile_mode,
                &project.output.encode,
                &project.output.preset,
                project.output.embed_subtitles,
            );
            let sub_fmt = if profile.encode.subtitle_format == "vtt" { "vtt" } else { "srt" };
            return (Vec::new(), sub_fmt.to_string(), profile.embed_subtitles);
        }
    };
    let profile = resolve_profile(
        &project.output.profile_mode,
        &project.output.encode,
        &project.output.preset,
        project.output.embed_subtitles,
    );
    let sub_fmt = if profile.encode.subtitle_format == "vtt" { "vtt" } else { "srt" };
    let groups: Vec<String> = if sub_fmt == "vtt" {
        st.vtt.keys().cloned().collect()
    } else {
        st.srt.keys().cloned().collect()
    };
    (groups, sub_fmt.to_string(), profile.embed_subtitles)
}

fn export_target(body: &Value, project: &Project) -> Result<Value, String> {
    let (groups, sub_fmt, embed) = export_batch_info(project);
    let res = paths::resolve_export_target(
        project,
        body.get("output_path").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("output_dir").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("output_name").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false),
        &groups,
        &sub_fmt,
        embed,
        &|p| Path::new(p).exists(),
    )?;
    Ok(serde_json::to_value(res).unwrap_or(Value::Null))
}

fn open_media(body: &Value, state: &Arc<State>, cfg: &ServerConfig) -> Result<Value, String> {
    let mut videos: Vec<String> = body
        .get("videos")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if videos.is_empty() {
        if let Some(v) = body.get("video").and_then(|v| v.as_str()) {
            videos = vec![v.to_string()];
        }
    }
    if videos.is_empty() {
        return Err("请至少选择一个视频文件".into());
    }

    let has_output = body.get("output").is_some();
    let mut output: OutputCfg = body
        .get("output")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if !has_output {
        output.profile_mode = "source".to_string();
    }
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            Path::new(&videos[0])
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        });

    let mut project = Project {
        name,
        sources: Vec::new(),
        tracks: Vec::new(),
        clips: Vec::new(),
        output,
        cue_edits: Vec::new(),
    };

    for (i, raw) in videos.iter().enumerate() {
        let path = clean_abs(raw);
        if !Path::new(&path).is_file() {
            return Err(format!("视频不存在: {path}"));
        }
        let mut source = ffmpeg::probe_source(&cfg.ffprobe_bin, &path, &format!("s{}", i + 1))?;
        source.keyframes_ms = ffmpeg::list_keyframes(&cfg.ffprobe_bin, &path);
        project.sources.push(source);
    }

    let mut specs: Vec<Value> = body
        .get("subtitles")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let auto = body
        .get("auto_subtitles")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if specs.is_empty() && auto {
        for source in &project.sources {
            let candidate = Path::new(&source.path)
                .with_extension("srt")
                .to_string_lossy()
                .to_string();
            if Path::new(&candidate).is_file() {
                specs.push(json!({
                    "path": candidate, "source_id": source.id,
                    "group_id": "zh", "label": "中文", "lang": "zh"
                }));
            }
        }
    }

    for (i, spec) in specs.iter().enumerate() {
        let raw_path = spec.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let path = clean_abs(&raw_path);
        if !Path::new(&path).is_file() {
            return Err(format!("字幕不存在: {path}"));
        }
        let source_id = spec
            .get("source_id")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                project
                    .sources
                    .first()
                    .map(|s| s.id.clone())
                    .unwrap_or_default()
            });
        let group = spec
            .get("group_id")
            .and_then(|v| v.as_str())
            .or_else(|| spec.get("lang").and_then(|v| v.as_str()))
            .map(String::from)
            .unwrap_or_else(|| format!("g{}", i + 1));
        let label = spec
            .get("label")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                Path::new(&path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            });
        let lang = spec.get("lang").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cues = read_srt_file(&path).map_err(|e| e.to_string())?;
        project.tracks.push(SubTrack {
            id: format!("t{}", i + 1),
            source_id,
            group_id: group,
            label,
            lang,
            path: Some(path),
            origin: "external".into(),
            cues,
            enabled: true,
        });
    }

    let st = preview_state(&project).map_err(|e| e.to_string())?;
    *state.project.lock().unwrap() = project.clone();
    save_project_disk(&project, &cfg.autosave_dir);
    Ok(json!({ "project": project, "state": st }))
}

fn apply_cue_edit(body: &Value, state: &Arc<State>, cfg: &ServerConfig) -> Result<Value, String> {
    let mut project = state.project.lock().unwrap().clone();
    let action = body.get("action").and_then(|v| v.as_str()).unwrap_or("shift");
    let track_id = body
        .get("track_id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            project
                .tracks
                .first()
                .map(|t| t.id.clone())
                .unwrap_or_default()
        });
    let track_idx = project
        .tracks
        .iter()
        .position(|t| t.id == track_id)
        .ok_or("字幕轨不存在（可能尚未载入字幕）")?;
    let at = iso_now();

    let mut clamped = 0i64;
    let mut applied = 0i64;
    let mut records: Vec<clip_core::model::CueEdit> = Vec::new();

    if action == "reload" {
        let path = project.tracks[track_idx]
            .path
            .clone()
            .ok_or("源字幕文件已不存在，无法重新载入")?;
        if !Path::new(&path).is_file() {
            return Err("源字幕文件已不存在，无法重新载入".into());
        }
        project.tracks[track_idx].cues = read_srt_file(&path).map_err(|e| e.to_string())?;
        cue_ops::append_edits(&mut project, &[], "reload", &track_id, &at);
    } else {
        let source_id = project.tracks[track_idx].source_id.clone();
        let upper = project
            .source(&source_id)
            .and_then(|s| if s.duration_ms > 0 { Some(s.duration_ms) } else { None });
        let scope = body.get("scope").and_then(|v| v.as_str()).unwrap_or("cue");
        let uniform = scope == "track" || scope == "all_tracks";
        let kind = if uniform {
            "global".to_string()
        } else {
            body.get("kind").and_then(|v| v.as_str()).unwrap_or("shift").to_string()
        };
        let cues = project.tracks[track_idx].cues.clone();
        let mut indices: Vec<i64>;
        if action == "set" {
            let i = body.get("index").and_then(|v| v.as_i64()).unwrap_or(-1);
            if i < 0 || i as usize >= cues.len() {
                return Err("要设置的字幕行不存在".into());
            }
            indices = vec![i];
        } else {
            indices = body
                .get("indices")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                .unwrap_or_default();
            if uniform {
                indices = (0..cues.len() as i64).collect();
            }
        }
        if indices.is_empty() {
            return Err("没有选中要矫正的字幕行".into());
        }

        if action == "set" {
            let i = indices[0];
            let start = body.get("start_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let end = body.get("end_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let (new_cues, recs, cl, ap) =
                cue_ops::set_cue_times(&cues, i, start, end, &track_id, 0, upper, &at);
            project.tracks[track_idx].cues = new_cues;
            clamped = cl;
            applied = ap;
            records = recs;
        } else {
            let mut delta = body.get("delta_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let edge = body.get("edge").and_then(|v| v.as_str()).unwrap_or("both");
            if uniform {
                delta = cue_ops::global_delta(&cues, delta, upper);
            }
            let (new_cues, recs, cl, ap) =
                cue_ops::shift_cues(&cues, &indices, delta, &track_id, edge, 0, upper, &kind, &at, false);
            project.tracks[track_idx].cues = new_cues;
            clamped = cl;
            applied = ap;
            records = recs;
            if scope == "all_tracks" {
                for ti in 0..project.tracks.len() {
                    if project.tracks[ti].id == track_id || project.tracks[ti].source_id != source_id {
                        continue;
                    }
                    let ocues = project.tracks[ti].cues.clone();
                    let oindices: Vec<i64> = (0..ocues.len() as i64).collect();
                    let otid = project.tracks[ti].id.clone();
                    let (onc, orecs, oc, _) = cue_ops::shift_cues(
                        &ocues, &oindices, delta, &otid, edge, 0, upper, "global", &at, false,
                    );
                    project.tracks[ti].cues = onc;
                    clamped += oc;
                    records.extend(orecs);
                }
            }
        }
        cue_ops::append_edits(&mut project, &records, "", "", "");
    }

    let summary = cue_ops::edit_summary(&project, &track_id);
    let st = preview_state(&project).map_err(|e| e.to_string())?;
    *state.project.lock().unwrap() = project.clone();
    save_project_disk(&project, &cfg.autosave_dir);
    Ok(json!({
        "project": project,
        "state": st,
        "records": records,
        "clamped": clamped,
        "applied_delta_ms": applied,
        "summary": summary,
        "saved_at": at,
    }))
}

fn export_subtitles(body: &Value, project: &Project) -> Result<Value, String> {
    let fmt = if body
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or(&project.output.encode.subtitle_format)
        == "vtt"
    {
        "vtt"
    } else {
        "srt"
    };

    let texts: HashMap<String, String> = if !project.clips.is_empty() {
        let st = preview_state(project).map_err(|e| e.to_string())?;
        if fmt == "vtt" {
            st.vtt
        } else {
            st.srt
        }
    } else {
        let w = cue_ops::whole_subtitle_text(project);
        let mut m = HashMap::new();
        for (g, ws) in w {
            m.insert(g, if fmt == "vtt" { ws.vtt } else { ws.srt });
        }
        m
    };

    let groups: Vec<String> = texts.keys().cloned().collect();
    if groups.is_empty() {
        return Err("没有可导出的字幕轨（很可能没载入字幕）".into());
    }
    let overwrite = body.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
    let target = paths::resolve_export_target(
        project,
        "",
        body.get("output_dir").and_then(|v| v.as_str()).unwrap_or(""),
        body.get("output_name").and_then(|v| v.as_str()).unwrap_or(""),
        overwrite,
        &[],
        fmt,
        false,
        &|p| Path::new(p).exists(),
    )?;
    let base = Path::new(&target["path"])
        .with_extension("")
        .to_string_lossy()
        .to_string();
    let candidates: Vec<String> = if groups.len() == 1 {
        vec![format!("{base}.{fmt}")]
    } else {
        groups
            .iter()
            .map(|g| format!("{base}.{}.{fmt}", paths::safe_group(g)))
            .collect()
    };
    let mut protected: Vec<String> = project.tracks.iter().filter_map(|t| t.path.clone()).collect();
    protected.extend(paths::source_paths(project));
    let (final_paths, renamed) = paths::unique_batch_paths(
        &candidates,
        overwrite,
        &protected,
        &|p| Path::new(p).exists(),
        999,
    )?;
    if let Some(parent) = Path::new(&final_paths[0]).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    for (g, p) in groups.iter().zip(final_paths.iter()) {
        std::fs::write(p, &texts[g]).map_err(|e| e.to_string())?;
    }

    let subtitles: HashMap<String, String> = groups
        .iter()
        .cloned()
        .zip(final_paths.iter().cloned())
        .collect();
    Ok(json!({
        "subtitles": subtitles,
        "dir": Path::new(&final_paths[0]).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        "format": fmt,
        "renamed_from": renamed,
        "count": final_paths.len(),
        "remapped": !project.clips.is_empty(),
        "default_path": target["default_path"],
    }))
}

fn reveal_path(path: &str, dry_run: bool) -> Result<Value, String> {
    let target = clean_abs(path);
    let is_file = Path::new(&target).is_file();
    let is_dir = Path::new(&target).is_dir();
    if !is_file && !is_dir {
        return Err(format!("路径不存在: {target}"));
    }
    if dry_run {
        return Ok(json!({ "ok": true, "opened": target, "dry_run": true }));
    }
    #[cfg(windows)]
    {
        if is_file {
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,{target}"))
                .spawn();
        } else {
            let _ = std::process::Command::new("explorer").arg(&target).spawn();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(Path::new(&target).parent().unwrap_or(Path::new("/")).to_string_lossy().to_string())
            .spawn();
    }
    Ok(json!({ "ok": true, "opened": target }))
}

fn mkdir(body: &Value) -> Result<Value, String> {
    let parent = body.get("parent").and_then(|v| v.as_str()).unwrap_or("");
    let parent_abs = clean_abs(parent);
    if parent_abs.is_empty() || !Path::new(&parent_abs).is_dir() {
        return Err(format!("父目录不存在: {parent_abs}"));
    }
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() || name.chars().any(|c| "\\/:*?\"<>|".contains(c)) {
        return Err("文件夹名称为空或含有非法字符".into());
    }
    let created = Path::new(&parent_abs).join(&name);
    std::fs::create_dir_all(&created).map_err(|e| e.to_string())?;
    Ok(json!({ "path": created.to_string_lossy() }))
}

fn browse(directory: &str, kind: &str) -> Result<Value, String> {
    if directory.is_empty() {
        let mut entries = Vec::new();
        for c in b'A'..=b'Z' {
            let d = format!("{}:\\", c as char);
            if Path::new(&d).exists() {
                entries.push(json!({ "name": d, "path": d, "is_dir": true, "size": 0 }));
            }
        }
        return Ok(json!({ "path": "", "parent": Value::Null, "entries": entries }));
    }
    let dir_abs = clean_abs(directory);
    if !Path::new(&dir_abs).is_dir() {
        return Err(format!("目录不存在: {dir_abs}"));
    }
    let stripped = dir_abs.trim_end_matches(['\\', '/']);
    let parent_raw = Path::new(stripped)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = if !parent_raw.is_empty() && parent_raw != stripped {
        format!("{}{}", parent_raw, std::path::MAIN_SEPARATOR)
    } else {
        String::new()
    };

    let mut entries = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir_abs) {
        let mut names: Vec<(bool, String, PathBuf)> = rd
            .filter_map(|e| e.ok())
            .map(|e| {
                let p = e.path();
                let is_dir = p.is_dir();
                (is_dir, e.file_name().to_string_lossy().to_string(), p)
            })
            .collect();
        names.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
        for (is_dir, name, full) in names {
            if name.starts_with('.') {
                continue;
            }
            let ext = full
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if kind == "dir" {
                if !is_dir {
                    continue;
                }
            } else if !is_dir {
                let allowed: &[&str] = match kind {
                    "video" => VIDEO_EXT,
                    "sub" => SUB_EXT,
                    _ => &[
                        ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".ts", ".flv", ".wmv",
                        ".srt", ".vtt", ".ass", ".ssa",
                    ],
                };
                if !allowed.contains(&ext.as_str()) {
                    continue;
                }
            }
            let size = if is_dir {
                0
            } else {
                std::fs::metadata(&full).map(|m| m.len() as i64).unwrap_or(0)
            };
            entries.push(json!({ "name": name, "path": full.to_string_lossy(), "is_dir": is_dir, "size": size }));
        }
    }
    Ok(json!({ "path": dir_abs, "parent": parent, "entries": entries }))
}

fn parse_mode(s: &str) -> ExportMode {
    if s == "lossless" {
        ExportMode::Lossless
    } else {
        ExportMode::Precise
    }
}

fn mode_str(m: &ExportMode) -> &'static str {
    match m {
        ExportMode::Lossless => "lossless",
        ExportMode::Precise => "precise",
    }
}

fn check_params(body: &Value, state: &Arc<State>, cfg: &ServerConfig) -> Result<Value, String> {
    let encode_cfg: EncodeCfg = body
        .get("encode")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let project = state.project.lock().unwrap().clone();
    let src = project.sources.first().ok_or("尚未载入视频")?;
    if !Path::new(&src.path).is_file() {
        return Err("尚未载入视频".into());
    }
    let info = ffmpeg::probe_encode_params(&cfg.ffprobe_bin, &src.path)?;
    let total_ms = body.get("total_ms").and_then(|v| v.as_i64()).unwrap_or(0);
    let mode = body
        .get("mode")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| mode_str(&project.output.mode).to_string());
    let clip_count = project.clips.len() as i64;
    let msb = body
        .get("match_source_bitrate")
        .and_then(|v| v.as_bool())
        .unwrap_or(project.output.match_source_bitrate);
    let pm = body
        .get("profile_mode")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| project.output.profile_mode.clone());
    let eval = clip_core::checks::evaluate_encode(
        &info,
        &encode_cfg,
        total_ms,
        &parse_mode(&mode),
        clip_count,
        msb,
        &pm,
    );
    Ok(serde_json::to_value(eval).unwrap_or(Value::Null))
}

fn start_export(body: &Value, state: &Arc<State>, cfg: &Arc<ServerConfig>) -> Result<Value, String> {
    let project = state.project.lock().unwrap().clone();
    {
        let tasks = state.tasks.lock().unwrap();
        if tasks.values().any(|t| t.status == "running") {
            return Err("已有导出任务在进行中".into());
        }
    }
    let target = export_target(body, &project)?;
    let output_path = target.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let dir = target.get("dir").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !dir.is_empty() {
        let _ = std::fs::create_dir_all(&dir);
    }

    let task_id = uuid_like();
    let task = Task {
        status: "running".into(),
        percent: 0,
        message: "准备中".into(),
        result: None,
        error: None,
    };
    state.tasks.lock().unwrap().insert(task_id.clone(), task);

    let state2 = Arc::clone(state);
    let ffmpeg = cfg.ffmpeg_bin.clone();
    let ffprobe = cfg.ffprobe_bin.clone();
    let out = output_path.clone();
    let tid = task_id.clone();
    let target_for_thread = target.clone();
    thread::spawn(move || {
        let st_prog = Arc::clone(&state2);
        let tid_prog = tid.clone();
        let on_progress = move |pct: i64, msg: &str| {
            if let Some(t) = st_prog.tasks.lock().unwrap().get_mut(&tid_prog) {
                t.percent = t.percent.max(pct.min(99));
                t.message = msg.to_string();
            }
        };
        match ffmpeg::execute_export(&project, &out, &ffmpeg, &ffprobe, &on_progress) {
            Ok(mut result) => {
                if let Value::Object(map) = &mut result {
                    map.insert(
                        "renamed_from".into(),
                        target_for_thread.get("renamed_from").cloned().unwrap_or(Value::Null),
                    );
                    map.insert(
                        "default_path".into(),
                        target_for_thread.get("default_path").cloned().unwrap_or(Value::Null),
                    );
                }
                if let Some(t) = state2.tasks.lock().unwrap().get_mut(&tid) {
                    t.status = "done".into();
                    t.percent = 100;
                    t.message = "导出完成".into();
                    t.result = Some(result);
                }
            }
            Err(e) => {
                if let Some(t) = state2.tasks.lock().unwrap().get_mut(&tid) {
                    t.status = "error".into();
                    t.message = "导出失败".into();
                    t.error = Some(e);
                }
            }
        }
    });

    Ok(json!({
        "task_id": task_id,
        "output_path": output_path,
        "renamed_from": target.get("renamed_from").cloned().unwrap_or(Value::Null),
    }))
}

// ---------------------------------------------------------------------------
// Static file / media serving
// ---------------------------------------------------------------------------

fn serve_static(req: Request, web_dir: &Path, name: &str) {
    let path = web_dir.join(name);
    match std::fs::read(&path) {
        Ok(data) => {
            let ctype = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "application/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("json") => "application/json; charset=utf-8",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                _ => "application/octet-stream",
            };
            let mut resp = Response::from_data(data).with_status_code(200);
            resp.add_header(header("Content-Type", ctype));
            resp.add_header(header("Cache-Control", "no-store"));
            let _ = req.respond(resp);
        }
        Err(_) => respond_err(req, name, 404),
    }
}

fn serve_media(mut req: Request, path: &Path, ctype: &str) {
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len() as i64,
        Err(_) => {
            respond_err(req, "not found", 404);
            return;
        }
    };
    let mut start = 0i64;
    let mut end = size - 1;
    let mut status = 200u16;
    if let Some(h) = req
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("range"))
    {
        let val = h.value.as_str().to_string();
        if let Some(inner) = val.strip_prefix("bytes=") {
            let parts: Vec<&str> = inner.split('-').collect();
            if parts.len() == 2 {
                if !parts[0].is_empty() {
                    start = parts[0].parse().unwrap_or(0);
                }
                if !parts[1].is_empty() {
                    end = parts[1].parse::<i64>().unwrap_or(size - 1).min(size - 1);
                }
                status = 206;
                if start >= size {
                    let mut resp = Response::empty(416);
                    resp.add_header(header("Content-Range", &format!("bytes */{size}")));
                    let _ = req.respond(resp);
                    return;
                }
            }
        }
    }
    let len = (end - start + 1).max(0) as u64;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => {
            respond_err(req, "not found", 404);
            return;
        }
    };
    let _ = file.seek(SeekFrom::Start(start as u64));
    let reader = file.take(len);
    let mut resp = Response::new(status.into(), vec![], Box::new(reader), Some(len as usize), None);
    resp.add_header(header("Content-Type", ctype));
    resp.add_header(header("Accept-Ranges", "bytes"));
    if status == 206 {
        resp.add_header(header("Content-Range", &format!("bytes {start}-{end}/{size}")));
    }
    resp.add_header(header("Cache-Control", "no-store"));
    let _ = req.respond(resp);
}

fn media_ctype(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("ts") => "video/mp2t",
        _ => "video/mp4",
    }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

fn route_get(req: Request, route: &str, q: &HashMap<String, String>, state: &Arc<State>, cfg: &Arc<ServerConfig>) {
    let get = |k: &str| q.get(k).map(|s| s.as_str()).unwrap_or("");

    match route {
        "/" | "/index.html" => serve_static(req, &cfg.web_dir, "index.html"),
        "/app.js" => serve_static(req, &cfg.web_dir, "app.js"),
        "/style.css" => serve_static(req, &cfg.web_dir, "style.css"),
        "/api/project" => {
            let project = state.project.lock().unwrap().clone();
            match preview_state(&project) {
                Ok(st) => respond_json(req, &json!({ "project": project, "state": st }), 200),
                Err(e) => respond_err(req, &e.to_string(), 500),
            }
        }
        "/api/project/recover" => match recover_project(&cfg.autosave_dir) {
            Some(v) => respond_json(req, &v, 200),
            None => respond_json(req, &json!({ "project": Value::Null }), 200),
        },
        "/api/browse" => match browse(get("dir"), if get("kind").is_empty() { "all" } else { get("kind") }) {
            Ok(v) => respond_json(req, &v, 200),
            Err(e) => respond_err(req, &e, 500),
        },
        "/api/config" => respond_json(
            req,
            &json!({
                "ffmpeg": cfg.ffmpeg_bin.to_string_lossy(),
                "ffprobe": cfg.ffprobe_bin.to_string_lossy(),
                "outdir": cfg.out_dir.to_string_lossy(),
                "cwd": std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            }),
            200,
        ),
        "/api/profiles" => respond_json(req, &json!({ "profiles": profile_catalog() }), 200),
        "/api/export/default" => {
            let project = state.project.lock().unwrap().clone();
            if project.sources.is_empty() {
                respond_err(req, "尚未载入视频", 400);
                return;
            }
            let body = json!({
                "output_dir": get("dir"),
                "output_name": get("name"),
                "overwrite": matches!(get("overwrite"), "1" | "true" | "True"),
            });
            match export_target(&body, &project) {
                Ok(v) => respond_json(req, &v, 200),
                Err(e) => respond_err(req, &e, 500),
            }
        }
        "/api/encode-params" => {
            let path = get("path");
            let project = state.project.lock().unwrap().clone();
            if path.is_empty() || !allowed_media(&project, path) || !Path::new(path).is_file() {
                respond_err(req, "未登记的媒体文件", 403);
                return;
            }
            match ffmpeg::probe_encode_params(&cfg.ffprobe_bin, path) {
                Ok(info) => respond_json(req, &serde_json::to_value(info).unwrap_or(Value::Null), 200),
                Err(e) => respond_err(req, &e, 500),
            }
        }
        "/api/export/status" => {
            let id = get("id");
            let tasks = state.tasks.lock().unwrap();
            match tasks.get(id) {
                Some(t) => respond_json(
                    req,
                    &json!({
                        "status": t.status,
                        "percent": t.percent,
                        "message": t.message,
                        "result": t.result,
                        "error": t.error,
                    }),
                    200,
                ),
                None => respond_err(req, "未知任务", 404),
            }
        }
        "/api/media" => {
            let path = get("path").to_string();
            let project = state.project.lock().unwrap().clone();
            if path.is_empty() || !allowed_media(&project, &path) || !Path::new(&path).is_file() {
                respond_err(req, "未登记的媒体文件", 403);
                return;
            }
            let ct = media_ctype(&path);
            serve_media(req, Path::new(&path), ct);
        }
        "/api/thumb" => {
            let path = get("path").to_string();
            let t: f64 = get("t").parse().unwrap_or(0.0);
            let project = state.project.lock().unwrap().clone();
            if !allowed_media(&project, &path) {
                respond_err(req, "未登记的媒体文件", 403);
                return;
            }
            match ffmpeg::thumb_jpeg(&cfg.ffmpeg_bin, &path, t) {
                Some(data) => respond_bytes(req, data, "image/jpeg"),
                None => respond_err(req, "thumbnail failed", 500),
            }
        }
        "/api/waveform" => {
            let path = get("path").to_string();
            let project = state.project.lock().unwrap().clone();
            if !allowed_media(&project, &path) {
                respond_err(req, "未登记的媒体文件", 403);
                return;
            }
            match ffmpeg::waveform_png(&cfg.ffmpeg_bin, &path) {
                Some(data) => respond_bytes(req, data, "image/png"),
                None => respond_err(req, "waveform failed", 500),
            }
        }
        _ => respond_err(req, &format!("未知路由 {route}"), 404),
    }
}

fn route_post(mut req: Request, route: &str, state: &Arc<State>, cfg: &Arc<ServerConfig>) {
    let body = read_body(&mut req);
    match route {
        "/api/open" => match open_media(&body, state, cfg) {
            Ok(v) => respond_json(req, &v, 200),
            Err(e) => respond_err(req, &e, 500),
        },
        "/api/project" => {
            let project: Option<Project> = body
                .get("project")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            match project {
                Some(p) => {
                    *state.project.lock().unwrap() = p.clone();
                    save_project_disk(&p, &cfg.autosave_dir);
                    match preview_state(&p) {
                        Ok(st) => respond_json(req, &json!({ "state": st }), 200),
                        Err(e) => respond_err(req, &e.to_string(), 500),
                    }
                }
                None => respond_err(req, "无效的工程数据", 500),
            }
        }
        "/api/cues/shift" => match apply_cue_edit(&body, state, cfg) {
            Ok(v) => respond_json(req, &v, 200),
            Err(e) => respond_err(req, &e, 500),
        },
        "/api/export-subtitles" => {
            let project = state.project.lock().unwrap().clone();
            match export_subtitles(&body, &project) {
                Ok(v) => respond_json(req, &v, 200),
                Err(e) => respond_err(req, &e, 500),
            }
        }
        "/api/project/load" => {
            let project: Option<Project> = body
                .get("project")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            match project {
                Some(p) => {
                    if p.sources.is_empty() {
                        respond_err(req, "工程里没有源视频", 500);
                        return;
                    }
                    let missing: Vec<String> = p
                        .sources
                        .iter()
                        .filter(|s| !Path::new(&s.path).is_file())
                        .map(|s| s.path.clone())
                        .collect();
                    if !missing.is_empty() {
                        respond_err(req, &format!("工程引用的视频已不存在：{}", missing.join("、")), 500);
                        return;
                    }
                    *state.project.lock().unwrap() = p.clone();
                    match preview_state(&p) {
                        Ok(st) => respond_json(req, &json!({ "project": p, "state": st }), 200),
                        Err(e) => respond_err(req, &e.to_string(), 500),
                    }
                }
                None => respond_err(req, "无效的工程数据", 500),
            }
        }
        "/api/preview" => {
            let project: Option<Project> = body
                .get("project")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            match project {
                Some(p) => match preview_state(&p) {
                    Ok(st) => respond_json(req, &json!({ "state": st }), 200),
                    Err(e) => respond_err(req, &e.to_string(), 500),
                },
                None => respond_err(req, "无效的工程数据", 500),
            }
        }
        "/api/check-params" => match check_params(&body, state, cfg) {
            Ok(v) => respond_json(req, &v, 200),
            Err(e) => respond_err(req, &e, 500),
        },
        "/api/snap" => {
            let project = state.project.lock().unwrap().clone();
            let source_id = body.get("source_id").and_then(|v| v.as_str()).unwrap_or("");
            let ms = body.get("ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let tol = body.get("tolerance_ms").and_then(|v| v.as_i64()).unwrap_or(500);
            let b = clip_core::remap::snap_to_cue(&project, source_id, ms, tol);
            respond_json(req, &json!({ "boundary": b }), 200);
        }
        "/api/clips/from-cues" => {
            let mut project = state.project.lock().unwrap().clone();
            let source_id = body.get("source_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let indices: Vec<i64> = body
                .get("indices")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                .unwrap_or_default();
            let track_id = body.get("track_id").and_then(|v| v.as_str());
            let padding_start = body.get("padding_start_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let padding_end = body.get("padding_end_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let merge_gap = body.get("merge_gap_ms").and_then(|v| v.as_i64()).unwrap_or(0);
            let id_prefix = body
                .get("id_prefix")
                .and_then(|v| v.as_str())
                .map(String::from)
                .unwrap_or_else(|| uuid_like().chars().take(6).collect());
            match clip_core::remap::clips_from_cue_selection(
                &project,
                &source_id,
                &indices,
                track_id,
                padding_start,
                padding_end,
                merge_gap,
                &id_prefix,
            ) {
                Ok(clips) => {
                    if body.get("replace").and_then(|v| v.as_bool()).unwrap_or(true) {
                        project.clips = clips.clone();
                    } else {
                        project.clips.extend(clips.clone());
                    }
                    *state.project.lock().unwrap() = project.clone();
                    match preview_state(&project) {
                        Ok(st) => respond_json(
                            req,
                            &json!({ "clips": clips, "project": project, "state": st }),
                            200,
                        ),
                        Err(e) => respond_err(req, &e.to_string(), 500),
                    }
                }
                Err(e) => respond_err(req, &e.to_string(), 500),
            }
        }
        "/api/export" => match start_export(&body, state, cfg) {
            Ok(v) => respond_json(req, &v, 200),
            Err(e) => respond_err(req, &e, 500),
        },
        "/api/reveal" => {
            let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let dry = body.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false);
            match reveal_path(path, dry) {
                Ok(v) => respond_json(req, &v, 200),
                Err(e) => respond_err(req, &e, 500),
            }
        }
        "/api/mkdir" => match mkdir(&body) {
            Ok(v) => respond_json(req, &v, 200),
            Err(e) => respond_err(req, &e, 500),
        },
        _ => respond_err(req, &format!("未知路由 {route}"), 404),
    }
}

fn handle(mut req: Request, state: &Arc<State>, cfg: &Arc<ServerConfig>) {
    let method = req.method().clone();
    let url = req.url().to_string();
    let (route, query) = split_url(&url);
    match method {
        Method::Get => route_get(req, &route, &query, state, cfg),
        Method::Post => route_post(req, &route, state, cfg),
        _ => {
            let _ = req.respond(Response::empty(405));
        }
    }
}

/// Bind a fresh listener and serve. Intended to be spawned on a background thread.
pub fn run(cfg: ServerConfig) -> std::io::Result<()> {
    let listener = std::net::TcpListener::bind(format!("{}:{}", cfg.host, cfg.port))?;
    run_with_listener(listener, cfg)
}

/// Serve on an already-bound listener (used by the Tauri app so it can pick the
/// port up front and point the webview at it without a race).
pub fn run_with_listener(listener: std::net::TcpListener, cfg: ServerConfig) -> std::io::Result<()> {
    let server = Server::from_listener(listener, None)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let state = Arc::new(State {
        project: Mutex::new(Project::default()),
        tasks: Mutex::new(HashMap::new()),
    });
    let cfg = Arc::new(cfg);

    loop {
        match server.recv() {
            Ok(req) => {
                let state = Arc::clone(&state);
                let cfg = Arc::clone(&cfg);
                thread::spawn(move || handle(req, &state, &cfg));
            }
            Err(_) => {
                // Transient accept error (closed probe connection, etc.).
                thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
}
