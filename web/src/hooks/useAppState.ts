import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiClient, mediaUrl } from '../api'
import type {
  EncodeCfg,
  EncodeEvaluation,
  ExportTarget,
  PreviewState,
  Profile,
  Project,
  Segment,
  ServerConfig,
  SrcInfo,
  Boundary,
} from '../types'
import { fmt } from '../lib/format'
import { advanceOutput, buildOutputLane, copyClip, isWholeFileProject, makeWholeClips, moveClip, outputToSource, renameClip, splitClipAt, timeBoundary } from '../lib/clips'
import {
  BASIC_KEYS,
  collectEncode,
  countEncodeChanges,
  defaultEncode,
  encodeToValues,
  type EncodeValues,
} from '../lib/encode'
import { downloadJson, readAutosave, readFileAsText, readRecent, rememberProject, saveAutosave, saveRecent, type RecentItem } from '../lib/storage'
import { useHistory } from './useHistory'

export type SideTab = 'clips' | 'cues' | 'settings'
export type CueSubTab = 'pick' | 'proof'

export interface ConfirmRequest {
  title: string
  description: string
  confirmLabel?: string
  onConfirm: () => void
}

export interface PromptRequest {
  title: string
  label: string
  initialValue: string
  onConfirm: (value: string) => void
}

export interface ExportResultData {
  video: string
  totalMs: number
  subtitles: Record<string, string>
  warnings: string[]
  renamedFrom: string | null
  reuseNote: string
}

const ZOOM_STEPS = [1, 2, 4, 8, 16, 32]

