import { useEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { thumbUrl, waveformUrl } from '@/api'
import { fmt, shortFmt } from '@/lib/format'
import { computeClipDrag, snapClipDrag, type SnapPoint } from '@/lib/clips'
import type { AppApi } from '@/hooks/useAppState'

/** "Close enough to snap" is a fixed on-screen distance, independent of zoom. */
const SNAP_PX = 7

function tipLeftPct(ms: number, viewStart: number, viewSpan: number) {
  return Math.max(8, Math.min(92, ((ms - viewStart) / viewSpan) * 100))
}

export function Timeline({ app }: { app: AppApi }) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLElement | null>(null)
  const appRef = useRef(app)
  appRef.current = app
  const [selection, setSelection] = useState<{ x0: number; x1: number } | null>(null)
  // The bubble is anchored under the dragged clip (a % of the track width),
  // not under the mouse cursor.
  const [dragTip, setDragTip] = useState<{ leftPct: number; text: string } | null>(null)

  const src = app.currentSource
  const duration = src?.duration_ms || 1
  const span = app.viewSpanMs
  const startMs = app.view.startMs
  const endMs = Math.min(duration, startMs + span)

  const xToMs = (x: number) => {
    const w = trackRef.current?.clientWidth || 1
    return Math.round(startMs + (x / w) * span)
  }
  const msToPct = (ms: number) => ((ms - startMs) / span) * 100

  const rulerTicks = useMemo(
    () => Array.from({ length: 9 }, (_, i) => ({ left: (i / 8) * 100, label: shortFmt(startMs + (span * i) / 8) })),
    [startMs, span],
  )
  const thumbs = useMemo(
    () =>
      src
        ? Array.from({ length: 8 }, (_, i) => thumbUrl(src.path, (src.duration_ms * (i + 0.5)) / 8 / 1000))
        : [],
    [src?.path, src?.duration_ms], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const zoomBy = (delta: number, anchorMs: number | null = null) => {
    const steps = app.ZOOM_STEPS
    const idx = steps.indexOf(app.view.zoom)
    const next = steps[Math.max(0, Math.min(steps.length - 1, (idx < 0 ? 0 : idx) + delta))]
    if (next === app.view.zoom) return
    const oldSpan = app.viewSpanMs
    const anchor = anchorMs === null ? startMs + oldSpan / 2 : anchorMs
    const frac = Math.max(0, Math.min(1, (anchor - startMs) / oldSpan))
    const ns = anchor - frac * (duration / next)
    app.setView({ zoom: next, startMs: Math.max(0, Math.min(ns, Math.max(0, duration - duration / next))) })
  }
  const zoomFit = () => app.setView({ startMs: 0, zoom: 1 })
  const panTo = (value: number) => {
    const max = Math.max(0, duration - span)
    app.setView({ ...app.view, startMs: (max * value) / 1000 })
  }
  const panByMs = (delta: number) => {
    const max = Math.max(0, duration - span)
    app.setView({ ...app.view, startMs: Math.max(0, Math.min(app.view.startMs + delta, max)) })
  }

  // Wheel pans; Ctrl+wheel zooms around the cursor (native listener: React
  // wheel handlers are passive and cannot preventDefault the page scroll).
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const wheel = (e: WheelEvent) => {
      const a = appRef.current
      if (!a.project) return
      e.preventDefault()
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
        const w = rect.width || 1
        const anchor = a.view.startMs + (x / w) * a.viewSpanMs
        const steps = a.ZOOM_STEPS
        const idx = steps.indexOf(a.view.zoom)
        const next = steps[Math.max(0, Math.min(steps.length - 1, idx + (e.deltaY < 0 ? 1 : -1)))]
        if (next !== a.view.zoom) {
          const oldSpan = a.viewSpanMs
          const frac = Math.max(0, Math.min(1, (anchor - a.view.startMs) / oldSpan))
          const ns = anchor - frac * ((a.currentSource?.duration_ms || 1) / next)
          const max = Math.max(0, (a.currentSource?.duration_ms || 1) - (a.currentSource?.duration_ms || 1) / next)
          a.setView({ zoom: next, startMs: Math.max(0, Math.min(ns, max)) })
        }
      } else {
        const max = Math.max(0, (a.currentSource?.duration_ms || 1) - a.viewSpanMs)
        a.setView({ ...a.view, startMs: Math.max(0, Math.min(a.view.startMs + a.viewSpanMs * (e.deltaY > 0 ? 0.12 : -0.12), max)) })
      }
    }
    pane.addEventListener('wheel', wheel, { passive: false })
    return () => pane.removeEventListener('wheel', wheel)
  }, [])

  // Drag state lives in refs; the clip element is moved directly during the
  // drag (no React re-render per mousemove), then committed on mouseup.
  const dragRef = useRef<{
    kind: 'clip' | 'sort' | 'new'
    i: number
    el: HTMLElement | null
    mode: 'start' | 'end' | 'move'
    originX: number
    start0: number
    end0: number
    start: number
    end: number
    len: number
    moved: boolean
    x0: number
    x1: number
    target: number | null
  } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      const track = trackRef.current
      if (!d || !track) return
      const a = appRef.current
      const rect = track.getBoundingClientRect()
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      if (d.kind === 'sort') {
        const under = (document.elementFromPoint?.(e.clientX, e.clientY) as HTMLElement | null)?.closest?.('.tl-clip') as HTMLElement | null
        const target = under && under !== d.el ? Number((under as HTMLElement).dataset.i) : null
        d.target = Number.isNaN(target as number) ? null : target
        track.querySelectorAll('.tl-clip').forEach((el) => el.classList.toggle('sort-target', Number((el as HTMLElement).dataset.i) === d.target))
        setDragTip({
          leftPct: Math.max(8, Math.min(92, (x / (rect.width || 1)) * 100)),
          text: d.target === null ? `#${d.i + 1} 拖到另一个片段上 = 改变合并顺序` : `#${d.i + 1} → 第 ${(d.target ?? 0) + 1} 位`,
        })
        return
      }
      if (d.kind === 'clip') {
        const srcDuration = a.currentSource?.duration_ms || 1
        const ms = Math.round(a.view.startMs + (x / (rect.width || 1)) * a.viewSpanMs)
        const originMs = Math.round(a.view.startMs + (d.originX / (rect.width || 1)) * a.viewSpanMs)
        const raw = computeClipDrag({ mode: d.mode, start0: d.start0, end0: d.end0, len: d.len, duration: srcDuration }, ms, originMs)

        // Snap targets: the playhead set by a click-to-seek, source bounds,
        // and every OTHER clip's edges (handy for butt-joining two segments).
        const points: SnapPoint[] = [
          { ms: a.srcMs, label: '播放头' },
          { ms: 0, label: '片头' },
          { ms: srcDuration, label: '片尾' },
        ]
        const otherSegs = a.state?.segments || []
        otherSegs.forEach((s, i) => {
          if (i === d.i || s.source_id !== a.currentSource?.id) return
          points.push({ ms: s.in_ms, label: `片段 ${i + 1} 起点` }, { ms: s.out_ms, label: `片段 ${i + 1} 终点` })
        })
        const tolMs = (a.viewSpanMs / (rect.width || 1)) * SNAP_PX
        const snapped = snapClipDrag(raw, d.mode, points, tolMs, srcDuration)

        d.start = snapped.start
        d.end = snapped.end
        d.moved = true
        if (d.el) {
          d.el.style.left = ((d.start - a.view.startMs) / a.viewSpanMs) * 100 + '%'
          d.el.style.width = Math.max(0.3, ((d.end - d.start) / a.viewSpanMs) * 100) + '%'
        }
        const snapNote = snapped.hit ? `  ·  吸到${snapped.hit.label}` : ''
        setDragTip({
          leftPct: tipLeftPct((d.start + d.end) / 2, a.view.startMs, a.viewSpanMs),
          text: `#${d.i + 1}  ${fmt(d.start)} → ${fmt(d.end)}  ·  时长 ${fmt(d.end - d.start)}${snapNote}`,
        })
        return
      }
      d.x1 = x
      setSelection({ x0: d.x0, x1: d.x1 })
    }
    const onUp = async () => {
      const d = dragRef.current
      dragRef.current = null
      const a = appRef.current
      setDragTip(null)
      if (!d) return
      if (d.kind === 'sort') {
        d.el?.classList.remove('dragging')
        trackRef.current?.querySelectorAll('.tl-clip').forEach((n) => n.classList.remove('sort-target'))
        if (d.target !== null && d.target !== undefined) {
          await a.moveClipOrder(d.i, d.target)
        }
        return
      }
      if (d.kind === 'clip') {
        d.el?.classList.remove('dragging')
        if (!d.moved) {
          const seg = a.state?.segments?.[d.i]
          if (seg) a.setVideoSource(seg.source_id, seg.in_ms / 1000)
          return
        }
        await a.commitClipDrag({ i: d.i, mode: d.mode, start: d.start, end: d.end })
        return
      }
      // new clip (rubber band)
      setSelection(null)
      const track = trackRef.current
      if (!track) return
      const w = track.clientWidth || 1
      const aMs = Math.round(a.view.startMs + (Math.min(d.x0, d.x1) / w) * a.viewSpanMs)
      const bMs = Math.round(a.view.startMs + (Math.max(d.x0, d.x1) / w) * a.viewSpanMs)
      if (Math.abs(d.x1 - d.x0) < 3 || bMs - aMs < 100) {
        a.seekToMs(aMs)
        return
      }
      await a.addTimeClip(aMs, bMs)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const onTrackMouseDown = (e: React.MouseEvent) => {
    const a = appRef.current
    if (!a.project || e.button !== 0) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    dragRef.current = { kind: 'new', i: -1, el: null, mode: 'move', originX: x, start0: 0, end0: 0, start: 0, end: 0, len: 0, moved: false, x0: x, x1: x, target: null }
    setSelection({ x0: x, x1: x })
    e.preventDefault()
  }

  const onClipMouseDown = (e: React.MouseEvent, i: number, el: HTMLElement) => {
    const a = appRef.current
    if (!a.project || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const seg = a.state?.segments?.[i]
    if (!seg) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    if (e.altKey) {
      dragRef.current = { kind: 'sort', i, el, mode: 'move', originX: x, start0: seg.in_ms, end0: seg.out_ms, start: seg.in_ms, end: seg.out_ms, len: seg.out_ms - seg.in_ms, moved: false, x0: x, x1: x, target: null }
      a.setSelectedClip(i)
      el.classList.add('dragging')
      setDragTip({
        leftPct: tipLeftPct((seg.in_ms + seg.out_ms) / 2, a.view.startMs, a.viewSpanMs),
        text: `#${i + 1} 拖到另一个片段上 = 改变合并顺序`,
      })
      return
    }
    const handle = (e.target as HTMLElement).closest('[data-edge]')
    const mode = handle ? ((handle as HTMLElement).dataset.edge as 'start' | 'end') : 'move'
    dragRef.current = { kind: 'clip', i, el, mode, originX: x, start0: seg.in_ms, end0: seg.out_ms, start: seg.in_ms, end: seg.out_ms, len: seg.out_ms - seg.in_ms, moved: false, x0: x, x1: x, target: null }
    a.setSelectedClip(i)
    el.classList.add('dragging')
    setDragTip({
      leftPct: tipLeftPct((seg.in_ms + seg.out_ms) / 2, a.view.startMs, a.viewSpanMs),
      text: `#${i + 1}  ${fmt(seg.in_ms)} → ${fmt(seg.out_ms)}  ·  时长 ${fmt(seg.out_ms - seg.in_ms)}`,
    })
  }

  const seekFromEvent = (e: React.MouseEvent, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
    app.seekToMs(xToMs(x))
  }

  const cueBlocks = useMemo(() => {
    const track = app.currentTrack
    if (!src || !track || track.source_id !== src.id) return []
    return track.cues
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.end_ms > startMs && c.start_ms < endMs)
      .slice(0, 400)
  }, [app.currentTrack, src, startMs, endMs]) // eslint-disable-line react-hooks/exhaustive-deps

  const maxScroll = Math.max(0, duration - span)
  const scrollValue = maxScroll > 0 ? Math.round((startMs / maxScroll) * 1000) : 0

  return (
    <section ref={paneRef} className="shrink-0 border-t bg-background px-4 pb-3 pt-2.5">
      <div className="mb-2 flex items-center gap-3.5">
        <div className="font-medium">时间轴</div>
        <div
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title="拖拽 = 新建片段 · 拖边缘 = 改单边 · 拖中间 = 平移 · Alt+拖片段 = 改顺序 · 单击 = 定位 · 滚轮 = 平移 · Ctrl+滚轮 = 缩放"
        >
          拖拽 = 新建片段 · 拖边缘 = 改单边 · 拖中间 = 平移 · Alt+拖片段 = 改顺序 · 单击 = 定位 · 滚轮 = 平移 · Ctrl+滚轮 = 缩放
        </div>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 min-w-[26px] px-1.5" disabled={app.view.zoom <= 1} onClick={() => zoomBy(-1)} title="缩小，看得更全">
            <Minus className="size-3.5" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2" disabled={app.view.zoom === 1 && startMs === 0} onClick={zoomFit} title="恢复显示整片">
            适应
          </Button>
          <Button variant="outline" size="sm" className="h-7 min-w-[26px] px-1.5" disabled={app.view.zoom >= 32} onClick={() => zoomBy(1)} title="放大，选点更精确">
            <Plus className="size-3.5" />
          </Button>
          <span className="w-[30px] text-center font-mono text-xs text-muted-foreground">{app.view.zoom}×</span>
          <Slider
            className="w-[110px]"
            value={[scrollValue]}
            min={0}
            max={1000}
            disabled={maxScroll <= 0}
            onValueChange={([v]) => panTo(v)}
          />
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {src ? `可视 ${fmt(Math.round(startMs))} → ${fmt(Math.round(endMs))} / 全长 ${fmt(duration)}` : ''}
        </span>
      </div>

      <div className="relative mb-1 h-4 font-mono leading-none text-xs text-muted-foreground">
        {rulerTicks.map((t, i) => (
          <span
            key={i}
            className={`absolute ${i === 0 ? 'translate-x-0' : i === rulerTicks.length - 1 ? '-translate-x-full' : '-translate-x-1/2'}`}
            style={{ left: `${t.left}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>

      {/* Wrapper is NOT clipped: the drag bubble lives just below the track,
          aligned with the dragged clip. */}
      <div className="relative">
      <div
        ref={trackRef}
        className="relative h-[52px] cursor-crosshair overflow-hidden rounded-md border bg-muted"
        onMouseDown={onTrackMouseDown}
      >
        <div
          className="absolute bottom-0 top-0 left-0 flex"
          style={{ width: `${app.view.zoom * 100}%`, transform: `translateX(-${((startMs / duration) * 100).toFixed(4)}%)` }}
        >
          {thumbs.map((u, i) => (
            <img key={i} src={u} alt="" className="h-full min-w-0 flex-1 border-r border-white object-cover opacity-85" draggable={false} />
          ))}
        </div>
        {src && (
          <div className="pointer-events-none absolute inset-0">
            {app.state?.segments.map((s, i) => {
              if (s.source_id !== src.id) return null
              if (s.out_ms <= startMs || s.in_ms >= endMs) return null
              const left = msToPct(s.in_ms)
              const width = Math.max(0.3, (s.duration_ms / span) * 100)
              return (
                <div
                  key={s.clip_id}
                  data-i={i}
                  className={`tl-clip pointer-events-auto absolute bottom-0 top-0 z-[3] min-w-[5px] cursor-grab border-x-2 border-blue-700 dark:border-blue-400 bg-blue-600/20 dark:bg-blue-500/20 hover:bg-blue-600/30 dark:hover:bg-blue-500/35 ${
                    app.selectedClip === i ? 'bg-blue-600/40 dark:bg-blue-500/40 shadow-[inset_0_0_0_2px_hsl(var(--primary))]' : ''
                  }`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`片段 ${i + 1}  ${fmt(s.in_ms)} → ${fmt(s.out_ms)}（拖两端改单边，拖中间平移）`}
                  onMouseDown={(e) => onClipMouseDown(e, i, e.currentTarget)}
                >
                  <span data-edge="start" className="absolute bottom-0 left-[-5px] top-0 w-2.5 cursor-ew-resize" title="只改起点，终点不动" />
                  <span className="absolute inset-x-2 flex items-center justify-center overflow-hidden whitespace-nowrap text-xs font-semibold text-blue-900 dark:text-blue-100">
                    {i + 1}
                  </span>
                  <span data-edge="end" className="absolute bottom-0 right-[-5px] top-0 w-2.5 cursor-ew-resize" title="只改终点，起点不动" />
                </div>
              )
            })}
          </div>
        )}
        {selection && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-[4] border-x-2 border-primary bg-primary/20"
            style={{
              left: `${(Math.min(selection.x0, selection.x1) / (trackRef.current?.clientWidth || 1)) * 100}%`,
              width: `${(Math.abs(selection.x1 - selection.x0) / (trackRef.current?.clientWidth || 1)) * 100}%`,
            }}
          />
        )}
        <div className="pointer-events-none absolute bottom-0 top-0 z-[5] w-0.5 bg-red-500" style={{ left: `${msToPct(app.srcMs)}%` }} />
      </div>
      {dragTip && (
        <div
          className="pointer-events-none absolute top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900/90 px-2 py-0.5 font-mono text-xs text-white shadow-md"
          style={{ left: `${dragTip.leftPct}%` }}
        >
          {dragTip.text}
        </div>
      )}
      </div>

      <div
        className="relative mt-1 flex h-[34px] items-center overflow-hidden rounded-md bg-blue-50 dark:bg-blue-950/40"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('.cue-block')) return
          seekFromEvent(e, e.currentTarget)
        }}
      >
        {src && (
          <img
            src={waveformUrl(src.path)}
            alt="波形"
            className="absolute left-0 top-0 h-full object-fill"
            style={{ width: `${app.view.zoom * 100}%`, transform: `translateX(-${((startMs / duration) * 100).toFixed(4)}%)` }}
            draggable={false}
          />
        )}
      </div>

      <div className="relative mt-1 h-[30px] overflow-hidden rounded-md bg-muted" onClick={(e) => seekFromEvent(e, e.currentTarget)}>
        {cueBlocks.map(({ c, i }) => {
          const left = msToPct(c.start_ms)
          const width = Math.max(0.4, ((c.end_ms - c.start_ms) / span) * 100)
          return (
            <div
              key={i}
              className="cue-block absolute top-1 h-[22px] cursor-pointer overflow-hidden whitespace-nowrap rounded border border-amber-700 dark:border-amber-500 bg-amber-300 dark:bg-amber-600/70 px-1 py-0.5 text-xs text-amber-950 dark:text-amber-50"
              style={{ left: `${left}%`, width: `${width}%` }}
              title={c.lines.join(' ')}
              onClick={(e) => {
                e.stopPropagation()
                app.selectCue(i, true)
                if (src) app.setVideoSource(src.id, c.start_ms / 1000)
              }}
            >
              {(c.lines[0] || '').slice(0, 18)}
            </div>
          )
        })}
      </div>

      <div className="mb-1 mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">成片时间轴</span>
        <span className="font-mono text-xs">
          {app.segments.length ? `${app.segments.length} 段 · 共 ${fmt(app.totalMs)} · 单击定位` : '尚未添加片段'}
        </span>
      </div>
      <div
        className="relative h-[26px] cursor-pointer overflow-hidden rounded-md border bg-blue-100/70 dark:bg-blue-950/40"
        title="按输出顺序拼接后的成片，单击可跳到该位置"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
          app.seekOutput((x / (rect.width || 1)) * app.totalMs)
        }}
      >
        {app.outputLane.map((cell) => (
          <div
            key={cell.i}
            className={`absolute bottom-0.5 top-0.5 overflow-hidden whitespace-nowrap rounded border border-blue-300 dark:border-blue-500/70 text-center text-xs leading-5 ${
              cell.i % 2 ? 'bg-blue-100 dark:bg-blue-700/70' : 'bg-blue-200 dark:bg-blue-600/70'
            } ${app.followSeg === cell.i ? 'bg-primary text-primary-foreground' : 'text-blue-900 dark:text-blue-100'}`}
            style={{ left: `${cell.left}%`, width: `${cell.width}%` }}
            title={`片段 ${cell.i + 1} · 输出 ${fmt(cell.offset_ms)}`}
          >
            {cell.width > 3 ? cell.label : ''}
          </div>
        ))}
        {app.totalMs > 0 && app.outputMs !== null && app.outputMs !== undefined && (
          <div className="pointer-events-none absolute bottom-0 top-0 z-[4] w-0.5 bg-red-500" style={{ left: `${Math.max(0, Math.min(100, (app.outputMs / app.totalMs) * 100))}%` }} />
        )}
      </div>
    </section>
  )
}
