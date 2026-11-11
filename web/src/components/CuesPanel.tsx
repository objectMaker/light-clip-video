import { useEffect, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fmt, shortFmt } from '@/lib/format'
import type { AppApi } from '@/hooks/useAppState'
import { CalibrationWorkbench } from './CalibrationWorkbench'

export function CuesPanel({ app }: { app: AppApi }) {
  const track = app.currentTrack
  const needle = app.cueSearch.trim().toLowerCase()
  const indices = app.visibleCueIndices()
  // Embedded subtitle streams of the current video that have not been
  // extracted yet as a usable track.
  const embeddedForSource = (app.embeddedSubs || []).filter((s) => s.source_id === app.activeSource)
  // Collapsed by default: the embedded list used to eat a lot of screen
  // space with no way to hide it. The header always stays visible with
  // the track count and the track currently used for clipping.
  const [embeddedOpen, setEmbeddedOpen] = useState(false)
  const cueTrackObj = (app.project?.tracks || []).find((t) => t.id === app.cueTrack)
  // The list comes from /api/open, so after a reload / project restore it
  // is empty: probe the current video once so the embedded section shows.
  useEffect(() => {
    if (app.activeSource && embeddedForSource.length === 0) void app.refreshEmbedded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.activeSource])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs value={app.cueSub} onValueChange={(v) => app.showCueSub(v as 'pick' | 'proof')} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="pick">选点剪辑</TabsTrigger>
          <TabsTrigger value="proof">时间校准</TabsTrigger>
        </TabsList>

        {app.cueSub === 'pick' && (
          <div className="flex shrink-0 flex-col pt-2">
            <div className="pb-2 text-xs text-muted-foreground">剪辑用字幕轨：下方「由勾选行生成片段」等操作使用这里选中的字幕轨。</div>
            <div className="flex items-center gap-2 pb-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-xs"
                  placeholder="搜索字幕文本"
                  value={app.cueSearch}
                  onChange={(e) => app.setCueSearch(e.target.value)}
                />
              </div>
              <Select value={app.cueTrack || ''} onValueChange={(v) => { app.setCueTrack(v); app.setChecked(new Set()) }}>
                <SelectTrigger className="h-8 w-[150px] text-xs">
                  <SelectValue placeholder="剪辑用字幕轨" />
                </SelectTrigger>
                <SelectContent>
                  {(app.project?.tracks || []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label || t.group_id} · {t.cues.length} 条{t.origin === 'embedded' ? '（内嵌）' : t.origin === 'external' ? '（外挂）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Embedded subtitle streams in the current video: extract
                (separate) one to an SRT track, then use it for clipping
                like any other track. Collapsible: the header row always
                shows, the list only when the user opens it. */}
            {(embeddedForSource.length > 0 || app.currentSource) && (
              <div className="mb-2 rounded-md border">
                <button
                  type="button"
                  aria-expanded={embeddedOpen}
                  onClick={() => setEmbeddedOpen((o) => !o)}
                  className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/50"
                >
                  <ChevronDown className={`size-4 shrink-0 transition-transform ${embeddedOpen ? 'rotate-180' : ''}`} />
                  <span className="shrink-0">内嵌字幕（视频自带）</span>
                  {embeddedForSource.length > 0 && <span className="shrink-0 text-muted-foreground">· {embeddedForSource.length} 条</span>}
                  {cueTrackObj && (
                    <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
                      当前：{cueTrackObj.label || cueTrackObj.group_id} · {cueTrackObj.cues.length} 条
                      {cueTrackObj.origin === 'embedded' ? '（内嵌）' : cueTrackObj.origin === 'external' ? '（外挂）' : ''}
                    </span>
                  )}
                </button>
                {embeddedOpen && (
                  <div className="space-y-1.5 px-2.5 pb-2.5">
                    {embeddedForSource.map((s) => (
                      <div key={s.index} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">
                          {s.title || s.language || `字幕流 #${s.index}`} · {s.codec || '未知编码'}
                          {s.language ? ` · ${s.language}` : ''}
                        </span>
                        {s.text ? (
                          <Button size="sm" variant="outline" className="h-6 shrink-0 text-xs" onClick={() => void app.extractEmbedded(s)}>
                            提取并使用
                          </Button>
                        ) : (
                          <span className="shrink-0 text-muted-foreground">图片字幕，无法提取</span>
                        )}
                      </div>
                    ))}
                    {embeddedForSource.length === 0 && (
                      <Button size="sm" variant="outline" className="h-7 self-start text-xs" onClick={() => void app.refreshEmbedded()}>
                        检测视频内嵌字幕
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 pb-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (app.activeCue === null) return app.notify('请先点击一条字幕')
                  app.setCueStart(app.activeCue)
                }}
              >
                设为起点
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (app.activeCue === null) return app.notify('请先点击一条字幕')
                  app.setCueEnd(app.activeCue)
                }}
              >
                设为终点
              </Button>
              <Button variant="outline" size="sm" onClick={() => void app.addClipsFromEndpoints()}>
                用起止行生成
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 pb-2">
              <Button size="sm" onClick={() => void app.addClipsFromChecked()}>
                由勾选行生成片段
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="只勾选当前搜索结果"
                onClick={() => {
                  const next = new Set(app.checked)
                  indices.forEach((i) => next.add(i))
                  app.setChecked(next)
                }}
              >
                全选可见
              </Button>
              <Button variant="outline" size="sm" onClick={() => app.setChecked(new Set())}>
                清空选择
              </Button>
            </div>
            <div className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
              前留白
              <Input
                className="h-7 w-[62px] text-xs"
                type="number"
                value={app.padStart}
                onChange={(e) => app.setPadStart(Number(e.target.value) || 0)}
              />
              ms 后留白
              <Input
                className="h-7 w-[62px] text-xs"
                type="number"
                value={app.padEnd}
                onChange={(e) => app.setPadEnd(Number(e.target.value) || 0)}
              />
              ms
            </div>
            <div className="pb-1 text-xs text-muted-foreground">
              {app.cueStart !== null || app.cueEnd !== null
                ? `起点行 ${app.cueStart === null ? '未设' : app.cueStart + 1} · 终点行 ${app.cueEnd === null ? '未设' : app.cueEnd + 1}`
                : '未设置起止行（点行尾的「起 / 终」，或选中行后用上方按钮）'}
            </div>
          </div>
        )}

        {app.cueSub === 'proof' && <CalibrationWorkbench app={app} />}

        <div className="border-b pb-1 pt-1 text-[11px] text-muted-foreground">
          {track
            ? `共 ${track.cues.length} 条${needle ? ` · 匹配 ${indices.length} 条` : ''} · 已勾选 ${app.checked.size} 条`
            : ''}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {!track ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground">尚未载入字幕</div>
          ) : indices.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground">没有匹配的字幕</div>
          ) : (
            <div className="flex flex-col gap-0.5 py-1 pr-1">
              {indices.map((i) => {
                const c = track.cues[i]
                const active = app.activeCue === i
                const mark = app.cueStart === i ? '起 ' : app.cueEnd === i ? '终 ' : ''
                return (
                  <div
                    key={i}
                    data-cue-row={i}
                    className={`group flex cursor-pointer items-start gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-muted ${
                      active ? 'border-blue-300 bg-blue-50' : ''
                    } ${app.cueStart === i ? 'shadow-[inset_3px_0_0_#1d9e75]' : ''} ${
                      app.cueEnd === i ? 'shadow-[inset_3px_0_0_#ba7517]' : ''
                    }`}
                    onClick={() => app.selectCue(i, true)}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={app.checked.has(i)}
                      onCheckedChange={(v) => {
                        const next = new Set(app.checked)
                        if (v) next.add(i)
                        else next.delete(i)
                        app.setChecked(next)
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="w-7 shrink-0 pt-0.5 text-right font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                    <span className="shrink-0 whitespace-nowrap pt-0.5 font-mono text-[11px] text-muted-foreground">
                      {mark}
                      {shortFmt(c.start_ms)}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-[13px] leading-snug">{c.lines.join(' / ') || '(空)'}</span>
                    <span className="hidden shrink-0 gap-1 group-hover:flex">
                      <Button
                        variant="outline"
                        size="xs"
                        className={`h-5 px-1.5 text-[10px] ${app.cueStart === i ? 'border-green-600 bg-green-50 text-green-800' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          app.setCueStart(i)
                          app.setActiveCue(i)
                        }}
                        title="设为起点"
                      >
                        起
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        className={`h-5 px-1.5 text-[10px] ${app.cueEnd === i ? 'border-amber-600 bg-amber-50 text-amber-800' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          app.setCueEnd(i)
                          app.setActiveCue(i)
                        }}
                        title="设为终点"
                      >
                        终
                      </Button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
        <div className="hidden">{fmt(0)}</div>
      </Tabs>
    </div>
  )
}