export function useAppState() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const history = useHistory()

  const [project, setProject] = useState<Project | null>(null)
  const [state, setState] = useState<PreviewState | null>(null)
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [srcInfo, setSrcInfo] = useState<SrcInfo | null>(null)
  const [status, setStatus] = useState('就绪')
  const [tab, setTab] = useState<SideTab>('clips')
  const [cueSub, setCueSub] = useState<CueSubTab>('pick')
  const [activeSource, setActiveSource] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [cueTrack, setCueTrack] = useState<string | null>(null)
  const [activeCue, setActiveCue] = useState<number | null>(null)
  const [cueStart, setCueStart] = useState<number | null>(null)
  const [cueEnd, setCueEnd] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [selectedClip, setSelectedClip] = useState<number | null>(null)
  const [view, setView] = useState({ startMs: 0, zoom: 1 })
  const [follow, setFollow] = useState(true)
  const [volume, setVolume] = useState(100)
  const [playing, setPlaying] = useState(false)
  const [srcMs, setSrcMs] = useState(0)
  const [outputMs, setOutputMs] = useState<number | null>(null)
  const [followSeg, setFollowSeg] = useState(-1)
  const [cueLoopOn, setCueLoopOn] = useState(false)
  const [profileMode, setProfileModeState] = useState<'source' | 'builtin_720p' | 'custom'>('source')
  const [mode, setMode] = useState<'precise' | 'lossless'>('precise')
  const [presetSpeed, setPresetSpeed] = useState('medium')
  const [embedSubs, setEmbedSubs] = useState(false)
  const [snapToCue, setSnapToCue] = useState(false)
  const [snapTol, setSnapTol] = useState(500)
  const [encValues, setEncValues] = useState<EncodeValues>({})
  const [encCustomValues, setEncCustomValues] = useState<EncodeValues>({})
  const [lastCheck, setLastCheck] = useState<EncodeEvaluation | null>(null)
  const [outDir, setOutDir] = useState('')
  const [outName, setOutName] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [outDefault, setOutDefault] = useState<ExportTarget | null>(null)
  const [cueSearch, setCueSearch] = useState('')
  const [padStart, setPadStart] = useState(200)
  const [padEnd, setPadEnd] = useState(300)
  const [wbStep, setWbStep] = useState(100)
  const [wbTrackDelta, setWbTrackDelta] = useState(0)
  const [wbStartText, setWbStartText] = useState('')
  const [wbEndText, setWbEndText] = useState('')

  // Dialogs
  const [openDialog, setOpenDialog] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportStatusText, setExportStatusText] = useState('准备中…')
  const [exportProgress, setExportProgress] = useState(0)
  const [exportResult, setExportResult] = useState<ExportResultData | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [revealPath, setRevealPath] = useState('')
  const [confirmExport, setConfirmExport] = useState<{ sizeText: string; warnings: EncodeEvaluation['warnings'] } | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [promptReq, setPromptReq] = useState<PromptRequest | null>(null)

  // Latest-value refs (for timers / video callbacks that must not go stale).
  const projectRef = useRef(project)
  const stateRef = useRef(state)
  const followSegRef = useRef(-1)
  const lastOutputMsRef = useRef(0)
  const lastJumpAtRef = useRef(0)
  const lastRememberAtRef = useRef(0)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const outPathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingExportRef = useRef<(() => void) | null>(null)
  const outDirRef = useRef(outDir)
  const outNameRef = useRef(outName)
  const overwriteRef = useRef(overwrite)
  const profileModeRef = useRef(profileMode)
  const modeRef = useRef(mode)
  const encValuesRef = useRef(encValues)
  const encCustomValuesRef = useRef(encCustomValues)
  const cueLoopRef = useRef(cueLoopOn)
  const activeCueRef = useRef(activeCue)
  const cueTrackRef = useRef(cueTrack)

  projectRef.current = project
  stateRef.current = state
  outDirRef.current = outDir
  outNameRef.current = outName
  overwriteRef.current = overwrite
  profileModeRef.current = profileMode
  modeRef.current = mode
  encValuesRef.current = encValues
  encCustomValuesRef.current = encCustomValues
  cueLoopRef.current = cueLoopOn
  activeCueRef.current = activeCue
  cueTrackRef.current = cueTrack

  const currentSource = useMemo(
    () => (project?.sources || []).find((s) => s.id === activeSource) || null,
    [project, activeSource],
  )
  const currentTrack = useMemo(
    () =>
      (project?.tracks || []).find((t) => t.id === cueTrack) ||
      (project?.tracks || []).find((t) => t.source_id === activeSource) ||
      null,
    [project, cueTrack, activeSource],
  )
  const totalMs = state?.total_ms || 0
  const sourceDuration = currentSource?.duration_ms || 1
  const viewSpanMs = sourceDuration / view.zoom
  const viewEndMs = view.startMs + viewSpanMs

  const notify = useCallback((msg: string) => {
    setStatus(msg)
    toast(msg)
  }, [])

  const remember = useCallback((p: Project) => {
    const now = Date.now()
    if (now - lastRememberAtRef.current < 5000) return
    lastRememberAtRef.current = now
    rememberProject(p)
  }, [])

  const refreshExportPath = useCallback(async () => {
    const p = projectRef.current
    if (!p?.sources?.length) return
    try {
      const info = await apiClient.exportDefault(outDirRef.current.trim(), outNameRef.current.trim(), overwriteRef.current)
      setOutDefault(info)
    } catch (e) {
      setStatus('无法计算默认路径：' + (e as Error).message)
    }
  }, [])

  const scheduleExportPath = useCallback(() => {
    if (outPathTimerRef.current) clearTimeout(outPathTimerRef.current)
    outPathTimerRef.current = setTimeout(() => void refreshExportPath(), 180)
  }, [refreshExportPath])

  const syncProject = useCallback(
    async (immediate = false) => {
      const run = async () => {
        const p = projectRef.current
        if (!p) return
        try {
          const res = await apiClient.syncProject(p)
          setState(res.state)
          saveAutosave(p)
          remember(p)
          scheduleExportPath()
          setStatus('已同步')
        } catch (e) {
          setStatus('同步失败: ' + (e as Error).message)
        }
      }
      if (immediate) return run()
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
      syncTimerRef.current = setTimeout(() => void run(), 120)
    },
    [remember, scheduleExportPath],
  )

  const applyProject = useCallback(
    (proj: Project, st: PreviewState) => {
      setProject(proj)
      projectRef.current = proj
      setState(st)
      stateRef.current = st
      history.reset()
      if (!proj.sources.some((s) => s.id === activeSource)) {
        setActiveSource(proj.sources[0]?.id || null)
      }
      if (!proj.tracks.some((t) => t.id === cueTrack)) {
        setCueTrack(proj.tracks[0]?.id || null)
      }
      if (!activeGroup || !st.groups?.[activeGroup]) {
        const firstGroup = Object.keys(st.groups || {})[0] || proj.tracks[0]?.group_id || null
        setActiveGroup(firstGroup)
      }
      setChecked(new Set())
      setCueStart(null)
      setCueEnd(null)
      setActiveCue(null)
      setSelectedClip(null)
      followSegRef.current = -1
      setFollowSeg(-1)
      lastOutputMsRef.current = 0
      setOutputMs(null)
      const out = proj.output || ({} as Project['output'])
      setMode(out.mode || 'precise')
      modeRef.current = out.mode || 'precise'
      setPresetSpeed(out.preset || 'medium')
      setEmbedSubs(!!out.embed_subtitles)
      setSnapToCue(!!out.snap_to_cue)
      setSnapTol(out.snap_tolerance_ms ?? 500)
      const { values, customValues } = encodeToValues(out.encode || defaultEncode(), null, out.match_source_bitrate)
      setEncValues(values)
      setEncCustomValues(customValues)
      setProfileModeState(out.profile_mode || 'source')
      profileModeRef.current = out.profile_mode || 'source'
      setView({ startMs: 0, zoom: 1 })
      saveAutosave(proj)
      remember(proj)
      void refreshExportPath()
      void loadSourceEncodeInfo(proj.sources[0]?.id)
      setVideoSource(proj.sources[0]?.id || '')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, remember, refreshExportPath],
  )

  async function loadSourceEncodeInfo(sourceId?: string) {
    const proj = projectRef.current
    const src = (proj?.sources || []).find((s) => s.id === (sourceId || activeSource)) || proj?.sources[0]
    if (!src) {
      setSrcInfo(null)
      return
    }
    try {
      const info = await apiClient.encodeParams(src.path)
      setSrcInfo(info)
      // Re-derive option lists (resolution etc. depend on the source).
      const { values, customValues } = encodeToValues(
        projectRef.current?.output?.encode || defaultEncode(),
        info,
        projectRef.current?.output?.match_source_bitrate,
      )
      setEncValues(values)
      setEncCustomValues(customValues)
    } catch (e) {
      setSrcInfo(null)
      setStatus('原片参数读取失败: ' + (e as Error).message)
    }
    scheduleEncodeCheck()
  }

  const collectEncodeNow = useCallback((): EncodeCfg => {
    return collectEncode(encValuesRef.current, encCustomValuesRef.current, projectRef.current?.output?.match_source_bitrate)
  }, [])

  const syncOutputFromEncode = useCallback((): EncodeCfg | null => {
    const p = projectRef.current
    if (!p) return null
    const enc = collectEncodeNow()
    const next: Project = {
      ...p,
      output: {
        ...p.output,
        encode: enc,
        crf: enc.crf,
        match_source_bitrate: enc.rate_control === 'source',
        profile_mode: profileModeRef.current,
      },
    }
    setProject(next)
    projectRef.current = next
    return enc
  }, [collectEncodeNow])

  const persistProject = useCallback(async () => {
    const p = projectRef.current
    if (!p) return
    try {
      await apiClient.syncProject(p)
      void refreshExportPath()
    } catch (e) {
      setStatus('参数同步失败: ' + (e as Error).message)
    }
  }, [refreshExportPath])

  const runEncodeCheck = useCallback(async () => {
    const p = projectRef.current
    if (!p?.sources?.length) return
    const enc = syncOutputFromEncode()
    if (!enc) return
    await persistProject()
    try {
      const res = await apiClient.checkParams(
        enc,
        stateRef.current?.total_ms || 0,
        modeRef.current === 'lossless' ? 'lossless' : 'precise',
        enc.rate_control === 'source',
        profileModeRef.current,
      )
      setLastCheck(res)
    } catch (e) {
      setLastCheck(null)
      setStatus('参数检查失败: ' + (e as Error).message)
    }
  }, [persistProject, syncOutputFromEncode])

  const scheduleEncodeCheck = useCallback(() => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    checkTimerRef.current = setTimeout(() => void runEncodeCheck(), 260)
  }, [runEncodeCheck])

  // --- playback ------------------------------------------------------------
  const setVideoSource = useCallback(
    (sourceId: string, seekSeconds: number | null = null) => {
      const video = videoRef.current
      const src = (projectRef.current?.sources || []).find((s) => s.id === sourceId)
      if (!src || !video) return
      const url = mediaUrl(src.path)
      if (video.dataset.path !== src.path) {
        video.dataset.path = src.path
        video.src = url
        if (seekSeconds !== null) {
          video.addEventListener('loadedmetadata', () => {
            video.currentTime = seekSeconds
          }, { once: true })
        }
      } else if (seekSeconds !== null) {
        video.currentTime = seekSeconds
      }
      setActiveSource(sourceId)
    },
    [],
  )

  const seekToMs = useCallback(
    (ms: number) => {
      const src = currentSource
      if (!src) return
      setVideoSource(src.id, Math.max(0, Math.min(ms, Math.max(0, src.duration_ms - 50))) / 1000)
    },
    [currentSource, setVideoSource],
  )

  const seekOutput = useCallback(
    (ms: number) => {
      const hit = outputToSource(stateRef.current?.segments || [], ms)
      if (!hit) return
      followSegRef.current = hit.segIdx
      setFollowSeg(hit.segIdx)
      lastOutputMsRef.current = hit.outMs
      setOutputMs(hit.outMs)
      setVideoSource(hit.sourceId, hit.srcMs / 1000)
    },
    [setVideoSource],
  )

  const playWhenReady = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const go = () => {
      const p = video.play()
      if (p?.catch) p.catch(() => setStatus('播放失败：视频尚未就绪'))
    }
    if (Number(video.readyState) >= 2) go()
    else video.addEventListener('loadedmetadata', go, { once: true })
  }, [])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!projectRef.current?.sources?.length) {
      setStatus('请先打开视频')
      return
    }
    if (!video) return
    if (video.paused) playWhenReady()
    else video.pause()
  }, [playWhenReady])

  const nudge = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video || !video.src) return
    const dur = Number(video.duration) || 0
    video.currentTime = Math.max(0, Math.min(video.currentTime + seconds, Math.max(0, dur - 0.05)))
  }, [])

  const startOutputPreview = useCallback(() => {
    const segs = stateRef.current?.segments || []
    if (!segs.length) {
      notify('请先添加片段，再预览成片')
      return
    }
    setFollow(true)
    seekOutput(0)
    playWhenReady()
    setStatus('正在按输出顺序预览成片（跳过未保留部分）')
  }, [notify, playWhenReady, seekOutput])

  /** Called from the <video> timeupdate event. Implements follow-output,
   * single-cue loop, and the output clock. */
  const onVideoTime = useCallback((srcMsNow: number) => {
    setSrcMs(srcMsNow)
    const video = videoRef.current
    const paused = video?.paused ?? true
    // Single-cue loop.
    if (cueLoopRef.current && !paused) {
      const track = (projectRef.current?.tracks || []).find((t) => t.id === cueTrackRef.current)
      const c = track?.cues[activeCueRef.current ?? -1]
      if (c && srcMsNow >= c.end_ms - 3 && video) video.currentTime = c.start_ms / 1000
    }
    const segs = stateRef.current?.segments || []
    let outMs: number | null = null
    if (follow && segs.length) {
      const detected = segs.findIndex(
        (s) => s.source_id === activeSource && srcMsNow >= s.in_ms - 60 && srcMsNow < s.out_ms - 20,
      )
      followSegRef.current = detected
      setFollowSeg(detected)
      const seg = detected >= 0 ? segs[detected] : null
      if (seg) {
        outMs = seg.offset_ms + Math.max(0, srcMsNow - seg.in_ms)
        lastOutputMsRef.current = outMs
        if (!paused && srcMsNow >= seg.out_ms - 40 && Date.now() - lastJumpAtRef.current > 600) {
          const jump = advanceOutput(segs, detected, srcMsNow)
          if (jump) {
            lastJumpAtRef.current = Date.now()
            if ('done' in jump) {
              video?.pause()
            } else {
              followSegRef.current = jump.segIdx
              setFollowSeg(jump.segIdx)
              lastOutputMsRef.current = segs[jump.segIdx].offset_ms || 0
              setVideoSource(segs[jump.segIdx].source_id, jump.srcMs / 1000)
              playWhenReady()
            }
          }
        }
      }
    }
    setOutputMs(outMs)
  }, [follow, activeSource, setVideoSource, playWhenReady])

  // --- undo / redo ---------------------------------------------------------
  const undo = useCallback(() => {
    const p = projectRef.current
    if (!p) return
    const prev = history.undo(p)
    if (!prev) {
      setStatus('没有可撤销的操作')
      return
    }
    const next: Project = { ...p, clips: prev.clips, tracks: prev.tracks, cue_edits: prev.cue_edits }
    setProject(next)
    projectRef.current = next
    setSelectedClip(null)
    void syncProject(true)
    setStatus('已撤销（可用 Ctrl+Shift+Z 重做）')
  }, [history, syncProject])

  const redo = useCallback(() => {
    const p = projectRef.current
    if (!p) return
    const nextSnap = history.redo(p)
    if (!nextSnap) {
      setStatus('没有可重做的操作')
      return
    }
    const next: Project = { ...p, clips: nextSnap.clips, tracks: nextSnap.tracks, cue_edits: nextSnap.cue_edits }
    setProject(next)
    projectRef.current = next
    setSelectedClip(null)
    void syncProject(true)
    setStatus('已重做')
  }, [history, syncProject])

  const updateProject = useCallback((mutate: (p: Project) => Project, opts?: { snapshot?: boolean }) => {
    const p = projectRef.current
    if (!p) return
    if (opts?.snapshot !== false) history.snapshot(p)
    const next = mutate(p)
    setProject(next)
    projectRef.current = next
  }, [history])

  // --- clips ---------------------------------------------------------------
  const addTimeClip = useCallback(
    async (msStart: number, msEnd: number) => {
      const p = projectRef.current
      if (!p) return
      let start: Boundary = timeBoundary(msStart)
      let end: Boundary = timeBoundary(msEnd)
      if (snapToCue) {
        const tol = snapTol || 500
        try {
          const [a, b] = await Promise.all([
            apiClient.snap(activeSource || '', msStart, tol),
            apiClient.snap(activeSource || '', msEnd, tol),
          ])
          if (a.boundary) start = a.boundary as typeof start
          if (b.boundary) end = b.boundary as typeof end
        } catch (e) {
          setStatus('吸附失败: ' + (e as Error).message)
        }
      }
      updateProject((proj) => ({
        ...proj,
        clips: [
          ...(proj.clips || []),
          {
            id: `c${Math.random().toString(36).slice(2, 9)}`,
            source_id: activeSource || '',
            start,
            end,
            track_ids: [],
            label: `${fmt(msStart).slice(3, 12)}-${fmt(msEnd).slice(3, 12)}`,
          },
        ],
      }))
      setSelectedClip((projectRef.current?.clips.length || 1) - 1)
      await syncProject(true)
      const kind = start.kind === 'cue' || end.kind === 'cue' ? '（已吸附到字幕）' : ''
      setStatus(`已添加片段 ${fmt(msStart)} → ${fmt(msEnd)}${kind}`)
    },
    [activeSource, snapToCue, snapTol, syncProject, updateProject],
  )

  const commitClipDrag = useCallback(
    async (d: { i: number; mode: 'start' | 'end' | 'move'; start: number; end: number }) => {
      const p = projectRef.current
      const clip = p?.clips[d.i]
      if (!clip || !p) return
      history.snapshot(p)
      const nextClips = JSON.parse(JSON.stringify(p.clips)) as Project['clips']
      const c = nextClips[d.i]
      if (d.mode === 'start' || d.mode === 'move') c.start = timeBoundary(d.start)
      if (d.mode === 'end' || d.mode === 'move') c.end = timeBoundary(d.end)
      c.label = `${fmt(d.start).slice(3, 12)}-${fmt(d.end).slice(3, 12)}`
      if (snapToCue && d.mode !== 'move') {
        const ms = d.mode === 'start' ? d.start : d.end
        try {
          const res = await apiClient.snap(activeSource || '', ms, snapTol || 500)
          if (res.boundary) {
            if (d.mode === 'start') c.start = res.boundary as typeof c.start
            else c.end = res.boundary as typeof c.end
          }
        } catch (e) {
          setStatus('吸附失败: ' + (e as Error).message)
        }
      }
      const next: Project = { ...p, clips: nextClips }
      setProject(next)
      projectRef.current = next
      await syncProject(true)
      setStatus(`片段 ${d.i + 1} 已调整：${fmt(d.start)} → ${fmt(d.end)}（另一端保持不变）`)
    },
    [activeSource, history, snapToCue, snapTol, syncProject],
  )

  const clipOp = useCallback(
    async (i: number, op: 'up' | 'down' | 'split' | 'copy' | 'del') => {
      const p = projectRef.current
      if (!p) return
      const clips = p.clips || []
      const seg = stateRef.current?.segments?.[i] || null
      let next: Project['clips'] | null = null
      let note = ''
      let selectAt: number | null = i
      if (op === 'del') {
        next = clips.filter((_, n) => n !== i)
        selectAt = null
        note = `已删除片段 ${i + 1}`
      } else if (op === 'up' && i > 0) {
        next = moveClip(clips, i, i - 1)
        selectAt = i - 1
        note = `片段已上移到第 ${i} 位`
      } else if (op === 'down' && i < clips.length - 1) {
        next = moveClip(clips, i, i + 1)
        selectAt = i + 2
        note = `片段已下移到第 ${i + 2} 位`
      } else if (op === 'copy') {
        next = copyClip(clips, i)
        selectAt = i + 1
        note = `已复制片段 ${i + 1}（Ctrl+Z 可撤销）`
      } else if (op === 'split') {
        const playMs = Number(videoRef.current?.currentTime || 0) * 1000
        const usable = seg && activeSource === seg.source_id && playMs > seg.in_ms + 100 && playMs < seg.out_ms - 100
        const at = usable ? playMs : seg ? (seg.in_ms + seg.out_ms) / 2 : null
        next = at === null ? null : splitClipAt(clips, i, at, seg)
        if (!next || at === null) {
          setStatus('片段太短或拆分点太靠边，请先把播放头移到片段中间')
          return
        }
        note = `已在 ${fmt(Math.round(at))} 拆成两段（${usable ? '按播放头' : '按中点'}）`
      }
      if (!next) return
      updateProject((proj) => ({ ...proj, clips: next! }))
      setSelectedClip(selectAt)
      await syncProject(true)
      setStatus(note)
    },
    [activeSource, syncProject, updateProject],
  )

  const renameClipAt = useCallback(
    async (i: number, label: string) => {
      const p = projectRef.current
      if (!p) return
      const next = renameClip(p.clips || [], i, label)
      if (!next) return
      updateProject((proj) => ({ ...proj, clips: next }))
      await syncProject(true)
      setStatus('已重命名')
    },
    [syncProject, updateProject],
  )

  const commitTimeInput = useCallback(
    async (i: number, edge: 'start' | 'end', ms: number) => {
      const p = projectRef.current
      const clip = p?.clips[i]
      const seg = stateRef.current?.segments?.[i]
      if (!clip || !seg || !p) return false
      const owner = (p.sources || []).find((s) => s.id === clip.source_id)
      const dur = owner?.duration_ms || 0
      const value =
        edge === 'start'
          ? Math.max(0, Math.min(ms, seg.out_ms - 100))
          : Math.max(seg.in_ms + 100, Math.min(ms, dur || ms))
      if (value === (edge === 'start' ? seg.in_ms : seg.out_ms)) return true
      history.snapshot(p)
      const nextClips = JSON.parse(JSON.stringify(p.clips)) as Project['clips']
      nextClips[i][edge] = timeBoundary(value)
      nextClips[i].label = `${fmt(edge === 'start' ? value : seg.in_ms).slice(3, 12)}-${fmt(edge === 'end' ? value : seg.out_ms).slice(3, 12)}`
      const next: Project = { ...p, clips: nextClips }
      setProject(next)
      projectRef.current = next
      setSelectedClip(i)
      await syncProject(true)
      setStatus(`片段 ${i + 1} 的${edge === 'start' ? '起点' : '终点'}改为 ${fmt(value)}（另一端不变）`)
      return true
    },
    [history, syncProject],
  )

  const moveClipOrder = useCallback(
    async (from: number, to: number) => {
      const p = projectRef.current
      if (!p) return
      const next = moveClip(p.clips || [], from, to)
      if (!next) return
      updateProject((proj) => ({ ...proj, clips: next }))
      setSelectedClip(to)
      await syncProject(true)
      setStatus(`片段 ${from + 1} 已移到第 ${to + 1} 位（Ctrl+Z 可撤销）`)
    },
    [syncProject, updateProject],
  )

  const applyWholeClips = useCallback(async () => {
    const p = projectRef.current
    if (!p?.sources?.length) {
      notify('请先打开视频')
      return
    }
    const clips = makeWholeClips(p.sources)
    if (!clips.length) {
      notify('没有探测到可用的视频时长')
      return
    }
    if (p.clips.length) {
      setConfirmReq({
        title: '替换为整片（不剪辑）吗？',
        description: `已有 ${p.clips.length} 个片段，将替换为每个源片 0 → 全长的片段。`,
        onConfirm: () => {
          updateProject((proj) => ({ ...proj, clips }))
          setSelectedClip(null)
          setChecked(new Set())
          void syncProject(true)
          setStatus(`已按 ${clips.length} 个源片铺满全长（0 → 片尾），时间轴不变`)
        },
      })
      return
    }
    updateProject((proj) => ({ ...proj, clips }))
    setSelectedClip(null)
    setChecked(new Set())
    await syncProject(true)
    setStatus(`已按 ${clips.length} 个源片铺满全长（0 → 片尾），时间轴不变`)
  }, [notify, syncProject, updateProject])

  const clearClips = useCallback(async () => {
    const p = projectRef.current
    if (!p?.clips?.length) return
    setConfirmReq({
      title: `清空全部 ${p.clips.length} 个片段？`,
      description: '可以用 Ctrl+Z 撤销。',
      confirmLabel: '清空',
      onConfirm: () => {
        updateProject((proj) => ({ ...proj, clips: [] }))
        setSelectedClip(null)
        void syncProject(true)
        setStatus('已清空片段（Ctrl+Z 可撤销）')
      },
    })
  }, [syncProject, updateProject])

  // --- cues ----------------------------------------------------------------
  const selectCue = useCallback(
    (index: number, seek = false) => {
      setActiveCue(index)
      if (seek) {
        const track = currentTrack
        const c = track?.cues[index]
        if (c) setVideoSource(track.source_id, c.start_ms / 1000)
      }
    },
    [currentTrack, setVideoSource],
  )

  const visibleCueIndices = useCallback((): number[] => {
    const track = currentTrack
    if (!track) return []
    const needle = cueSearch.trim().toLowerCase()
    return track.cues
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !needle || c.lines.join(' ').toLowerCase().includes(needle))
      .map(({ i }) => i)
  }, [currentTrack, cueSearch])

  const addClipsFromEndpoints = useCallback(async () => {
    const p = projectRef.current
    const track = currentTrack
    if (cueStart === null || cueEnd === null) {
      notify('请先分别设置起点行和终点行')
      return
    }
    if (cueStart > cueEnd) {
      notify('起点行不能晚于终点行')
      return
    }
    if (!p || !track) return
    updateProject((proj) => ({
      ...proj,
      clips: [
        ...(proj.clips || []),
        {
          id: `c${Math.random().toString(36).slice(2, 9)}`,
          source_id: track.source_id,
          start: { kind: 'cue', ms: 0, padding_ms: padStart || 0, cue_ref: { track_id: track.id, cue_index: cueStart, edge: 'start' } },
          end: { kind: 'cue', ms: 0, padding_ms: padEnd || 0, cue_ref: { track_id: track.id, cue_index: cueEnd, edge: 'end' } },
          track_ids: [track.id],
          label: `字幕 ${cueStart + 1}-${cueEnd + 1}`,
        },
      ],
    }))
    setSelectedClip((projectRef.current?.clips.length || 1) - 1)
    await syncProject(true)
    setStatus(`已按字幕 ${cueStart + 1}–${cueEnd + 1} 行生成片段`)
  }, [cueStart, cueEnd, currentTrack, notify, padStart, padEnd, syncProject, updateProject])

  const addClipsFromChecked = useCallback(async () => {
    const track = currentTrack
    if (!checked.size) {
      notify('请先勾选字幕行')
      return
    }
    if (!track) return
    history.snapshot(projectRef.current!)
    try {
      const res = await apiClient.clipsFromCues({
        source_id: track.source_id,
        track_id: track.id,
        indices: [...checked],
        padding_start_ms: padStart || 0,
        padding_end_ms: padEnd || 0,
        merge_gap_ms: 0,
        id_prefix: 'cue',
        replace: false,
      })
      const proj = res.project
      setProject(proj)
      projectRef.current = proj
      setState(res.state)
      stateRef.current = res.state
      setChecked(new Set())
      setSelectedClip(proj.clips.length ? proj.clips.length - 1 : null)
      setStatus(`已由勾选字幕生成 ${res.clips.length} 个片段`)
    } catch (e) {
      history.discardLast()
      setStatus('生成片段失败: ' + (e as Error).message)
    }
  }, [checked, currentTrack, history, padStart, padEnd])

  // --- calibration workbench ----------------------------------------------
  const commitCueEdit = useCallback(
    async (body: Record<string, unknown>) => {
      const track = currentTrack
      if (!track) return
      body.track_id = track.id
      history.snapshot(projectRef.current!)
      try {
        const res = await apiClient.shiftCues(body)
        const proj = res.project
        setProject(proj)
        projectRef.current = proj
        setState(res.state)
        stateRef.current = res.state
        const msg = res.clamped
          ? `已保存 · ${res.clamped} 句被夹到边界`
          : `已保存矫正（本轨已改 ${res.summary?.track_edit_count ?? '?'} 句）`
        setStatus(msg)
        if (cueLoopRef.current) {
          const c = (projectRef.current?.tracks || []).find((t) => t.id === track.id)?.cues[activeCueRef.current ?? -1]
          const video = videoRef.current
          if (c && video) {
            video.currentTime = c.start_ms / 1000
            if (video.paused) playWhenReady()
          }
        }
      } catch (e) {
        history.discardLast()
        setStatus('矫正失败: ' + (e as Error).message)
      }
    },
    [currentTrack, history, playWhenReady],
  )

  const wbShift = useCallback(
    async (delta: number, edge: 'start' | 'end' | 'both') => {
      if (activeCueRef.current == null) {
        setStatus('先选一句字幕')
        return
      }
      await commitCueEdit({ action: 'shift', indices: [activeCueRef.current], delta_ms: delta, edge })
    },
    [commitCueEdit],
  )

  const wbSetExact = useCallback(
    async (start: number, end: number) => {
      if (activeCueRef.current == null) {
        setStatus('先选一句字幕')
        return
      }
      await commitCueEdit({ action: 'set', index: activeCueRef.current, start_ms: start, end_ms: end })
    },
    [commitCueEdit],
  )

  const wbShiftWholeTrack = useCallback(
    async (delta: number, all: boolean) => {
      await commitCueEdit({ action: 'shift', scope: all ? 'all_tracks' : 'track', indices: [], delta_ms: delta, edge: 'both' })
    },
    [commitCueEdit],
  )

  const wbReload = useCallback(async () => {
    const track = currentTrack
    if (!track) return
    setConfirmReq({
      title: '从源文件重载本轨？',
      description: '将放弃本轨所有矫正，回到源 .srt。',
      confirmLabel: '重载',
      onConfirm: async () => {
        history.snapshot(projectRef.current!)
        try {
          const res = await apiClient.shiftCues({ action: 'reload', track_id: track.id })
          setProject(res.project)
          projectRef.current = res.project
          setState(res.state)
          stateRef.current = res.state
          setStatus('已从源文件重载本轨字幕')
        } catch (e) {
          history.discardLast()
          setStatus('重载失败: ' + (e as Error).message)
        }
      },
    })
  }, [currentTrack, history])

  const toggleCueLoop = useCallback(() => {
    if (!cueLoopRef.current) {
      if (activeCueRef.current == null) {
        const track = currentTrack
        if (!track) {
          setStatus('先选一句字幕再开循环')
          return
        }
        setActiveCue(0)
        activeCueRef.current = 0
      }
      setCueLoopOn(true)
      const c = currentTrack?.cues[activeCueRef.current ?? 0]
      const video = videoRef.current
      if (c && video) video.currentTime = c.start_ms / 1000
      playWhenReady()
    } else {
      setCueLoopOn(false)
    }
  }, [currentTrack, playWhenReady])

  const gotoCueRelative = useCallback(
    (dir: number) => {
      const track = currentTrack
      if (!track) return
      let i = activeCueRef.current == null ? (dir > 0 ? 0 : track.cues.length - 1) : activeCueRef.current + dir
      i = Math.max(0, Math.min(i, track.cues.length - 1))
      selectCue(i, true)
    },
    [currentTrack, selectCue],
  )

  const showCueSub = useCallback(
    (sub: CueSubTab) => {
      setCueSub(sub)
      if (sub === 'proof' && activeCueRef.current == null) {
        const track = currentTrack
        if (track && track.cues.length) {
          const t = (videoRef.current?.currentTime || 0) * 1000
          let idx = track.cues.findIndex((c) => c.start_ms <= t && t < c.end_ms)
          if (idx < 0) idx = 0
          setActiveCue(idx)
        }
      }
    },
    [currentTrack],
  )

  const wbSummary = useCallback(() => {
    const track = currentTrack
    const p = projectRef.current
    if (!track || !p) return null
    const edits = (p.cue_edits || []).filter((e) => e.kind !== 'reload')
    const mine = edits.filter((e) => e.track_id === track.id)
    const corrected = new Set(mine.map((e) => e.cue_index))
    const cs = track.cues.slice().sort((a, b) => a.start_ms - b.start_ms)
    let overlaps = 0
    for (let k = 1; k < cs.length; k++) if (cs[k].start_ms < cs[k - 1].end_ms) overlaps++
    return { track_edit_count: mine.length, corrected_indices: [...corrected], overlaps }
  }, [currentTrack])

  // --- export ---------------------------------------------------------------
  const exportSubtitlesOnly = useCallback(async () => {
    const track = currentTrack
    const p = projectRef.current
    if (!track || !track.cues.length) {
      notify('没有可导出的字幕')
      return
    }
    const fmtMode = p?.output?.encode?.subtitle_format || 'srt'
    try {
      const res = await apiClient.exportSubtitles({
        format: fmtMode,
        output_dir: outDirRef.current || '',
        output_name: outNameRef.current || '',
        overwrite: overwriteRef.current || false,
      })
      setExportStatusText(res.remapped ? '已按当前片段重映射并导出字幕' : '已导出矫正后的字幕（未剪辑）')
      setExportResult({
        video: '',
        totalMs: 0,
        subtitles: res.subtitles,
        warnings: [],
        renamedFrom: res.renamed_from?.join(', ') || null,
        reuseNote: '',
      })
      setExportError(null)
      setExportProgress(100)
      setRevealPath(res.dir)
      setExportOpen(true)
      setStatus('字幕已导出')
    } catch (e) {
      setStatus('导出字幕失败: ' + (e as Error).message)
    }
  }, [currentTrack, notify])

  const pollExport = useCallback(
    (taskId: string) => {
      const tick = async () => {
        let res
        try {
          res = await apiClient.exportStatus(taskId)
        } catch (e) {
          setExportStatusText('状态查询失败: ' + (e as Error).message)
          return
        }
        setExportStatusText(`${res.message} (${res.percent}%)`)
        setExportProgress(res.percent)
        if (res.status === 'running') {
          setTimeout(tick, 500)
          return
        }
        if (res.status === 'error') {
          setExportError(res.error || '导出失败')
          return
        }
        const r = res.result || ({} as NonNullable<typeof res.result>)
        const reuseNote =
          projectRef.current && !projectRef.current.tracks?.length && isWholeFileProject(projectRef.current) && !Object.keys(r.subtitles || {}).length
            ? (() => {
                const file = String(r.video || '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || ''
                return `这次是「整片压缩」，时间轴没有变化：把原来的字幕文件改名成 ${file ? `${file}.srt` : '与视频同名的 .srt'} 放在视频旁边就能直接继续使用，不需要重新生成字幕。`
              })()
            : ''
        setExportResult({
          video: r.video || '',
          totalMs: r.total_ms || 0,
          subtitles: r.subtitles || {},
          warnings: r.warnings || [],
          renamedFrom: r.renamed_from ? String(r.video || '').split(/[\\/]/).pop() || null : null,
          reuseNote,
        })
        setExportError(null)
        setRevealPath(r.video || r.output_dir || '')
        void refreshExportPath()
        try {
          const cur = await apiClient.getProject()
          setProject(cur.project)
          projectRef.current = cur.project
          setState(cur.state)
          stateRef.current = cur.state
        } catch {
          /* keep current state */
        }
      }
      setTimeout(tick, 300)
    },
    [refreshExportPath],
  )

  const startExport = useCallback(async () => {
    const p = projectRef.current
    if (!p?.sources?.length) {
      notify('请先打开视频')
      return
    }
    if (!p?.clips?.length) {
      notify('请先添加至少一个片段')
      return
    }
    const enc = syncOutputFromEncode()
    if (!enc) return
    const output = {
      ...p.output,
      mode: modeRef.current,
      crf: enc.crf,
      preset: presetSpeed,
      match_source_bitrate: enc.rate_control === 'source',
      embed_subtitles: embedSubs,
      snap_to_cue: snapToCue,
      snap_tolerance_ms: snapTol || 500,
      profile_mode: profileModeRef.current,
    }
    const next: Project = { ...p, output }
    setProject(next)
    projectRef.current = next
    let evaluation = lastCheck
    try {
      evaluation = await apiClient.checkParams(
        enc,
        totalMs,
        output.mode,
        output.match_source_bitrate,
        output.profile_mode,
      )
      setLastCheck(evaluation)
    } catch (e) {
      setStatus('导出前检查失败: ' + (e as Error).message)
    }
    const proceed = async () => {
      setExportOpen(true)
      setExportStatusText('准备中…')
      setExportProgress(0)
      setExportResult(null)
      setExportError(null)
      setRevealPath('')
      try {
        await apiClient.syncProject(projectRef.current!)
        const res = await apiClient.startExport({
          output_dir: outDirRef.current.trim(),
          output_name: outNameRef.current.trim(),
          overwrite: overwriteRef.current,
        })
        pollExport(res.task_id)
      } catch (e) {
        setExportStatusText('导出失败: ' + (e as Error).message)
      }
    }
    const warns = (evaluation?.warnings || []).filter((w) => w.level === 'warn')
    if (!warns.length) {
      void proceed()
      return
    }
    const est = evaluation?.estimated_bytes
    pendingExportRef.current = () => void proceed()
    setConfirmExport({
      sizeText:
        est !== null && est !== undefined
          ? `当前预计体积 ${(est / 1048576).toFixed(1)} MB（已修改 ${countEncodeChanges(enc)} 项参数）。`
          : '当前使用 CRF，体积无法预估。',
      warnings: warns,
    })
  }, [embedSubs, lastCheck, pollExport, presetSpeed, snapToCue, snapTol, syncOutputFromEncode, totalMs, notify])

  const confirmExportGo = useCallback(() => {
    const fn = pendingExportRef.current
    pendingExportRef.current = null
    setConfirmExport(null)
    if (fn) fn()
  }, [])

  const reveal = useCallback(async () => {
    if (!revealPath) return
    try {
      await apiClient.reveal(revealPath)
      setStatus('已在文件管理器中打开输出文件夹')
    } catch (e) {
      setStatus('打开文件夹失败: ' + (e as Error).message)
    }
  }, [revealPath])

  // --- profiles & presets ---------------------------------------------------
  const setProfileModeFull = useCallback(
    (m: 'source' | 'builtin_720p' | 'custom') => {
      setProfileModeState(m)
      profileModeRef.current = m
      const p = projectRef.current
      if (p?.output) {
        const next: Project = { ...p, output: { ...p.output, profile_mode: m } }
        setProject(next)
        projectRef.current = next
      }
      if (m === 'builtin_720p' && modeRef.current === 'lossless') {
        setMode('precise')
        modeRef.current = 'precise'
        const p2 = projectRef.current
        if (p2?.output) {
          const next: Project = { ...p2, output: { ...p2.output, mode: 'precise' } }
          setProject(next)
          projectRef.current = next
        }
        setStatus('720p 预设需要重新编码，已自动切到精确模式')
      }
      void persistProject()
      scheduleEncodeCheck()
    },
    [persistProject, scheduleEncodeCheck],
  )

  const applyBuiltinAsCustom = useCallback(() => {
    const prof = profiles.find((x) => x.id === 'builtin_720p')
    if (prof?.encode) {
      const { values, customValues } = encodeToValues(prof.encode, srcInfo, false)
      setEncValues(values)
      setEncCustomValues(customValues)
      encValuesRef.current = values
      encCustomValuesRef.current = customValues
    }
    if (prof?.speed) setPresetSpeed(prof.speed)
    setEmbedSubs(false)
    setMode('precise')
    modeRef.current = 'precise'
    setProfileModeFull('custom')
    setStatus('已把 720p 预设填入自定义参数，现在可以微调')
  }, [profiles, setProfileModeFull, srcInfo])

  const applyPresetValues = useCallback(
    (preset: { encode: EncodeCfg; preset: string; embed_subtitles: boolean }) => {
      const { values, customValues } = encodeToValues(preset.encode || defaultEncode(), srcInfo, undefined)
      setEncValues(values)
      setEncCustomValues(customValues)
      encValuesRef.current = values
      encCustomValuesRef.current = customValues
      if (preset.preset) setPresetSpeed(preset.preset)
      setEmbedSubs(!!preset.embed_subtitles)
      scheduleEncodeCheck()
      setStatus('已应用参数预设')
    },
    [scheduleEncodeCheck, srcInfo],
  )

  const shrinkPreset = useCallback(() => {
    const src = srcInfo?.video || {}
    const enc = defaultEncode()
    enc.rate_control = 'bitrate'
    enc.video_kbps = Math.max(150, Math.round(((src.video_kbps as number) || 800) * 0.5))
    enc.audio_kbps = 96
    const { values, customValues } = encodeToValues(enc, srcInfo, undefined)
    setEncValues(values)
    setEncCustomValues(customValues)
    encValuesRef.current = values
    encCustomValuesRef.current = customValues
    syncOutputFromEncode()
    scheduleEncodeCheck()
    setStatus(`已应用「省体积」：视频目标码率 ${enc.video_kbps} kbps、音频 96 kbps（画质会下降，可继续微调）`)
  }, [scheduleEncodeCheck, srcInfo, syncOutputFromEncode])

  const resetEncode = useCallback(() => {
    const { values, customValues } = encodeToValues(defaultEncode(), srcInfo, undefined)
    setEncValues(values)
    setEncCustomValues(customValues)
    encValuesRef.current = values
    encCustomValuesRef.current = customValues
    syncOutputFromEncode()
    scheduleEncodeCheck()
    setStatus('已恢复为沿用原片参数')
  }, [scheduleEncodeCheck, srcInfo, syncOutputFromEncode])

  // --- project files ---------------------------------------------------------
  const saveProjectFile = useCallback(() => {
    const p = projectRef.current
    if (!p?.sources?.length) {
      notify('请先打开媒体')
      return
    }
    const base = String(p.name || 'clip-video').replace(/[\\/:*?"<>|]/g, '_')
    downloadJson(base + '.clip-video.json', { version: 1, app: 'clip-video', saved_at: new Date().toISOString(), project: p })
    setStatus('工程已导出为 JSON（片段、字幕轨与参数都在里面）')
  }, [notify])

  const loadProjectPayload = useCallback(
    async (payload: { project: Project }) => {
      const proj = payload?.project
      if (!proj?.sources?.length) throw new Error('文件里没有工程数据')
      const res = await apiClient.loadProject(proj)
      applyProject(res.project, res.state)
      setStatus('工程已载入')
    },
    [applyProject],
  )

  const loadProjectFile = useCallback(
    async (file: File) => {
      const text = await readFileAsText(file)
      await loadProjectPayload(JSON.parse(text))
    },
    [loadProjectPayload],
  )

  const loadRecentItem = useCallback(
    async (item: RecentItem) => {
      await loadProjectPayload({ project: item.project })
      setRecentOpen(false)
      setStatus('已载入最近工程：' + (item.name || ''))
    },
    [loadProjectPayload],
  )

  // --- open media ------------------------------------------------------------
  const loadSelected = useCallback(
    async (videos: string[], subtitles: { path: string; source_id: string; group_id: string; label: string; lang: string }[], auto: boolean) => {
      if (!videos.length) {
        notify('请先选择至少一个视频')
        return
      }
      setStatus('正在载入媒体…')
      try {
        const res = await apiClient.open(videos, subtitles, auto)
        applyProject(res.project, res.state)
        setOpenDialog(false)
        const trackCount = res.project.tracks?.length || 0
        setStatus(
          `已载入 ${videos.length} 个视频、${trackCount} 条字幕轨` +
            (trackCount ? '' : '（未载入字幕：整片压缩时把原 .srt 改名即可复用）'),
        )
      } catch (e) {
        notify('载入失败: ' + (e as Error).message)
        setStatus('载入失败')
      }
    },
    [applyProject, notify],
  )

  // --- init ------------------------------------------------------------------
  const init = useCallback(async () => {
    try {
      const profs = await apiClient.getProfiles()
      setProfiles(profs.profiles || [])
    } catch {
      /* catalogue is backend-owned; a slow load just leaves the card empty */
    }
    try {
      setConfig(await apiClient.getConfig())
    } catch (e) {
      setStatus('配置读取失败: ' + (e as Error).message)
    }
    try {
      const cur = await apiClient.getProject()
      if (cur.project?.sources?.length) {
        applyProject(cur.project, cur.state)
      } else {
        const saved = readAutosave()
        if (saved?.project?.sources?.length) {
          try {
            const res = await apiClient.loadProject(saved.project)
            applyProject(res.project, res.state)
            setStatus(`已自动恢复上次工程${saved.saved_at ? '（' + saved.saved_at.slice(0, 16).replace('T', ' ') + '）' : ''} · 点「打开媒体」可换片子`)
          } catch (err) {
            const rec = await apiClient.getRecover().catch(() => null)
            if (rec?.project?.sources?.length) {
              const res = await apiClient.loadProject(rec.project)
              applyProject(res.project, res.state)
              setStatus('已从磁盘自动恢复上次校正进度')
            } else {
              setStatus('上次工程无法恢复（视频文件可能已移动）：' + (err as Error).message + ' · 点「打开媒体」开始')
            }
          }
        } else {
          const rec = await apiClient.getRecover().catch(() => null)
          if (rec?.project?.sources?.length) {
            const res = await apiClient.loadProject(rec.project)
            applyProject(res.project, res.state)
            setStatus('已从磁盘自动恢复上次校正进度')
          } else {
            setStatus('就绪 · 点击「打开媒体」开始')
          }
        }
      }
    } catch (e) {
      setStatus('初始化失败: ' + (e as Error).message)
    }
  }, [applyProject])

  useEffect(() => {
    const onResize = () => setView((v) => ({ ...v }))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** Update one encode-panel value and immediately re-run the live check.
   * The ref is updated synchronously so collectEncode() sees the new value. */
  const updateEncode = useCallback(
    (key: string, value: string, customValue?: string) => {
      const nv = { ...encValuesRef.current, [key]: value }
      encValuesRef.current = nv
      setEncValues(nv)
      if (customValue !== undefined) {
        const nc = { ...encCustomValuesRef.current, [key]: customValue }
        encCustomValuesRef.current = nc
        setEncCustomValues(nc)
      }
      syncOutputFromEncode()
      scheduleEncodeCheck()
    },
    [scheduleEncodeCheck, syncOutputFromEncode],
  )

  /** Patch project.output fields, persist, and re-run the live check. */
  const updateOutput = useCallback(
    (patch: Partial<Project['output']>) => {
      const p = projectRef.current
      if (!p) return
      const next: Project = { ...p, output: { ...p.output, ...patch } }
      setProject(next)
      projectRef.current = next
      void persistProject()
      scheduleEncodeCheck()
    },
    [persistProject, scheduleEncodeCheck],
  )

  const outputLane = useMemo(() => buildOutputLane(state?.segments || [], totalMs), [state, totalMs])
  const segments: Segment[] = state?.segments || []

  return {
    videoRef, project, state, config, profiles, srcInfo, status, setStatus, notify,
    tab, setTab, cueSub, setCueSub,
    activeSource, setActiveSource, activeGroup, setActiveGroup, cueTrack, setCueTrack,
    activeCue, setActiveCue, cueStart, setCueStart, cueEnd, setCueEnd,
    checked, setChecked, selectedClip, setSelectedClip,
    view, setView, follow, setFollow, volume, setVolume, playing, setPlaying,
    srcMs, outputMs, followSeg, cueLoopOn, setCueLoopOn,
    profileMode, mode, setMode, presetSpeed, setPresetSpeed, embedSubs, setEmbedSubs,
    snapToCue, setSnapToCue, snapTol, setSnapTol,
    encValues, setEncValues, encCustomValues, setEncCustomValues, lastCheck,
    outDir, setOutDir, outName, setOutName, overwrite, setOverwrite, outDefault,
    cueSearch, setCueSearch, padStart, setPadStart, padEnd, setPadEnd,
    wbStep, setWbStep, wbTrackDelta, setWbTrackDelta, wbStartText, setWbStartText, wbEndText, setWbEndText,
    openDialog, setOpenDialog, helpOpen, setHelpOpen, recentOpen, setRecentOpen,
    dirOpen, setDirOpen, exportOpen, setExportOpen,
    exportStatusText, setExportStatusText, exportProgress, setExportProgress,
    exportResult, setExportResult, exportError, setExportError, revealPath, setRevealPath,
    confirmExport, setConfirmExport, confirmReq, setConfirmReq, promptReq, setPromptReq,
    currentSource, currentTrack, totalMs, sourceDuration, viewSpanMs, viewEndMs, segments, outputLane,
    canUndo: history.canUndo, canRedo: history.canRedo,
    history, applyProject, syncProject, refreshExportPath, scheduleExportPath,
    loadSourceEncodeInfo, collectEncodeNow, syncOutputFromEncode, persistProject,
    runEncodeCheck, scheduleEncodeCheck,
    setVideoSource, seekToMs, seekOutput, playWhenReady, togglePlay, nudge, startOutputPreview, onVideoTime,
    undo, redo, updateProject,
    addTimeClip, commitClipDrag, clipOp, renameClipAt, commitTimeInput, moveClipOrder,
    applyWholeClips, clearClips,
    selectCue, visibleCueIndices, addClipsFromEndpoints, addClipsFromChecked,
    wbShift, wbSetExact, wbShiftWholeTrack, wbReload, toggleCueLoop, gotoCueRelative,
    showCueSub, wbSummary, commitCueEdit,
    exportSubtitlesOnly, startExport, confirmExportGo, reveal, pollExport,
    setProfileMode: setProfileModeFull, applyBuiltinAsCustom, applyPresetValues,
    shrinkPreset, resetEncode, saveProjectFile, loadProjectPayload, loadProjectFile,
    loadRecentItem, loadSelected, init,
    readRecent, saveRecent, updateEncode, updateOutput,
    ZOOM_STEPS,
    countEncodeChanges,
    BASIC_KEYS,
  }
}

export type AppApi = ReturnType<typeof useAppState>
