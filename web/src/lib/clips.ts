import type { Clip, Project, Segment, Source } from '../types'
import { clamp, shortFmt, uid } from './format'

export function timeBoundary(ms: number) {
  return { kind: 'time' as const, ms: Math.round(ms), cue_ref: null, padding_ms: 0 }
}

/** Split one clip into two at an absolute SOURCE time. `seg` is the resolved
 * segment (in_ms/out_ms), so cue-anchored boundaries are handled correctly:
 * the untouched edge keeps its original expression, only the cut becomes a
 * plain time. Returns a NEW array, or null when the cut is not legal. */
export function splitClipAt(clips: Clip[], i: number, atMs: number, seg: Segment | null | undefined): Clip[] | null {
  const c = clips[i]
  if (!c || !seg || !Number.isFinite(atMs)) return null
  const at = Math.round(atMs)
  if (at <= seg.in_ms + 100 || at >= seg.out_ms - 100) return null
  const out = JSON.parse(JSON.stringify(clips)) as Clip[]
  const left = JSON.parse(JSON.stringify(c)) as Clip
  const right = JSON.parse(JSON.stringify(c)) as Clip
  const base = c.label || `片段 ${i + 1}`
  left.end = timeBoundary(at)
  left.label = base + ' · 前'
  right.id = uid()
  right.start = timeBoundary(at)
  right.label = base + ' · 后'
  out.splice(i, 1, left, right)
  return out
}

export function copyClip(clips: Clip[], i: number): Clip[] | null {
  const c = clips[i]
  if (!c) return null
  const out = JSON.parse(JSON.stringify(clips)) as Clip[]
  const dup = JSON.parse(JSON.stringify(c)) as Clip
  dup.id = uid()
  dup.label = (c.label || `片段 ${i + 1}`) + ' 副本'
  out.splice(i + 1, 0, dup)
  return out
}

/** Deep copy with a fresh id, for the Ctrl+C / Ctrl+V clipboard. The original
 * clip keeps its Boundary expressions (time OR cue anchor) and track ids, so
 * a pasted segment still follows subtitle edits. */
export function cloneClip(clip: Clip): Clip {
  const out = JSON.parse(JSON.stringify(clip)) as Clip
  out.id = uid()
  return out
}

/** Insert at `at` (clamped to 0..length). Used by paste: after the selected
 * clip, or appended to the end when nothing is selected. */
export function insertClip(clips: Clip[], clip: Clip, at: number): Clip[] {
  const out = clips.slice()
  out.splice(Math.max(0, Math.min(at, out.length)), 0, cloneClip(clip))
  return out
}

export function renameClip(clips: Clip[], i: number, label: string): Clip[] | null {
  if (!clips[i]) return null
  const out = JSON.parse(JSON.stringify(clips)) as Clip[]
  out[i].label = String(label || '').trim().slice(0, 60)
  return out
}

