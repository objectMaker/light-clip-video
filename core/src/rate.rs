//! Rate-control decisions: the ONE source of truth for both the settings
//! panel's size estimate and the actual ffmpeg command.
//!
//! Historically the panel read bitrates through `parse_encode_params` (which
//! understands ffprobe's STRING numbers) while export used a separate parser
//! that only accepted JSON numbers. The export parser therefore always got 0
//! and silently fell back to CRF 18 — a 4x size explosion on low-bitrate
//! sources. Everything now flows through `plan_rate()`.

use crate::checks::resolve_rate_control;
use crate::model::{EncodeCfg, ExportMode};
use crate::probe::{source_bitrates, EncodeParams};

/// Codecs that are meaningfully MORE efficient than H.264. Re-encoding one of
/// these at the source bitrate into H.264 necessarily loses quality.
const EFFICIENT: &[&str] = &["hevc", "h265", "vp9", "av1", "av01"];
/// Codecs less efficient than H.264: re-encoding at source bitrate is safe.
const LEGACY: &[&str] = &["mpeg4", "msmpeg4v3", "vp8", "wmv3", "mpeg2video", "h263", "theora"];
/// Near-lossless / editing intermediates: their bitrate is NOT a sensible
/// target for an H.264 deliverable.
const MEZZANINE: &[&str] = &["prores", "dnxhd", "dnxhr", "ffv1", "rawvideo", "huffyuv", "qtrle"];
/// Only truly enormous rates are treated as intermediates. A perfectly normal
/// 20 Mbps H.264 1080p source must NOT be re-encoded at 8 Mbps just because it
/// is "high bitrate" — that would throw away quality for no reason.
const MEZZANINE_BITRATE_KBPS: i64 = 50_000;
const MEZZANINE_CAP_KBPS: i64 = 25_000;
const MIN_CEILING_KBPS: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecClass {
    Legacy,
    H264Like,
    Efficient,
    Mezzanine,
}

pub fn codec_class(info: &EncodeParams) -> CodecClass {
    let c = info.video.codec.as_deref().unwrap_or("").to_lowercase();
    if MEZZANINE.iter().any(|x| c.contains(x)) || info.video.video_kbps > MEZZANINE_BITRATE_KBPS {
        return CodecClass::Mezzanine;
    }
    if EFFICIENT.iter().any(|x| c.contains(x)) {
        return CodecClass::Efficient;
    }
    if LEGACY.iter().any(|x| c.contains(x)) {
        return CodecClass::Legacy;
    }
    CodecClass::H264Like
}

/// When ffprobe gives us no bitrate at all, pick a conservative ceiling from
/// the frame geometry instead of a flat 1000k (which would wreck a 4K source).
fn fallback_ceiling_kbps(info: &EncodeParams) -> i64 {
    let px = (info.video.width.max(0) * info.video.height.max(0)) as f64;
    if px <= 0.0 {
        return 1000;
    }
    let fps = info.video.fps_float.clamp(24.0, 60.0);
    let kbps = 1000.0 * px / (1280.0 * 720.0) * (fps / 30.0);
    (kbps.round() as i64).clamp(300, 12_000)
}

/// One note = (level, title, text). `level` is "warn" or "info".
pub type RateNote = (String, String, String);

#[derive(Debug, Clone)]
pub struct RatePlan {
    pub rc: String,
    /// CRF to use when `video_bps` is None.
    pub crf: i64,
    /// `-b:v` value in bits/s, None means CRF mode.
    pub video_bps: Option<i64>,
    /// `-maxrate` in kbit/s, None means no ceiling.
    pub maxrate_kbps: Option<i64>,
    /// `-bufsize` in kbit/s.
    pub bufsize_kbps: Option<i64>,
    /// `-b:a` value in bits/s, None means the caller's 128k fallback.
    pub audio_bps: Option<i64>,
    /// Effective ceiling used by the size estimator.
    pub ceiling_kbps: Option<i64>,
    pub notes: Vec<RateNote>,
}

