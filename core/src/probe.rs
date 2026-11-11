//! Thin ffprobe JSON parsing. No process spawning here — the command layer runs
//! ffprobe and hands the parsed JSON to these pure functions, so the logic is
//! unit-testable without a real ffmpeg on the machine.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::Source;

fn clean_str(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let t = s.trim().to_string();
            if t.is_empty() || matches!(t.to_lowercase().as_str(), "n/a" | "unknown" | "unspecified" | "none") {
                None
            } else {
                Some(t)
            }
        }
        _ => None,
    }
}

fn as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Durations/bitrates come back as DECIMAL strings (e.g. "3.000000"), so they
/// must never be routed through the integer parser.
fn as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

const X264_PIX_FMTS: &[&str] = &[
    "yuv420p", "yuvj420p", "yuv422p", "yuvj422p", "yuv444p", "yuvj444p", "nv12", "nv16", "nv21",
    "yuv420p10le", "yuv422p10le", "yuv444p10le", "nv20le", "gray", "gray10le",
];

fn parse_ratio(r: &str) -> f64 {
    let parts: Vec<&str> = r.split('/').collect();
    if parts.len() == 2 {
        let num: f64 = parts[0].parse().unwrap_or(0.0);
        let den: f64 = parts[1].parse().unwrap_or(0.0);
        if den != 0.0 {
            return num / den;
        }
    }
    r.parse().unwrap_or(0.0)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VideoParams {
    pub codec: Option<String>,
    pub supported: bool,
    pub profile: Option<String>,
    pub level: Option<String>,
    pub pix_fmt: Option<String>,
    pub fps: Option<String>,
    pub fps_float: f64,
    pub width: i64,
    pub height: i64,
    pub video_kbps: i64,
    pub b_frames: i64,
    pub colorspace: Option<String>,
    pub color_trc: Option<String>,
    pub color_primaries: Option<String>,
    pub color_range: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioParams {
    pub codec: Option<String>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub profile: Option<String>,
    pub audio_kbps: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FormatParams {
    pub duration_ms: i64,
    pub size_bytes: i64,
    pub bitrate_kbps: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EncodeParams {
    pub video: VideoParams,
    pub audio: AudioParams,
    pub format: FormatParams,
}

/// Read a source's encoding parameters so a re-encode can mirror them.
pub fn parse_encode_params(value: &Value) -> EncodeParams {
    let empty = EncodeParams::default();
    let data = match value {
        Value::Object(_) => value,
        _ => return empty,
    };
    let streams = data.get("streams").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let fmt = data.get("format").cloned().unwrap_or(Value::Null);
    let v = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(clean_str) == Some("video".to_string()))
        .cloned()
        .unwrap_or(Value::Null);
    let a = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(clean_str) == Some("audio".to_string()))
        .cloned()
        .unwrap_or(Value::Null);

    let codec = clean_str(&v["codec_name"]);
    let pix = clean_str(&v["pix_fmt"]).filter(|p| X264_PIX_FMTS.contains(&p.as_str()));
    let raw_level = clean_str(&v["level"]);
    let level = raw_level.and_then(|l| {
        if l.chars().all(|c| c.is_ascii_digit()) {
            let n: i64 = l.parse().ok()?;
            Some(format!("{}.{}", n / 10, n % 10))
        } else {
            None
        }
    });
    let r = clean_str(&v["r_frame_rate"]);
    let avg = clean_str(&v["avg_frame_rate"]);
    let fps = if r.is_some() && r == avg { r } else { None };
    let fps_float = fps.as_deref().map(parse_ratio).unwrap_or(0.0);
    let bframes = as_i64(&v["has_b_frames"]).unwrap_or(0);
    let width = as_i64(&v["width"]).unwrap_or(0);
    let height = as_i64(&v["height"]).unwrap_or(0);
    let video_kbps = as_i64(&v["bit_rate"]).unwrap_or(0) / 1000;
    let duration_ms = (as_f64(&fmt["duration"]).unwrap_or(0.0) * 1000.0) as i64;
    let size_bytes = as_i64(&fmt["size"]).unwrap_or(0);

    let audio = if clean_str(&a["codec_name"]).as_deref() == Some("aac") {
        AudioParams {
            codec: Some("aac".to_string()),
            sample_rate: as_i64(&a["sample_rate"]),
            channels: as_i64(&a["channels"]),
            profile: match clean_str(&a["profile"]).as_deref() {
                Some("LC") | Some("AAC-LC") => Some("aac_low".to_string()),
                _ => None,
            },
            audio_kbps: as_i64(&a["bit_rate"]).unwrap_or(0) / 1000,
        }
    } else {
        AudioParams::default()
    };

    let total_kbps = (as_i64(&fmt["bit_rate"]).unwrap_or(0) / 1000) as i64;
    EncodeParams {
        video: VideoParams {
            codec: codec.clone(),
            supported: codec.as_deref() == Some("h264") && pix.is_some(),
            profile: if codec.as_deref() == Some("h264") {
                clean_str(&v["profile"]).and_then(|p| {
                    let m = [
                        ("Constrained Baseline", "baseline"),
                        ("Baseline", "baseline"),
                        ("Main", "main"),
                        ("High", "high"),
                        ("High 10", "high10"),
                        ("High 10 Intra", "high10"),
                        ("High 4:2:2", "high422"),
                        ("High 4:2:2 Intra", "high422"),
                        ("High 4:4:4 Predictive", "high444"),
                    ];
                    m.iter().find(|(k, _)| *k == p).map(|(_, v)| v.to_string())
                })
            } else {
                None
            },
            level,
            pix_fmt: pix,
            fps,
            fps_float,
            width,
            height,
            video_kbps,
            b_frames: bframes,
            colorspace: clean_str(&v["color_space"]),
            color_trc: clean_str(&v["color_transfer"]),
            color_primaries: clean_str(&v["color_primaries"]),
            color_range: clean_str(&v["color_range"]),
        },
        audio: audio.clone(),
        format: FormatParams {
            duration_ms,
            size_bytes,
            bitrate_kbps: (video_kbps + audio.audio_kbps).max(total_kbps),
        },
    }
}

/// Build a [`Source`] from ffprobe JSON.
pub fn parse_source(value: &Value, source_id: Option<&str>, path: &str) -> Source {
    let fmt = value.get("format").cloned().unwrap_or(Value::Null);
    let duration = as_f64(&fmt["duration"]).unwrap_or(0.0);
    let bitrate = as_i64(&fmt["bit_rate"]).unwrap_or(0);
    let streams = value.get("streams").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let v = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(clean_str) == Some("video".to_string()))
        .cloned()
        .unwrap_or(Value::Null);
    let rate = clean_str(&v["avg_frame_rate"]).or_else(|| clean_str(&v["r_frame_rate"])).unwrap_or_default();
    let fps = parse_ratio(&rate);
    Source {
        id: source_id.map(|s| s.to_string()).unwrap_or_else(|| {
            std::path::Path::new(path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "video".to_string())
        }),
        path: path.to_string(),
        duration_ms: (duration as f64 * 1000.0) as i64,
        fps,
        bitrate_bps: bitrate,
        keyframes_ms: Vec::new(),
    }
}

/// Parse `frame=pts_time,...` CSV lines into floored millisecond keyframes.
///
/// Frame pts are not whole milliseconds. Lossless export passes this back to
/// ffmpeg as `-ss`; flooring keeps `-ss` at or before the real keyframe pts so
/// the I-frame is always the first packet (rounding up would skip it).
pub fn parse_keyframes_csv(text: &str) -> Vec<i64> {
    let mut out = Vec::new();
    for line in text.lines() {
        for cell in line.split(',') {
            let cell = cell.trim();
            if cell.is_empty() || cell == "N/A" {
                continue;
            }
            if let Ok(f) = cell.parse::<f64>() {
                if f >= 0.0 {
                    out.push((f * 1000.0) as i64);
                }
            }
            break; // only the first cell of each line carries the timestamp
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// Nearest keyframe at or before `ms` (lossless cuts can only start there).
pub fn snap_down(ms: i64, keyframes: &[i64]) -> i64 {
    let candidates: Vec<i64> = keyframes.iter().copied().filter(|k| *k <= ms).collect();
    candidates.into_iter().max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_encode_params_h264_10bit() {
        let v = json!({
            "streams": [
                {"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p10le",
                 "level":"40","profile":"High 10","r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001",
                 "has_b_frames":3,"width":1920,"height":1080,"bit_rate":8000000,
                 "color_space":"bt709","color_transfer":"bt709","color_primaries":"bt709","color_range":"tv"},
                {"codec_type":"audio","codec_name":"aac","sample_rate":48000,"channels":2,
                 "profile":"LC","bit_rate":192000}
            ],
            "format": {"duration":"10.0","size":"10000000","bit_rate":8200000}
        });
        let p = parse_encode_params(&v);
        assert!(p.video.supported);
        assert_eq!(p.video.profile.as_deref(), Some("high10"));
        assert_eq!(p.video.level.as_deref(), Some("4.0"));
        assert_eq!(p.video.pix_fmt.as_deref(), Some("yuv420p10le"));
        assert_eq!(p.video.b_frames, 3);
        assert!((p.video.fps_float - 29.97).abs() < 0.1);
        assert_eq!(p.audio.codec.as_deref(), Some("aac"));
        assert_eq!(p.audio.channels, Some(2));
    }

    #[test]
    fn unsupported_codec_reports_false() {
        let v = json!({"streams":[{"codec_type":"video","codec_name":"hevc","pix_fmt":"yuv420p"}],"format":{}});
        let p = parse_encode_params(&v);
        assert!(!p.video.supported);
    }

    #[test]
    fn duration_is_a_decimal_string() {
        // ffprobe returns format.duration as "3.000000"; it must parse as f64.
        let v = json!({
            "format": {"duration": "3.000000", "bit_rate": "121794"},
            "streams": [{"codec_type": "video", "avg_frame_rate": "25/1"}]
        });
        let s = parse_source(&v, Some("s1"), "x.mp4");
        assert_eq!(s.duration_ms, 3000);
        assert!((s.fps - 25.0).abs() < 0.01);
        let p = parse_encode_params(&v);
        assert_eq!(p.format.duration_ms, 3000);
    }
}
