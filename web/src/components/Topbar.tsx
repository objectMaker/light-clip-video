import type { ReactNode } from 'react'
import { Clapperboard, Download, FolderOpen, HelpCircle, History, Monitor, Moon, Save, Sun, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme, THEME_LABEL, type Theme } from '@/hooks/useTheme'
import type { AppApi } from '@/hooks/useAppState'

const NEXT_HINT: Record<Theme, string> = {
  light: '点击切换为深色主题',
  dark: '点击切换为跟随系统',
  system: '点击切换为浅色主题',
}

function IconAction({
  label,
  hint,
  onClick,
  children,
}: {
  label: string
  hint?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={onClick}
          aria-label={label}
          title={hint ? `${label} · ${hint}` : label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {hint ? ` · ${hint}` : ''}
      </TooltipContent>
    </Tooltip>
  )
}

export function Topbar({ app }: { app: AppApi }) {
  const { theme, cycleTheme } = useTheme()
  const projectName = app.project?.name || '未载入媒体'
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 shadow-sm">
      <div className="flex shrink-0 items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <Clapperboard className="size-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Light Clip</span>
          <span className="text-xs text-muted-foreground">视频字幕剪辑</span>
        </div>
      </div>

      <div className="mx-1 h-6 w-px shrink-0 bg-border" />

      <Button onClick={() => app.setOpenDialog(true)} size="sm" className="shrink-0">
        <FolderOpen className="size-4" />
        打开媒体
      </Button>
      <span className="max-w-[160px] shrink-0 truncate text-sm text-muted-foreground" title={projectName}>
        {projectName}
      </span>

      <div className="min-w-2 flex-1" />

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={app.snapToCue}
                onCheckedChange={(v) => {
                  app.setSnapToCue(v)
                  app.updateOutput({ snap_to_cue: v })
                }}
              />
              吸附字幕
            </label>
          </TooltipTrigger>
          <TooltipContent>让切点自动吸附到最近的字幕边界，避免切在半句话中间。</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="shrink-0">
              <Select
                value={app.mode}
                onValueChange={(v) => {
                  const m = v as 'precise' | 'lossless'
                  app.setMode(m)
                  app.updateOutput({ mode: m })
                }}
              >
                <SelectTrigger className="h-8 w-[210px]" title="导出方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="precise">精确模式 · 帧级准确</SelectItem>
                  <SelectItem value="lossless">无损模式 · 流拷贝</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs leading-relaxed">
            精确模式重新编码、帧级准确、可改参数；无损模式直接流拷贝，画质与体积不变，但起点须吸附关键帧。
          </TooltipContent>
        </Tooltip>

        <div className="mx-1 h-6 w-px shrink-0 bg-border" />

        <div className="flex shrink-0 items-center rounded-lg border bg-muted/40 p-0.5">
          <IconAction label="保存工程" hint="存成 JSON，随时继续编辑" onClick={app.saveProjectFile}>
            <Save className="size-4" />
          </IconAction>
          <IconAction label="打开工程" hint="载入之前保存的工程 JSON" onClick={() => document.getElementById('project-file-input')?.click()}>
            <Upload className="size-4" />
          </IconAction>
          <IconAction label="最近工程" hint="一键接着做" onClick={() => app.setRecentOpen(true)}>
            <History className="size-4" />
          </IconAction>
          <IconAction label="主题" hint={`${THEME_LABEL[theme]} · ${NEXT_HINT[theme]}`} onClick={cycleTheme}>
            <ThemeIcon className="size-4" />
          </IconAction>
          <IconAction label="快捷键与操作说明" onClick={() => app.setHelpOpen(true)}>
            <HelpCircle className="size-4" />
          </IconAction>
        </div>
      </TooltipProvider>

      <Button onClick={() => void app.startExport()} className="shrink-0 gap-2 shadow-sm">
        <Download className="size-4" />
        导出
      </Button>
    </header>
  )
}
