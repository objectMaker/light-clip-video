import { Download, FolderOpen, HelpCircle, History, Save, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AppApi } from '@/hooks/useAppState'

export function Topbar({ app }: { app: AppApi }) {
  const projectName = app.project?.name || '未载入媒体'
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold tracking-tight">clip-video</span>
      </div>
      <Button onClick={() => app.setOpenDialog(true)} size="sm">
        <FolderOpen className="size-4" />
        打开媒体
      </Button>
      <span className="max-w-[180px] truncate text-sm text-muted-foreground" title={projectName}>
        {projectName}
      </span>
      <div className="flex-1" />
      <TooltipProvider>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={app.snapToCue}
            onCheckedChange={(v) => {
              app.setSnapToCue(v)
              app.updateOutput({ snap_to_cue: v })
            }}
          />
          吸附到字幕边界
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select
                value={app.mode}
                onValueChange={(v) => {
                  const m = v as 'precise' | 'lossless'
                  app.setMode(m)
                  app.updateOutput({ mode: m })
                }}
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="precise">精确模式（帧级准确·回填原片参数）</SelectItem>
                  <SelectItem value="lossless">无损模式（逐字节原画质·切点吸附关键帧）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent>导出方式：精确模式重新编码、帧级准确；无损模式流拷贝、起点吸附关键帧。</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={app.saveProjectFile} title="把工程存成 JSON，随时可以继续编辑">
          <Save className="size-4" />
          保存工程
        </Button>
        <Button variant="ghost" size="sm" onClick={() => document.getElementById('project-file-input')?.click()} title="载入之前保存的工程 JSON">
          <Upload className="size-4" />
          打开工程
        </Button>
        <Button variant="ghost" size="sm" onClick={() => app.setRecentOpen(true)} title="最近编辑过的工程，点一下就能接着做">
          <History className="size-4" />
          最近工程
        </Button>
        <Button variant="ghost" size="icon" onClick={() => app.setHelpOpen(true)} title="快捷键与操作说明">
          <HelpCircle className="size-4" />
        </Button>
      </div>
      <Button onClick={() => void app.startExport()} className="gap-2">
        <Download className="size-4" />
        导出
      </Button>
    </header>
  )
}
