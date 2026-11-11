//! Pure evaluation of transcode overrides: warnings + size estimate.
//!
//! Single source of truth for both the live settings panel and the export result.
//! No ffmpeg calls, no project mutation - just source facts + chosen overrides.

use crate::model::{EncodeCfg, ExportMode};
use crate::presets::{resolve_profile, PROFILE_720P};
use crate::probe::EncodeParams;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct WarningItem {
    pub level: String,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct EncodeEvaluation {
    pub warnings: Vec<WarningItem>,
    pub estimated_bytes: Option<i64>,
    pub source_equivalent_bytes: i64,
    pub ratio: Option<f64>,
    pub estimate_note: String,
    pub is_upper_bound: bool,
}

fn item(level: &str, title: &str, text: &str) -> WarningItem {
    WarningItem {
        level: level.to_string(),
        title: title.to_string(),
        text: text.to_string(),
    }
}

fn kbps_to_bytes(kbps: i64, total_ms: i64) -> i64 {
    (kbps.max(0) as f64 * total_ms.max(0) as f64 / 8.0) as i64
}

/// One rule for the UI, the API and the ffmpeg command.
pub fn resolve_rate_control(cfg: &EncodeCfg, match_source_bitrate: bool) -> String {
    if cfg.rate_control.is_empty() {
        if match_source_bitrate {
            "source".to_string()
        } else {
            "crf".to_string()
        }
    } else {
        cfg.rate_control.clone()
    }
}

/// Return warnings and a rough output size for the chosen overrides.
pub fn evaluate_encode(
    info: &EncodeParams,
    cfg: &EncodeCfg,
    total_ms: i64,
    mode: &ExportMode,
    clip_count: i64,
    match_source_bitrate: bool,
    profile_mode: &str,
) -> EncodeEvaluation {
    let v = &info.video;
    let a = &info.audio;
    let mut warnings: Vec<WarningItem> = Vec::new();

    let profile = resolve_profile(profile_mode, cfg, &"medium".to_string(), false);
    let cfg = &profile.encode;
    let rc = resolve_rate_control(cfg, match_source_bitrate);

    if profile_mode == PROFILE_720P && *mode == ExportMode::Lossless {
        warnings.push(item(
            "warn",
            "720p 省体积方案在无损模式下不生效",
            "无损是流拷贝（不重新编码），分辨率、CRF、码率上限全部会被忽略。要用这套压缩参数请切到「精确模式」。",
        ));
    }

    let src_w = v.width as i64;
    let src_h = v.height as i64;
    let src_fps = v.fps_float;
    let src_vkb = v.video_kbps;
    let src_akb = a.audio_kbps;
    let src_rate = a.sample_rate.unwrap_or(0);
    let src_ch = a.channels.unwrap_or(0);
    let src_10bit = v.pix_fmt.as_deref().map(|p| p.contains("10")).unwrap_or(false);
    let src_equiv = kbps_to_bytes(src_vkb + src_akb, total_ms);

    if cfg.scale_mode == "height" && cfg.height > 0 && src_h > 0 {
        let ratio = (cfg.height as f64 / src_h as f64).powi(2);
        let est_w = ((src_w as f64 * cfg.height as f64 / src_h as f64 / 2.0).round() as i64 * 2).max(2);
        let builtin_cap = profile_mode == PROFILE_720P;
        if builtin_cap && cfg.height >= src_h {
            warnings.push(item(
                "info",
                "源片分辨率已低于预设上限",
                &format!("源片 {src_w}×{src_h} 不超过 {}p，不会把它放大；仍按 CRF 25 + 峰值码率上限重新编码来减小体积。", cfg.height),
            ));
        } else if cfg.height > src_h {
            warnings.push(item(
                "warn",
                "放大转码不会提升画质",
                &format!("源片高度 {src_h} → 输出高度 {}，像素数约 {ratio:.2} 倍。放大只是插值，细节不会变多，体积和编码时间却会上升。", cfg.height),
            ));
        } else {
            warnings.push(item(
                "info",
                "等比缩小分辨率",
                &format!("源片 {src_w}×{src_h} → 约 {est_w}×{}，像素数约 {ratio:.2} 倍。宽度按原比例自动取偶数，竖屏 / 超宽片源同样适用。", cfg.height),
            ));
        }
    } else if cfg.scale_mode == "width" && cfg.width > 0 && src_w > 0 {
        let ratio = (cfg.width as f64 / src_w as f64).powi(2);
        let est_h = ((src_h as f64 * cfg.width as f64 / src_w as f64 / 2.0).round() as i64 * 2).max(2);
        if cfg.width > src_w {
            warnings.push(item(
                "warn",
                "放大转码不会提升画质",
                &format!("源片宽度 {src_w} → 输出宽度 {}，像素数约 {ratio:.2} 倍，细节不会变多但体积会上升。", cfg.width),
            ));
        } else {
            warnings.push(item(
                "info",
                "等比缩小分辨率",
                &format!("源片 {src_w}×{src_h} → 约 {}×{est_h}，像素数约 {ratio:.2} 倍。", cfg.width),
            ));
        }
    } else if cfg.width > 0 && cfg.height > 0 && src_w > 0 && src_h > 0 {
        let ratio = (cfg.width * cfg.height) as f64 / (src_w * src_h) as f64;
        if cfg.width > src_w || cfg.height > src_h {
            warnings.push(item(
                "warn",
                "放大转码不会提升画质",
                &format!("源片 {src_w}×{src_h} → 输出 {}×{}，像素数 {ratio:.2} 倍。放大只是把已有像素插值，细节不会变多，但体积和编码时间会明显增加。想省体积请选更小的分辨率或更低的码率。", cfg.width, cfg.height),
            ));
        } else if cfg.width < src_w || cfg.height < src_h {
            warnings.push(item(
                "info",
                "缩小分辨率",
                &format!("输出 {}×{}（像素数 {ratio:.2} 倍），细节会减少。若仍沿用原片码率，体积不会自动变小 —— 想真正省体积请同时调低目标码率。", cfg.width, cfg.height),
            ));
        }
    }

    if !cfg.fps.is_empty() {
        let target_fps = if cfg.fps.contains('/') {
            let parts: Vec<&str> = cfg.fps.split('/').collect();
            parts[0].parse::<f64>().unwrap_or(0.0) / parts[1].parse::<f64>().unwrap_or(1.0)
        } else {
            cfg.fps.parse::<f64>().unwrap_or(0.0)
        };
        if target_fps > 0.0 && src_fps > 0.0 && target_fps > src_fps + 0.5 {
            warnings.push(item(
                "warn",
                "提高帧率不会增加细节",
                &format!("源片 {src_fps:.3} fps → 输出 {target_fps} fps，多出的帧由复制/插值产生，画面信息不变，体积和编码时间会上升。"),
            ));
        }
    }

    if cfg.pix_fmt.contains("10") && !src_10bit {
        warnings.push(item(
            "warn",
            "提高位深补不回色阶",
            "源片是 8-bit，输出到 10-bit 只会让文件变大，无法恢复已经丢失的色彩层次。",
        ));
    }
    if cfg.pix_fmt.contains("10") {
        warnings.push(item(
            "info",
            "10-bit 输出的兼容性",
            "10-bit 色阶更细腻，但很多手机、老电视、浏览器无法硬解 H.264 10-bit，播放可能变卡或黑屏。只在本机归档建议保留，要广泛分发建议 8-bit。",
        ));
    }
    if cfg.video_codec == "libx265" {
        warnings.push(item(
            "info",
            "改用 H.265 编码",
            "同画质下体积通常比 H.264 小 30~50%，但编码更慢，部分老设备/浏览器不能硬解。原片的 H.264 profile / level 不适用于 H.265，会被自动忽略。",
        ));
    }
    if rc == "bitrate" && cfg.video_kbps > 0 && src_vkb > 0 {
        if cfg.video_kbps > src_vkb * 3 / 2 {
            warnings.push(item(
                "warn",
                "目标码率高于原片",
                &format!("原片视频 {src_vkb} kbps → 目标 {} kbps。重编码的画质上限就是原片，给更多码率只会把文件撑大，不会更清晰。", cfg.video_kbps),
            ));
        } else if cfg.video_kbps < src_vkb * 4 / 5 {
            warnings.push(item(
                "info",
                "已降低目标码率",
                &format!("原片视频 {src_vkb} kbps → 目标 {} kbps，体积会明显变小，快速运动/细节画面可能出现涂抹感，建议先剪一小段看效果。", cfg.video_kbps),
            ));
        }
    }
    if rc == "crf" {
        if cfg.maxrate_kbps > 0 {
            let buf = if cfg.bufsize_kbps > 0 {
                cfg.bufsize_kbps
            } else {
                (cfg.maxrate_kbps as f64 * 1.8) as i64
            };
            warnings.push(item(
                "info",
                "CRF + 峰值码率上限（capped CRF）",
                &format!("按 CRF {} 分配画质，同时用 -maxrate {}k / -bufsize {}k 封住峰值。复杂画面也不会把体积撑爆，这是「恒定质量 + 可控体积」的常用组合。", cfg.crf, cfg.maxrate_kbps, buf),
            ));
        } else {
            warnings.push(item(
                "info",
                "CRF 恒定质量模式",
                "CRF 按画面复杂度分配码率，与原片码率无关，体积无法精确预估。低码率片源可能被「越剪越大」，想控制体积请加峰值码率上限或用固定码率。",
            ));
        }
    }
    if cfg.audio_codec == "copy" {
        warnings.push(item(
            "info",
            "音轨直接拷贝",
            "音频不重新编码，音质不损失。但多个源片的音频参数不一致时，合并阶段可能失败，此时请改回 AAC 重编码。",
        ));
    }
    if cfg.subtitle_format == "vtt" {
        warnings.push(item(
            "info",
            "外挂字幕输出为 WebVTT",
            "WebVTT 适合网页播放器；若要在本地播放器里自动识别同名外挂字幕，SRT 兼容性更好。封装进视频时内部仍会用 SRT 转换，不影响时间轴。",
        ));
    }
    if cfg.sample_rate > 0 && src_rate > 0 && cfg.sample_rate > src_rate {
        warnings.push(item(
            "info",
            "音频重采样提高",
            &format!("源片 {src_rate} Hz → {} Hz，不会补回高频细节，只会略微增大体积。", cfg.sample_rate),
        ));
    }
    if cfg.channels > 0 && src_ch > 0 && cfg.channels > src_ch {
        warnings.push(item(
            "info",
            "声道数增加",
            &format!("源片 {src_ch} 声道 → {} 声道，不会变成真正的多声道音源。", cfg.channels),
        ));
    }
    if cfg.audio_codec == "none" {
        warnings.push(item("info", "已丢弃音频", "输出视频将不含音轨。"));
    }

    if *mode == ExportMode::Lossless && clip_count > 1 {
        warnings.push(item(
            "warn",
            "无损模式多段合并会有累积漂移",
            "流拷贝每段尾部约多 0.2 秒，concat 时逐段累积，字幕会一段比一段提前。多段合并且在意同步时请改用精确模式。",
        ));
    }
    if *mode == ExportMode::Lossless
        && [cfg.width, cfg.height]
            .iter()
            .any(|x| *x != 0)
        || cfg.scale_mode != ""
        || cfg.fps != ""
        || cfg.pix_fmt != ""
        || cfg.profile != ""
        || cfg.level != ""
        || cfg.video_kbps != 0
        || cfg.audio_kbps != 0
        || cfg.sample_rate != 0
        || cfg.channels != 0
        || cfg.video_codec != ""
        || cfg.maxrate_kbps != 0
    {
        warnings.push(item(
            "info",
            "无损模式下转码参数不生效",
            "无损是流拷贝（不重新编码），分辨率/码率/帧率/编码器等设置会被忽略；要改变这些参数请选精确模式。",
        ));
    }

    let audio_kbps = if cfg.audio_codec == "none" { 0 } else { cfg.audio_kbps.max(src_akb) };
    let (estimated, note, is_upper_bound) = if *mode == ExportMode::Lossless {
        (kbps_to_bytes(src_vkb + src_akb, total_ms), "流拷贝沿用原片码率，估算较准确。".to_string(), false)
    } else if rc == "bitrate" && cfg.video_kbps > 0 {
        (kbps_to_bytes(cfg.video_kbps + audio_kbps, total_ms), "按你设定的固定码率估算；实际值会随画面复杂度小幅浮动。".to_string(), false)
    } else if rc == "crf" && cfg.maxrate_kbps > 0 {
        (kbps_to_bytes(cfg.maxrate_kbps + audio_kbps, total_ms), format!("按峰值上限 {} kbps 估算的体积天花板（最坏情况）；静止/对话场景实际会明显更小。", cfg.maxrate_kbps), true)
    } else if rc == "crf" {
        (0, "CRF 按质量分配码率，无法预估体积。".to_string(), false)
    } else {
        (kbps_to_bytes(src_vkb + audio_kbps, total_ms), "沿用原片码率，估算较准确。".to_string(), false)
    };
    let estimated_opt = if *mode == ExportMode::Lossless || rc != "crf" || cfg.maxrate_kbps > 0 || rc == "bitrate" {
        Some(estimated)
    } else {
        None
    };
    let ratio = match (estimated_opt, src_equiv) {
        (Some(e), s) if s > 0 => Some(e as f64 / s as f64),
        _ => None,
    };

    EncodeEvaluation {
        warnings,
        estimated_bytes: estimated_opt,
        source_equivalent_bytes: src_equiv,
        ratio,
        estimate_note: note,
        is_upper_bound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioParams, EncodeParams, FormatParams, VideoParams};

    fn info() -> EncodeParams {
        EncodeParams {
            video: VideoParams {
                codec: Some("h264".into()),
                supported: true,
                profile: Some("high".into()),
                level: Some("4.0".into()),
                pix_fmt: Some("yuv420p".into()),
                fps: Some("30000/1001".into()),
                fps_float: 29.97,
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
            },
            format: FormatParams {
                duration_ms: 60_000,
                size_bytes: 0,
                bitrate_kbps: 8192,
            },
        }
    }

    #[test]
    fn upscaling_warns() {
        let cfg = EncodeCfg { height: 2160, scale_mode: "height".into(), ..Default::default() };
        let e = evaluate_encode(&info(), &cfg, 60_000, &ExportMode::Precise, 1, true, "custom");
        assert!(e.warnings.iter().any(|w| w.title == "放大转码不会提升画质"));
    }

    #[test]
    fn crf_with_ceiling_is_upper_bound() {
        let cfg = EncodeCfg {
            rate_control: "crf".into(),
            crf: 23,
            maxrate_kbps: 2000,
            ..Default::default()
        };
        let e = evaluate_encode(&info(), &cfg, 60_000, &ExportMode::Precise, 1, true, "custom");
        assert!(e.is_upper_bound);
        assert!(e.estimated_bytes.unwrap() > 0);
    }

    #[test]
    fn lossless_multi_clip_warns_drift() {
        let e = evaluate_encode(&info(), &EncodeCfg::default(), 60_000, &ExportMode::Lossless, 3, true, "custom");
        assert!(e.warnings.iter().any(|w| w.title.contains("累积漂移")));
    }
}
