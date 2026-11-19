//! Built-in parameter profiles. Pure data + pure functions, no ffmpeg / web.
//!
//! The project offers three main classes of presets:
//!
//! * `source`          lock every parameter to the source's own encoding
//! * `builtin_720p`    the standard balanced recipe (T2, CRF 25, 900k, 96k AAC)
//! * `builtin_720p_t1` the high-fidelity recipe for quality 1080p (T1, CRF 24, 1000k, 96k AAC)
//! * `builtin_720p_t2` alias of `builtin_720p`
//! * `builtin_720p_t3` the compact recipe for 720p/low-bitrate sources (T3, CRF 26, 800k, 96k AAC)
//! * `custom`          free-form overrides from the parameter panel

use serde::{Deserialize, Serialize};

use crate::model::EncodeCfg;

pub const PROFILE_SOURCE: &str = "source";
pub const PROFILE_720P: &str = "builtin_720p";
pub const PROFILE_720P_T1: &str = "builtin_720p_t1";
pub const PROFILE_720P_T2: &str = "builtin_720p_t2";
pub const PROFILE_720P_T3: &str = "builtin_720p_t3";
pub const PROFILE_CUSTOM: &str = "custom";
pub const PROFILE_IDS: &[&str] = &[
    PROFILE_SOURCE,
    PROFILE_720P,
    PROFILE_720P_T1,
    PROFILE_720P_T2,
    PROFILE_720P_T3,
    PROFILE_CUSTOM,
];

pub const BUILTIN_720P_SPEED: &str = "slow";

