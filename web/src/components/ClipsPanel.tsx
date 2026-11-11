import { useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Film,
  Pencil,
  Redo2,
  Scissors,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { fmt, parseTime, shortFmt, basename } from '@/lib/format'
import type { AppApi } from '@/hooks/useAppState'

function ClipTimeInput({
  initial,
  onCommit,
}: {
  initial: string
  onCommit: (ms: number) => Promise<boolean>
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState(false)
  return (
    <Input
      className={`h-7 w-[104px] font-mono text-[11px] ${error ? 'border-destructive' : ''}`}
      value={value}
      onChange={(e) => {
        setValue(e.target.value)
        setError(false)
      }}
      onFocus={(e) => e.target.select()}
      onKeyDown={async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const ms = parseTime(value)
          if (ms === null) {
            setError(true)
            return
          }
          await onCommit(ms)
          ;(e.target as HTMLInputElement).blur()
        }
        if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
      }}
      onBlur={async () => {
        const ms = parseTime(value)
        if (ms === null) {
          setError(true)
          setValue(initial)
          return
        }
        await onCommit(ms)
      }}
      title="HH:MM:SS.mmm / MM:SS.mmm / 秒数，回车生效"
    />
  )
}

export function ClipsPanel({ app }: { app: AppApi }) {
  const clips = app.project?.clips || []
  const segs = app.state?.segments || []
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const handleSourceChange = (id: string) => {
    app.setActiveSource(id)
    const track = app.project?.tracks.find((t) => t.source_id === id)
    if (track) app.setCueTrack(track.id)
    app.setChecked(new Set())
    app.setVideoSource(id, 0)
    app.setView({ startMs: 0, zoom: 1 })
    void app.loadSourceEncodeInfo(id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <Select value={app.activeSource || ''} onValueChange={handleSourceChange}>
          <SelectTrigger className="h-8 w-[180px] text-xs" title="当前编辑的源视频">
            <SelectValue placeholder="选择源视频" />
          </SelectTrigger>
          <SelectContent>
            {(app.project?.sources || []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {basename(s.path)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="outline" size="sm" disabled={!app.canUndo} onClick={app.undo} title="撤销（Ctrl+Z）">
          <Undo2 className="size-4" />
          撤销
        </Button>
        <Button variant="outline" size="sm" disabled={!app.canRedo} onClick={app.redo} title="重做（Ctrl+Shift+Z）">
          <Redo2 className="size-4" />
          重做
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.applyWholeClips()} title="每个视频生成 0 → 全长的片段，只压缩不剪辑">
          整片（不剪辑）
        </Button>
        <Button variant="outline" size="sm" onClick={() => void app.clearClips()} title="清空全部片段（可撤销）">
          清空
        </Button>
      </div>

      <div className="mb-2 rounded-lg border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <b className="text-foreground">怎么剪：</b>在时间轴空白处拖拽新建片段；拖片段两端只改起 / 终点，拖中间整体平移。
        卡片上 <Scissors className="inline size-3" /> 在播放头处拆分、<Copy className="inline size-3" /> 复制、
        <Pencil className="inline size-3" /> 重命名；<b className="text-foreground">直接拖动卡片可改顺序</b>。
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {!clips.length ? (
          <div className="flex flex-col items-center gap-2 px-2 py-10 text-center text-xs leading-relaxed text-muted-foreground">
            <Film className="size-8 text-muted-foreground/50" />
            还没有片段。
            <span>
              在时间轴上空白处拖拽框选，
              <br />
              或到「字幕」页按字幕行选点。
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pr-1">
            {clips.map((c, i) => {
              const s = segs[i] || {}
              const shift = s.keyframe_shift_ms || 0
              const selected = app.selectedClip === i
              return (
                <Card
                  key={c.id}
                  className={`cursor-pointer p-3 shadow-none transition-colors hover:border-primary ${
                    selected ? 'border-primary bg-primary/5 ring-2 ring-primary/20' : ''
                  } ${dragOver === i ? 'border-green-600 ring-2 ring-green-600/30' : ''} ${
                    dragFrom === i ? 'opacity-45' : ''
                  }`}
                  draggable
                  onDragStart={(e) => {
                    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') {
                      e.preventDefault()
                      return
                    }
                    setDragFrom(i)
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', String(i))
                  }}
                  onDragOver={(e) => {
                    if (dragFrom === null) return
                    e.preventDefault()
                    setDragOver(i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = dragFrom
                    setDragFrom(null)
                    setDragOver(null)
                    if (from !== null) void app.moveClipOrder(from, i)
                  }}
                  onDragEnd={() => {
                    setDragFrom(null)
                    setDragOver(null)
                  }}
                  onClick={() => {
                    app.setSelectedClip(i)
                    if (s.in_ms !== undefined) app.setVideoSource(s.source_id, s.in_ms / 1000)
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{i + 1}</Badge>
                    <span className="font-mono text-xs">
                      {fmt(s.in_ms)} → {fmt(s.out_ms)}
                    </span>
                    {c.label && (
                      <span className="max-w-[150px] truncate text-[11px] text-muted-foreground" title={c.label}>
                        {c.label}
                      </span>
                    )}
                    <span className="ml-auto flex gap-0.5">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); void app.clipOp(i, 'up') }}>
                              <ArrowUp className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>上移</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); void app.clipOp(i, 'down') }}>
                              <ArrowDown className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>下移</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); void app.clipOp(i, 'split') }}>
                              <Scissors className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>在播放头处拆分（播放头不在片段内则取中点）</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); void app.clipOp(i, 'copy') }}>
                              <Copy className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>复制这个片段</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={(e) => {
                                e.stopPropagation()
                                app.setPromptReq({
                                  title: '重命名片段',
                                  label: '给这个片段起个名字（只影响列表显示）：',
                                  initialValue: c.label || `片段 ${i + 1}`,
                                  onConfirm: (v) => void app.renameClipAt(i, v),
                                })
                              }}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>重命名</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6 hover:text-destructive" onClick={(e) => { e.stopPropagation(); void app.clipOp(i, 'del') }}>
                              <X className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span>
                      输出 {fmt(s.offset_ms)} · 时长 {fmt(s.duration_ms)}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {c.start.kind === 'cue' ? '字幕锚点' : '时间'}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {c.end.kind === 'cue' ? '字幕锚点' : '时间'}
                    </Badge>
                    {shift > 0 && (
                      <Badge variant="outline" className="border-amber-600 text-[10px] text-amber-800">
                        关键帧提前 {(shift / 1000).toFixed(2)}s
                      </Badge>
                    )}
                  </div>
                  <div
                    className="mt-2 flex items-center gap-1.5 border-t border-dashed pt-2 text-[11px] text-muted-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span>起点</span>
                    <ClipTimeInput
                      key={`s-${c.id}-${s.in_ms}`}
                      initial={fmt(s.in_ms)}
                      onCommit={async (ms) => {
                        const ok = await app.commitTimeInput(i, 'start', ms)
                        return ok
                      }}
                    />
                    <span>→</span>
                    <ClipTimeInput
                      key={`e-${c.id}-${s.out_ms}`}
                      initial={fmt(s.out_ms)}
                      onCommit={async (ms) => app.commitTimeInput(i, 'end', ms)}
                    />
                    <span className="flex items-center gap-0.5">
                      回车生效 <ChevronDown className="hidden size-3" />
                    </span>
                  </div>
                  <div className="sr-only">{shortFmt(s.in_ms || 0)}</div>
                </Card>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
