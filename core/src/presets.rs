//! Built-in parameter profiles. Pure data + pure functions, no ffmpeg / web.
//!
//! The project offers three ways to use the transcode settings:
//!
//! * `source`       lock every parameter to the source's own encoding
//! * `builtin_720p` the user's "720p eco" recipe (ignores `encode`)
//! * `custom`       free-form overrides from the parameter panel
//!
//! The built-in recipe is defined HERE rather than in the browser so an export
//! started from the API (or a future Tauri shell) behaves identically to one
//! started from the UI. The browser only sends `profile_mode`.

use serde::{Deserialize, Serialize};

use crate::model::EncodeCfg;

pub const PROFILE_SOURCE: &str = "source";
pub const PROFILE_720P: &str = "builtin_720p";
pub const PROFILE_CUSTOM: &str = "custom";
pub const PROFILE_IDS: &[&str] = &[PROFILE_SOURCE, PROFILE_720P, PROFILE_CUSTOM];

/// Verbatim translation of the user's command:
/// `ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf "scale=-2:720" -c:v libx264
/// -preset slow -crf 25 -maxrate 1000k -bufsize 1800k -pix_fmt yuv420p -c:a aac
/// -b:a 96k -ac 2 -sn -movflags +faststart out.mp4`
pub fn builtin_720p() -> EncodeCfg {
    EncodeCfg {
    video_codec: "libx264".to_string(),
    width: 0,
    height: 720,
    scale_mode: "height".to_string(),
    fps: String::new(),
    pix_fmt: "yuv420p".to_string(),
    profile: String::new(),
    level: String::new(),
    rate_control: "crf".to_string(),
    crf: 25,
    video_kbps: 0,
    maxrate_kbps: 1000,
    bufsize_kbps: 1800,
    gop: 0,
    bframes: -1,
    audio_codec: "aac".to_string(),
    audio_kbps: 96,
    sample_rate: 0,
    channels: 2,
    audio_profile: String::new(),
    subtitle_format: "srt".to_string(),
    container: "mp4".to_string(),
    faststart: true,
    }
}
pub const BUILTIN_720P_SPEED: &str = "slow";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Bullet {
    pub name: String,
    pub value: String,
    pub why: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProfileCatalogEntry {
    pub id: String,
    pub label: String,
    pub tagline: String,
    pub detail: String,
    pub bullets: Vec<Bullet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encode: Option<EncodeCfg>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_subtitles: Option<bool>,
    pub locked: bool,
}

/// The effective settings for one export. Never mutated afterwards.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ResolvedProfile {
    pub encode: EncodeCfg,
    pub speed: String,
    pub embed_subtitles: bool,
    pub locked: bool,
    /// A fixed recipe (like the 720p one) must NOT inherit the source's H.264
    /// profile/level; "source"/"custom" keep the faithful read-back.
    pub inherit_source_profile: bool,
}

/// Single entry point for UI previews, API checks and the ffmpeg command.
pub fn resolve_profile(
    profile_mode: &str,
    encode: &EncodeCfg,
    fallback_speed: &str,
    embed_subtitles: bool,
) -> ResolvedProfile {
    match profile_mode {
        PROFILE_SOURCE => ResolvedProfile {
            encode: EncodeCfg::default(),
            speed: fallback_speed.to_string(),
            embed_subtitles,
            locked: true,
            inherit_source_profile: true,
        },
        PROFILE_720P => ResolvedProfile {
            encode: builtin_720p(),
            speed: BUILTIN_720P_SPEED.to_string(),
            embed_subtitles: false,
            locked: true,
            inherit_source_profile: false,
        },
        _ => ResolvedProfile {
            encode: encode.clone(),
            speed: fallback_speed.to_string(),
            embed_subtitles,
            locked: false,
            inherit_source_profile: true,
        },
    }
}

const P720_COMMAND: &str = "ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf \"scale=-2:720\" \
-c:v libx264 -preset slow -crf 25 -maxrate 1000k -bufsize 1800k -pix_fmt yuv420p \
-c:a aac -b:a 96k -ac 2 -sn -movflags +faststart output.mp4";