export function moveClip<T>(items: T[], from: number, to: number): T[] | null {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return null
  const out = items.slice()
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/** One 0 -> full-length clip per source, in source order. An untouched
 * timeline means the original .srt stays valid after a simple rename. */
export function makeWholeClips(sources: Source[]): Clip[] {
  return (sources || [])
    .filter((s) => (s.duration_ms || 0) > 0)
    .map((s, i) => ({
      id: uid(),
      source_id: s.id,
      start: timeBoundary(0),
      end: timeBoundary(s.duration_ms),
      track_ids: [],
      label: `整片 ${i + 1}`,
    }))
}

export function isWholeFileProject(project: Project | null | undefined): boolean {
  const clips = project?.clips || []
  if (!clips.length) return false
  const sources = project?.sources || []
  return clips.every((c) => {
    const src = sources.find((s) => s.id === c.source_id)
    return c.start?.kind === 'time' && c.start.ms === 0 && c.end?.kind === 'time' && !!src && c.end.ms >= src.duration_ms
  })
}

export interface OutputCell {
  i: number
  left: number
  width: number
  offset_ms: number
  label: string
}

/** Lane cells for the concatenated result. Widths are proportional to each
 * segment's duration, NOT to source time, so gaps simply disappear. */
export function buildOutputLane(segments: Segment[], total: number): OutputCell[] {
  const segs = segments || []
  const span = total || segs.reduce((a, s) => a + (s.duration_ms || 0), 0)
  if (!span || !segs.length) return []
  let acc = 0
  return segs.map((s, i) => {
    const cell: OutputCell = {
      i,
      left: (acc / span) * 100,
      width: ((s.duration_ms || 0) / span) * 100,
      offset_ms: s.offset_ms,
      label: String(i + 1),
    }
    acc += s.duration_ms || 0
    return cell
  })
}

/** OUTPUT time -> (segment index, source time). Clicking the output lane and
 * "preview whole result" both go through this single mapping. */
export function outputToSource(segments: Segment[], outMs: number) {
  const segs = segments || []
  if (!segs.length) return null
  const total = segs.reduce((a, s) => a + (s.duration_ms || 0), 0)
  const t = clamp(Number(outMs) || 0, 0, Math.max(0, total - 1))
  let idx = 0
  for (let i = 0; i < segs.length; i++) {
    if (t >= (segs[i].offset_ms || 0)) idx = i
  }
  const seg = segs[idx]
  return {
    segIdx: idx,
    sourceId: seg.source_id,
    srcMs: (seg.in_ms || 0) + Math.max(0, t - (seg.offset_ms || 0)),
    outMs: t,
  }
}

/** null = stay where we are; {done:true} = end of the result; otherwise jump. */
export function advanceOutput(segments: Segment[], segIdx: number, srcMs: number) {
  const seg = (segments || [])[segIdx]
  if (!seg) return { done: true as const }
  if (srcMs < seg.out_ms - 40) return null
  for (let n = segIdx + 1; n < segments.length; n++) {
    if ((segments[n].duration_ms || 0) > 0) {
      return { segIdx: n, srcMs: segments[n].in_ms }
    }
  }
  return { done: true as const }
}

export interface ClipDragState {
  mode: 'start' | 'end' | 'move'
  start0: number
  end0: number
  len: number
  duration: number
}

/** Pure drag math. 'start'/'end' keep the OTHER edge exactly where it was. */
export function computeClipDrag(d: ClipDragState, ms: number, originMs: number) {
  const delta = ms - originMs
  if (d.mode === 'start') return { start: clamp(ms, 0, d.end0 - 100), end: d.end0 }
  if (d.mode === 'end') return { start: d.start0, end: clamp(ms, d.start0 + 100, d.duration) }
  const ns = clamp(d.start0 + delta, 0, d.duration - d.len)
  return { start: ns, end: ns + d.len }
}

export interface SnapPoint {
  ms: number
  label: string
}

export interface SnapOutcome {
  start: number
  end: number
  /** null = no snap point was close enough. */
  hit: SnapPoint | null
}

/**
 * Pull a dragged clip edge onto a nearby snap point (playhead, another clip's
 * edge, or the source bounds). Only fires within `tolMs`, which the timeline
 * derives from a fixed pixel distance so "close" means close ON SCREEN at any
 * zoom level. 'start'/'end' modes never move the opposite edge; 'move' keeps
 * the clip length. A candidate that would break min-length or source bounds is
 * rejected outright rather than clamped (clamping would silently un-snap it).
 */
export function snapClipDrag(
  next: { start: number; end: number },
  mode: 'start' | 'end' | 'move',
  points: SnapPoint[],
  tolMs: number,
  duration: number,
): SnapOutcome {
  const minLen = 100
  const len = next.end - next.start
  const plain: SnapOutcome = { start: next.start, end: next.end, hit: null }
  if (tolMs <= 0 || !points.length) return plain

  const edges: ('start' | 'end')[] = mode === 'move' ? ['start', 'end'] : [mode]
  let best: { dist: number; edge: 'start' | 'end'; point: SnapPoint } | null = null
  for (const edge of edges) {
    for (const p of points) {
      if (!Number.isFinite(p.ms)) continue
      const dist = Math.abs(next[edge] - p.ms)
      if (dist <= tolMs && (!best || dist < best.dist)) best = { dist, edge, point: p }
    }
  }
  if (!best) return plain

  let { start, end } = next
  if (mode === 'start') {
    start = best.point.ms
    if (start < 0 || end - start < minLen) return plain
  } else if (mode === 'end') {
    end = best.point.ms
    if (end > duration || end - start < minLen) return plain
  } else if (best.edge === 'start') {
    start = best.point.ms
    end = start + len
    if (start < 0 || end > duration) return plain
  } else {
    end = best.point.ms
    start = end - len
    if (start < 0 || end > duration) return plain
  }
  return { start, end, hit: best.point }
}

/** Window around a cue for the calibration mini-timeline. */
export function cueWindow(cue: { start_ms: number; end_ms: number }, sourceDurationMs: number) {
  const dur = sourceDurationMs || cue.end_ms + 16000
  const span = Math.max(4000, cue.end_ms - cue.start_ms + 16000)
  let w0 = cue.start_ms - span / 2 + (cue.end_ms - cue.start_ms) / 2
  let w1 = w0 + span
  if (w0 < 0) {
    w0 = 0
    w1 = span
  }
  if (w1 > dur) {
    w1 = dur
    w0 = Math.max(0, dur - span)
  }
  return { start: w0, end: w1 }
}

export function clipLabel(startMs: number, endMs: number): string {
  return `${shortFmt(startMs)}-${shortFmt(endMs)}`
}
