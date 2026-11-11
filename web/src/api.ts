// All /api calls, typed. The contract in docs/API.md is frozen: do not change
// payloads or field names here.
import type {
  BrowseEntry,
  CueShiftResult,
  EmbeddedSubtitle,
  EncodeCfg,
  EncodeEvaluation,
  ExportStatus,
  ExportTarget,
  Profile,
  Project,
  ProjectAndState,
  ServerConfig,
  SrcInfo,
} from './types'

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const data = await res.json()
  if (data.error) throw new Error(String(data.error))
  return data as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

function q(params: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString()
}

export const apiClient = {
  getProject: () => api<ProjectAndState>('/api/project'),
  getRecover: () => api<{ project: Project | null; state?: unknown; saved_at?: string; file?: string }>('/api/project/recover'),
  getConfig: () => api<ServerConfig>('/api/config'),
  getProfiles: () => api<{ profiles: Profile[] }>('/api/profiles'),
  syncProject: (project: Project) => post<{ state: ProjectAndState['state'] }>('/api/project', { project }),
  loadProject: (project: Project) => post<ProjectAndState>('/api/project/load', { project }),
  preview: (project: Project) => post<{ state: ProjectAndState['state'] }>('/api/preview', { project }),
  open: (videos: string[], subtitles: { path: string; source_id: string; group_id: string; label: string; lang: string }[], auto_subtitles: boolean) =>
    post<ProjectAndState>('/api/open', { videos, subtitles, auto_subtitles }),
  embeddedSubtitles: (path: string) =>
    api<{ streams: EmbeddedSubtitle[] }>(`/api/subtitles/embedded?${q({ path })}`),
  extractSubtitle: (body: { path: string; stream_index: number; source_id: string }) =>
    post<ProjectAndState & { track_id: string; path: string; reused: boolean }>('/api/subtitles/extract', body),
  browse: (dir: string, kind: 'all' | 'video' | 'sub' | 'dir') =>
    api<{ path: string; parent: string; entries: BrowseEntry[] }>(`/api/browse?${q({ dir, kind })}`),
  encodeParams: (path: string) => api<SrcInfo>(`/api/encode-params?${q({ path })}`),
  exportDefault: (dir: string, name: string, overwrite: boolean) =>
    api<ExportTarget>(`/api/export/default?${q({ dir, name, overwrite: overwrite ? 1 : 0 })}`),
  checkParams: (encode: EncodeCfg, total_ms: number, mode: string, match_source_bitrate: boolean, profile_mode: string) =>
    post<EncodeEvaluation>('/api/check-params', { encode, total_ms, mode, match_source_bitrate, profile_mode }),
  snap: (source_id: string, ms: number, tolerance_ms: number) =>
    post<{ boundary: Project['clips'][number]['start'] | null }>('/api/snap', { source_id, ms, tolerance_ms }),
  clipsFromCues: (body: { source_id: string; indices: number[]; track_id: string; padding_start_ms: number; padding_end_ms: number; merge_gap_ms: number; id_prefix: string; replace: boolean }) =>
    post<{ clips: Project['clips']; project: Project; state: ProjectAndState['state'] }>('/api/clips/from-cues', body),
  shiftCues: (body: Record<string, unknown>) => post<CueShiftResult>('/api/cues/shift', body),
  exportSubtitles: (body: { format: string; output_dir: string; output_name: string; overwrite: boolean }) =>
    post<{ subtitles: Record<string, string>; dir: string; format: string; renamed_from: string[] | null; count: number; remapped: boolean; default_path: string }>('/api/export-subtitles', body),
  startExport: (body: { output_dir: string; output_name: string; overwrite: boolean }) =>
    post<{ task_id: string; output_path: string; renamed_from: string | null }>('/api/export', body),
  exportStatus: (id: string) => api<ExportStatus>(`/api/export/status?${q({ id })}`),
  reveal: (path: string) => post<{ ok: boolean; opened: string }>('/api/reveal', { path, dry_run: false }),
  mkdir: (parent: string, name: string) => post<{ path: string }>('/api/mkdir', { parent, name }),
}

export function mediaUrl(path: string): string {
  return `/api/media?${q({ path })}`
}

export function thumbUrl(path: string, tSeconds: number): string {
  return `/api/thumb?${q({ path, t: tSeconds.toFixed(2) })}`
}

export function waveformUrl(path: string): string {
  return `/api/waveform?${q({ path })}`
}