/// JSON-safe copy for `GET /api/profiles`.
pub fn profile_catalog() -> Vec<ProfileCatalogEntry> {
    vec![
        ProfileCatalogEntry {
            id: PROFILE_SOURCE.to_string(),
            label: "沿用原片".to_string(),
            tagline: "什么都不改".to_string(),
            detail: "把原片的位深、profile、level、色彩标签、GOP、B 帧、音频采样率与声道全部回填，\
                     并沿用原片码率。体积约等于保留时长占比，画质格式与原片一致。此方案下所有参数锁定。"
                .to_string(),
            bullets: vec![],
            command: None,
            encode: None,
            speed: None,
            embed_subtitles: None,
            locked: true,
        },
        ProfileCatalogEntry {
            id: PROFILE_720P.to_string(),
            label: "720p 省体积".to_string(),
            tagline: "丢 1080p 进来就压成 720p".to_string(),
            detail: "你给的那套命令。真正决定体积与画质的只有分辨率、CRF 和峰值码率上限这三项；\
                     其余是兼容性与封装设置。宽度按原比例自动计算，16:9 / 4:3 / 超宽 / 竖屏都能用。"
                .to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度缩到 720，宽度按原比例自动且取偶数".into(), why: "体积的最大杠杆；放大不会变清晰，缩小才会真的省空间".into() },
                Bullet { name: "画质".into(), value: "CRF 25（恒定质量）".into(), why: "数值越大体积越小、细节越糊；25 是明显省体积但还能看的档位".into() },
                Bullet { name: "码率天花板".into(), value: "峰值 1000 kbps / 缓冲 1800 kbps".into(), why: "给 CRF 加 VBV 上限，打斗、雪花等复杂画面也不会把体积撑爆".into() },
                Bullet { name: "编码".into(), value: "H.264 / slow / 8-bit yuv420p".into(), why: "slow 在同画质下更省体积；8-bit 保证几乎所有播放器都能放".into() },
                Bullet { name: "音频".into(), value: "AAC 96 kbps 立体声".into(), why: "音频占比本来就小，96k 对语音足够，音乐可到 128k".into() },
                Bullet { name: "封装".into(), value: "MP4 + faststart，不把字幕封装进视频".into(), why: "边下边播；外挂 SRT 仍会按剪辑后的时间轴生成".into() },
            ],
            command: Some(P720_COMMAND.to_string()),
            encode: Some(builtin_720p()),
            speed: Some(BUILTIN_720P_SPEED.to_string()),
            embed_subtitles: Some(false),
            locked: true,
        },
        ProfileCatalogEntry {
            id: PROFILE_CUSTOM.to_string(),
            label: "自定义".to_string(),
            tagline: "全部参数自己调".to_string(),
            detail: "常用参数直接可选，看不懂的高级参数默认折叠。支持保存成自己的预设反复使用。".to_string(),
            bullets: vec![],
            command: None,
            encode: None,
            speed: None,
            embed_subtitles: None,
            locked: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_locks_everything() {
        let p = resolve_profile(PROFILE_SOURCE, &builtin_720p(), "medium", false);
        assert!(p.locked);
        assert_eq!(p.encode.height, 0);
        assert!(p.inherit_source_profile);
    }

    #[test]
    fn p720_is_fixed_recipe() {
        let mut custom = EncodeCfg::default();
        custom.crf = 30;
        let p = resolve_profile(PROFILE_720P, &custom, "medium", true);
        assert_eq!(p.encode.crf, 25);
        assert_eq!(p.speed, "slow");
        assert!(!p.embed_subtitles);
        assert!(!p.inherit_source_profile);
    }

    #[test]
    fn custom_uses_overrides() {
        let mut custom = EncodeCfg::default();
        custom.crf = 20;
        let p = resolve_profile(PROFILE_CUSTOM, &custom, "medium", false);
        assert_eq!(p.encode.crf, 20);
        assert!(!p.locked);
    }
}
