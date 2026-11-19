import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle, Info, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'
import { fmt, fmtMB, basename } from '@/lib/format'
import { BASIC_KEYS, CUSTOM_VALUE, ENCODE_SPECS, countEncodeChanges, customConfig, defaultEncode, type EncodeSpec } from '@/lib/encode'
import { loadPresets, savePresets, downloadJson, readFileAsText } from '@/lib/storage'
import type { AppApi } from '@/hooks/useAppState'

function EncodeField({
  spec,
  app,
  disabled,
}: {
  spec: EncodeSpec
  app: AppApi
  disabled: boolean
}) {
  const value = app.encValues[spec.key] ?? ''
  const custom = customConfig(spec)
  const options = spec.options(app.srcInfo)
  const isCustom = value === CUSTOM_VALUE
  return (
    <div className="pb-3">
      <Label className="mb-1.5 flex items-center gap-1 text-xs font-normal text-foreground">
        {spec.label}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-muted-foreground hover:text-primary" aria-label={`${spec.label}说明`}>
                <HelpCircle className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs leading-relaxed">{spec.tip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Label>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(v) => app.updateEncode(spec.key, v)}
      >
        <SelectTrigger className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.v} value={o.v}>
              {o.t}
            </SelectItem>
          ))}
          {custom && <SelectItem value={CUSTOM_VALUE}>自定义数值…（自己输入）</SelectItem>}
        </SelectContent>
      </Select>
      {custom && isCustom && (
        <>
          <Input
            className="mt-1.5 border-primary bg-blue-50/50 dark:bg-blue-950/30"
            type="number"
            min={custom.min}
            max={custom.max}
            step={custom.step}
            placeholder={`输入任意数值${custom.unit ? `（${custom.unit}）` : ''}`}
            value={app.encCustomValues[spec.key] ?? ''}
            disabled={disabled}
            onChange={(e) => app.updateEncode(spec.key, CUSTOM_VALUE, e.target.value)}
          />
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{custom.hint}</span>
        </>
      )}
      {spec.source && (
        <span className="mt-1 block text-xs text-muted-foreground">原片：{spec.source(app.srcInfo)}</span>
      )}
    </div>
  )
}

