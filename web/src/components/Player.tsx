import { useRef } from 'react'
import { Pause, Play, RotateCcw, RotateCw, Clapperboard, Film, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { fmt } from '@/lib/format'
import type { AppApi } from '@/hooks/useAppState'

export function Player({ app }: { app: AppApi }) {
  const srcPath = app.currentSource?.path
  // Right-click on the volume slider toggles mute and remembers the previous
  // level, so a second right-click restores exactly what you had.
  const prevVolumeRef = useRef(100)

  const toggleMute = () => {
    const el = app.videoRef.current
    if (app.volume > 0) {
      prevVolumeRef.current = app.volume
      app.setVolume(0)
      if (el) {
        el.volume = 0
        el.muted = true
      }
      app.notify('已静音 · 右键音量滑块可恢复')
    } else {
      const restored = prevVolumeRef.current || 100
      app.setVolume(restored)
      if (el) {
        el.volume = restored / 100
        el.muted = false
      }
      app.notify(`已恢复音量 ${restored}%`)
    }
  }

  // Subtitle overlay: follow the OUTPUT timeline when a clip is playing,
  // otherwise the source timeline of the current track.
  const group = app.activeGroup
  let cueText = ''
  if (app.outputMs !== null && group && app.state?.groups?.[group]) {
    const hit = app.state.groups[group].find((c) => c.start_ms <= (app.outputMs ?? 0) && (app.outputMs ?? 0) < c.end_ms)
    if (hit) cueText = hit.lines.join('\n')
  } else if (app.currentTrack) {
    const hit = app.currentTrack.cues.find((c) => c.start_ms <= app.srcMs && app.srcMs < c.end_ms)
    if (hit) cueText = hit.lines.join('\n')
  }

  const segs = app.state?.segments || []
  const badgeIdx = segs.findIndex((s) => s.source_id === app.activeSource && app.srcMs >= s.in_ms && app.srcMs < s.out_ms)
  const badgeText = !app.project?.sources?.length
    ? '—'
    : badgeIdx >= 0
      ? `片段 ${badgeIdx + 1} / ${segs.length}`
      : segs.length
        ? '未保留区间'
        : '尚未添加片段'

  const groups = [...new Set([...Object.keys(app.state?.groups || {}), ...(app.project?.tracks || []).map((t) => t.group_id)])]

  return (
    <section className="flex min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-zinc-900 dark:bg-black">
        {/* The video src is set imperatively by app.setVideoSource (media URL
            + seek-after-load), exactly as the original player did. */}
        <video
          ref={app.videoRef}
          className="h-full w-full object-contain"
          preload="metadata"
          onPlay={() => app.setPlaying(true)}
          onPause={() => app.setPlaying(false)}
          onTimeUpdate={(e) => app.onVideoTime(e.currentTarget.currentTime * 1000)}
        />
        {cueText && (
          <div className="pointer-events-none absolute inset-x-[8%] bottom-[8%] text-center text-base font-medium leading-relaxed text-white [text-shadow:0_1px_3px_#000,0_0_8px_#000]">
            <span className="rounded bg-black/40 px-2 py-0.5 [box-decoration-break:clone]">{cueText}</span>
          </div>
        )}
        {!srcPath && (
          <div className="pointer-events-none flex flex-col items-center gap-2 px-4 text-center text-zinc-400">
            <Film className="size-10 opacity-40" />
            <div className="text-sm font-medium">还没有打开视频</div>
            <div className="text-xs">点左上角「打开媒体」，选好视频与字幕后就能开始剪辑</div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-2 text-muted-foreground">
        <div className="flex gap-1">
          <Button variant="outline" size="sm" onClick={app.togglePlay} title="播放 / 暂停（空格）">
            {app.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            {app.playing ? '暂停' : '播放'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => app.nudge(-5)} title="后退 5 秒（←）">
            <RotateCcw className="size-4" />
            −5s
          </Button>
          <Button variant="outline" size="sm" onClick={() => app.nudge(5)} title="前进 5 秒（→）">
            <RotateCw className="size-4" />
            +5s
          </Button>
          <Button variant="outline" size="sm" onClick={app.startOutputPreview} title="从第一段开始按输出顺序播放（跳过没保留的部分）">
            <Clapperboard className="size-4" />
            预览成片
          </Button>
        </div>
        <span className="font-mono text-xs tabular-nums">
          原片 {fmt(app.srcMs)} / 输出 {app.outputMs === null ? '--' : fmt(app.outputMs)} / 共 {fmt(app.totalMs)}
        </span>
        <div className="flex-1" />
        <Badge variant="secondary">{badgeText}</Badge>
        <Select
          value={app.activeGroup || ''}
          onValueChange={(v) => {
            app.setActiveGroup(v)
            // The overlay group and the clip track stay in sync: picking a
            // group here also makes that group's track the one used for
            // clip generation in the Subtitles tab.
            const t = (app.project?.tracks || []).find((tr) => tr.group_id === v && tr.source_id === app.activeSource)
            if (t) app.setCueTrack(t.id)
          }}
        >
          <SelectTrigger className="h-8 w-[110px] text-xs">
            <SelectValue placeholder="字幕轨" />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label
          className="flex cursor-pointer items-center gap-2 text-xs"
          title="左键拖动 = 调音量 · 右键 = 静音 / 恢复上次音量"
          onContextMenu={(e) => {
            e.preventDefault()
            toggleMute()
          }}
        >
          {app.volume > 0 ? <Volume2 className="size-4" /> : <VolumeX className="size-4 text-muted-foreground" />}
          <Slider
            className="w-[68px]"
            value={[app.volume]}
            min={0}
            max={100}
            onValueChange={([v]) => {
              app.setVolume(v)
              const el = app.videoRef.current
              if (el) {
                el.volume = v / 100
                el.muted = false
              }
            }}
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs" title="开启后播放器按输出顺序跳过未保留部分，用于预览成片；关闭则自由浏览原片">
          <Switch
            checked={app.follow}
            onCheckedChange={(v) => {
              app.setFollow(v)
              if (v && app.state?.segments?.length) app.seekOutput(app.outputMs || 0)
            }}
          />
          跟随输出时间轴
        </label>
      </div>
    </section>
  )
}
