import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Download, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fmt, parseTime } from '@/lib/format'
import { cueWindow } from '@/lib/clips'
import type { AppApi } from '@/hooks/useAppState'

export function CalibrationWorkbench({ app }: { app: AppApi }) {
  const track = app.currentTrack
  const idx = app.activeCue
  const cue = track && idx !== null ? track.cues[idx] : null
  const [preview, setPreview] = useState<{ ns: number; ne: number } | null>(null)
  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')
  const dragRef = useRef<{ mode: 'l' | 'r' | 'b'; x: number; win: { start: number; end: number }; origStart: number; origEnd: number; w: number } | null>(null)
  const tlRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (cue) {
      setStartText(fmt(cue.start_ms))
      setEndText(fmt(cue.end_ms))
      setPreview(null)
    }
  }, [cue?.start_ms, cue?.end_ms, idx]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!track || !cue || idx === null) {
    return (
      <div className="rounded-lg border bg-muted/50 px-3.5 py-3 text-sm leading-relaxed text-muted-foreground">
        点击下方字幕列表里的任意一句，就能在这里拖动或微调它的时间；开着「单句循环」边听边改最顺手。
      </div>
    )
  }

  const win = cueWindow(cue, app.sourceDuration)
  const span = win.end - win.start || 1
  const shownStart = preview ? preview.ns : cue.start_ms
  const shownEnd = preview ? preview.ne : cue.end_ms
  const summary = app.wbSummary()
  const corrected = summary?.corrected_indices.includes(idx) ? '已校准' : '未改'

  const startDrag = (mode: 'l' | 'r' | 'b', e: React.PointerEvent) => {
    const rect = tlRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { mode, x: e.clientX, win, origStart: cue.start_ms, origEnd: cue.end_ms, w: rect.width }
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const msPerPx = (d.win.end - d.win.start) / (d.w || 1)
      const dms = (ev.clientX - d.x) * msPerPx
      const dur = d.origEnd - d.origStart
      let ns = d.origStart
      let ne = d.origEnd
      if (d.mode === 'l') ns = Math.max(d.win.start, Math.min(d.origStart + dms, d.origEnd - 20))
      else if (d.mode === 'r') ne = Math.max(d.origStart + 20, Math.min(d.origEnd + dms, d.win.end))
      else {
        const maxStart = Math.max(d.win.start, d.win.end - dur)
        const s = Math.max(d.win.start, Math.min(d.origStart + dms, maxStart))
        ns = s
        ne = s + dur
      }
      setPreview({ ns: Math.round(ns), ne: Math.round(ne) })
      setStartText(fmt(ns))
      setEndText(fmt(ne))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = dragRef.current
      dragRef.current = null
      setPreview((p) => {
        if (p) void app.wbSetExact(p.ns, p.ne)
        return null
      })
      void d
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const stepMs = (mult = 1) => app.wbStep * mult
  const applyExact = () => {
    const s = parseTime(startText)
    const e = parseTime(endText)
    if (s === null || e === null) {
      app.notify('时间格式不对（用 00:00:01.200 或毫秒）')
      return
    }
    if (e <= s) {
      app.notify('终点必须晚于起点')
      return
    }
    void app.wbSetExact(s, e)
  }

  return (
    <div className="flex flex-col gap-2 pb-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">字幕时间校准</span>
        <div className="flex-1" />
        <Button variant={app.cueLoopOn ? 'default' : 'outline'} size="sm" onClick={app.toggleCueLoop} title="循环播放当前句，边调边听，立刻看到效果">
          <Repeat className="size-4" />
          单句循环：{app.cueLoopOn ? '开' : '关'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.exportSubtitlesOnly()} title="只导出矫正后的字幕文件（不碰视频）">
          <Download className="size-4" />
          只导出字幕
        </Button>
      </div>

      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-semibold">
          第 {idx + 1} 句 / 共 {track.cues.length} 句
        </span>
        <span className="ml-auto text-muted-foreground">
          {corrected} · 本轨已改 {summary?.track_edit_count ?? 0} 句
          {summary?.overlaps ? ` · 重叠 ${summary.overlaps} 处` : ''}
        </span>
      </div>

      <div
        ref={tlRef}
        className="relative h-[54px] touch-none select-none overflow-hidden rounded-lg border bg-muted"
        title="拖动两端改起/终点，拖动中间整体平移"
      >
        <div
          className="absolute bottom-1 top-1 cursor-grab rounded border border-blue-300 dark:border-blue-700 bg-blue-100 dark:bg-blue-900/50 active:cursor-grabbing"
          style={{ left: `${((shownStart - win.start) / span) * 100}%`, width: `${((shownEnd - shownStart) / span) * 100}%` }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.handle) return
            startDrag('b', e)
          }}
        >
          <div
            data-handle="l"
            className="absolute -left-0.5 bottom-0 top-0 w-3 cursor-ew-resize rounded bg-primary opacity-90 hover:opacity-100"
            title="拖动改起点"
            onPointerDown={(e) => {
              e.stopPropagation()
              startDrag('l', e)
            }}
          />
          <div
            data-handle="r"
            className="absolute -right-0.5 bottom-0 top-0 w-3 cursor-ew-resize rounded bg-primary opacity-90 hover:opacity-100"
            title="拖动改终点"
            onPointerDown={(e) => {
              e.stopPropagation()
              startDrag('r', e)
            }}
          />
        </div>
        <div
          className="pointer-events-none absolute -top-0.5 bottom-0.5 w-0.5 bg-destructive"
          style={{ left: `${Math.max(0, Math.min(100, ((app.srcMs - win.start) / span) * 100))}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => app.gotoCueRelative(-1)}>
          <ChevronUp className="size-4" />
          上一句
        </Button>
        <Button variant="outline" size="sm" onClick={() => app.gotoCueRelative(1)}>
          <ChevronDown className="size-4" />
          下一句
        </Button>
        <span className="text-sm text-muted-foreground">
          步长
          <Select value={String(app.wbStep)} onValueChange={(v) => app.setWbStep(Number(v))}>
            <SelectTrigger className="mx-1 inline-flex h-9 w-[84px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[50, 100, 200, 500, 1000].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          ms（按住 Shift = ×5）
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => void app.wbShift(-stepMs(), 'start')}>
          起点 −
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.wbShift(stepMs(), 'start')}>
          起点 ＋
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.wbShift(-stepMs(), 'end')}>
          终点 −
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.wbShift(stepMs(), 'end')}>
          终点 ＋
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void app.wbShift(-stepMs(), 'both')}>
          整句前移 −
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.wbShift(stepMs(), 'both')}>
          整句后移 ＋
        </Button>
        <span className="text-sm text-muted-foreground">整句平移不改时长</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">起点</span>
        <Input
          className="h-9 w-[132px] font-mono text-sm"
          inputMode="numeric"
          placeholder="00:00:00.000"
          value={startText}
          onChange={(e) => setStartText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyExact()
          }}
        />
        <span className="text-sm text-muted-foreground">终点</span>
        <Input
          className="h-9 w-[132px] font-mono text-sm"
          inputMode="numeric"
          placeholder="00:00:00.000"
          value={endText}
          onChange={(e) => setEndText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyExact()
          }}
        />
        <Button variant="outline" size="sm" onClick={applyExact}>
          应用精确时间
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-dashed pt-2">
        <span className="text-sm text-muted-foreground">整轨偏移</span>
        <Input
          className="h-9 w-[88px] text-sm"
          type="number"
          value={app.wbTrackDelta}
          onChange={(e) => app.setWbTrackDelta(Number(e.target.value) || 0)}
        />
        <span className="text-sm text-muted-foreground">ms</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!app.wbTrackDelta) return app.notify('整轨偏移量为 0')
            void app.wbShiftWholeTrack(app.wbTrackDelta, false)
          }}
        >
          应用到本轨
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!app.wbTrackDelta) return app.notify('整轨偏移量为 0')
            void app.wbShiftWholeTrack(app.wbTrackDelta, true)
          }}
        >
          应用到所有轨
        </Button>
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={() => void app.wbReload()} title="从源字幕文件重新载入，放弃本轨所有矫正">
          从源文件重载本轨
        </Button>
      </div>
    </div>
  )
}