export function SettingsPanel({ app }: { app: AppApi }) {
  const [presetNames, setPresetNames] = useState<string[]>(() => Object.keys(loadPresets()).sort())
  const [selectedPreset, setSelectedPreset] = useState('')
  const [nav, setNav] = useState('sec-output')
  const custom = app.profileMode === 'custom'
  const lossless = app.mode === 'lossless'
  const profile = app.profiles.find((p) => p.id === app.profileMode) || null
  const enc = app.collectEncodeNow()
  const changed = countEncodeChanges(enc)
  const check = app.lastCheck
  const v = app.srcInfo?.video || {}
  const a = app.srcInfo?.audio || {}
  const f = app.srcInfo?.format || {}

  const adaptiveTarget = useMemo(() => {
    const vid = app.srcInfo?.video
    const height = vid?.height || 0
    const vkbps = vid?.video_kbps || 0
    const fps = vid?.fps_float || 0
    const codec = (vid?.codec || '').toLowerCase()
    const isEfficient = ['av1', 'av01', 'vp9', 'hevc', 'h265'].some((c) => codec.includes(c))
    const effectiveKbps = isEfficient ? Math.round(vkbps * 1.5) : vkbps

    // 1. 高帧率全局优先升一档
    if (fps >= 49.0) {
      return {
        id: 'builtin_720p_t1' as const,
        name: '一档 · 防马赛克',
        tagline: 'CRF 27 / 峰值 1100k / 音频 96k',
        reason: '检测到高帧率(>=50fps)动态片源，自动升为一档（CRF 27 / 峰值 1100k）以抑制运动撕裂与马赛克。',
      }
    }

    // 2. 小分辨率 (<= 540p)
    if (height > 0 && height <= 540) {
      return {
        id: 'builtin_720p_t3' as const,
        name: '三档 · 极致紧凑',
        tagline: 'CRF 28 / 峰值 900k / 音频 96k',
        reason: '源片本身分辨率较低(<=540p)，分配三档极致紧凑（CRF 28 / 峰值 900k），避免二次重编码体积虚胖浪费。',
      }
    }

    // 3. 720p 档位 (540p < height <= 720p)
    if (height > 540 && height <= 720) {
      if (effectiveKbps >= 1000 || (isEfficient && vkbps >= 650)) {
        return {
          id: 'builtin_720p_t1' as const,
          name: '一档 · 防马赛克',
          tagline: 'CRF 27 / 峰值 1100k / 音频 96k',
          reason: '720p 源片具备充足有效码率与动态细节，自动升为一档（CRF 27 / 峰值 1100k）以杜绝镜头晃动马赛克。',
        }
      }
      if ((effectiveKbps > 0 && effectiveKbps < 650) || (isEfficient && vkbps > 0 && vkbps < 450)) {
        return {
          id: 'builtin_720p_t3' as const,
          name: '三档 · 极致紧凑',
          tagline: 'CRF 28 / 峰值 900k / 音频 96k',
          reason: '720p 源片码率较为匮乏，分配三档极致紧凑（CRF 28 / 峰值 900k）以防二次转码体积虚胖。',
        }
      }
      return {
        id: 'builtin_720p_t2' as const,
        name: '二档 · 标准主力',
        tagline: 'CRF 27 / 峰值 950k / 音频 96k',
        reason: '720p 标准均衡片源，分配二档标准主力（CRF 27 / 峰值 950k），兼顾画质与轻量体积。',
      }
    }

    // 4. 1080p 档位 (720p < height <= 1080p)
    if (height > 720 && height <= 1080) {
      if (effectiveKbps >= 2400) {
        return {
          id: 'builtin_720p_t1' as const,
          name: '一档 · 防马赛克',
          tagline: 'CRF 27 / 峰值 1100k / 音频 96k',
          reason: '1080p 高清源片且码率充沛，下采样至 720p 时自动升为一档（CRF 27 / 峰值 1100k）保留高保真细节。',
        }
      }
      if (effectiveKbps > 0 && effectiveKbps < 850) {
        return {
          id: 'builtin_720p_t3' as const,
          name: '三档 · 极致紧凑',
          tagline: 'CRF 28 / 峰值 900k / 音频 96k',
          reason: '1080p 源片码率较为紧凑，分配三档极致紧凑（CRF 28 / 峰值 900k），杜绝过度转码浪费。',
        }
      }
      return {
        id: 'builtin_720p_t2' as const,
        name: '二档 · 标准主力',
        tagline: 'CRF 27 / 峰值 950k / 音频 96k',
        reason: '1080p 常规教学与日常片源，分配二档标准主力（CRF 27 / 峰值 950k），兼顾扎实画质与精简体积。',
      }
    }

    // 5. 4K / 超清档位 (height > 1080p)
    if (height > 1080) {
      if (effectiveKbps > 0 && effectiveKbps < 1200) {
        return {
          id: 'builtin_720p_t3' as const,
          name: '三档 · 极致紧凑',
          tagline: 'CRF 28 / 峰值 900k / 音频 96k',
          reason: '超清源片码率较低，分配三档极致紧凑以防体积虚胖。',
        }
      }
      return {
        id: 'builtin_720p_t1' as const,
        name: '一档 · 防马赛克',
        tagline: 'CRF 27 / 峰值 1100k / 音频 96k',
        reason: '4K/超清高精源片，下采样至 720p 时自动分配一档（CRF 27 / 峰值 1100k）以保留最佳纹理。',
      }
    }

    // 6. 未知分辨率回退
    if (effectiveKbps >= 1500) {
      return {
        id: 'builtin_720p_t1' as const,
        name: '一档 · 防马赛克',
        tagline: 'CRF 27 / 峰值 1100k / 音频 96k',
        reason: '源片有效码率充沛，自动分配一档（CRF 27 / 峰值 1100k）防马赛克。',
      }
    }
    if (effectiveKbps > 0 && effectiveKbps < 800) {
      return {
        id: 'builtin_720p_t3' as const,
        name: '三档 · 极致紧凑',
        tagline: 'CRF 28 / 峰值 900k / 音频 96k',
        reason: '源片有效码率较低，自动分配三档极致紧凑（CRF 28 / 峰值 900k）防虚胖。',
      }
    }
    return {
      id: 'builtin_720p_t2' as const,
      name: '二档 · 标准主力',
      tagline: 'CRF 27 / 峰值 950k / 音频 96k',
      reason: '源片码率适中，优先分配二档标准主力（CRF 27 / 峰值 950k）。',
    }
  }, [app.srcInfo])

  const scrollTo = (id: string) => {
    setNav(id)
    if (id === 'paramsTitle' && !custom) {
      app.notify('转码参数在 ② 720p / ① 沿用原片 下是锁定的；选 ③ 自定义 才能修改')
      return
    }
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const refreshPresetNames = (selected?: string) => {
    const names = Object.keys(loadPresets()).sort()
    setPresetNames(names)
    if (selected && names.includes(selected)) setSelectedPreset(selected)
    else if (!names.includes(selectedPreset)) setSelectedPreset('')
  }

  const basic = useMemo(() => ENCODE_SPECS.filter((s) => BASIC_KEYS.has(s.key)), [])
  const advanced = useMemo(() => ENCODE_SPECS.filter((s) => !BASIC_KEYS.has(s.key)), [])

  const estimateText = (() => {
    if (!check) return '正在检查参数…'
    const est = check.estimated_bytes
    if (est === null || est === undefined) return 'CRF 模式无法预估体积'
    return `${check.is_upper_bound ? '体积上限' : '预计体积'} ${(est / 1048576).toFixed(1)} MB${
      check.ratio !== null && check.ratio !== undefined ? ` · 约为原片按保留时长的 ${check.ratio.toFixed(2)}×` : ''
    }${check.source_equivalent_bytes ? ` · 原片等比 ${(check.source_equivalent_bytes / 1048576).toFixed(1)} MB` : ''}`
  })()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b pb-1.5">
        <div className="flex flex-wrap gap-1 pb-1.5">
          {[
            ['sec-output', '导出位置'],
            ['sec-basic', '基础'],
            ['paramsTitle', '转码参数'],
            ['sec-help', '说明'],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant={nav === id ? 'secondary' : 'outline'}
              size="xs"
              className={id === 'paramsTitle' && !custom ? 'opacity-55' : ''}
              onClick={() => scrollTo(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-1.5 pb-1.5">
          {(app.profiles.length > 0
            ? app.profiles
            : [
                { id: 'source', label: '沿用原片', tagline: '什么都不改', detail: '' },
                { id: 'builtin_720p', label: '720p 智能自适应', tagline: '算法毫秒匹配', detail: '' },
                { id: 'builtin_720p_t1', label: '一档 · 防马赛克', tagline: 'CRF 27 / 1100k', detail: '' },
                { id: 'builtin_720p_t2', label: '二档 · 标准主力', tagline: 'CRF 27 / 950k', detail: '' },
                { id: 'builtin_720p_t3', label: '三档 · 极致紧凑', tagline: 'CRF 28 / 900k', detail: '' },
                { id: 'custom', label: '自定义', tagline: '全部参数开放', detail: '' },
              ]
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => app.setProfileMode(p.id as any)}
              className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${
                app.profileMode === p.id ? 'border-primary bg-primary/10 shadow-[inset_0_0_0_1px_hsl(var(--primary))]' : 'border-input bg-background hover:border-primary'
              }`}
              title={p.detail || p.tagline}
            >
              <b className={`block truncate text-xs ${app.profileMode === p.id ? 'text-primary' : ''}`}>{p.label}</b>
              <span className="block truncate text-xs text-muted-foreground">{p.tagline}</span>
            </button>
          ))}
        </div>
        {app.profileMode === 'builtin_720p' && (
          <div className="mb-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-primary animate-pulse" />
                <span className="font-semibold text-foreground">
                  算法决策预设：已自动匹配【{adaptiveTarget.name}】
                </span>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-mono text-primary">
                  {adaptiveTarget.tagline}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">更改为：</span>
                <button
                  type="button"
                  onClick={() => app.setProfileMode('builtin_720p_t1')}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    adaptiveTarget.id === 'builtin_720p_t1'
                      ? 'border-primary bg-primary/10 font-semibold text-primary'
                      : 'border-input hover:border-primary hover:bg-background'
                  }`}
                  title="强制指定为一档：CRF 27 / 峰值 1100k"
                >
                  一档 (防马赛克)
                </button>
                <button
                  type="button"
                  onClick={() => app.setProfileMode('builtin_720p_t2')}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    adaptiveTarget.id === 'builtin_720p_t2'
                      ? 'border-primary bg-primary/10 font-semibold text-primary'
                      : 'border-input hover:border-primary hover:bg-background'
                  }`}
                  title="强制指定为二档：CRF 27 / 峰值 950k"
                >
                  二档 (标准主力)
                </button>
                <button
                  type="button"
                  onClick={() => app.setProfileMode('builtin_720p_t3')}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    adaptiveTarget.id === 'builtin_720p_t3'
                      ? 'border-primary bg-primary/10 font-semibold text-primary'
                      : 'border-input hover:border-primary hover:bg-background'
                  }`}
                  title="强制指定为三档：CRF 28 / 峰值 900k"
                >
                  三档 (极致紧凑)
                </button>
              </div>
            </div>
            <p className="mt-1 text-muted-foreground">{adaptiveTarget.reason}</p>
          </div>
        )}
        {['builtin_720p_t1', 'builtin_720p_t2', 'builtin_720p_t3'].includes(app.profileMode) && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
            <span>
              📌 <b>当前已手动指定档位</b>：
              {app.profileMode === 'builtin_720p_t1' && '一档 · 防马赛克 (CRF 27 / 峰值 1100k / 音频 96k)'}
              {app.profileMode === 'builtin_720p_t2' && '二档 · 标准主力 (CRF 27 / 峰值 950k / 音频 96k)'}
              {app.profileMode === 'builtin_720p_t3' && '三档 · 极致紧凑 (CRF 28 / 峰值 900k / 音频 96k)'}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => app.setProfileMode('builtin_720p')}
              className="text-primary hover:text-primary"
            >
              ↺ 恢复算法智能自适应
            </Button>
          </div>
        )}
        <div className="mb-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          {!app.srcInfo || !v.width
            ? '打开视频后自动读取并回显原片参数（编码、分辨率、帧率、位深、码率、音频、体积）。'
            : (
              <>
                <b className="text-foreground">{app.currentSource ? basename(app.currentSource.path) : '源片'}</b> · {v.width}×{v.height} ·{' '}
                {String(v.codec || '').toUpperCase()} {v.profile || ''} · {v.pix_fmt || ''} · {(v.fps_float || 0).toFixed(3)} fps
                <br />
                视频 {v.video_kbps || 0} kbps · 音频 {String(a.codec || '无').toUpperCase()} {a.audio_kbps || 0} kbps / {a.sample_rate || 0} Hz /{' '}
                {a.channels || 0} 声道 · 全长 {fmt(f.duration_ms || 0)} · {fmtMB(f.size_bytes)}
              </>
            )}
        </div>
        {custom && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
            <Select value={selectedPreset} onValueChange={setSelectedPreset}>
              <SelectTrigger className="h-8 w-[150px] text-xs" title="已保存的参数预设">
                <SelectValue placeholder="— 已保存的预设 —" />
              </SelectTrigger>
              <SelectContent>
                {presetNames.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (!selectedPreset) return app.notify('请先选择一个预设')
                const p = loadPresets()[selectedPreset]
                if (p) app.applyPresetValues(p as never)
              }}
            >
              应用
            </Button>
            <Button
              size="xs"
              onClick={() =>
                app.setPromptReq({
                  title: '保存参数预设',
                  label: '给这套参数起个名字：',
                  initialValue: '我的预设',
                  onConfirm: (name) => {
                    if (!name.trim()) return
                    const data = loadPresets()
                    data[name.trim()] = {
                      encode: app.collectEncodeNow(),
                      preset: app.presetSpeed,
                      embed_subtitles: app.embedSubs,
                      updated: Date.now(),
                    }
                    savePresets(data)
                    refreshPresetNames(name.trim())
                    app.notify('已保存预设：' + name.trim())
                  },
                })
              }
            >
              另存为
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (!selectedPreset) return app.notify('请先选择一个预设')
                app.setConfirmReq({
                  title: `删除预设「${selectedPreset}」？`,
                  description: '删除后无法恢复。',
                  confirmLabel: '删除',
                  onConfirm: () => {
                    const data = loadPresets()
                    delete data[selectedPreset]
                    savePresets(data)
                    refreshPresetNames()
                    app.notify('已删除预设：' + selectedPreset)
                  },
                })
              }}
            >
              删除
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                const data = loadPresets()
                if (!Object.keys(data).length) return app.notify('还没有保存过预设')
                downloadJson('clip-video-presets.json', { version: 1, presets: data })
                app.notify('预设已导出为 JSON')
              }}
            >
              导出
            </Button>
            <Button variant="outline" size="xs" onClick={() => document.getElementById('preset-file-input')?.click()}>
              导入
            </Button>
            <Button variant="outline" size="xs" onClick={app.shrinkPreset} title="把视频码率设为原片的一半、音频降到 96 kbps，快速压小体积">
              一键省体积
            </Button>
            <Button variant="outline" size="xs" onClick={app.resetEncode}>
              恢复原片
            </Button>
          </div>
        )}
        <div className="rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          <span dangerouslySetInnerHTML={{ __html: '' }} />
          {estimateText}
          <br />
          {changed ? (
            <>
              已修改 <b className="text-primary">{changed}</b> 项参数
            </>
          ) : (
            '全部沿用原片参数'
          )}
          {check?.estimate_note ? ` · ${check.estimate_note}` : ''}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 pt-2">
        <div className="mb-3 flex flex-col gap-1.5">
          {(check?.warnings || []).map((w, i) => (
            <div
              key={i}
              className={`rounded-r-md border-l-[3px] px-2.5 py-1.5 text-xs leading-relaxed ${
                w.level === 'warn'
                  ? 'border-destructive bg-red-50 dark:bg-red-950/40'
                  : w.level === 'info'
                    ? 'border-primary bg-muted'
                    : 'border-green-600 dark:border-green-500 bg-muted'
              }`}
            >
              <b className="flex items-center gap-1 text-xs">
                {w.level === 'warn' ? <AlertTriangle className="size-4 text-destructive" /> : w.level === 'info' ? <Info className="size-4 text-primary" /> : <CheckCircle2 className="size-4 text-green-600" />}
                {w.title}
              </b>
              {w.text}
            </div>
          ))}
          {check && !(check.warnings || []).length && (
            <div className="rounded-r-md border-l-[3px] border-green-600 dark:border-green-500 bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
              当前参数没有发现浪费或风险。
            </div>
          )}
          {!check && <div className="text-xs text-muted-foreground">打开视频后自动检查参数。</div>}
        </div>

        {!custom && profile && (
          <div className="mb-3 rounded-lg border bg-muted/60 p-3">
            <div className="mb-1 flex flex-wrap items-baseline gap-1.5">
              <b className="text-xs">{profile.label}</b>
              <span className="text-xs text-primary">{profile.tagline}</span>
            </div>
            <div className="mb-2 text-xs leading-relaxed text-muted-foreground">{profile.detail}</div>
            {app.profileMode === 'source' ? (
              <div className="flex items-start gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
                <Lock className="mt-0.5 size-4 shrink-0" />
                已锁定：视频编码、分辨率、码率、音频、字幕格式等全部沿用原片，不能修改。想压缩体积请选 ② 720p 省体积，或 ③ 自定义。
              </div>
            ) : (
              <>
                {profile.bullets?.length ? (
                  <div className="overflow-hidden rounded-md border bg-background">
                    {profile.bullets.map((b, i) => (
                      <div key={i} className="grid grid-cols-[76px_1fr] gap-x-2 border-b px-2.5 py-1.5 text-xs leading-relaxed last:border-b-0">
                        <b className="row-span-2 font-medium">{b.name}</b>
                        <span>{b.value}</span>
                        <span className="text-xs text-muted-foreground">{b.why}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {profile.command && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">查看对应的 ffmpeg 命令</summary>
                    <code className="mt-1.5 block whitespace-pre-wrap break-all rounded-md bg-zinc-900 dark:bg-black p-2 font-mono text-xs leading-relaxed text-blue-100">
                      {profile.command}
                    </code>
                  </details>
                )}
                <div className="mt-2 flex justify-end">
                  <Button variant="outline" size="xs" onClick={app.applyBuiltinAsCustom}>
                    以此为基础微调 →
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        <h3 id="sec-output" className="mb-2 border-b pb-1.5 text-xs font-semibold">
          导出位置 <span className="ml-1 font-normal text-muted-foreground">默认在原视频旁边新建同名「剪辑」文件夹</span>
        </h3>
        <Label className="mb-1.5 block text-xs font-normal text-muted-foreground">输出文件夹</Label>
        <div className="mb-3 flex gap-1.5">
          <Input
            placeholder="留空 = 原视频所在文件夹 / 片名_剪辑"
            value={app.outDir}
            onChange={(e) => {
              app.setOutDir(e.target.value)
              app.scheduleExportPath()
            }}
          />
          <Button variant="outline" size="xs" onClick={() => app.setDirOpen(true)} title="浏览本机文件夹">
            选择…
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              app.setOutDir('')
              app.setOutName('')
              void app.refreshExportPath()
              app.notify('已恢复默认导出位置（原视频旁边的新建文件夹）')
            }}
            title="恢复成原视频旁边的默认文件夹"
          >
            默认
          </Button>
        </div>
        <Label className="mb-1.5 block text-xs font-normal text-muted-foreground">输出文件名（不用写扩展名）</Label>
        <Input
          className="mb-2"
          placeholder="留空 = 片名_剪辑"
          value={app.outName}
          onChange={(e) => {
            app.setOutName(e.target.value)
            app.scheduleExportPath()
          }}
        />
        <div className="mb-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          {app.outDefault ? (
            <>
              将导出到：<b className="text-primary">{app.outDefault.path}</b>
              <br />
              默认位置：<span className="font-mono">{app.outDefault.default_dir}</span>
              {app.outDefault.renamed_from && (
                <>
                  <br />
                  <span className="text-destructive">
                    同名已存在，将自动改名为 <b>{app.outDefault.filename}</b>，不会覆盖旧文件。
                  </span>
                </>
              )}
            </>
          ) : (
            '打开视频后自动按第一个源片命名'
          )}
        </div>
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
          视频和字幕会一起放进这个文件夹，文件名同源。多次导出同名时<b>不会覆盖</b>，自动变成 <span className="font-mono">_2</span>、
          <span className="font-mono">_3</span>…（视频、字幕、封装版整批一起改号）。
        </p>
        <label className="mb-3 flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="accent-primary"
            checked={app.overwrite}
            onChange={(e) => {
              app.setOverwrite(e.target.checked)
              app.scheduleExportPath()
            }}
          />
          允许覆盖同名文件（仍会保护原始视频不被覆盖）
        </label>

        <h3 id="sec-basic" className="mb-2 border-b pb-1.5 text-xs font-semibold">
          基础 <span className="ml-1 font-normal text-muted-foreground">编码与选点</span>
        </h3>
        <Label className="mb-1.5 block text-xs font-normal text-muted-foreground">编码速度（越慢，同码率画质越接近原片）</Label>
        <Select
          value={app.presetSpeed}
          onValueChange={(v) => {
            app.setPresetSpeed(v)
            app.updateOutput({ preset: v })
          }}
        >
          <SelectTrigger className="mb-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="veryfast">快（veryfast）</SelectItem>
            <SelectItem value="medium">均衡（medium，默认）</SelectItem>
            <SelectItem value="slow">慢（slow）</SelectItem>
          </SelectContent>
        </Select>
        <Label className="mb-1.5 block text-xs font-normal text-muted-foreground">吸附容差（ms）</Label>
        <Input
          className="mb-3"
          type="number"
          value={app.snapTol}
          onChange={(e) => {
            const n = Number(e.target.value) || 500
            app.setSnapTol(n)
            app.updateOutput({ snap_tolerance_ms: n })
          }}
        />
        <label className="mb-3 flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="accent-primary"
            checked={app.embedSubs}
            onChange={(e) => {
              app.setEmbedSubs(e.target.checked)
              app.updateOutput({ embed_subtitles: e.target.checked })
            }}
          />
          同时把字幕封装进视频
        </label>

        {custom && (
          <>
            <h3 id="paramsTitle" className="mb-2 border-b pb-1.5 text-xs font-semibold">
              转码参数{' '}
              <span className="ml-1 font-normal text-muted-foreground">
                全部下拉选择 · 悬停 <HelpCircle className="inline size-3.5" /> 看影响 · 仅精确模式生效
              </span>
              {lossless && <Badge variant="secondary" className="ml-2">无损模式下忽略</Badge>}
            </h3>
            <div className={lossless ? 'opacity-50' : ''}>
              <details open className="mb-2 overflow-hidden rounded-lg border">
                <summary className="cursor-pointer bg-muted px-2.5 py-1.5 text-xs font-medium">
                  常用 · 决定体积和画质 <span className="font-normal text-muted-foreground">· 这几种最值得调 · {basic.length} 项</span>
                </summary>
                <div className="px-2.5 pt-2.5">
                  {basic.map((s) => (
                    <EncodeField key={s.key} spec={s} app={app} disabled={lossless} />
                  ))}
                </div>
              </details>
              <details className="mb-2 overflow-hidden rounded-lg border">
                <summary className="cursor-pointer bg-muted px-2.5 py-1.5 text-xs font-medium">
                  高级 · 兼容性与细节 <span className="font-normal text-muted-foreground">· 看不懂就别动，默认沿用原片 · {advanced.length} 项</span>
                </summary>
                <div className="px-2.5 pt-2.5">
                  {advanced.map((s) => (
                    <EncodeField key={s.key} spec={s} app={app} disabled={lossless} />
                  ))}
                </div>
              </details>
            </div>
            <details className="mb-3 rounded-lg border">
              <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground">参数影响速查表（画质 / 体积 / 兼容性）</summary>
              {ENCODE_SPECS.map((s) => (
                <div key={s.key} className="flex gap-1.5 border-t px-2.5 py-1.5 text-xs leading-relaxed">
                  <b className="w-24 shrink-0 font-medium">{s.label}</b>
                  <span className="text-muted-foreground">{s.tip}</span>
                </div>
              ))}
            </details>
          </>
        )}
        {!custom && <div id="paramsTitle" className="hidden" />}

        <h3 id="sec-help" className="mb-2 border-b pb-1.5 text-xs font-semibold">
          说明 <span className="ml-1 font-normal text-muted-foreground">两种导出模式到底做了什么</span>
        </h3>
        <div className="mb-3 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-2">
            <b className="text-foreground">精确模式（默认）</b>：帧级准确，字幕就是「原时间 − 起点」，没有任何补偿或回读。会自动读取原片的位深、profile、level、色彩标签、GOP、B
            帧数、音频采样率与声道并<b>回填给编码器</b>（不会再把 10-bit 压成 8-bit）。仍是二次压缩，画质极接近但<b>不是逐字节一致</b>；实测同码率下 medium 比 veryfast
            高约 1.7 dB PSNR。
          </p>
          <p className="mb-2">
            <b className="text-foreground">无损模式</b>：不重新编码，画质逐字节一致；但流拷贝只能从关键帧起刀（起点提前 0~几秒），终点按包截断（每段尾部约多 0.2s，多段合并会逐段累积）。下方转码参数在无损模式下自动忽略，只有字幕格式、容器、faststart
            仍生效。
          </p>
          <p>
            <b className="text-foreground">只压缩不剪辑</b>：选 ② 720p 省体积后，到「片段」页点「整片（不剪辑）」即可铺满全长。此时<b>可以不载入字幕</b>——时间轴没变，原来的 .srt
            改名成输出视频同名就能继续用；工具也不会生成多余的字幕文件。
          </p>
        </div>
        <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
          {app.config ? (
            <>
              ffmpeg: {app.config.ffmpeg}
              <br />
              ffprobe: {app.config.ffprobe}
              <br />
              工作目录: {app.config.cwd}
            </>
          ) : (
            '正在读取环境信息…'
          )}
        </div>
      </div>
      <input
        id="preset-file-input"
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            const parsed = JSON.parse(await readFileAsText(file))
            const incoming = parsed.presets || parsed
            const data = loadPresets()
            let n = 0
            Object.keys(incoming).forEach((k) => {
              if (incoming[k]?.encode) {
                data[k] = incoming[k]
                n++
              }
            })
            savePresets(data)
            refreshPresetNames()
            app.notify(`已导入 ${n} 个预设`)
          } catch (err) {
            app.notify('预设文件解析失败: ' + (err as Error).message)
          }
          e.target.value = ''
        }}
      />
    </div>
  )
}