/// Decide the rate-control flags for one source.
///
/// `locked` profiles (source / builtin_720p) get an automatic ceiling of
/// `min(configured ceiling, source video bitrate)` so the output can never be
/// larger than the source. `custom` keeps the user's explicit values and only
/// warns when they exceed the source bitrate.
#[allow(clippy::too_many_arguments)]
pub fn plan_rate(
    info: &EncodeParams,
    cfg: &EncodeCfg,
    match_source_bitrate: bool,
    profile_mode: &str,
    mode: &ExportMode,
    output_crf: i64,
) -> RatePlan {
    let (vbps, abps) = source_bitrates(info);
    let v_kbps = (vbps / 1000).max(0);
    let a_kbps = (abps / 1000).max(0);
    let class = codec_class(info);
    let rc = resolve_rate_control(cfg, match_source_bitrate);
    let locked = profile_mode != crate::presets::PROFILE_CUSTOM;
    let mut notes: Vec<RateNote> = Vec::new();

    let desired = if cfg.maxrate_kbps > 0 {
        cfg.maxrate_kbps
    } else if cfg.video_kbps > 0 {
        cfg.video_kbps
    } else {
        v_kbps
    };

    let mut ceiling_clamped = false;
    let ceiling = if v_kbps > 0 {
        if locked {
            let c = desired.min(v_kbps).max(MIN_CEILING_KBPS);
            if c < desired {
                ceiling_clamped = true;
                notes.push((
                    "info".into(),
                    "峰值上限已按源片下调".into(),
                    format!(
                        "为避免「越剪越大」，峰值码率上限从 {} kbps 下调到 {} kbps（源片视频码率）。",
                        desired, c
                    ),
                ));
            }
            Some(c)
        } else if desired > v_kbps {
            notes.push((
                "warn".into(),
                "目标码率高于源片".into(),
                format!(
                    "设定的 {} kbps 高于源片视频码率 {} kbps，输出可能比源片大。",
                    desired, v_kbps
                ),
            ));
            Some(desired)
        } else if cfg.maxrate_kbps > 0 || cfg.video_kbps > 0 {
            Some(desired)
        } else {
            // Custom CRF without any ceiling: respect the user's free choice.
            None
        }
    } else {
        None
    };

    if class == CodecClass::Efficient && *mode == ExportMode::Precise {
        notes.push((
            "warn".into(),
            "源片为高效编码，重编码会掉画质".into(),
            format!(
                "源片是 {}，压缩效率高于 H.264。按源片码率重编码为 H.264 能控制体积，但画质必然下降（H.264 需要更多码率才能追平同等画质）。若不需要剪辑，建议用「无损模式」流拷贝，画质与体积都不变；若既要剪辑又要更接近原片画质，只能在自定义方案里调高目标码率，体积会随之变大。只交付 H.264 时，这是无法绕开的取舍。",
                info.video.codec.as_deref().unwrap_or("高效编码")
            ),
        ));
    }

    let mut crf = if cfg.crf > 0 { cfg.crf } else { output_crf };
    let mut video_bps: Option<i64> = None;
    let mut no_bitrate = false;

    if vbps <= 0 {
        // NEVER silently fall back to high-quality CRF 18: that is exactly what
        // produced the 4x size explosion. Use a conservative CRF + a ceiling.
        crf = 23;
        no_bitrate = true;
        notes.push((
            "warn".into(),
            "未读到源片码率".into(),
            "无法从 ffprobe 读取源片码率，已改用保守的 CRF 23 并加峰值上限，避免静默启用高质量重编码导致体积暴涨。".into(),
        ));
    } else if rc == "crf" {
        // Quality-driven mode: no -b:v, ceiling (if any) is applied below.
    } else if rc == "bitrate" && cfg.video_kbps > 0 {
        video_bps = Some(cfg.video_kbps * 1000);
    } else {
        let mut v = vbps;
        if class == CodecClass::Mezzanine && v > MEZZANINE_CAP_KBPS * 1000 {
            v = MEZZANINE_CAP_KBPS * 1000;
            notes.push((
                "info".into(),
                "源片为高码率中间格式".into(),
                format!(
                    "源片视频码率 {} kbps 极高，沿用会白占空间；已把目标码率限制在 {} kbps。",
                    v_kbps, MEZZANINE_CAP_KBPS
                ),
            ));
        }
        video_bps = Some(v);
    }

    let maxrate = if no_bitrate {
        Some(ceiling.unwrap_or_else(|| fallback_ceiling_kbps(info)).max(MIN_CEILING_KBPS))
    } else {
        ceiling
    };
    let bufsize = maxrate.map(|c| {
        if cfg.bufsize_kbps <= 0 {
            return (c as f64 * 1.8) as i64;
        }
        // When the ceiling was clamped down, scale the recipe's buffer with
        // it. Keeping a 1800k buffer for a 677k ceiling would let long bursts
        // defeat the whole point of the cap.
        if ceiling_clamped && cfg.maxrate_kbps > 0 {
            let ratio = cfg.bufsize_kbps as f64 / cfg.maxrate_kbps as f64;
            ((c as f64 * ratio).round() as i64).max(c)
        } else {
            cfg.bufsize_kbps
        }
    });

    let audio_bps = if cfg.audio_kbps > 0 {
        let k = if locked && a_kbps > 0 {
            cfg.audio_kbps.min(a_kbps)
        } else {
            cfg.audio_kbps
        };
        Some(k * 1000)
    } else if abps > 0 {
        Some(abps)
    } else {
        None
    };

    RatePlan {
        rc,
        crf,
        video_bps,
        maxrate_kbps: maxrate,
        bufsize_kbps: bufsize,
        audio_bps,
        ceiling_kbps: ceiling,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioParams, FormatParams, VideoParams};

    fn info(codec: &str, vkb: i64, akb: i64) -> EncodeParams {
        EncodeParams {
            video: VideoParams { codec: Some(codec.into()), video_kbps: vkb, ..Default::default() },
            audio: AudioParams { audio_kbps: akb, ..Default::default() },
            format: FormatParams { bitrate_kbps: vkb + akb, ..Default::default() },
        }
    }

    #[test]
    fn classifies_codecs() {
        assert_eq!(codec_class(&info("h264", 3000, 128)), CodecClass::H264Like);
        assert_eq!(codec_class(&info("av1", 677, 128)), CodecClass::Efficient);
        assert_eq!(codec_class(&info("vp9", 900, 128)), CodecClass::Efficient);
        assert_eq!(codec_class(&info("mpeg4", 2000, 128)), CodecClass::Legacy);
        assert_eq!(codec_class(&info("prores", 90000, 128)), CodecClass::Mezzanine);
        assert_eq!(codec_class(&info("h264", 20000, 128)), CodecClass::H264Like);
        assert_eq!(codec_class(&info("h264", 80000, 128)), CodecClass::Mezzanine);
    }

    #[test]
    fn source_profile_uses_source_bitrate_with_ceiling() {
        let cfg = EncodeCfg::default();
        let p = plan_rate(&info("av1", 677, 128), &cfg, true, "source", &ExportMode::Precise, 18);
        assert_eq!(p.video_bps, Some(677000));
        assert_eq!(p.maxrate_kbps, Some(677));
        assert_eq!(p.audio_bps, Some(128000));
        assert!(p.notes.iter().any(|(l, t, _)| l == "warn" && t.contains("高效编码")));
    }

    #[test]
    fn builtin_720p_ceiling_never_exceeds_source() {
        let cfg = crate::presets::builtin_720p();
        let p = plan_rate(&info("av1", 677, 128), &cfg, true, "builtin_720p", &ExportMode::Precise, 18);
        assert_eq!(p.video_bps, None); // CRF mode
        assert_eq!(p.crf, 25);
        assert_eq!(p.maxrate_kbps, Some(677)); // clamped down from 1000
        assert_eq!(p.bufsize_kbps, Some(1219)); // 1800/1000 * 677, not 1800
        assert_eq!(p.audio_bps, Some(96000)); // min(96, 128)
        assert!(p.notes.iter().any(|(_, t, _)| t.contains("下调")));
    }

    #[test]
    fn high_bitrate_source_keeps_recipe_ceiling() {
        let cfg = crate::presets::builtin_720p();
        let p = plan_rate(&info("h264", 8000, 192), &cfg, true, "builtin_720p", &ExportMode::Precise, 18);
        assert_eq!(p.maxrate_kbps, Some(1000));
        assert_eq!(p.ceiling_kbps, Some(1000));
    }

    #[test]
    fn custom_without_ceiling_respects_user() {
        let cfg = EncodeCfg { rate_control: "crf".into(), crf: 20, ..Default::default() };
        let p = plan_rate(&info("h264", 3000, 128), &cfg, false, "custom", &ExportMode::Precise, 18);
        assert_eq!(p.video_bps, None);
        assert_eq!(p.crf, 20);
        assert_eq!(p.maxrate_kbps, None);
    }

    #[test]
    fn missing_bitrate_never_falls_back_to_crf18() {
        let cfg = EncodeCfg::default();
        let p = plan_rate(&info("h264", 0, 0), &cfg, true, "source", &ExportMode::Precise, 18);
        assert_eq!(p.crf, 23);
        assert!(p.maxrate_kbps.is_some());
        assert!(p.notes.iter().any(|(l, t, _)| l == "warn" && t.contains("未读到")));
    }

    #[test]
    fn mezzanine_bitrate_is_capped() {
        let cfg = EncodeCfg::default();
        let p = plan_rate(&info("prores", 90000, 128), &cfg, true, "source", &ExportMode::Precise, 18);
        assert_eq!(p.video_bps, Some(25_000_000));
    }

    #[test]
    fn string_bitrate_source_never_uses_crf18() {
        // Mirrors the reported AV1 VLOG: 677 kbps video / 128 kbps audio.
        let i = EncodeParams {
            video: VideoParams {
                codec: Some("av1".into()),
                video_bps: 677_123,
                video_kbps: 677,
                width: 1280,
                height: 720,
                ..Default::default()
            },
            audio: AudioParams { codec: Some("opus".into()), audio_bps: 128_456, audio_kbps: 128, ..Default::default() },
            format: FormatParams { bitrate_bps: 805_579, bitrate_kbps: 805, ..Default::default() },
        };
        let p = plan_rate(&i, &EncodeCfg::default(), true, "source", &ExportMode::Precise, 18);
        assert_eq!(p.video_bps, Some(677_123));
        assert_eq!(p.audio_bps, Some(128_456));
        assert_eq!(p.maxrate_kbps, Some(677));
        assert!(!p.notes.iter().any(|(_, t, _)| t.contains("未读到")));
    }

    #[test]
    fn missing_bitrate_ceiling_scales_with_resolution() {
        let mut i = info("h264", 0, 0);
        i.video.width = 3840;
        i.video.height = 2160;
        i.video.fps_float = 30.0;
        let p = plan_rate(&i, &EncodeCfg::default(), true, "source", &ExportMode::Precise, 18);
        assert_eq!(p.crf, 23);
        assert!(p.maxrate_kbps.unwrap() > 1000, "4K must not be capped at a flat 1000k");
    }
}
