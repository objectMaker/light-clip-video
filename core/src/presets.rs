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

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

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

fn default_slow() -> String {
    "slow".to_string()
}

/// 720p 档位具体参数配置（支持用户在界面自由编辑并持久化保留）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TierConfig {
    pub name: String,
    pub tagline: String,
    pub crf: i64,
    pub maxrate_kbps: i64,
    pub bufsize_kbps: i64,
    pub audio_kbps: i64,
    #[serde(default = "default_slow")]
    pub speed: String,
}

impl TierConfig {
    pub fn to_encode_cfg(&self) -> EncodeCfg {
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
            crf: self.crf,
            video_kbps: 0,
            maxrate_kbps: self.maxrate_kbps,
            bufsize_kbps: self.bufsize_kbps,
            gop: 0,
            bframes: -1,
            audio_codec: "aac".to_string(),
            audio_kbps: self.audio_kbps,
            sample_rate: 0,
            channels: 2,
            audio_profile: String::new(),
            subtitle_format: "srt".to_string(),
            container: "mp4".to_string(),
            faststart: true,
        }
    }
}

/// 720p 三档预设持久化集合
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TierSettings {
    pub builtin_720p_t1: TierConfig,
    pub builtin_720p_t2: TierConfig,
    pub builtin_720p_t3: TierConfig,
}

impl Default for TierSettings {
    fn default() -> Self {
        Self {
            builtin_720p_t1: TierConfig {
                name: "一档 · 防马赛克".to_string(),
                tagline: "防马赛克：CRF 28 / 峰值 1100k / 音频 96k".to_string(),
                crf: 28,
                maxrate_kbps: 1100,
                bufsize_kbps: 2200,
                audio_kbps: 96,
                speed: "slow".to_string(),
            },
            builtin_720p_t2: TierConfig {
                name: "二档 · 标准主力".to_string(),
                tagline: "标准主力：CRF 28 / 峰值 950k / 音频 96k".to_string(),
                crf: 28,
                maxrate_kbps: 950,
                bufsize_kbps: 1800,
                audio_kbps: 96,
                speed: "slow".to_string(),
            },
            builtin_720p_t3: TierConfig {
                name: "三档 · 极致紧凑".to_string(),
                tagline: "极致紧凑：CRF 29 / 峰值 900k / 音频 96k".to_string(),
                crf: 29,
                maxrate_kbps: 900,
                bufsize_kbps: 1700,
                audio_kbps: 96,
                speed: "slow".to_string(),
            },
        }
    }
}

pub fn default_tier_presets_path() -> PathBuf {
    let base = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join(".clip-video").join("tier_presets.json")
}

impl TierSettings {
    pub fn load_from_path(p: &Path) -> Self {
        if let Ok(content) = std::fs::read_to_string(p) {
            if let Ok(settings) = serde_json::from_str::<TierSettings>(&content) {
                return settings;
            }
        }
        let def = Self::default();
        let _ = def.save_to_path(p);
        def
    }

    pub fn save_to_path(&self, p: &Path) -> std::io::Result<()> {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(p, json)
    }

    pub fn get_cfg(&self, tier_id: &str) -> EncodeCfg {
        match tier_id {
            PROFILE_720P_T1 => self.builtin_720p_t1.to_encode_cfg(),
            PROFILE_720P_T3 => self.builtin_720p_t3.to_encode_cfg(),
            _ => self.builtin_720p_t2.to_encode_cfg(),
        }
    }

    pub fn get_speed(&self, tier_id: &str) -> &str {
        match tier_id {
            PROFILE_720P_T1 => &self.builtin_720p_t1.speed,
            PROFILE_720P_T3 => &self.builtin_720p_t3.speed,
            _ => &self.builtin_720p_t2.speed,
        }
    }
}

static GLOBAL_TIER_SETTINGS: LazyLock<RwLock<TierSettings>> = LazyLock::new(|| {
    let p = default_tier_presets_path();
    RwLock::new(TierSettings::load_from_path(&p))
});

pub fn current_tier_settings() -> TierSettings {
    GLOBAL_TIER_SETTINGS.read().unwrap().clone()
}

