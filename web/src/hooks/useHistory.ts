import { useCallback, useRef, useState } from 'react'
import type { Clip, CueEdit, Project, SubTrack } from '../types'

export interface HistorySnapshot {
  clips: Clip[]
  tracks: SubTrack[]
  cue_edits: CueEdit[]
}

const HISTORY_LIMIT = 50

function snapshotOf(project: Project): HistorySnapshot {
  return JSON.parse(
    JSON.stringify({
      clips: project.clips || [],
      tracks: project.tracks || [],
      cue_edits: project.cue_edits || [],
    }),
  )
}

/** A single undo stack governs clips, subtitle timing and the correction log. */
export function useHistory() {
  const historyRef = useRef<HistorySnapshot[]>([])
  const futureRef = useRef<HistorySnapshot[]>([])
  const [, force] = useState(0)

  const snapshot = useCallback((project: Project | null) => {
    if (!project) return
    historyRef.current.push(snapshotOf(project))
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift()
    futureRef.current = []
    force((n) => n + 1)
  }, [])

  const discardLast = useCallback(() => {
    historyRef.current.pop()
    force((n) => n + 1)
  }, [])

  const reset = useCallback(() => {
    historyRef.current = []
    futureRef.current = []
    force((n) => n + 1)
  }, [])

  const undo = useCallback((project: Project | null): HistorySnapshot | null => {
    if (!project || !historyRef.current.length) return null
    futureRef.current.push(snapshotOf(project))
    const prev = historyRef.current.pop()!
    force((n) => n + 1)
    return prev
  }, [])

  const redo = useCallback((project: Project | null): HistorySnapshot | null => {
    if (!project || !futureRef.current.length) return null
    historyRef.current.push(snapshotOf(project))
    const next = futureRef.current.pop()!
    force((n) => n + 1)
    return next
  }, [])

  return {
    snapshot,
    discardLast,
    reset,
    undo,
    redo,
    canUndo: historyRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  }
}
