//! `clip-core`: framework-agnostic domain logic for clip-video.
//!
//! This crate is the 1:1 Rust port of the Python `core/` package. It contains no
//! web, no ffmpeg, and (outside of `probe`/`plan`'s parsing helpers) no process
//! spawning or filesystem IO. Every type is `serde`-serialisable so the Tauri
//! backend and the (future) frontend share one contract.

pub mod checks;
pub mod cues;
pub mod model;
pub mod paths;
pub mod plan;
pub mod presets;
pub mod probe;
pub mod rate;
pub mod remap;
pub mod srt;

// Re-export the public surface, mirroring Python's `core/__init__.py`.
pub use checks::{evaluate_encode, resolve_rate_control, EncodeEvaluation, WarningItem};
pub use cues::{
    append_edits, corrected_cue_indices, detect_overlaps, edit_summary, global_delta, set_cue_times,
    shift_cues, shift_one, whole_subtitle_text, EditSummary, MIN_CUE_MS, STEP_OPTIONS, EDIT_LOG_LIMIT,
};
pub use model::{
    Boundary, BoundaryKind, Clip, Cue, CueEdit, CueRef, Edge, EncodeCfg, ExportMode, OutputCfg,
    Project, Source, SubTrack,
};
pub use paths::{
    default_export_dir, default_export_path, export_base_name, forced_container, resolve_export_target,
    safe_group, safe_stem, unique_batch_paths, unique_export_path, FOLDER_SUFFIX, KNOWN_EXT, MP4_LIKE,
};
pub use plan::{build_export_plan, ExportPlan};
pub use presets::{
    profile_catalog, resolve_profile, Bullet, ProfileCatalogEntry, ResolvedProfile, builtin_720p,
    BUILTIN_720P_SPEED, PROFILE_720P, PROFILE_CUSTOM, PROFILE_IDS, PROFILE_SOURCE,
};
pub use probe::{
    parse_encode_params, parse_keyframes_csv, parse_source, parse_subtitle_streams, snap_down,
    source_bitrates, AudioParams, EncodeParams, FormatParams, VideoParams,
};
pub use rate::{codec_class, plan_rate, CodecClass, RateNote, RatePlan};
pub use remap::{
    build_segments, clips_from_cue_selection, preview_state, remap_cues, resolve_boundary,
    snap_to_cue, tracks_for_clip, PreviewState, RemapError, Segment,
};
pub use srt::{ms_to_ts, parse_srt, read_srt_file, to_vtt, write_srt, WholeSubtitle};