/// 档位 1: 优质源片/高清档 (720p High)
/// 适合 1080p 高码率/高质量片源，超采样保留极高锐度。
/// `crf=24`, `maxrate=1000k`, `bufsize=1800k`, `audio=96k aac`
pub fn builtin_720p_t1() -> EncodeCfg {
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
        crf: 24,
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

/// 档位 2: 标准均衡/默认主力档 (720p Balanced)
/// 适合绝大多数正常画质片源，画质与体积高度均衡。
/// `crf=25`, `maxrate=900k`, `bufsize=1600k`, `audio=96k aac`
pub fn builtin_720p_t2() -> EncodeCfg {
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
        maxrate_kbps: 900,
        bufsize_kbps: 1600,
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

/// 档位 3: 紧凑省流/低质防胀档 (720p Compact)
/// 适合原生 720p 或 YouTube 贫码率源片，杜绝二次转码虚胖。
/// `crf=26`, `maxrate=800k`, `bufsize=1400k`, `audio=96k aac`
pub fn builtin_720p_t3() -> EncodeCfg {
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
        crf: 26,
        video_kbps: 0,
        maxrate_kbps: 800,
        bufsize_kbps: 1400,
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

/// 默认 720p 预设指向主力均衡档（T2：CRF 25 / 900k / 96k AAC）
pub fn builtin_720p() -> EncodeCfg {
    builtin_720p_t2()
}

/// 根据源片客观分辨率、视频码率及编码类型智能选择匹配的 720p 预设。
///
/// 核心铁律：
/// 1. 每分钟质量与体积恒定，杜绝按时长长短降低画质；
/// 2. 源片 1080p 优质高码率时选 T1 (CRF 24 / 1000k)，发挥超采样锐度；
/// 3. 源片原生 720p 且低码率时选 T3 (CRF 26 / 800k)，杜绝重编码虚胖膨胀；
/// 4. 其余普通/正常片源采用主力均衡档 T2 (CRF 25 / 900k)。
pub fn adaptive_720p_preset(
    source_height: i64,
    source_video_kbps: i64,
    is_efficient_codec: bool,
) -> &'static str {
    let effective_kbps = if is_efficient_codec {
        (source_video_kbps as f64 * 1.5).round() as i64
    } else {
        source_video_kbps
    };

    if source_height >= 1080 {
        if effective_kbps >= 1500 || source_video_kbps == 0 {
            PROFILE_720P_T1
        } else {
            PROFILE_720P_T2
        }
    } else {
        if effective_kbps < 850 && source_video_kbps > 0 {
            PROFILE_720P_T3
        } else {
            PROFILE_720P_T2
        }
    }
}

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
        PROFILE_720P_T1 => ResolvedProfile {
            encode: builtin_720p_t1(),
            speed: BUILTIN_720P_SPEED.to_string(),
            embed_subtitles: false,
            locked: true,
            inherit_source_profile: false,
        },
        PROFILE_720P | PROFILE_720P_T2 => ResolvedProfile {
            encode: builtin_720p_t2(),
            speed: BUILTIN_720P_SPEED.to_string(),
            embed_subtitles: false,
            locked: true,
            inherit_source_profile: false,
        },
        PROFILE_720P_T3 => ResolvedProfile {
            encode: builtin_720p_t3(),
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
-c:v libx264 -preset slow -crf 25 -maxrate 900k -bufsize 1600k -pix_fmt yuv420p \
-c:a aac -b:a 96k -ac 2 -sn -movflags +faststart output.mp4";

const P720_T1_COMMAND: &str = "ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf \"scale=-2:720\" \
-c:v libx264 -preset slow -crf 24 -maxrate 1000k -bufsize 1800k -pix_fmt yuv420p \
-c:a aac -b:a 96k -ac 2 -sn -movflags +faststart output.mp4";

const P720_T3_COMMAND: &str = "ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf \"scale=-2:720\" \
-c:v libx264 -preset slow -crf 26 -maxrate 800k -bufsize 1400k -pix_fmt yuv420p \
-c:a aac -b:a 96k -ac 2 -sn -movflags +faststart output.mp4";

/// JSON-safe copy for `GET /api/profiles`.
pub fn profile_catalog() -> Vec<ProfileCatalogEntry> {
    vec![
        ProfileCatalogEntry {
            id: PROFILE_SOURCE.to_string(),
            label: "沿用原片".to_string(),
            tagline: "什么都不改".to_string(),
            detail: "把原片的位深、profile、level、色彩标签、GOP、B 帧、音频采样率与声道全部回填，\
                     并沿用原片码率，同时以原片码率作为峰值上限，保证输出不会「越剪越大」。\
                     体积约等于保留时长占比，画质格式与原片一致。此方案下所有参数锁定。"
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
            label: "720p 标准均衡 (推荐)".to_string(),
            tagline: "主力档：CRF 25 / 峰值 900k / 音频 96k".to_string(),
            detail: "最均衡主力档。相比原 24 档体积立减约 15%，画质极佳，适合绝大多数正常片源。\
                     宽度按原比例自动计算且取偶数，峰值上限自动受控于源片，杜绝虚胖。"
                .to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度缩到 720，宽度按原比例自动且取偶数".into(), why: "体积的最大杠杆；放大不会变清晰，缩小才会真的省空间".into() },
                Bullet { name: "画质".into(), value: "CRF 25（标准均衡主力档）".into(), why: "数值越大越小；25 在保证画面纯净度的同时比 24 节省约 15% 空间".into() },
                Bullet { name: "码率天花板".into(), value: "峰值 900 kbps / 缓冲 1600 kbps".into(), why: "给 CRF 加 VBV 上限，严格避免动态场景码率冲高膨胀".into() },
                Bullet { name: "编码".into(), value: "H.264 / slow / 8-bit yuv420p".into(), why: "slow 在同画质下更省体积；8-bit 保证几乎所有播放器都能放".into() },
                Bullet { name: "音频".into(), value: "AAC 96 kbps 立体声".into(), why: "纯净语音恒定 96k，不浪费多余体积".into() },
                Bullet { name: "封装".into(), value: "MP4 + faststart，不把字幕封装进视频".into(), why: "边下边播；外挂 SRT 仍会按剪辑后的时间轴生成".into() },
            ],
            command: Some(P720_COMMAND.to_string()),
            encode: Some(builtin_720p_t2()),
            speed: Some(BUILTIN_720P_SPEED.to_string()),
            embed_subtitles: Some(false),
            locked: true,
        },
        ProfileCatalogEntry {
            id: PROFILE_720P_T1.to_string(),
            label: "720p 优质高清".to_string(),
            tagline: "高清档：CRF 24 / 峰值 1000k / 音频 96k".to_string(),
            detail: "适合 1080p 高清优质源片。超采样缩放下文字与人脸细节极度锐利。".to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度 720p".into(), why: "超采样保真".into() },
                Bullet { name: "画质".into(), value: "CRF 24（黄金保真档）".into(), why: "更高锐度".into() },
                Bullet { name: "码率天花板".into(), value: "峰值 1000 kbps / 缓冲 1800 kbps".into(), why: "容纳更多纹理信息".into() },
                Bullet { name: "音频".into(), value: "AAC 96 kbps 立体声".into(), why: "高品质语音".into() },
            ],
            command: Some(P720_T1_COMMAND.to_string()),
            encode: Some(builtin_720p_t1()),
            speed: Some(BUILTIN_720P_SPEED.to_string()),
            embed_subtitles: Some(false),
            locked: true,
        },
        ProfileCatalogEntry {
            id: PROFILE_720P_T3.to_string(),
            label: "720p 紧凑防胀".to_string(),
            tagline: "防胀档：CRF 26 / 峰值 800k / 音频 96k".to_string(),
            detail: "适合原生 720p 或 YouTube 贫码率源片。杜绝低质源片重编码虚胖，极致节省空间。".to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度 720p".into(), why: "紧凑尺寸".into() },
                Bullet { name: "画质".into(), value: "CRF 26（紧凑防胀档）".into(), why: "杜绝低质片虚胖".into() },
                Bullet { name: "码率天花板".into(), value: "峰值 800 kbps / 缓冲 1400 kbps".into(), why: "严格控顶".into() },
                Bullet { name: "音频".into(), value: "AAC 96 kbps 立体声".into(), why: "纯净语音恒定 96k".into() },
            ],
            command: Some(P720_T3_COMMAND.to_string()),
            encode: Some(builtin_720p_t3()),
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
        assert_eq!(p.encode.maxrate_kbps, 900);
        assert_eq!(p.encode.bufsize_kbps, 1600);
        assert_eq!(p.encode.audio_kbps, 96);
        assert_eq!(p.speed, "slow");
        assert!(!p.embed_subtitles);
        assert!(!p.inherit_source_profile);
    }

    #[test]
    fn p720_t1_and_t3_recipes() {
        let t1 = resolve_profile(PROFILE_720P_T1, &EncodeCfg::default(), "medium", false);
        assert_eq!(t1.encode.crf, 24);
        assert_eq!(t1.encode.maxrate_kbps, 1000);
        assert_eq!(t1.encode.bufsize_kbps, 1800);
        assert_eq!(t1.encode.audio_kbps, 96);

        let t3 = resolve_profile(PROFILE_720P_T3, &EncodeCfg::default(), "medium", false);
        assert_eq!(t3.encode.crf, 26);
        assert_eq!(t3.encode.maxrate_kbps, 800);
        assert_eq!(t3.encode.bufsize_kbps, 1400);
        assert_eq!(t3.encode.audio_kbps, 96);
    }

    #[test]
    fn adaptive_preset_selection() {
        // 1080p high bitrate -> T1
        assert_eq!(adaptive_720p_preset(1080, 1200, true), PROFILE_720P_T1); // 1200 * 1.5 = 1800 >= 1500
        // 1080p low/medium bitrate -> T2
        assert_eq!(adaptive_720p_preset(1080, 800, false), PROFILE_720P_T2);
        // 1080p missing bitrate -> T1
        assert_eq!(adaptive_720p_preset(1080, 0, false), PROFILE_720P_T1);
        // 720p starved -> T3
        assert_eq!(adaptive_720p_preset(720, 500, false), PROFILE_720P_T3);
        // 720p normal -> T2
        assert_eq!(adaptive_720p_preset(720, 1200, false), PROFILE_720P_T2);
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
