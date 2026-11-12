//! Build and return the ffmpeg export plan as plain command vectors.
//!
//! Precise mode  : `-ss AFTER -i`, re-encode with libx264/aac -> frame-accurate.
//!                Encoding parameters (bit depth, profile, level, colour tags,
//!                GOP, B-frames, audio layout) are read from the source and fed
//!                back, so the re-encode does not silently degrade 10-bit->8-bit.
//!                This is NOT bit-exact: only `-c copy` is.
//! Lossless mode : `-ss BEFORE -i` (input seek) with `-c copy`, snapped to a
//!                keyframe up front.
//!
//! This module only *constructs* commands and serialises the remapped subtitle
//! text. The actual process spawning and file IO happen in the Tauri command
//! layer, which also owns the temp work directory.

use std::collections::HashMap;
use std::path::Path;

use crate::checks::evaluate_encode;
use crate::model::{ExportMode, Project, Source};
use crate::presets::{resolve_profile, PROFILE_720P};
use crate::probe::{AudioParams, EncodeParams, FormatParams, VideoParams};
use crate::rate::plan_rate;
use crate::remap::{build_segments, preview_state};
use crate::srt::{to_vtt, write_srt};

pub struct ExportPlan {
    /// One full ffmpeg argv (including the binary) per segment.
    pub segment_commands: Vec<Vec<String>>,
    /// Concatenation command (includes the binary).
    pub concat_command: Vec<String>,
    /// Optional "mux subtitles into the video" command.
    pub embed_command: Option<Vec<String>>,
    /// The final video path ffmpeg will write (container may have been forced).
    pub output_video: String,
    /// group_id -> subtitle text (srt or vtt, per `subtitle_format`).
    pub subtitles: HashMap<String, String>,
    pub subtitle_format: String,
    pub warnings: Vec<String>,
}

