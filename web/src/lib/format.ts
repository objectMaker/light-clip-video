export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** ms -> "HH:MM:SS.mmm" */
export function fmt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--'
  ms = Math.max(0, Math.round(ms))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms % 1000).padStart(3, '0')}`
}

/** "MM:SS.mmm" (no hours), as used on the timeline ruler and clip cards. */
export function shortFmt(ms: number): string {
  return fmt(ms).slice(3, 12)
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function uid(): string {
  return 'c' + Math.random().toString(36).slice(2, 9)
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/** "HH:MM:SS.mmm" | "MM:SS.mmm" | "SS.mmm" | plain milliseconds -> ms, or null. */
export function parseTime(text: string): number | null {
  const s = String(text).trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':')
  if (parts.length > 3) return null
  const nums = parts.map((p) => {
    const t = p.trim()
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN
  })
  if (nums.some((n) => Number.isNaN(n))) return null
  let ms: number
  if (parts.length === 3) ms = (nums[0] * 3600 + nums[1] * 60 + nums[2]) * 1000
  else if (parts.length === 2) ms = (nums[0] * 60 + nums[1]) * 1000
  else ms = nums[0] * 1000
  return Math.round(ms)
}

export function fmtMB(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '未知'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

export function fmtClock(iso: string | undefined): string {
  return String(iso ?? '').slice(0, 16).replace('T', ' ')
}
