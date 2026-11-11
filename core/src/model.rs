//! Framework-agnostic domain model.
//!
//! No web, no ffmpeg, no filesystem IO here. Every type maps 1:1 to a JSON
//! object so this layer can be shared between the Tauri backend and (if ever)
//! a future reimplementation. Field names intentionally mirror the Python
//! `core.model` so the API contract stays byte-compatible.

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}
fn default_crf() -> i64 {
    18
}
fn default_bframes() -> i64 {
    -1
}
fn default_sub_fmt() -> String {
    "srt".to_string()
}
fn default_preset() -> String {
    "medium".to_string()
}
fn default_snap_tol() -> i64 {
    500
}
fn default_profile_mode() -> String {
    "custom".to_string()
}

/// A clip edge kind: a frozen millisecond value, or a reference to a subtitle
/// line resolved lazily at use time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum BoundaryKind {
    #[default]
    Time,
    Cue,
}

/// Which edge of a subtitle line a [`CueRef`] points at.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    #[default]
    Start,
    End,
}

/// Export strategy.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExportMode {
    /// Frame-accurate re-encode; subtitles are simply `t - in` with no drift.
    #[default]
    Precise,
    /// Bit-exact stream copy, cut must land on a keyframe (snapped up front).
    Lossless,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CueRef {
    pub track_id: String,
    pub cue_index: i64,
    #[serde(default)]
    pub edge: Edge,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Boundary {
    #[serde(default)]
    pub kind: BoundaryKind,
    #[serde(default)]
    pub ms: i64,
    #[serde(default)]
    pub cue_ref: Option<CueRef>,
    #[serde(default)]
    pub padding_ms: i64,
}

impl Boundary {
    pub fn at_time(ms: i64, padding_ms: i64) -> Self {
        Boundary {
            kind: BoundaryKind::Time,
            ms: ms as i64,
            cue_ref: None,
            padding_ms: padding_ms as i64,
        }
    }

    pub fn at_cue(track_id: &str, cue_index: i64, edge: Edge, padding_ms: i64) -> Self {
        Boundary {
            kind: BoundaryKind::Cue,
            ms: 0,
            cue_ref: Some(CueRef {
                track_id: track_id.to_string(),
                cue_index,
                edge,
            }),
            padding_ms,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Cue {
    #[serde(default)]
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: i64,
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub index: i64,
}

/// One human timing correction, kept as an audit log inside the project so a
/// half-finished proofreading session can be recovered and replayed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CueEdit {
    pub track_id: String,
    pub cue_index: i64,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub delta_ms: i64,
    #[serde(default)]
    pub before_start_ms: i64,
    #[serde(default)]
    pub before_end_ms: i64,
    #[serde(default)]
    pub after_start_ms: i64,
    #[serde(default)]
    pub after_end_ms: i64,
    #[serde(default)]
    pub at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SubTrack {
    pub id: String,
    pub source_id: String,
    #[serde(default)]
    pub group_id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub cues: Vec<Cue>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for SubTrack {
    fn default() -> Self {
        SubTrack {
            id: String::new(),
            source_id: String::new(),
            group_id: String::new(),
            label: String::new(),
            lang: String::new(),
            path: None,
            origin: String::new(),
            cues: Vec::new(),
            enabled: true,
        }
    }
}

impl SubTrack {
    /// `group_id` falls back to `id` when empty (mirrors the Python contract).
    pub fn effective_group(&self) -> &str {
        if self.group_id.is_empty() {
            &self.id
        } else {
            &self.group_id
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Source {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub bitrate_bps: i64,
    #[serde(default)]
    pub keyframes_ms: Vec<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Clip {
    pub id: String,
    pub source_id: String,
    pub start: Boundary,
    pub end: Boundary,
    #[serde(default)]
    pub track_ids: Vec<String>,
    #[serde(default)]
    pub label: String,
}

/// User-facing transcode overrides for precise mode. Empty string / zero / -1
/// means "keep whatever the source has".
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct EncodeCfg {
    #[serde(default)]
    pub video_codec: String,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
    #[serde(default)]
    pub scale_mode: String,
    #[serde(default)]
    pub fps: String,
    #[serde(default)]
    pub pix_fmt: String,
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub rate_control: String,
    #[serde(default = "default_crf")]
    pub crf: i64,
    #[serde(default)]
    pub video_kbps: i64,
    #[serde(default)]
    pub maxrate_kbps: i64,
    #[serde(default)]
    pub bufsize_kbps: i64,
    #[serde(default)]
    pub gop: i64,
    #[serde(default = "default_bframes")]
    pub bframes: i64,
    #[serde(default)]
    pub audio_codec: String,
    #[serde(default)]
    pub audio_kbps: i64,
    #[serde(default)]
    pub sample_rate: i64,
    #[serde(default)]
    pub channels: i64,
    #[serde(default)]
    pub audio_profile: String,
    #[serde(default = "default_sub_fmt")]
    pub subtitle_format: String,
    #[serde(default)]
    pub container: String,
    #[serde(default = "default_true")]
    pub faststart: bool,
}

impl Default for EncodeCfg {
    fn default() -> Self {
        EncodeCfg {
            video_codec: String::new(),
            width: 0,
            height: 0,
            scale_mode: String::new(),
            fps: String::new(),
            pix_fmt: String::new(),
            profile: String::new(),
            level: String::new(),
            rate_control: String::new(),
            crf: 18,
            video_kbps: 0,
            maxrate_kbps: 0,
            bufsize_kbps: 0,
            gop: 0,
            bframes: -1,
            audio_codec: String::new(),
            audio_kbps: 0,
            sample_rate: 0,
            channels: 0,
            audio_profile: String::new(),
            subtitle_format: "srt".to_string(),
            container: String::new(),
            faststart: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct OutputCfg {
    #[serde(default)]
    pub mode: ExportMode,
    #[serde(default = "default_crf")]
    pub crf: i64,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "default_true")]
    pub match_source_bitrate: bool,
    #[serde(default)]
    pub embed_subtitles: bool,
    #[serde(default)]
    pub snap_to_cue: bool,
    #[serde(default = "default_snap_tol")]
    pub snap_tolerance_ms: i64,
    #[serde(default = "default_profile_mode")]
    pub profile_mode: String,
    #[serde(default)]
    pub encode: EncodeCfg,
}

impl Default for OutputCfg {
    fn default() -> Self {
        OutputCfg {
            mode: ExportMode::Precise,
            crf: 18,
            preset: "medium".to_string(),
            match_source_bitrate: true,
            embed_subtitles: false,
            snap_to_cue: false,
            snap_tolerance_ms: 500,
            profile_mode: "custom".to_string(),
            encode: EncodeCfg::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Project {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub tracks: Vec<SubTrack>,
    #[serde(default)]
    pub clips: Vec<Clip>,
    #[serde(default)]
    pub output: OutputCfg,
    #[serde(default)]
    pub cue_edits: Vec<CueEdit>,
}

impl Default for Project {
    fn default() -> Self {
        Project {
            name: "untitled".to_string(),
            sources: Vec::new(),
            tracks: Vec::new(),
            clips: Vec::new(),
            output: OutputCfg::default(),
            cue_edits: Vec::new(),
        }
    }
}

impl Project {
    pub fn source(&self, source_id: &str) -> Option<&Source> {
        self.sources.iter().find(|s| s.id == source_id)
    }

    pub fn source_mut(&mut self, source_id: &str) -> Option<&mut Source> {
        self.sources.iter_mut().find(|s| s.id == source_id)
    }

    pub fn track(&self, track_id: &str) -> Option<&SubTrack> {
        self.tracks.iter().find(|t| t.id == track_id)
    }

    pub fn track_mut(&mut self, track_id: &str) -> Option<&mut SubTrack> {
        self.tracks.iter_mut().find(|t| t.id == track_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_roundtrip_json() {
        let b = Boundary::at_cue("trk1", 3, Edge::End, 120);
        let json = serde_json::to_string(&b).unwrap();
        let back: Boundary = serde_json::from_str(&json).unwrap();
        assert_eq!(b, back);
        assert_eq!(back.kind, BoundaryKind::Cue);
        assert_eq!(back.cue_ref.unwrap().cue_index, 3);
    }

    #[test]
    fn project_defaults() {
        let p = Project::default();
        assert_eq!(p.name, "untitled");
        assert!(p.output.match_source_bitrate);
        assert_eq!(p.output.preset, "medium");
        assert_eq!(p.output.encode.crf, 18);
        assert_eq!(p.output.encode.bframes, -1);
    }

    #[test]
    fn subtrack_effective_group() {
        let t = SubTrack {
            id: "a".into(),
            source_id: "s".into(),
            ..Default::default()
        };
        assert_eq!(t.effective_group(), "a");
        let t2 = SubTrack {
            id: "a".into(),
            source_id: "s".into(),
            group_id: "zh".into(),
            ..Default::default()
        };
        assert_eq!(t2.effective_group(), "zh");
    }
}