fn sec(ms: i64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

fn source_keyint(source: &Source) -> i64 {
    let keys = &source.keyframes_ms;
    let fps = source.fps;
    if keys.len() < 3 || fps <= 0.0 {
        return 0;
    }
    let mut gaps: Vec<i64> = keys
        .windows(2)
        .filter_map(|w| if w[1] > w[0] { Some(w[1] - w[0]) } else { None })
        .collect();
    if gaps.is_empty() {
        return 0;
    }
    gaps.sort_unstable();
    let median = gaps[gaps.len() / 2];
    let frames = (median as f64 * fps / 1000.0).round() as i64;
    frames.max(12).min(600)
}

/// H.264 profile names are tied to bit depth; a mismatch makes ffmpeg fail.
///
/// Returns `None` when no `-profile:v` should be passed at all: the source
/// has no profile, or the pixel format is 4:2:2 / 4:4:4 (x264 has no profile
/// for those on 8-bit, and passing an empty profile makes ffmpeg fail with
/// exit code -22 "invalid profile"). The profile name is normalised to
/// lowercase first, because ffprobe / user input may capitalise it ("High").
fn compatible_profile(profile: &str, pix_fmt: &str) -> Option<String> {
    let profile = profile.trim().to_lowercase();
    if profile.is_empty() {
        return None;
    }
    let ten_bit = pix_fmt.contains("10");
    if pix_fmt.contains("422") || pix_fmt.contains("444") {
        return None;
    }
    if ten_bit {
        return if ["baseline", "main", "high", "high10"].contains(&profile.as_str()) {
            Some("high10".to_string())
        } else {
            None
        };
    }
    if ["high10", "high422", "high444"].contains(&profile.as_str()) {
        Some("high".to_string())
    } else {
        Some(profile)
    }
}

/// Build the full export plan. `info_by_source`/`bitrate_by_source` are keyed by
/// source id and pre-populated by the command layer via ffprobe.
#[allow(clippy::too_many_arguments)]
pub fn build_export_plan(
    project: &Project,
    output_path: &str,
    workdir: &str,
    ffmpeg_bin: &str,
    info_by_source: &HashMap<String, EncodeParams>,
    bitrate_by_source: &HashMap<String, (i64, i64)>,
) -> Result<ExportPlan, String> {
    if project.clips.is_empty() {
        return Err("没有可导出的片段".to_string());
    }

    let profile = resolve_profile(
        &project.output.profile_mode,
        &project.output.encode,
        &project.output.preset,
        project.output.embed_subtitles,
    );
    let cfg = &profile.encode;
    let speed = &profile.speed;
    let embed_subtitles = profile.embed_subtitles;
    let mode = &project.output.mode;
    let segments = build_segments(project).map_err(|e| e.to_string())?;

    let container = crate::paths::forced_container(project, None);
    let mut output_path = output_path.to_string();
    if !container.is_empty() {
        output_path = Path::new(&output_path)
            .with_extension(container.as_str())
            .to_string_lossy()
            .to_string();
    }

    let mut warnings: Vec<String> = Vec::new();
    let requested_container = if cfg.container == "mp4" || cfg.container == "mkv" {
        cfg.container.clone()
    } else {
        String::new()
    };
    if *mode == ExportMode::Lossless && !requested_container.is_empty() && requested_container == "mp4" && container == "mkv" {
        warnings.push(
            "无损模式下部分源片不是 MP4 容器，流拷贝无法安全写入 MP4；已自动改用 MKV 输出（画质不受影响）。".to_string(),
        );
    }

    // Evaluate warnings with the same rule engine as the settings panel.
    if let (Some(first), Some(info)) = (
        segments.first(),
        info_by_source.get(&segments[0].source_id),
    ) {
        let total_ms: i64 = segments.iter().map(|s| s.duration_ms).sum();
        let eval = evaluate_encode(
            info,
            cfg,
            total_ms,
            mode,
            segments.len() as i64,
            project.output.match_source_bitrate,
            &project.output.profile_mode,
        );
        for w in eval.warnings {
            if w.level == "warn" {
                warnings.push(format!("⚠ {}：{}", w.title, w.text));
            }
        }
        let _ = first;
    }

    let mut segment_commands: Vec<Vec<String>> = Vec::new();
    let total = segments.len();

    for (i, seg) in segments.iter().enumerate() {
        let source = project.source(&seg.source_id).ok_or_else(|| format!("unknown source {}", seg.source_id))?;
        let source_ext = Path::new(&source.path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let ext = if !container.is_empty() {
            container.clone()
        } else if *mode == ExportMode::Precise || ["mp4", "m4v", "mov"].contains(&source_ext.as_str()) {
            "mp4".to_string()
        } else {
            "mkv".to_string()
        };
        let destination = format!("{}/seg_{:03}.{}", workdir, i, ext);
        let duration = seg.out_ms - seg.in_ms;

        let mut cmd: Vec<String> = vec![ffmpeg_bin.to_string(), "-y".into(), "-v".into(), "error".into()];

        if *mode == ExportMode::Precise {
            // Prefer the single ffprobe snapshot. The legacy bitrate map is
            // only a fallback for callers that predate `EncodeParams::*_bps`.
            let info: EncodeParams = info_by_source
                .get(&source.id)
                .cloned()
                .unwrap_or_else(|| {
                    let (vb, ab) = bitrate_by_source.get(&source.id).copied().unwrap_or((0, 0));
                    EncodeParams {
                        video: VideoParams { video_bps: vb, video_kbps: vb / 1000, ..Default::default() },
                        audio: AudioParams { audio_bps: ab, audio_kbps: ab / 1000, ..Default::default() },
                        format: FormatParams {
                            bitrate_bps: vb + ab,
                            bitrate_kbps: (vb + ab) / 1000,
                            ..Default::default()
                        },
                    }
                });
            let v = Some(&info.video);
            let a = Some(&info.audio);
            let mut resolved: HashMap<String, String> = HashMap::new();
            if let Some(v) = v {
                if v.supported {
                    for key in [
                        "pix_fmt", "profile", "level", "fps", "colorspace", "color_trc",
                        "color_primaries", "color_range",
                    ] {
                        if !profile.inherit_source_profile && (key == "profile" || key == "level") {
                            continue;
                        }
                        let val = match key {
                            "pix_fmt" => v.pix_fmt.clone(),
                            "profile" => v.profile.clone(),
                            "level" => v.level.clone(),
                            "fps" => v.fps.clone(),
                            "colorspace" => v.colorspace.clone(),
                            "color_trc" => v.color_trc.clone(),
                            "color_primaries" => v.color_primaries.clone(),
                            "color_range" => v.color_range.clone(),
                            _ => None,
                        };
                        if let Some(val) = val.filter(|s| !s.trim().is_empty()) {
                            resolved.insert(key.into(), val);
                        }
                    }
                    if v.b_frames > 0 {
                        resolved.insert("bf".into(), v.b_frames.to_string());
                    }
                    let keyint = source_keyint(source);
                    if keyint > 0 {
                        resolved.insert("g".into(), keyint.to_string());
                    }
                } else {
                    resolved.insert("pix_fmt".into(), "yuv420p".into());
                    warnings.push(format!(
                        "源 {} 的编码格式（{}）无法原样回填，已改用标准 H.264 8-bit 重编码。",
                        Path::new(&source.path).file_name().and_then(|s| s.to_str()).unwrap_or(""),
                        v.codec.clone().unwrap_or_default()
                    ));
                }
            }
            for (key, value) in [("pix_fmt", &cfg.pix_fmt), ("profile", &cfg.profile), ("level", &cfg.level), ("fps", &cfg.fps)] {
                if !value.is_empty() {
                    resolved.insert(key.into(), value.clone());
                }
            }
            if cfg.gop > 0 {
                resolved.insert("g".into(), cfg.gop.to_string());
            }
            if cfg.bframes >= 0 {
                resolved.insert("bf".into(), cfg.bframes.to_string());
            }

            let mut scale_expr = String::new();
            if cfg.scale_mode == "height" && cfg.height > 0 {
                let src_h = v.map(|v| v.height).unwrap_or(0);
                if project.output.profile_mode == PROFILE_720P && src_h > 0 && src_h <= cfg.height {
                    warnings.push(format!(
                        "源 {} 本身只有 {}p，720p 预设不会把它放大（放大只是白占空间）。",
                        Path::new(&source.path).file_name().and_then(|s| s.to_str()).unwrap_or(""),
                        src_h
                    ));
                } else {
                    scale_expr = format!("-2:{}", cfg.height);
                }
            } else if cfg.scale_mode == "width" && cfg.width > 0 {
                scale_expr = format!(":{}", cfg.width);
                scale_expr = format!("{}:-2", cfg.width);
            } else if cfg.width > 0 && cfg.height > 0 {
                scale_expr = format!("{}:{}", cfg.width, cfg.height);
            }
            if !scale_expr.is_empty() {
                resolved.insert("scale".into(), scale_expr);
            }

            let encoder = if cfg.video_codec == "libx264" || cfg.video_codec == "libx265" {
                cfg.video_codec.clone()
            } else {
                "libx264".into()
            };
            let mut video_options: Vec<String> = vec!["-c:v".into(), encoder.clone(), "-preset".into(), speed.clone()];
            let mut pairs: Vec<(&str, &str)> = vec![
                ("-pix_fmt", "pix_fmt"),
                ("-r", "fps"),
                ("-colorspace", "colorspace"),
                ("-color_trc", "color_trc"),
                ("-color_primaries", "color_primaries"),
                ("-color_range", "color_range"),
            ];
            if encoder == "libx264" {
                // Never pass an empty -profile:v to ffmpeg: compatible_profile
                // returns None when no profile applies (no profile, 4:2:2 /
                // 4:4:4, or an unsupported 10-bit profile) — drop the key
                // instead of inserting "".
                match compatible_profile(
                    resolved.get("profile").map(|s| s.as_str()).unwrap_or(""),
                    resolved.get("pix_fmt").map(|s| s.as_str()).unwrap_or(""),
                ) {
                    Some(p) => {
                        resolved.insert("profile".into(), p);
                    }
                    None => {
                        resolved.remove("profile");
                    }
                }
                pairs = vec![
                    ("-profile:v", "profile"),
                    ("-level:v", "level"),
                    ("-pix_fmt", "pix_fmt"),
                    ("-r", "fps"),
                    ("-colorspace", "colorspace"),
                    ("-color_trc", "color_trc"),
                    ("-color_primaries", "color_primaries"),
                    ("-color_range", "color_range"),
                ];
                if let Some(bf) = resolved.get("bf") {
                    video_options.push("-bf".into());
                    video_options.push(bf.clone());
                }
                if let Some(g) = resolved.get("g") {
                    video_options.push("-g".into());
                    video_options.push(g.clone());
                }
            }
            for (flag, key) in pairs {
                // Never pass an empty option value to ffmpeg (e.g. an empty
                // profile/level/pix_fmt/fps): ffmpeg rejects it with -22.
                if let Some(val) = resolved.get(key) {
                    if val.is_empty() {
                        continue;
                    }
                    video_options.push(flag.into());
                    video_options.push(val.clone());
                }
            }
            if let Some(scale) = resolved.get("scale") {
                video_options.push("-vf".into());
                video_options.push(format!("scale={}:flags=lanczos", scale));
            }

            // ONE decision drives both the settings-page estimate and this
            // command. There is deliberately no `else -> CRF 18` fallback:
            // that fallback was the 4x size explosion on low-bitrate sources.
            let rate = plan_rate(
                &info,
                cfg,
                project.output.match_source_bitrate,
                &project.output.profile_mode,
                mode,
                project.output.crf,
            );
            if let Some(bps) = rate.video_bps {
                video_options.push("-b:v".into());
                video_options.push(bps.to_string());
            } else {
                video_options.push("-crf".into());
                video_options.push(rate.crf.to_string());
            }
            if let Some(cap) = rate.maxrate_kbps {
                video_options.push("-maxrate".into());
                video_options.push(format!("{}k", cap));
                if let Some(buf) = rate.bufsize_kbps {
                    video_options.push("-bufsize".into());
                    video_options.push(format!("{}k", buf));
                }
            }

            let (audio_map, audio_options) = match cfg.audio_codec.as_str() {
                "none" => (vec!["-an".into()], vec!["-an".into()]),
                "copy" => (vec!["-map".into(), "0:a:0?".into()], vec!["-c:a".into(), "copy".into()]),
                _ => {
                    let mut map = vec!["-map".into(), "0:a:0?".into()];
                    let mut opt = vec!["-c:a".into(), "aac".into()];
                    let ap = if !cfg.audio_profile.is_empty() {
                        Some(cfg.audio_profile.clone())
                    } else {
                        a.and_then(|a| a.profile.clone())
                    };
                    let ar = if cfg.sample_rate > 0 {
                        Some(cfg.sample_rate)
                    } else {
                        a.and_then(|a| a.sample_rate)
                    };
                    let ac = if cfg.channels > 0 {
                        Some(cfg.channels)
                    } else {
                        a.and_then(|a| a.channels)
                    };
                    if let Some(ap) = ap {
                        opt.push("-profile:a".into());
                        opt.push(ap);
                    }
                    if let Some(ar) = ar {
                        opt.push("-ar".into());
                        opt.push(ar.to_string());
                    }
                    if let Some(ac) = ac {
                        opt.push("-ac".into());
                        opt.push(ac.to_string());
                    }
                    if let Some(bps) = rate.audio_bps {
                        opt.push("-b:a".into());
                        opt.push(bps.to_string());
                    } else {
                        opt.push("-b:a".into());
                        opt.push("192k".into());
                    }
                    (map, opt)
                }
            };

            let container_flags = if cfg.faststart && ["mp4", "m4v", "mov"].contains(&ext.as_str()) {
                vec!["-movflags".into(), "+faststart".into()]
            } else {
                vec![]
            };

            cmd.push("-i".into());
            cmd.push(source.path.clone());
            cmd.push("-ss".into());
            cmd.push(sec(seg.in_ms));
            cmd.push("-t".into());
            cmd.push(sec(duration));
            cmd.push("-map".into());
            cmd.push("0:v:0".into());
            cmd.extend(audio_map);
            cmd.extend(video_options);
            cmd.extend(audio_options);
            cmd.extend(container_flags);
            cmd.push("-progress".into());
            cmd.push("pipe:1".into());
            cmd.push("-nostats".into());
            cmd.push(destination.clone());
        } else {
            // Lossless stream copy. Plain input-seek command: no -avoid_negative_ts,
            // no -fflags +genpts (those break the snapped keyframe).
            let shift = seg.requested_in_ms - seg.in_ms;
            if shift > 0 {
                warnings.push(format!(
                    "片段 {}: 无损流拷贝只能从关键帧开始，起点由 {}ms 提前到 {}ms（{}ms）。视频与字幕已同时按该起点处理，不会错位。",
                    i + 1, seg.requested_in_ms, seg.in_ms, shift
                ));
            }
            let container_options = if cfg.faststart && ["mp4", "m4v", "mov"].contains(&ext.as_str()) {
                vec!["-movflags".into(), "+faststart".into()]
            } else {
                vec![]
            };
            cmd.push("-ss".into());
            cmd.push(sec(seg.in_ms));
            cmd.push("-i".into());
            cmd.push(source.path.clone());
            cmd.push("-t".into());
            cmd.push(sec(duration));
            cmd.push("-map".into());
            cmd.push("0:v:0".into());
            cmd.push("-map".into());
            cmd.push("0:a?".into());
            cmd.push("-c".into());
            cmd.push("copy".into());
            cmd.extend(container_options);
            cmd.push("-progress".into());
            cmd.push("pipe:1".into());
            cmd.push("-nostats".into());
            cmd.push(destination.clone());
        }

        let _ = total;
        segment_commands.push(cmd);
    }

    let state = preview_state(project).map_err(|e| e.to_string())?;
    let sub_fmt = if cfg.subtitle_format == "vtt" { "vtt" } else { "srt" };
    let mut subtitles: HashMap<String, String> = HashMap::new();
    for (group, cues) in &state.groups {
        let text = if sub_fmt == "vtt" {
            to_vtt(cues)
        } else {
            write_srt(cues)
        };
        subtitles.insert(group.clone(), text);
    }

    // Concatenation
    let mut concat = vec![ffmpeg_bin.to_string(), "-y".into(), "-v".into(), "error".into()];
    let is_mp4 = output_path.to_lowercase().ends_with(".mp4")
        || output_path.to_lowercase().ends_with(".m4v")
        || output_path.to_lowercase().ends_with(".mov");
    let faststart = if is_mp4 { vec!["-movflags".into(), "+faststart".into()] } else { vec![] };
    if segment_commands.len() == 1 {
        concat.extend(vec![
            "-i".into(),
            format!("{}/seg_000.{}", workdir, if !container.is_empty() { container.clone() } else { "mp4".into() }),
            "-c".into(),
            "copy".into(),
        ]);
        concat.extend(faststart);
        concat.push(output_path.clone());
    } else {
        let list_path = format!("{}/_concat_list.txt", workdir);
        let mut list_content = String::new();
        for (i, _) in segment_commands.iter().enumerate() {
            let ext = if !container.is_empty() {
                container.clone()
            } else {
                "mp4".to_string()
            };
            let p = format!("{}/seg_{:03}.{}", workdir, i, ext).replace('\\', "/");
            list_content.push_str(&format!("file '{}'\n", p));
        }
        // The list is written by the command layer; plan records its path.
        concat.extend(vec![
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list_path,
            "-c".into(),
            "copy".into(),
        ]);
        concat.extend(faststart);
        concat.push(output_path.clone());
    }

    // Embedding is performed by the command layer after concat; the plan only
    // notes that the resolved profile requested it.
    let _ = embed_subtitles;
    let embed_command: Option<Vec<String>> = None;
    let _ = &embed_command;

    Ok(ExportPlan {
        segment_commands,
        concat_command: concat,
        embed_command: None,
        output_video: output_path,
        subtitles,
        subtitle_format: sub_fmt.to_string(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clip, EncodeCfg, OutputCfg, Source};
    use crate::probe::{AudioParams, EncodeParams, FormatParams, VideoParams};
    use std::collections::HashMap;

    fn project() -> Project {
        let mut p = Project::default();
        p.sources.push(Source {
            id: "s1".into(),
            path: "D:/videos/x.mp4".into(),
            duration_ms: 10_000,
            fps: 30.0,
            bitrate_bps: 8_000_000,
            keyframes_ms: vec![0, 5000],
        });
        p.clips.push(Clip {
            id: "c1".into(),
            source_id: "s1".into(),
            start: crate::model::Boundary::at_time(1000, 0),
            end: crate::model::Boundary::at_time(4000, 0),
            track_ids: vec![],
            label: "clip".into(),
        });
        p
    }

    fn info() -> EncodeParams {
        EncodeParams {
            video: VideoParams {
                codec: Some("h264".into()),
                supported: true,
                profile: Some("high".into()),
                level: Some("4.0".into()),
                pix_fmt: Some("yuv420p".into()),
                fps: Some("30/1".into()),
                fps_float: 30.0,
                width: 1920,
                height: 1080,
                video_kbps: 8000,
                b_frames: 3,
                ..Default::default()
            },
            audio: AudioParams {
                codec: Some("aac".into()),
                sample_rate: Some(48000),
                channels: Some(2),
                profile: Some("aac_low".into()),
                audio_kbps: 192,
                audio_bps: 192_000,
            },
            format: FormatParams::default(),
        }
    }

    #[test]
    fn builds_precise_segment_command() {
        let mut p = project();
        let mut infos = HashMap::new();
        infos.insert("s1".into(), info());
        let mut bitrates = HashMap::new();
        bitrates.insert("s1".into(), (8_000_000i64, 192_000i64));
        let plan = build_export_plan(&p, "D:/out/clip.mp4", "D:/tmp/work", "ffmpeg", &infos, &bitrates).unwrap();
        assert_eq!(plan.segment_commands.len(), 1);
        let cmd = &plan.segment_commands[0];
        assert!(cmd.contains(&"libx264".to_string()));
        assert!(cmd.contains(&"-ss".to_string()));
        assert!(cmd.contains(&"1.000".to_string()));
        assert!(cmd.contains(&"3.000".to_string())); // duration 4000-1000
        assert_eq!(plan.subtitle_format, "srt");
    }

    #[test]
    fn lossless_snaps_and_uses_input_seek() {
        let mut p = project();
        p.output.mode = ExportMode::Lossless;
        let mut infos = HashMap::new();
        infos.insert("s1".into(), info());
        let mut bitrates = HashMap::new();
        bitrates.insert("s1".into(), (8_000_000i64, 192_000i64));
        let plan = build_export_plan(&p, "D:/out/clip.mp4", "D:/tmp/work", "ffmpeg", &infos, &bitrates).unwrap();
        let cmd = &plan.segment_commands[0];
        // input seek: -ss appears BEFORE -i
        let ss = cmd.iter().position(|c| c == "-ss").unwrap();
        let ii = cmd.iter().position(|c| c == "-i").unwrap();
        assert!(ss < ii, "lossless must use input seek (-ss before -i)");
        assert!(cmd.contains(&"copy".to_string()));
    }

    #[test]
    fn no_clips_errors() {
        let p = Project::default();
        let infos = HashMap::new();
        let bitrates = HashMap::new();
        let r = build_export_plan(&p, "out.mp4", "w", "ffmpeg", &infos, &bitrates);
        assert!(r.is_err());
    }

    fn info_with(profile: Option<&str>, pix_fmt: &str) -> EncodeParams {
        let mut i = info();
        i.video.profile = profile.map(|s| s.to_string());
        i.video.pix_fmt = Some(pix_fmt.to_string());
        i
    }

    fn plan_cmd(profile: Option<&str>, pix_fmt: &str) -> Vec<String> {
        let p = project();
        let mut infos = HashMap::new();
        infos.insert("s1".into(), info_with(profile, pix_fmt));
        let mut bitrates = HashMap::new();
        bitrates.insert("s1".into(), (8_000_000i64, 192_000i64));
        let plan = build_export_plan(&p, "D:/out/clip.mp4", "D:/tmp/work", "ffmpeg", &infos, &bitrates).unwrap();
        assert_eq!(plan.segment_commands.len(), 1);
        plan.segment_commands[0].clone()
    }

    fn assert_no_empty_args(cmd: &[String]) {
        assert!(
            !cmd.iter().any(|a| a.is_empty()),
            "ffmpeg command must never contain an empty argument: {cmd:?}"
        );
    }

    #[test]
    fn compatible_profile_cases() {
        assert_eq!(compatible_profile("", "yuv420p"), None);
        assert_eq!(compatible_profile("high", "yuv422p"), None);
        assert_eq!(compatible_profile("high422", "yuv422p"), None);
        assert_eq!(compatible_profile("high444", "yuv444p"), None);
        assert_eq!(compatible_profile("high", "yuv420p10le"), Some("high10".into()));
        assert_eq!(compatible_profile("high422", "yuv420p10le"), None);
        // ffprobe / user input may capitalise the profile name.
        assert_eq!(compatible_profile("High", "yuv420p"), Some("high".into()));
        assert_eq!(compatible_profile("HIGH", "yuv420p"), Some("high".into()));
        assert_eq!(compatible_profile("high", "yuv420p"), Some("high".into()));
    }

    #[test]
    fn yuv422p_export_omits_profile_flag() {
        // Regression test for the reported -22 failure: a yuv422p source
        // (profile "High 4:2:2") used to produce `-profile:v ""`.
        let cmd = plan_cmd(Some("high422"), "yuv422p");
        assert_no_empty_args(&cmd);
        assert!(!cmd.contains(&"-profile:v".to_string()), "422 must not pass -profile:v: {cmd:?}");
    }

    #[test]
    fn empty_profile_export_omits_profile_flag() {
        // A source with no profile (ffprobe reports none) must not pass
        // `-profile:v ""` either.
        let cmd = plan_cmd(None, "yuv420p");
        assert_no_empty_args(&cmd);
        assert!(!cmd.contains(&"-profile:v".to_string()), "empty profile must not pass -profile:v: {cmd:?}");
    }

    #[test]
    fn capitalised_profile_is_lowercased() {
        let cmd = plan_cmd(Some("High"), "yuv420p");
        assert_no_empty_args(&cmd);
        let pos = cmd.iter().position(|a| a == "-profile:v").expect("profile flag expected");
        assert_eq!(cmd[pos + 1], "high");
    }

    #[test]
    fn ten_bit_export_uses_high10() {
        let cmd = plan_cmd(Some("high"), "yuv420p10le");
        assert_no_empty_args(&cmd);
        let pos = cmd.iter().position(|a| a == "-profile:v").expect("profile flag expected");
        assert_eq!(cmd[pos + 1], "high10");
    }

    #[test]
    fn normal_yuv420p_high_keeps_profile() {
        let cmd = plan_cmd(Some("high"), "yuv420p");
        assert_no_empty_args(&cmd);
        let pos = cmd.iter().position(|a| a == "-profile:v").expect("profile flag expected");
        assert_eq!(cmd[pos + 1], "high");
    }

    /// The exact shape of the AV1/Opus VLOG that reproduced "转码后反而变大".
    fn av1_info() -> EncodeParams {
        EncodeParams {
            video: VideoParams {
                codec: Some("av1".into()),
                supported: false,
                pix_fmt: Some("yuv420p".into()),
                fps: Some("30/1".into()),
                fps_float: 30.0,
                width: 1280,
                height: 720,
                video_bps: 677_123,
                video_kbps: 677,
                ..Default::default()
            },
            audio: AudioParams {
                codec: Some("opus".into()),
                sample_rate: Some(48000),
                channels: Some(2),
                audio_bps: 128_456,
                audio_kbps: 128,
                ..Default::default()
            },
            format: FormatParams {
                bitrate_bps: 805_579,
                bitrate_kbps: 805,
                ..Default::default()
            },
        }
    }

    fn cmd_for(profile_mode: &str, i: EncodeParams) -> (Vec<String>, Vec<String>) {
        let mut p = project();
        p.output.profile_mode = profile_mode.to_string();
        let mut infos = HashMap::new();
        infos.insert("s1".into(), i);
        // Deliberately EMPTY legacy bitrate map: the exporter must no longer
        // depend on the buggy second parser.
        let plan = build_export_plan(
            &p,
            "D:/out/clip.mp4",
            "D:/tmp/work",
            "ffmpeg",
            &infos,
            &HashMap::new(),
        )
        .unwrap();
        (plan.segment_commands[0].clone(), plan.warnings.clone())
    }

    fn value_after(cmd: &[String], flag: &str) -> String {
        let pos = cmd.iter().position(|a| a == flag).unwrap_or_else(|| panic!("missing {flag}: {cmd:?}"));
        cmd[pos + 1].clone()
    }

    #[test]
    fn low_bitrate_source_profile_never_silently_uses_crf18() {
        let (cmd, warnings) = cmd_for("source", av1_info());
        assert!(!cmd.contains(&"-crf".to_string()), "must not fall back to CRF: {cmd:?}");
        assert_eq!(value_after(&cmd, "-b:v"), "677123");
        assert_eq!(value_after(&cmd, "-maxrate"), "677k");
        assert_eq!(value_after(&cmd, "-b:a"), "128456");
        assert!(warnings.iter().any(|w| w.contains("高效编码")));
    }

    #[test]
    fn builtin_720p_clamps_ceiling_and_buffer_to_source() {
        let (cmd, _) = cmd_for("builtin_720p", av1_info());
        assert_eq!(value_after(&cmd, "-crf"), "25");
        assert_eq!(value_after(&cmd, "-maxrate"), "677k"); // not 1000k
        assert_eq!(value_after(&cmd, "-bufsize"), "1219k"); // not 1800k
        assert_eq!(value_after(&cmd, "-b:a"), "96000");
    }

    #[test]
    fn builtin_720p_keeps_recipe_on_high_bitrate_source() {
        let (cmd, _) = cmd_for("builtin_720p", info());
        assert_eq!(value_after(&cmd, "-maxrate"), "1000k");
        assert_eq!(value_after(&cmd, "-bufsize"), "1800k");
    }
}