pub fn update_global_tier_settings(settings: TierSettings) -> std::io::Result<()> {
    let p = default_tier_presets_path();
    settings.save_to_path(&p)?;
    *GLOBAL_TIER_SETTINGS.write().unwrap() = settings;
    Ok(())
}

/// 档位 1: 优质源片/高动态防马赛克档 (720p High / Anti-Macroblock)
/// 适合大幅移动、剧烈晃动、高帧率或追求细节的视频，放宽峰值天花板，平时用 CRF 28 省流，剧烈晃动用 1100k 峰值抗马赛克。
pub fn builtin_720p_t1() -> EncodeCfg {
    current_tier_settings().builtin_720p_t1.to_encode_cfg()
}

/// 档位 2: 标准均衡/默认主力档 (720p Balanced / Default Main)
/// 适合绝大多数正常教学、访谈与日常视频，画质饱满且体积轻盈。
pub fn builtin_720p_t2() -> EncodeCfg {
    current_tier_settings().builtin_720p_t2.to_encode_cfg()
}

/// 档位 3: 极致紧凑/防胀省流档 (720p Compact / ~70MB)
/// 适合原本画质较低、动画片、静态板书课件或低码率场景，杜绝二次转码虚胖。
pub fn builtin_720p_t3() -> EncodeCfg {
    current_tier_settings().builtin_720p_t3.to_encode_cfg()
}

/// 默认 720p 预设指向主力均衡档（T2：CRF 28 / 950k / 96k AAC）
pub fn builtin_720p() -> EncodeCfg {
    builtin_720p_t2()
}

