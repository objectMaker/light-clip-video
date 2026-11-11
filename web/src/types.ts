// Backend data shapes (docs/API.md). Field names are snake_case, exactly as
// the server returns them; the frontend round-trips `project` verbatim.
export type BoundaryKind = 'time' | 'cue'
export type CueEdge = 'start' | 'end'
export type ExportMode = 'precise' | 'lossless'
export type ProfileMode = 'source' | 'builtin_720p' | 'custom'

export interface CueRef {
  track_id: string
  cue_index: number
  edge: CueEdge
}

export interface Boundary {
  kind: BoundaryKind
  ms: number
  cue_ref: CueRef | null
  padding_ms: number
}

export interface Source {
  id: string
  path: string
  duration_ms: number
  fps: number
  bitrate_bps: number
  keyframes_ms: number[]
}

export interface Cue {
  start_ms: number
  end_ms: number
  lines: string[]
  index: number
}

export interface SubTrack {
  id: string
  source_id: string
  group_id: string
  label: string
  lang: string
  path: string
  origin?: string
  enabled: boolean
  cues: Cue[]
}

export interface Clip {
  id: string
  source_id: string
  start: Boundary
  end: Boundary
  track_ids: string[]
  label: string
}

export interface EncodeCfg {
  video_codec: string
  width: number
  height: number
  scale_mode: string
  fps: string
  pix_fmt: string
  profile: string
  level: string
  rate_control: string
  crf: number
  video_kbps: number
  maxrate_kbps: number
  bufsize_kbps: number
  gop: number
  bframes: number
  audio_codec: string
  audio_kbps: number
  sample_rate: number
  channels: number
  audio_profile: string
  subtitle_format: string
  container: string
  faststart: boolean
  [key: string]: string | number | boolean
}

export interface OutputCfg {
  mode: ExportMode
  crf: number
  preset: string
  match_source_bitrate: boolean
  embed_subtitles: boolean
  snap_to_cue: boolean
  snap_tolerance_ms: number
  profile_mode: ProfileMode
  encode: EncodeCfg
}

export interface CueEdit {
  kind: string
  track_id: string
  cue_index: number
  [key: string]: unknown
}

export interface Project {
  name: string
  sources: Source[]
  tracks: SubTrack[]
  clips: Clip[]
  output: OutputCfg
  cue_edits: CueEdit[]
}

export interface Segment {
  clip_id: string
  source_id: string
  in_ms: number
  out_ms: number
  duration_ms: number
  offset_ms: number
  requested_in_ms: number
  track_ids: string[]
  label: string
  keyframe_shift_ms?: number
}

export interface PreviewState {
  segments: Segment[]
  total_ms: number
  groups: Record<string, Cue[]>
  srt: Record<string, string>
  vtt: Record<string, string>
  estimated_lossless_bytes?: number
}

export interface ProjectAndState {
  project: Project
  state: PreviewState
  embedded_subtitles?: EmbeddedSubtitle[]
}

/// One subtitle stream embedded in a video file (from /api/open or
/// /api/subtitles/embedded). `text` is false for bitmap subtitles
/// (DVD/PGS/DVB), which cannot be extracted to SRT.
export interface EmbeddedSubtitle {
  source_id: string
  index: number
  codec?: string | null
  language?: string | null
  title?: string | null
  text: boolean
}

export interface SrcInfo {
  video?: {
    codec?: string
    supported?: boolean
    profile?: string
    level?: string
    pix_fmt?: string
    fps?: string
    fps_float?: number
    width?: number
    height?: number
    video_kbps?: number
    b_frames?: number
    [key: string]: unknown
  }
  audio?: {
    codec?: string
    audio_kbps?: number
    sample_rate?: number
    channels?: number
    profile?: string
    [key: string]: unknown
  }
  format?: { duration_ms?: number; size_bytes?: number; bitrate_kbps?: number }
}

export interface EncodeWarning {
  level: 'warn' | 'info' | 'ok'
  title: string
  text: string
}

export interface EncodeEvaluation {
  warnings: EncodeWarning[]
  estimated_bytes: number | null
  source_equivalent_bytes: number | null
  ratio: number | null
  estimate_note: string
  is_upper_bound: boolean
}

export interface ProfileBullet {
  name: string
  value: string
  why: string
}

export interface Profile {
  id: string
  label: string
  tagline: string
  detail: string
  bullets?: ProfileBullet[]
  command?: string
  encode?: EncodeCfg
  speed?: string
}

export interface BrowseEntry {
  name: string
  path: string
  is_dir: boolean
  size: number
}

export interface ExportTarget {
  path: string
  dir: string
  filename: string
  base_path: string
  renamed_from: string | null
  default_path: string
  default_dir: string
  default_name: string
  source_dir: string
  overwrite: boolean
}

export interface ExportStatus {
  status: 'running' | 'done' | 'error'
  percent: number
  message: string
  result?: {
    video: string
    output_dir: string
    subtitles: Record<string, string>
    warnings: string[]
    srt: string
    vtt: string
    segments: Segment[]
    total_ms: number
    renamed_from?: string | null
  }
  error?: string
}

export interface CueShiftSummary {
  edit_count: number
  track_edit_count: number
  corrected_indices: number[]
  global_applied_ms: number
  overlaps: number
}

export interface CueShiftResult extends ProjectAndState {
  records: unknown[]
  clamped: number
  applied_delta_ms: number
  summary: CueShiftSummary
  saved_at: string
}

export interface ServerConfig {
  ffmpeg: string
  ffprobe: string
  outdir: string
  cwd: string
}
