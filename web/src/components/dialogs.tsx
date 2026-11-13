import { useEffect, useState } from 'react'
import { ChevronUp, FileVideo, Folder, FolderOpen, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { apiClient } from '@/api'
import { fmt, fmtClock, basename } from '@/lib/format'
import { readRecent, saveRecent } from '@/lib/storage'
import type { AppApi } from '@/hooks/useAppState'
import type { BrowseEntry } from '@/types'

/* ---------- generic prompt / confirm (replaces window.prompt / confirm) --- */

export function PromptDialog({ app }: { app: AppApi }) {
  const req = app.promptReq
  const [value, setValue] = useState('')
  useEffect(() => {
    if (req) setValue(req.initialValue)
  }, [req])
  return (
    <Dialog
      open={!!req}
      onOpenChange={(open) => {
        if (!open) app.setPromptReq(null)
      }}
    >
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
          <DialogDescription>{req?.label}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && req) {
              req.onConfirm(value)
              app.setPromptReq(null)
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => app.setPromptReq(null)}>
            取消
          </Button>
          <Button
            onClick={() => {
              if (!req) return
              req.onConfirm(value)
              app.setPromptReq(null)
            }}
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmDialog({ app }: { app: AppApi }) {
  const req = app.confirmReq
  return (
    <AlertDialog
      open={!!req}
      onOpenChange={(open) => {
        if (!open) app.setConfirmReq(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{req?.title}</AlertDialogTitle>
          <AlertDialogDescription>{req?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => app.setConfirmReq(null)}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const fn = req?.onConfirm
              app.setConfirmReq(null)
              if (fn) void fn()
            }}
          >
            {req?.confirmLabel || '确定'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* ---------- export confirm (warnings before export) ----------------------- */

export function ConfirmExportDialog({ app }: { app: AppApi }) {
  const c = app.confirmExport
  return (
    <Dialog
      open={!!c}
      onOpenChange={(open) => {
        if (!open) app.setConfirmExport(null)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导出前检查：这些设置可能白花空间</DialogTitle>
          <DialogDescription>{c?.sizeText}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[320px]">
          <div className="flex flex-col gap-2">
            {(c?.warnings || []).map((w, i) => (
              <div key={i} className="rounded-r-md border-l-[3px] border-destructive bg-red-50 dark:bg-red-950/40 px-2.5 py-1.5 text-xs leading-relaxed">
                <b className="block text-xs text-red-800 dark:text-red-300">{w.title}</b>
                {w.text}
              </div>
            ))}
          </div>
        </ScrollArea>
        <p className="text-xs text-muted-foreground">可以返回「设置」页改参数，也可以直接继续导出。</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => app.setConfirmExport(null)}>
            返回修改
          </Button>
          <Button onClick={app.confirmExportGo}>仍然导出</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- export progress / result --------------------------------------- */

export function ExportDialog({ app }: { app: AppApi }) {
  const r = app.exportResult
  return (
    <Dialog
      open={app.exportOpen}
      onOpenChange={(open) => app.setExportOpen(open)}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导出</DialogTitle>
        </DialogHeader>
        <div className="text-xs">{app.exportStatusText}</div>
        <Progress value={app.exportProgress} />
        {app.exportError && <div className="text-xs text-destructive">{app.exportError}</div>}
        {r && (
          <div className="max-h-[200px] overflow-auto text-xs leading-relaxed text-muted-foreground">
            {r.video && (
              <>
                视频: <b className="text-foreground">{r.video}</b>
                <br />
                输出时长: {fmt(r.totalMs)}
                <br />
              </>
            )}
            {r.outputDir && (
              <>
                输出文件夹: <b className="break-all text-foreground">{r.outputDir}</b>
                <br />
              </>
            )}
            字幕:
            <br />
            {Object.entries(r.subtitles).length
              ? Object.entries(r.subtitles).map(([g, p]) => (
                  <span key={g}>
                    {g}: {p}
                    <br />
                  </span>
                ))
              : '（无）'}
            {r.warnings.length > 0 && (
              <>
                <br />
                提示:
                <br />
                {r.warnings.map((w, i) => (
                  <span key={i}>· {w}<br /></span>
                ))}
              </>
            )}
            {r.renamedFrom && (
              <div className="mt-2 rounded-md border border-blue-200 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/40 px-2.5 py-2 text-primary">
                同名文件已存在，本次自动改名为 <b>{r.renamedFrom}</b>，旧文件没有被覆盖。
              </div>
            )}
            {r.reuseNote && (
              <div className="mt-2 rounded-md border border-blue-200 dark:border-blue-800/70 bg-blue-50 dark:bg-blue-950/40 px-2.5 py-2 text-primary">{r.reuseNote}</div>
            )}
          </div>
        )}
        {r && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void app.reveal()}>
              打开所在文件夹
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => app.setExportOpen(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- help ------------------------------------------------------------ */

const HELP_ROWS: [string, string][] = [
  ['空格', '播放 / 暂停'],
  ['← / →', '后退 / 前进 5 秒'],
  ['i / o', '当前字幕行设为起点 / 终点'],
  ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做（片段与字幕校准通用）'],
  ['Ctrl+S', '立即保存工程到磁盘'],
  ['Ctrl+E', '只导出矫正后的字幕'],
  ['字幕 → 时间校准', '切到校准页：拖动迷你时间条、用按钮 ±微调、开「单句循环」边听边改'],
  [', / .', '当前句整体前移 / 后移一步（按住 Shift = ×5）'],
  ['↑ / ↓', '上一句 / 下一句（播放头跟着跳过去）'],
  ['滚轮', '平移时间轴'],
  ['Ctrl + 滚轮', '以光标为中心缩放'],
  ['时间轴单击', '定位播放头'],
  ['时间轴拖拽', '新建片段'],
  ['拖片段两端 / 中间', '只改单边 / 整体平移'],
  ['拖片段时靠近播放头', '边界自动吸附到播放头 / 相邻片段边界 / 片头片尾（约 7 像素内），时间提示显示在片段下方'],
  ['Ctrl+C / Ctrl+X', '复制 / 剪切时间轴上选中的片段'],
  ['Ctrl+V', '粘贴到选中片段之后（没选中就追加到末尾）'],
  ['Delete / Backspace', '删除选中的片段（Ctrl+Z 可撤销）'],
  ['时间轴平移滑块 右键', '把视图居中到当前播放头，保持当前缩放'],
  ['音量滑块 右键', '静音 / 恢复上一次的音量'],
  ['Esc', '取消正在进行的片段拖动'],
  ['片段卡片 复制 / 拆分 / 重命名', '复制 / 在播放头处拆分 / 重命名'],
  ['拖动片段卡片', '上下拖拽调整合并顺序'],
  ['Alt + 拖时间轴片段', '拖到另一段上改变合并顺序'],
  ['成片时间轴单击', '按输出时间定位，跳过未保留部分'],
  ['顶栏主题按钮', '循环切换浅色 / 深色 / 跟随系统（自动记住选择）'],
]

export function HelpDialog({ app }: { app: AppApi }) {
  return (
    <Dialog open={app.helpOpen} onOpenChange={(open) => app.setHelpOpen(open)}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>快捷键与操作说明</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="overflow-hidden rounded-lg border">
            {HELP_ROWS.map(([k, v], i) => (
              <div key={i} className="grid grid-cols-[145px_1fr] gap-2 border-b px-2.5 py-1.5 text-xs last:border-b-0">
                <b className="font-mono text-xs font-medium">{k}</b>
                <span className="text-muted-foreground">{v}</span>
              </div>
            ))}
          </div>
          <p className="pt-2 text-xs text-muted-foreground">长视频建议先放大时间轴再选点，选完点「适应」回到整片视图。</p>
          <p className="pb-1 text-xs text-muted-foreground">主题按钮在顶栏工具组里（太阳 / 月亮 / 显示器），依次切换浅色、深色、跟随系统；选择保存在本机，重启后保持。</p>
        </ScrollArea>
        <DialogFooter>
          <Button onClick={() => app.setHelpOpen(false)}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- directory picker ------------------------------------------------ */

export function DirDialog({ app }: { app: AppApi }) {
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState('')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)

  const browse = async (dir: string) => {
    setLoading(true)
    try {
      const res = await apiClient.browse(dir, 'dir')
      setCwd(res.path)
      setParent(res.parent || '')
      setEntries(res.entries)
      if (res.notice) app.notify(res.notice)
    } catch (e) {
      app.notify('浏览失败: ' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (app.dirOpen) {
      // default_dir (`<片名>_剪辑`) does not exist until export time. Opening
      // the picker on it used to make /api/browse return 500, leaving the
      // dialog empty. Start from a directory that is guaranteed to exist.
      void browse(app.outDir.trim() || app.outDefault?.source_dir || app.config?.cwd || '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.dirOpen])

  return (
    <Dialog open={app.dirOpen} onOpenChange={(open) => app.setDirOpen(open)}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>选择导出文件夹</DialogTitle>
          <DialogDescription>视频和字幕会一起放进所选文件夹，名字仍按原视频生成。留空可恢复默认的「原视频旁边 / 片名_剪辑」。</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1.5">
          <Input value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void browse(cwd.trim()) }} placeholder="输入目录路径，或从下方盘符进入" />
          <Button variant="outline" size="sm" onClick={() => void browse(cwd.trim())}>
            转到
          </Button>
          <Button variant="outline" size="sm" onClick={() => void browse(parent)}>
            上级
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!cwd.trim()}
            title={cwd.trim() ? '在当前目录下新建一个文件夹' : '请先进入一个盘符或文件夹'}
            onClick={() =>
              app.setPromptReq({
                title: '新建文件夹',
                label: `在「${cwd || '当前目录'}」下新建文件夹，名称：`,
                initialValue: '剪辑',
                onConfirm: async (name) => {
                  if (!name.trim()) return
                  try {
                    const res = await apiClient.mkdir(cwd, name.trim())
                    await browse(res.path)
                    app.notify('已新建文件夹：' + res.path)
                  } catch (err) {
                    app.notify('新建失败: ' + (err as Error).message)
                  }
                },
              })
            }
          >
            新建文件夹
          </Button>
        </div>
        <ScrollArea className="h-[240px] rounded-lg border">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">加载中…</div>
          ) : entries.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">此目录没有子文件夹</div>
          ) : (
            <div className="p-1">
              {parent && (
                <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void browse(parent)}>
                  <ChevronUp className="size-4 text-muted-foreground" />
                  <span className="flex-1">.. 上级目录</span>
                </button>
              )}
              {entries.map((e) => (
                <button key={e.path} type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void browse(e.path)}>
                  <Folder className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              app.setOutDir('')
              app.setDirOpen(false)
              void app.refreshExportPath()
            }}
          >
            用默认位置
          </Button>
          <Button variant="outline" onClick={() => app.setDirOpen(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              const dir = cwd.trim()
              if (!dir) return app.notify('请先选择一个文件夹')
              app.setOutDir(dir)
              app.setDirOpen(false)
              void app.refreshExportPath()
              app.notify('导出文件夹已设为：' + dir)
            }}
          >
            就用这个文件夹
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- recent projects -------------------------------------------------- */

export function RecentDialog({ app }: { app: AppApi }) {
  const [items, setItems] = useState(() => readRecent())
  useEffect(() => {
    if (app.recentOpen) setItems(readRecent())
  }, [app.recentOpen])
  return (
    <Dialog open={app.recentOpen} onOpenChange={(open) => app.setRecentOpen(open)}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>最近工程</DialogTitle>
          <DialogDescription>工程保存在本机浏览器里，包含片段、字幕轨和参数；源视频仍需在原来的位置。点「载入」会检查视频是否还在。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[320px]">
          {!items.length ? (
            <div className="py-6 text-center text-xs leading-relaxed text-muted-foreground">
              还没有最近工程。
              <br />
              打开媒体或载入一次工程后，这里会自动记住（保存在本机浏览器里）。
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((r, i) => (
                <div key={r.key + i} className="flex items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-2">
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-xs font-medium">{r.name || '未命名工程'}</b>
                    <span className="block truncate text-xs text-muted-foreground" title={r.path}>
                      {r.path}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {r.clips} 段 · {fmtClock(r.saved_at)}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await app.loadRecentItem(r)
                      } catch (err) {
                        app.notify('工程载入失败: ' + (err as Error).message)
                      }
                    }}
                  >
                    载入
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const list = readRecent()
                      list.splice(i, 1)
                      saveRecent(list)
                      setItems(list)
                    }}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => app.setRecentOpen(false)}>
            关闭
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              app.setRecentOpen(false)
              document.getElementById('project-file-input')?.click()
            }}
          >
            从 JSON 文件导入…
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- open media (two-step wizard) ------------------------------------- */

interface OpenSub {
  path: string
  source_id: string | null
}

export function OpenMediaDialog({ app }: { app: AppApi }) {
  const [step, setStep] = useState(1)
  const [videos, setVideos] = useState<string[]>([])
  const [subs, setSubs] = useState<OpenSub[]>([])
  const [autoSub, setAutoSub] = useState(true)
  const [cwd, setCwd] = useState('')
  const [parent, setParent] = useState('')
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [subCwd, setSubCwd] = useState('')
  const [subParent, setSubParent] = useState('')
  const [subEntries, setSubEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)

  const browse = async (dir: string, kind: 'video' | 'sub') => {
    setLoading(true)
    try {
      const res = await apiClient.browse(dir, kind)
      if (kind === 'video') {
        setCwd(res.path)
        setParent(res.parent || '')
        setEntries(res.entries)
      } else {
        setSubCwd(res.path)
        setSubParent(res.parent || '')
        setSubEntries(res.entries)
      }
    } catch (e) {
      app.notify('浏览失败: ' + (e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (app.openDialog) {
      setStep(1)
      setVideos([])
      setSubs([])
      void browse(app.config?.cwd || '', 'video')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.openDialog])

  const gotoStep2 = () => {
    setStep(2)
    const dir = videos.length ? videos[0].replace(/[\\/][^\\/]+$/, '') : subCwd || ''
    void browse(dir, 'sub')
  }

  const load = (autoOverride?: boolean) => {
    const auto = autoOverride === undefined ? autoSub : autoOverride
    const subtitles = subs.map((s, i) => {
      let sourceId: string | null = s.source_id
      const sid = sourceId || ''
      if (!sourceId || !videos.some((v) => v.toLowerCase() === sid.toLowerCase())) {
        const stem = s.path.replace(/\.(srt|vtt|ass|ssa)$/i, '').toLowerCase()
        const match = videos.find((v) => v.replace(/\.[^.]+$/, '').toLowerCase() === stem)
        sourceId = match || videos[0]
      }
      const idx = videos.findIndex((v) => v.toLowerCase() === (sourceId || videos[0] || '').toLowerCase()) + 1
      return { path: s.path, source_id: `s${Math.max(1, idx)}`, group_id: `g${i + 1}`, label: basename(s.path), lang: '' }
    })
    void app.loadSelected(videos, subtitles, auto)
  }

  const list = (kind: 'video' | 'sub') => {
    const ents = kind === 'video' ? entries : subEntries
    const par = kind === 'video' ? parent : subParent
    if (loading) return <div className="p-6 text-center text-xs text-muted-foreground">加载中…</div>
    if (!ents.length && !par) return <div className="p-6 text-center text-xs text-muted-foreground">此目录没有可选文件</div>
    return (
      <div className="p-1">
        {par && (
          <button type="button" className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void browse(par, kind)}>
            <ChevronUp className="size-4 text-muted-foreground" />
            <span className="flex-1">.. 上级目录</span>
          </button>
        )}
        {ents.map((e) => (
          <button
            key={e.path}
            type="button"
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs hover:bg-muted"
            onClick={() => {
              if (e.is_dir) void browse(e.path, kind)
              else if (kind === 'video') setVideos((v) => (v.some((p) => p.toLowerCase() === e.path.toLowerCase()) ? v : [...v, e.path]))
              else setSubs((s) => (s.some((x) => x.path.toLowerCase() === e.path.toLowerCase()) ? s : [...s, { path: e.path, source_id: null }]))
            }}
          >
            {e.is_dir ? <Folder className="size-4 text-muted-foreground" /> : <FileVideo className="size-4 text-muted-foreground" />}
            <span className="flex-1 truncate">{e.name}</span>
            {!e.is_dir && <span className="text-xs text-muted-foreground">{(e.size / 1048576).toFixed(1)} MB</span>}
          </button>
        ))}
      </div>
    )
  }

  return (
    <Dialog open={app.openDialog} onOpenChange={(open) => app.setOpenDialog(open)}>
      <DialogContent className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>选择媒体 · 第 {step} 步：{step === 1 ? '视频' : '字幕（可跳过）'}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          {[
            { n: 1, label: '选择视频' },
            { n: 2, label: '选择字幕（可跳过）' },
          ].map((s) => (
            <div
              key={s.n}
              className={`flex flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${step === s.n ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground'}`}
            >
              <b className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-xs ${step === s.n ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {s.n}
              </b>
              {s.label}
            </div>
          ))}
        </div>

        {step === 1 && (
          <>
            <div className="flex gap-1.5">
              <Input value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void browse(cwd.trim(), 'video') }} placeholder="输入目录路径，或从下方盘符进入" />
              <Button variant="outline" size="sm" onClick={() => void browse(cwd.trim(), 'video')}>
                转到
              </Button>
              <Button variant="outline" size="sm" onClick={() => void browse(parent, 'video')}>
                上级
              </Button>
            </div>
            <ScrollArea className="h-[240px] rounded-lg border">{list('video')}</ScrollArea>
            <div className="text-xs text-muted-foreground">已选视频（可多选，按加入顺序拼接）</div>
            <ScrollArea className="max-h-[130px] rounded-lg border">
              {!videos.length ? (
                <div className="p-4 text-center text-xs text-muted-foreground">还没有选视频，单击上方目录里的视频文件加入</div>
              ) : (
                <div className="p-1">
                  {videos.map((p, i) => (
                    <div key={p} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">视频</span>
                      <span className="flex-1 truncate" title={p}>
                        {basename(p)}
                      </span>
                      <Button variant="outline" size="xs" onClick={() => setVideos((v) => v.filter((_, n) => n !== i))}>
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => app.setOpenDialog(false)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  if (!videos.length) return app.notify('请先在第 1 步选择至少一个视频')
                  gotoStep2()
                }}
              >
                下一步：选择字幕 →
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 2 && (
          <>
            <div className="flex gap-1.5">
              <Input value={subCwd} onChange={(e) => setSubCwd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void browse(subCwd.trim(), 'sub') }} placeholder="输入字幕所在目录" />
              <Button variant="outline" size="sm" onClick={() => void browse(subCwd.trim(), 'sub')}>
                转到
              </Button>
              <Button variant="outline" size="sm" onClick={() => void browse(subParent, 'sub')}>
                上级
              </Button>
            </div>
            <ScrollArea className="h-[240px] rounded-lg border">{list('sub')}</ScrollArea>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox checked={autoSub} onCheckedChange={(v) => setAutoSub(!!v)} />
              自动匹配同名同目录字幕（.srt / .vtt，含 <span className="font-mono">片名.语言.srt</span> 多语言）
            </label>
            <div className="text-xs text-muted-foreground">已选字幕（可多选；留空则只载入视频）</div>
            <div className="text-xs text-muted-foreground">视频自带的内嵌字幕不用在这里选：载入后在「字幕」页可提取分离，提取后即可用来选点剪辑。</div>
            <ScrollArea className="max-h-[130px] rounded-lg border">
              {!subs.length ? (
                <div className="p-4 text-center text-xs text-muted-foreground">没有手动选字幕（留空时会自动匹配同名 .srt / .vtt）</div>
              ) : (
                <div className="p-1">
                  {subs.map((s, i) => (
                    <div key={s.path} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">字幕</span>
                      <span className="flex-1 truncate" title={s.path}>
                        {basename(s.path)}
                      </span>
                      {videos.length > 1 && (
                        <Select
                          value={s.source_id || videos[0]}
                          onValueChange={(v) => setSubs((arr) => arr.map((x, n) => (n === i ? { ...x, source_id: v } : x)))}
                        >
                          <SelectTrigger className="h-7 w-[140px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {videos.map((v) => (
                              <SelectItem key={v} value={v}>
                                {basename(v)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <Button variant="outline" size="xs" onClick={() => setSubs((arr) => arr.filter((_, n) => n !== i))}>
                        移除
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
            <p className="text-xs leading-relaxed text-muted-foreground">
              字幕在这里单独挑；不挑的话，勾选「自动匹配」会按视频同名去找。<b className="text-foreground">整片压缩不剪辑时不需要字幕</b>：时间轴没变，原来的 .srt
              改名成输出视频同名即可继续用。
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep(1)}>
                ← 上一步
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSubs([])
                  load(false)
                }}
              >
                只载入视频
              </Button>
              <Button onClick={() => load()}>载入</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function HiddenFileInputs({ app }: { app: AppApi }) {
  return (
    <>
      <input
        id="project-file-input"
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            await app.loadProjectFile(file)
          } catch (err) {
            app.notify('工程载入失败: ' + (err as Error).message)
          }
          e.target.value = ''
        }}
      />
    </>
  )
}