/// 根据源片客观分辨率、视频码率、帧率及编码类型智能选择匹配的 720p 预设及其判定原因。
///
/// 核心法则：
/// 结合编码格式转换损耗系数（AV1/VP9/HEVC 需约 1.5x 码率对齐 H.264）与不同分辨率的像素密度（bppf 阶梯法则），
/// 对输入片源实行多维智能分流：
/// 1. 高帧率全局优先升一档：fps >= 49.0，抑制运动撕裂与晃动马赛克；
/// 2. 小分辨率降三档（<= 540p）：小画面无需高码率，降三档极致紧凑杜绝虚胖；
/// 3. 720p 档位（540p < h <= 720p）：
///    - effective_kbps >= 1000（或高效编码 >= 650k，如手持走动 VLOG）：自动升一档（CRF 28 / 1100k），彻底消灭马赛克；
///    - effective_kbps < 650（或高效编码 < 450k）：降三档（CRF 29 / 900k）；
///    - 其余：二档标准主力（CRF 28 / 950k）；
/// 4. 1080p 档位（720p < h <= 1080p）：
///    - effective_kbps >= 1800（或高效编码 >= 1200k）：升一档保留高保真细节；
///    - effective_kbps < 850（如低码率教学片）：降三档极致紧凑杜绝浪费；
///    - 其余：二档标准主力；
/// 5. 超清 2K/4K 档位（h > 1080p）：
///    - effective_kbps < 1200：降三档；其余升一档。
pub fn adaptive_720p_preset_with_reason(
    source_height: i64,
    source_video_kbps: i64,
    fps_float: f64,
    is_efficient_codec: bool,
) -> (&'static str, &'static str) {
    let effective_kbps = if is_efficient_codec {
        (source_video_kbps as f64 * 1.5).round() as i64
    } else {
        source_video_kbps
    };

    // 1. 高帧率全局优先升一档
    if fps_float >= 49.0 {
        return (
            PROFILE_720P_T1,
            "检测到高帧率(>=50fps)动态片源，自动升为一档（CRF 28 / 峰值 1100k）以抑制运动撕裂与马赛克",
        );
    }

    // 2. 小分辨率 (<= 540p)：杜绝插值放大虚胖
    if source_height > 0 && source_height <= 540 {
        return (
            PROFILE_720P_T3,
            "源片本身分辨率较低(<=540p)，分配三档极致紧凑（CRF 29 / 峰值 900k），避免二次重编码体积虚胖浪费",
        );
    }

    // 3. 720p 档位 (540p < height <= 720p)
    if source_height > 540 && source_height <= 720 {
        if effective_kbps >= 1000 || (is_efficient_codec && source_video_kbps >= 650) {
            return (
                PROFILE_720P_T1,
                "720p 源片具备充足有效码率与动态细节，自动升为一档（CRF 28 / 峰值 1100k）以杜绝镜头晃动马赛克",
            );
        }
        if (effective_kbps > 0 && effective_kbps < 650)
            || (is_efficient_codec && source_video_kbps > 0 && source_video_kbps < 450)
        {
            return (
                PROFILE_720P_T3,
                "720p 源片码率较为匮乏或画面极简（如动画片/课件），分配三档极致紧凑（CRF 29 / 峰值 900k）以防二次转码体积虚胖",
            );
        }
        return (
            PROFILE_720P_T2,
            "720p 标准均衡片源，分配二档标准主力（CRF 28 / 峰值 950k），兼顾画质与轻量体积",
        );
    }

    // 4. 1080p 档位 (720p < height <= 1080p)
    if source_height > 720 && source_height <= 1080 {
        if effective_kbps >= 1800 || (is_efficient_codec && source_video_kbps >= 1200) {
            return (
                PROFILE_720P_T1,
                "1080p 高清源片且动态码率充沛，下采样至 720p 时自动升为一档（CRF 28 / 峰值 1100k）保留高保真细节",
            );
        }
        if effective_kbps > 0 && effective_kbps < 850 {
            return (
                PROFILE_720P_T3,
                "1080p 源片码率较为紧凑，分配三档极致紧凑（CRF 29 / 峰值 900k），杜绝过度转码浪费",
            );
        }
        return (
            PROFILE_720P_T2,
            "1080p 常规教学与日常片源，分配二档标准主力（CRF 28 / 峰值 950k），兼顾扎实画质与精简体积",
        );
    }

    // 5. 超清 2K / 4K 档位 (height > 1080p)
    if source_height > 1080 {
        if effective_kbps > 0 && effective_kbps < 1200 {
            return (
                PROFILE_720P_T3,
                "超清源片码率较低，分配三档极致紧凑以防体积虚胖",
            );
        }
        return (
            PROFILE_720P_T1,
            "4K/超清高精源片，下采样至 720p 时自动分配一档（CRF 28 / 峰值 1100k）以保留最佳纹理",
        );
    }

    // 6. 未知分辨率回退
    if effective_kbps >= 1500 {
        (
            PROFILE_720P_T1,
            "源片有效码率充沛，自动分配一档（CRF 28 / 峰值 1100k）防马赛克",
        )
    } else if effective_kbps > 0 && effective_kbps < 800 {
        (
            PROFILE_720P_T3,
            "源片有效码率较低，自动分配三档极致紧凑（CRF 29 / 峰值 900k）防虚胖",
        )
    } else {
        (
            PROFILE_720P_T2,
            "源片码率适中，优先分配二档标准主力（CRF 28 / 峰值 950k）",
        )
    }
}

