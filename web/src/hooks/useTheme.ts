import { useSyncExternalStore } from 'react'

/** Light / dark / follow-OS. Persisted so the choice survives a restart. */
export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_KEY = 'clip-video.theme.v1'

const QUERY = '(prefers-color-scheme: dark)'
const ORDER: Theme[] = ['light', 'dark', 'system']

export const THEME_LABEL: Record<Theme, string> = {
  light: '浅色主题',
  dark: '深色主题',
  system: '跟随系统',
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches
}

function resolve(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemDark() ? 'dark' : 'light'
  return theme
}

function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* private mode: fall back to system */
  }
  return 'system'
}

/** Module-level store: Topbar and App always observe the same snapshot. */
let current: Theme = readTheme()
let snapshot: { theme: Theme; resolvedTheme: ResolvedTheme } = {
  theme: current,
  resolvedTheme: resolve(current),
}
const listeners = new Set<() => void>()

function paint(resolved: ResolvedTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved
}

function emit(next: Theme) {
  current = next
  const resolvedTheme = resolve(next)
  snapshot = { theme: next, resolvedTheme }
  paint(resolvedTheme)
  listeners.forEach((fn) => fn())
}

function setTheme(theme: Theme) {
  if (theme === current) return
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* persistence is best-effort */
  }
  emit(theme)
}

/** Cycle light -> dark -> system, for a compact single-icon control. */
function cycleTheme() {
  setTheme(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length])
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot() {
  return snapshot
}

// Keep "follow system" live when the OS flips its appearance, and make sure
// the DOM matches storage on the very first render (the inline script in
// index.html already painted once, this is the authoritative sync).
if (typeof window !== 'undefined') {
  paint(snapshot.resolvedTheme)
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', () => {
    if (current === 'system') emit('system')
  })
}

export function useTheme() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { ...state, setTheme, cycleTheme }
}
