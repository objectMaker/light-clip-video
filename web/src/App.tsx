import { useEffect, useRef } from 'react'
import { Captions, Scissors, SlidersHorizontal } from 'lucide-react'
import { Toaster } from 'sonner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppState } from '@/hooks/useAppState'
import { Topbar } from '@/components/Topbar'
import { Player } from '@/components/Player'
import { ClipsPanel } from '@/components/ClipsPanel'
import { CuesPanel } from '@/components/CuesPanel'
import { SettingsPanel } from '@/components/SettingsPanel'
import { Timeline } from '@/components/Timeline'
import {
  ConfirmDialog,
  ConfirmExportDialog,
  DirDialog,
  ExportDialog,
  HelpDialog,
  HiddenFileInputs,
  OpenMediaDialog,
  PromptDialog,
  RecentDialog,
} from '@/components/dialogs'
import { fmt } from '@/lib/format'
import { useTheme } from '@/hooks/useTheme'

export default function App() {
  const app = useAppState()
  const { resolvedTheme } = useTheme()
  const appRef = useRef(app)
  appRef.current = app
  const initRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    void appRef.current.init()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow playback in the subtitle list: highlight (and scroll to) the cue
  // under the playhead, as the original player did.
  useEffect(() => {
    const a = appRef.current
    const track = a.currentTrack
    if (!track?.cues.length) return
    let hit = -1
    for (let i = 0; i < track.cues.length; i++) {
      const c = track.cues[i]
      if (a.srcMs >= c.start_ms && a.srcMs < c.end_ms) {
        hit = i
        break
      }
    }
    if (hit !== a.activeCue) {
      a.setActiveCue(hit)
      if (hit >= 0 && a.playing && a.tab === 'cues') {
        document.querySelector(`[data-cue-row="${hit}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.srcMs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = appRef.current
      if (e.key === 'Escape') {
        a.setHelpOpen(false)
        a.setConfirmExport(null)
        a.setConfirmReq(null)
        return
      }
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT' || target?.isContentEditable
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) a.redo()
        else a.undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        a.redo()
        return
      }
      // Clipboard shortcuts operate on the clip selected on the timeline.
      if (mod && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        a.clipboardCopy()
        return
      }
      if (mod && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault()
        void a.clipboardCut()
        return
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        void a.clipboardPaste()
        return
      }
      // Both the labelled Delete key and Backspace (what many keyboards/users
      // mean by "delete"). Backspace is only intercepted when a clip is really
      // selected, so it never blocks ordinary editing elsewhere.
      if (e.key === 'Delete' || e.code === 'Delete' || e.key === 'Del' || e.key === 'Backspace') {
        if (e.key === 'Backspace' && a.selectedClip === null) return
        e.preventDefault()
        void a.clipboardDelete()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        a.togglePlay()
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        a.nudge(-5)
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        a.nudge(5)
        return
      }
      if (e.key === '?') {
        a.setHelpOpen(true)
        return
      }
      if (e.key === 'i' || e.key === 'I') {
        if (a.activeCue !== null) a.setCueStart(a.activeCue)
        return
      }
      if (e.key === 'o' || e.key === 'O') {
        if (a.activeCue !== null) a.setCueEnd(a.activeCue)
        return
      }
      if (e.key === ',' || e.key === '<') {
        e.preventDefault()
        void a.wbShift(-a.wbStep * (e.shiftKey ? 5 : 1), 'both')
        return
      }
      if (e.key === '.' || e.key === '>') {
        e.preventDefault()
        void a.wbShift(a.wbStep * (e.shiftKey ? 5 : 1), 'both')
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        a.gotoCueRelative(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        a.gotoCueRelative(1)
        return
      }
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void a.syncProject(true)
        a.setStatus('已保存工程')
        return
      }
      if (mod && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        void a.exportSubtitlesOnly()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const clips = app.project?.clips?.length || 0
  const estimated = app.state?.estimated_lossless_bytes
  const sizeHint = estimated ? ` · 预计体积 ${(estimated / 1048576).toFixed(1)} MB` : ''

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full min-w-[900px] flex-col bg-app text-app-foreground transition-colors duration-200">
        <Topbar app={app} />
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.55fr)_minmax(340px,1fr)] gap-3 p-3">
          <Player app={app} />
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
            <Tabs value={app.tab} onValueChange={(v) => app.setTab(v as 'clips' | 'cues' | 'settings')} className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-3 mt-3 grid h-9 grid-cols-3">
                <TabsTrigger value="clips" className="gap-1.5">
                  <Scissors className="size-4" />
                  片段
                </TabsTrigger>
                <TabsTrigger value="cues" className="gap-1.5">
                  <Captions className="size-4" />
                  字幕
                </TabsTrigger>
                <TabsTrigger value="settings" className="gap-1.5">
                  <SlidersHorizontal className="size-4" />
                  设置
                </TabsTrigger>
              </TabsList>
              <div className="flex min-h-0 flex-1 flex-col p-3">
                {app.tab === 'clips' && <ClipsPanel app={app} />}
                {app.tab === 'cues' && <CuesPanel app={app} />}
                {app.tab === 'settings' && <SettingsPanel app={app} />}
              </div>
            </Tabs>
          </aside>
        </main>
        <Timeline app={app} />
        <footer className="flex shrink-0 items-center gap-2 border-t bg-background px-4 py-1.5 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2 truncate">
            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
            <span className="truncate">{app.status || '就绪'}</span>
          </span>
          <div className="flex-1" />
          <span className="shrink-0 font-mono tabular-nums">
            {clips} 段 · 输出 {fmt(app.totalMs)} · {(app.project?.tracks || []).length} 条字幕轨{sizeHint}
          </span>
        </footer>
      </div>
      <OpenMediaDialog app={app} />
      <ExportDialog app={app} />
      <ConfirmExportDialog app={app} />
      <HelpDialog app={app} />
      <DirDialog app={app} />
      <RecentDialog app={app} />
      <PromptDialog app={app} />
      <ConfirmDialog app={app} />
      <HiddenFileInputs app={app} />
      <Toaster position="bottom-right" richColors closeButton theme={resolvedTheme} />
    </TooltipProvider>
  )
}