pub fn adaptive_720p_preset(
    source_height: i64,
    source_video_kbps: i64,
    fps_float: f64,
    is_efficient_codec: bool,
) -> &'static str {
    adaptive_720p_preset_with_reason(
        source_height,
        source_video_kbps,
        fps_float,
        is_efficient_codec,
    )
    .0
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
    let tiers = current_tier_settings();
    match profile_mode {
        PROFILE_SOURCE => ResolvedProfile {
            encode: EncodeCfg::default(),
            speed: fallback_speed.to_string(),
            embed_subtitles,
            locked: true,
            inherit_source_profile: true,
        },
        PROFILE_720P_T1 => ResolvedProfile {
            encode: if encode.crf > 0 && encode.height == 720 {
                encode.clone()
            } else {
                tiers.builtin_720p_t1.to_encode_cfg()
            },
            speed: if !fallback_speed.is_empty() && fallback_speed != BUILTIN_720P_SPEED {
                fallback_speed.to_string()
            } else {
                tiers.builtin_720p_t1.speed.clone()
            },
            embed_subtitles: false,
            locked: false,
            inherit_source_profile: false,
        },
        PROFILE_720P | PROFILE_720P_T2 => ResolvedProfile {
            encode: if profile_mode == PROFILE_720P_T2 && encode.crf > 0 && encode.height == 720 {
                encode.clone()
            } else {
                tiers.builtin_720p_t2.to_encode_cfg()
            },
            speed: if profile_mode == PROFILE_720P_T2 && !fallback_speed.is_empty() && fallback_speed != BUILTIN_720P_SPEED {
                fallback_speed.to_string()
            } else {
                tiers.builtin_720p_t2.speed.clone()
            },
            embed_subtitles: false,
            locked: profile_mode == PROFILE_720P,
            inherit_source_profile: false,
        },
        PROFILE_720P_T3 => ResolvedProfile {
            encode: if encode.crf > 0 && encode.height == 720 {
                encode.clone()
            } else {
                tiers.builtin_720p_t3.to_encode_cfg()
            },
            speed: if !fallback_speed.is_empty() && fallback_speed != BUILTIN_720P_SPEED {
                fallback_speed.to_string()
            } else {
                tiers.builtin_720p_t3.speed.clone()
            },
            embed_subtitles: false,
            locked: false,
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

/// JSON-safe copy for `GET /api/profiles`.
pub fn profile_catalog() -> Vec<ProfileCatalogEntry> {
    let tiers = current_tier_settings();
    let t1 = &tiers.builtin_720p_t1;
    let t2 = &tiers.builtin_720p_t2;
    let t3 = &tiers.builtin_720p_t3;

    let p720_t1_cmd = format!(
        "ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf \"scale=-2:720\" -c:v libx264 -preset {} -crf {} -maxrate {}k -bufsize {}k -pix_fmt yuv420p -c:a aac -b:a {}k -ac 2 -sn -movflags +faststart output.mp4",
        t1.speed, t1.crf, t1.maxrate_kbps, t1.bufsize_kbps, t1.audio_kbps
    );
    let p720_t2_cmd = format!(
        "ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf \"scale=-2:720\" -c:v libx264 -preset {} -crf {} -maxrate {}k -bufsize {}k -pix_fmt yuv420p -c:a aac -b:a {}k -ac 2 -sn -movflags +faststart output.mp4",
        t2.speed, t2.crf, t2.maxrate_kbps, t2.bufsize_kbps, t2.audio_kbps
    );
    let p720_t3_cmd = format!(
        "ffmpeg -i input.mkv -map 0:v:0 -map 0:a:0? -vf \"scale=-2:720\" -c:v libx264 -preset {} -crf {} -maxrate {}k -bufsize {}k -pix_fmt yuv420p -c:a aac -b:a {}k -ac 2 -sn -movflags +faststart output.mp4",
        t3.speed, t3.crf, t3.maxrate_kbps, t3.bufsize_kbps, t3.audio_kbps
    );

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
            label: "720p 智能自适应 (推荐)".to_string(),
            tagline: "基准二档 · 动态升一档 · 差片降三档".to_string(),
            detail: "根据导入的视频特征毫秒级自动匹配最合适的预设。默认优先分配二档标准主力；检测到大幅晃动防马赛克时自动升一档；原片本身较差或动画/课件时自动降三档防虚胖。各档具体参数支持自由修改并持久化保存。".to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度 720p，宽度按原比例自动取偶".into(), why: "体积最大杠杆，720p兼顾清晰与极轻体积".into() },
                Bullet { name: "智能自适应".into(), value: format!("二档 (CRF {} / {}k) / 一档 (CRF {} / {}k) / 三档 (CRF {} / {}k)", t2.crf, t2.maxrate_kbps, t1.crf, t1.maxrate_kbps, t3.crf, t3.maxrate_kbps), why: "按格式与像素密度多维矩阵毫秒自动匹配最优预设".into() },
                Bullet { name: "码率缓冲池".into(), value: format!("{}k ~ {}k 动态蓄水池", t3.maxrate_kbps, t1.maxrate_kbps), why: "静态画面按需省流，大幅晃动与运动放开峰值抗马赛克".into() },
                Bullet { name: "编码".into(), value: "H.264 / 8-bit yuv420p".into(), why: "全平台全播放器硬件直出".into() },
                Bullet { name: "音频".into(), value: format!("AAC {} kbps 立体声", t2.audio_kbps), why: "纯净语音恒定码率，不浪费多余体积".into() },
                Bullet { name: "封装".into(), value: "MP4 + faststart，不内嵌字幕".into(), why: "边下边播，外挂 SRT 同名即用".into() },
            ],
            command: Some(p720_t2_cmd.clone()),
            encode: Some(t2.to_encode_cfg()),
            speed: Some(t2.speed.clone()),
            embed_subtitles: Some(false),
            locked: true,
        },
        ProfileCatalogEntry {
            id: PROFILE_720P_T1.to_string(),
            label: "一档 · 防马赛克".to_string(),
            tagline: format!("防马赛克：CRF {} / 峰值 {}k / 音频 {}k", t1.crf, t1.maxrate_kbps, t1.audio_kbps),
            detail: "适合大幅移动、剧烈晃动、高帧率或追求细节的视频，放宽峰值天花板，平时用 CRF 省流，剧烈晃动放开峰值抗马赛克。此档参数可在下方随时调整并点击保存。".to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度 720p".into(), why: "超采样高保真".into() },
                Bullet { name: "画质".into(), value: format!("CRF {}（动态调优防马赛克档）", t1.crf), why: "静态画面智能控重".into() },
                Bullet { name: "码率天花板".into(), value: format!("峰值 {} kbps / 缓冲 {} kbps", t1.maxrate_kbps, t1.bufsize_kbps), why: "放宽峰值天花板与缓冲空间，剧烈晃动镜头绝不破防出马赛克".into() },
                Bullet { name: "音频".into(), value: format!("AAC {} kbps 立体声", t1.audio_kbps), why: "纯净语音恒定码率".into() },
            ],
            command: Some(p720_t1_cmd),
            encode: Some(t1.to_encode_cfg()),
            speed: Some(t1.speed.clone()),
            embed_subtitles: Some(false),
            locked: false,
        },
        ProfileCatalogEntry {
            id: PROFILE_720P_T2.to_string(),
            label: "二档 · 标准主力".to_string(),
            tagline: format!("标准主力：CRF {} / 峰值 {}k / 音频 {}k", t2.crf, t2.maxrate_kbps, t2.audio_kbps),
            detail: "标准均衡主力档。适合绝大多数教学、访谈与日常视频，画质饱满且体积轻盈。此档参数可在下方随时调整并点击保存。".to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度 720p".into(), why: "标准尺寸".into() },
                Bullet { name: "画质".into(), value: format!("CRF {}（标准主力档）", t2.crf), why: "扎实画质与极小体积的黄金平衡".into() },
                Bullet { name: "码率天花板".into(), value: format!("峰值 {} kbps / 缓冲 {} kbps", t2.maxrate_kbps, t2.bufsize_kbps), why: "平滑缓冲防失真".into() },
                Bullet { name: "音频".into(), value: format!("AAC {} kbps 立体声", t2.audio_kbps), why: "纯净语音恒定码率".into() },
            ],
            command: Some(p720_t2_cmd),
            encode: Some(t2.to_encode_cfg()),
            speed: Some(t2.speed.clone()),
            embed_subtitles: Some(false),
            locked: false,
        },
        ProfileCatalogEntry {
            id: PROFILE_720P_T3.to_string(),
            label: "三档 · 极致紧凑".to_string(),
            tagline: format!("极致紧凑：CRF {} / 峰值 {}k / 音频 {}k", t3.crf, t3.maxrate_kbps, t3.audio_kbps),
            detail: "极致紧凑档。适合原本画质较低的片源、动画片、静态板书或需要极致节省存储空间的场景，杜绝二次转码虚胖。此档参数可在下方随时调整并点击保存。".to_string(),
            bullets: vec![
                Bullet { name: "分辨率".into(), value: "高度 720p".into(), why: "紧凑尺寸".into() },
                Bullet { name: "画质".into(), value: format!("CRF {}（紧凑省流档）", t3.crf), why: "严格受控，杜绝虚胖".into() },
                Bullet { name: "码率天花板".into(), value: format!("峰值 {} kbps / 缓冲 {} kbps", t3.maxrate_kbps, t3.bufsize_kbps), why: "严格控顶且保留抗晃动缓冲".into() },
                Bullet { name: "音频".into(), value: format!("AAC {} kbps 立体声", t3.audio_kbps), why: "纯净语音恒定码率".into() },
            ],
            command: Some(p720_t3_cmd),
            encode: Some(t3.to_encode_cfg()),
            speed: Some(t3.speed.clone()),
            embed_subtitles: Some(false),
            locked: false,
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
        assert_eq!(p.encode.crf, 28);
        assert_eq!(p.encode.maxrate_kbps, 950);
        assert_eq!(p.encode.bufsize_kbps, 1800);
        assert_eq!(p.encode.audio_kbps, 96);
        assert_eq!(p.speed, "slow");
        assert!(!p.embed_subtitles);
        assert!(!p.inherit_source_profile);
    }

    #[test]
    fn p720_t1_and_t3_recipes() {
        let t1 = resolve_profile(PROFILE_720P_T1, &EncodeCfg::default(), "medium", false);
        assert_eq!(t1.encode.crf, 28);
        assert_eq!(t1.encode.maxrate_kbps, 1100);
        assert_eq!(t1.encode.bufsize_kbps, 2200);
        assert_eq!(t1.encode.audio_kbps, 96);

        let t2 = resolve_profile(PROFILE_720P_T2, &EncodeCfg::default(), "medium", false);
        assert_eq!(t2.encode.crf, 28);
        assert_eq!(t2.encode.maxrate_kbps, 950);
        assert_eq!(t2.encode.bufsize_kbps, 1800);
        assert_eq!(t2.encode.audio_kbps, 96);

        let t3 = resolve_profile(PROFILE_720P_T3, &EncodeCfg::default(), "medium", false);
        assert_eq!(t3.encode.crf, 29);
        assert_eq!(t3.encode.maxrate_kbps, 900);
        assert_eq!(t3.encode.bufsize_kbps, 1700);
        assert_eq!(t3.encode.audio_kbps, 96);
    }

    #[test]
    fn adaptive_preset_selection() {
        // 1. 60fps 高帧率/高动态 -> 自动升 T1
        assert_eq!(adaptive_720p_preset(720, 1000, 60.0, false), PROFILE_720P_T1);
        // 2. 720p 677k AV1 走动 VLOG (如 busy day) -> 自动升 T1 (effective 677 * 1.5 = 1016 >= 1000 且 677 >= 650)
        assert_eq!(adaptive_720p_preset(720, 677, 30.0, true), PROFILE_720P_T1);
        // 3. 720p 贫码率源片 (< 650k H.264 或 < 450k AV1) -> 降 T3 防虚胖
        assert_eq!(adaptive_720p_preset(720, 500, 30.0, false), PROFILE_720P_T3);
        assert_eq!(adaptive_720p_preset(720, 350, 30.0, true), PROFILE_720P_T3);
        // 4. 720p 正常片源 (如 800k H.264) -> 二档 T2
        assert_eq!(adaptive_720p_preset(720, 800, 30.0, false), PROFILE_720P_T2);
        // 5. 小分辨率 (480p) -> 降 T3
        assert_eq!(adaptive_720p_preset(480, 1000, 30.0, false), PROFILE_720P_T3);
        // 6. 1080p 优质大片 (8000k H.264) -> 升 T1
        assert_eq!(adaptive_720p_preset(1080, 8000, 30.0, false), PROFILE_720P_T1);
        // 7. 1080p 紧凑片源 (如 Everyday English 510k AV1, 510*1.5=765 < 850) -> 降 T3
        assert_eq!(adaptive_720p_preset(1080, 510, 30.0, true), PROFILE_720P_T3);
        // 8. 1080p 常规教学片 (如 1500k H.264) -> 默认主力 T2
        assert_eq!(adaptive_720p_preset(1080, 1500, 30.0, false), PROFILE_720P_T2);
        // 9. 4K 高清片源 -> 升 T1
        assert_eq!(adaptive_720p_preset(2160, 10000, 30.0, false), PROFILE_720P_T1);
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
