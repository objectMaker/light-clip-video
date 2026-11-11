import type { Project } from '../types'

const PROJECT_STORE = 'clip-video.autosave.v1'
const RECENT_STORE = 'clip-video.recent.v1'
const PRESET_STORE = 'clip-video.encode-presets.v1'
const RECENT_LIMIT = 6

export interface SavedProject {
  version: number
  app: string
  saved_at: string
  project: Project
}

export interface RecentItem {
  key: string
  name: string
  path: string
  clips: number
  saved_at: string
  project: Project
}

export function projectPayload(project: Project): SavedProject {
  return { version: 1, app: 'clip-video', saved_at: new Date().toISOString(), project }
}

export function saveAutosave(project: Project | null): void {
  try {
    if (project?.sources?.length) {
      localStorage.setItem(PROJECT_STORE, JSON.stringify(projectPayload(project)))
    }
  } catch {
    /* private mode / quota: autosave is best-effort only */
  }
}

export function readAutosave(): SavedProject | null {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_STORE) || 'null')
  } catch {
    return null
  }
}

export function readRecent(): RecentItem[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_STORE) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function saveRecent(list: RecentItem[]): void {
  try {
    localStorage.setItem(RECENT_STORE, JSON.stringify(list.slice(0, RECENT_LIMIT)))
  } catch {
    /* quota / private mode: recents are best-effort */
  }
}

export function rememberProject(project: Project): void {
  if (!project?.sources?.length) return
  const key = (project.sources || []).map((s) => s.path).join('|')
  const item: RecentItem = {
    key,
    name: project.name || '未命名工程',
    path: project.sources[0].path,
    clips: (project.clips || []).length,
    saved_at: new Date().toISOString(),
    project: JSON.parse(JSON.stringify(project)),
  }
  saveRecent([item, ...readRecent().filter((r) => r.key !== item.key)])
}

export function loadPresets(): Record<string, { encode: unknown; preset: string; embed_subtitles: boolean; updated: number }> {
  try {
    if (typeof localStorage === 'undefined') return {}
    return JSON.parse(localStorage.getItem(PRESET_STORE) || '{}') || {}
  } catch {
    return {}
  }
}

export function savePresets(data: Record<string, unknown>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PRESET_STORE, JSON.stringify(data))
  } catch {
    /* quota: best-effort */
  }
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file)
  })
}
