import type { EncodeCfg, SrcInfo } from '../types'

export interface EncodeOption {
  v: string
  t: string
}

export interface EncodeSpec {
  group: string
  key: string
  label: string
  tip: string
  numeric?: boolean
  custom?: { unit?: string; step?: number; max?: number; hint?: string }
  source?: (info: SrcInfo | null) => string
  options: (info: SrcInfo | null) => EncodeOption[]
}

function opt(v: string | number, t: string): EncodeOption {
  return { v: String(v), t: String(t) }
}

function uniqOpts(list: EncodeOption[]): EncodeOption[] {
  const seen = new Set<string>()
  return list.filter((o) => {
    if (seen.has(o.v)) return false
    seen.add(o.v)
    return true
  })
}

const nd = uniqOpts

// One declarative spec drives: the dropdowns, the source read-back labels, the
// hover help, the cheat sheet and the JSON presets. Everything is a <select>
// so the user never has to guess a legal ffmpeg value.
export const ENCODE_SPECS: EncodeSpec[] = [
  { group: '视频 · 画面', key: 'video_codec', label: '视频编码器',
    tip: '压缩算法。本项目默认 H.264：几乎所有设备、网页播放器和老手机都能播。H.265 虽在同画质下小 30~50%，但很多浏览器和旧设备没有硬解，广泛分发时不建议选。换编码器一定重新压缩，画质上限仍是原片，不会变清晰。',
    source: (i) => (i?.video?.codec ? String(i.video.codec).toUpperCase() : '自动'),
    options: () => nd([
      opt('', '沿用原片（H.264 / libx264）'),
      opt('libx264', 'H.264 / libx264（兼容性最好）'),
      opt('libx265', 'H.265 / libx265（兼容性差，不建议分发）'),
    ]) },
  { group: '视频 · 画面', key: 'resolution', label: '分辨率',
    tip: '像素数决定细节上限，也几乎线性影响体积。放大（如 720p→1080p）只是把已有像素插值，细节不会变多，反而更占空间；缩小分辨率若不一起降码率，体积也不会自动变小。想省体积：先缩小，再调低目标码率。',
    source: (i) => (i?.video?.width ? `${i.video.width}×${i.video.height}` : '自动'),
    options: (i) => {
      const v = i?.video || {}
      const list = [opt('', '沿用原片分辨率')]
      if (v.width && v.height) {
        list.push(opt(`${v.width}x${v.height}`, `原片 ${v.width}×${v.height}`))
        const w = Math.max(2, Math.round(v.width / 4) * 2)
        const h = Math.max(2, Math.round(v.height / 4) * 2)
        list.push(opt(`${w}x${h}`, `缩小一半 ${w}×${h}（固定宽高）`))
      }
      list.push(opt('h1080', '等比缩到 1080p（宽度自动，推荐高画质）'))
      list.push(opt('h720', '等比缩到 720p（宽度自动，省体积首选）'))
      list.push(opt('h480', '等比缩到 480p（宽度自动，最小体积）'))
      list.push(opt('w1280', '等比缩到宽 1280（高度自动）'))
      ;[[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [854, 480], [640, 360]]
        .forEach(([w, h]) => list.push(opt(`${w}x${h}`, `固定 ${w}×${h}`)))
      return nd(list)
    } },
  { group: '视频 · 画面', key: 'fps', label: '帧率',
    tip: '每秒多少帧。提高到源片之上只是复制/插值画面，运动细节不会变多，体积和编码时间却会上升；调低会让运动画面不流畅但能省体积。原片是 23.976 这类分数帧率时，沿用精确分数可避免长时间累积漂移。',
    source: (i) => (i?.video?.fps ? `${(i.video.fps_float || 0).toFixed(3)} fps（${i.video.fps}）` : '自动'),
    options: (i) => {
      const v = i?.video || {}
      const list = [opt('', '沿用原片帧率')]
      if (v.fps) list.push(opt(v.fps, `原片精确值 ${v.fps}`))
      ;[['23.976', '23.976'], ['24', '24'], ['25', '25（PAL）'], ['29.97', '29.97'],
        ['30', '30'], ['50', '50'], ['60', '60（高帧率）']].forEach(([v0, t]) => list.push(opt(v0, t)))
      return nd(list)
    } },
  { group: '视频 · 画面', key: 'pix_fmt', label: '像素格式 / 位深',
    tip: '8-bit 是通用格式；10-bit 色阶更细腻、渐变不容易出现色带，但体积略大，且很多手机/老电视/浏览器无法硬解 H.264 10-bit。把 8-bit 原片转成 10-bit 补不回已丢失的色彩层次，只是白占空间。',
    source: (i) => (i?.video?.pix_fmt ? `${i.video.pix_fmt}（${/10/.test(i.video.pix_fmt) ? '10-bit' : '8-bit'}）` : '自动'),
    options: (i) => {
      const v = i?.video || {}
      const list = [opt('', '沿用原片位深')]
      if (v.pix_fmt) list.push(opt(v.pix_fmt, `原片 ${v.pix_fmt}`))
      list.push(opt('yuv420p', '8-bit yuv420p（兼容性最好）'))
      list.push(opt('yuv420p10le', '10-bit yuv420p10le（色阶更细）'))
      return nd(list)
    } },

  { group: '视频 · 画质与体积', key: 'rate_control', label: '码率控制方式',
    tip: '决定编码器怎么分配码率。「沿用原片码率」让体积约等于保留时长占比，最不容易越剪越大；「固定目标码率」可以主动压小体积；「CRF 恒定质量」画质稳定，但码率随画面复杂度变化，体积无法预估，低码率片源可能被越剪越大。',
    source: () => '按原片码率等比',
    options: () => [
      opt('source', '沿用原片码率（默认 · 体积按保留比例）'),
      opt('bitrate', '固定目标码率（可主动压缩体积）'),
      opt('crf', 'CRF 恒定质量（体积不可预估）'),
    ] },
  { group: '视频 · 画质与体积', key: 'video_kbps', label: '目标视频码率', numeric: true,
    custom: { unit: 'kbps', step: 50, hint: '可填任意 kbps，例如 1350；0 = 沿用原片码率。' },
    tip: '仅「固定目标码率」生效。码率越低体积越小，但快速运动、纹理、暗场容易出现涂抹和色块。设得比原片还高不会更清晰——重编码的画质上限就是原片，只是把文件撑大。',
    source: (i) => (i?.video?.video_kbps ? `${i.video.video_kbps} kbps` : '自动'),
    options: (i) => {
      const src = i?.video?.video_kbps || 0
      const list = [opt('0', src ? `沿用原片（${src} kbps）` : '沿用原片')]
      if (src) [0.25, 0.35, 0.5, 0.7, 1].forEach((r) => {
        const n = Math.max(50, Math.round(src * r))
        list.push(opt(n, `${n} kbps（约原片 ${Math.round(r * 100)}%）`))
      })
      ;[150, 300, 500, 800, 1200, 2000, 3000, 5000, 8000, 12000]
        .forEach((n) => list.push(opt(n, `${n} kbps`)))
      return nd(list)
    } },
  { group: '视频 · 画质与体积', key: 'crf', label: 'CRF 质量值', numeric: true,
    custom: { max: 51, unit: '', hint: '可填 0~51 任意整数或小数，例如 24.5；越小画质越好、体积越大。' },
    tip: '仅「CRF 恒定质量」生效。数值越小画质越好、体积越大；18 接近视觉无损，23 是常用网络分发值，28 以上能明显看到压缩痕迹。注意 H.265 的 CRF 刻度与 H.264 不同。',
    source: () => '原片码率模式，不启用',
    options: () => ([[14, '14（近乎无损，体积很大）'], [16, '16'], [18, '18（默认，画质优先）'],
      [20, '20'], [22, '22'], [23, '23（网络分发常用）'], [25, '25（720p 预设）'],
      [26, '26（明显省体积）'], [28, '28'], [32, '32（画质明显下降）']] as [number, string][])
      .map(([v, t]) => opt(v, t)) },
  { group: '视频 · 画质与体积', key: 'maxrate_kbps', label: '峰值码率上限', numeric: true,
    custom: { unit: 'kbps', step: 50, hint: '可填任意 kbps，例如 1250；0 = 不限制。选最后「自定义数值…」即可自己输入。' },
    tip: '只在使用 CRF 时生效，给「恒定质量」加一个天花板：打斗、雪花、快速运动等复杂画面也不会把体积撑爆。设为 0 表示不限制，此时体积无法预估。列表没覆盖的数值，选最后「自定义数值…」自己填；缓冲大小默认按上限的 1.8 倍自动计算，也可在高级组单独改。',
    source: () => '不限制（体积不可预估）',
    options: () => [opt('0', '不限制（体积无法预估）'),
      opt('500', '500 kbps（压得很小，细节损失明显）'),
      opt('800', '800 kbps'),
      opt('1000', '1000 kbps（720p 预设，推荐）'),
      opt('1200', '1200 kbps'), opt('1500', '1500 kbps'),
      opt('1800', '1800 kbps'), opt('2000', '2000 kbps'),
      opt('2500', '2500 kbps'), opt('3000', '3000 kbps'),
      opt('5000', '5000 kbps'), opt('8000', '8000 kbps')] },
  { group: '视频 · 画质与体积', key: 'bufsize_kbps', label: '峰值缓冲大小', numeric: true,
    custom: { unit: 'kbps', step: 50, hint: '可填任意 kbps，例如 2200；填 0 = 自动。' },
    tip: '配合峰值码率上限使用，决定编码器能「预支」多少码率应对复杂画面。太小会让复杂画面画质突然变差，太大则峰值限制形同虚设。默认「自动 = 峰值 × 1.8」，改峰值上限时自动跟着变，一般不用管；想单独指定可自己填数值。',
    source: () => '自动 = 峰值上限 × 1.8',
    options: () => [opt('auto', '自动（= 峰值上限 × 1.8，推荐）'),
      opt('500', '500 kbps'), opt('900', '900 kbps'), opt('1200', '1200 kbps'),
      opt('1800', '1800 kbps（720p 预设值）'), opt('2000', '2000 kbps'),
      opt('3000', '3000 kbps'), opt('4000', '4000 kbps'), opt('6000', '6000 kbps')] },
  { group: '视频 · 画质与体积', key: 'profile', label: 'H.264 Profile',
    tip: '编码特性档位，主要影响兼容性。baseline 最老的设备也能播但压缩效率低；high 是主流；high10 对应 10-bit。位深和 profile 必须匹配，工具会自动纠正冲突值。改 H.265 时这些 H.264 档位会被忽略。',
    source: (i) => (i?.video?.profile ? String(i.video.profile) : '自动'),
    options: () => [opt('', '沿用原片 Profile'), opt('baseline', 'baseline（最兼容、效率最低）'),
      opt('main', 'main'), opt('high', 'high（主流 8-bit）'), opt('high10', 'high10（10-bit）')] },
  { group: '视频 · 画质与体积', key: 'level', label: 'H.264 Level',
    tip: '声明解码器需要处理的最大分辨率/帧率/码率组合，只影响兼容性标签，不会提升画质。调高会让老设备拒绝播放，调低而实际参数超标会导致编码失败。一般沿用原片即可。',
    source: (i) => (i?.video?.level ? String(i.video.level) : '自动'),
    options: () => [opt('', '沿用原片 Level'), ...['3.0', '3.1', '4.0', '4.1', '4.2', '5.0', '5.1']
      .map((x) => opt(x, x))] },
  { group: '视频 · 画质与体积', key: 'gop', label: '关键帧间隔 GOP', numeric: true,
    custom: { unit: '帧', step: 1, hint: '可填任意帧数，例如 45；0 = 沿用原片。' },
    tip: '每隔多少帧放一个可独立解码的关键帧。间隔大 → 压缩效率高、体积小，但拖动进度条/跳转会慢，剪辑容错差；间隔小 → 体积变大，但定位快、更抗出错。默认按原片关键帧密度推导。',
    source: () => '按原片关键帧密度推导',
    options: () => [opt('0', '沿用原片 / 自动推导'), ...[12, 24, 30, 48, 60, 120, 250, 300]
      .map((n) => opt(n, `${n} 帧${n <= 30 ? '（定位快、体积大）' : n >= 250 ? '（省体积、定位慢）' : ''}`))] },
  { group: '视频 · 画质与体积', key: 'bframes', label: 'B 帧数量', numeric: true,
    custom: { unit: '帧', step: 1, hint: '可填 0~16；-1 = 沿用原片。' },
    tip: '双向预测帧能提升压缩效率（同画质体积更小），但会增加编码耗时和解码延迟。设为 0 兼容性最好、体积略大；对实时直播或很老的设备建议 0。默认沿用原片。',
    source: (i) => (i?.video?.b_frames !== undefined ? `${i.video.b_frames} 帧` : '自动'),
    options: () => [opt('-1', '沿用原片'), opt('0', '0（最兼容、体积略大）'),
      opt('1', '1'), opt('2', '2'), opt('3', '3'), opt('4', '4')] },

  { group: '音频', key: 'audio_codec', label: '音频处理',
    tip: '「沿用原片」会按原采样率/声道/码率重新编码成 AAC；「直接拷贝」不重新编码，音质零损失，但多段来自不同源片且参数不一致时合并可能失败；「丢弃音轨」能省一点体积。重编码不会让音质变好。',
    source: (i) => (i?.audio?.codec ? String(i.audio.codec).toUpperCase() : '无音轨'),
    options: () => [opt('', '沿用原片（AAC 重编码 + 参数回填）'),
      opt('aac', '强制 AAC 重编码'), opt('copy', '直接拷贝音轨（音质不变）'),
      opt('none', '丢弃音轨（减小体积）')] },
  { group: '音频', key: 'audio_kbps', label: '音频码率', numeric: true,
    custom: { unit: 'kbps', step: 8, hint: '可填任意 kbps，例如 112；0 = 沿用原片。' },
    tip: '音频体积占比通常很小，降低它省不了多少空间，却容易让音乐/环境音发闷。语音 64~96 kbps 够用，音乐建议 128 kbps 以上。设得比原片高不会提升音质。',
    source: (i) => (i?.audio?.audio_kbps ? `${i.audio.audio_kbps} kbps` : '自动'),
    options: () => [opt('0', '沿用原片'), ...[32, 48, 64, 96, 128, 160, 192, 256, 320]
      .map((n) => opt(n, `${n} kbps`))] },
  { group: '音频', key: 'sample_rate', label: '采样率', numeric: true,
    custom: { unit: 'Hz', step: 100, hint: '可填任意 Hz，例如 48000；0 = 沿用原片。' },
    tip: '每秒采样次数。把 44100 Hz 提到 96000 Hz 补不回已丢失的高频，只会让文件略大；调低会损失高频细节。一般沿用原片，除非播放器对采样率有特殊要求。',
    source: (i) => (i?.audio?.sample_rate ? `${i.audio.sample_rate} Hz` : '自动'),
    options: () => [opt('0', '沿用原片'), ...[22050, 32000, 44100, 48000, 96000]
      .map((n) => opt(n, `${n} Hz`))] },
  { group: '音频', key: 'channels', label: '声道数', numeric: true,
    custom: { max: 8, unit: '声道', step: 1, hint: '可填 1~8；0 = 沿用原片。' },
    tip: '单声道/立体声/5.1。把单声道填成双声道不会变成真立体声，只会把同样内容复制一份、略微增大体积；把多声道压成立体声会丢失环绕信息。',
    source: (i) => (i?.audio?.channels ? `${i.audio.channels} 声道` : '自动'),
    options: () => [opt('0', '沿用原片'), opt('1', '1 单声道'), opt('2', '2 立体声'), opt('6', '6 声道 5.1')] },
  { group: '音频', key: 'audio_profile', label: 'AAC Profile',
    tip: 'AAC-LC 是通用格式；HE-AAC 在低码率下更好但部分老播放器不支持，且对高码率没有意义。沿用原片最安全。',
    source: (i) => (i?.audio?.profile ? String(i.audio.profile) : '自动'),
    options: () => [opt('', '沿用原片'), opt('aac_low', 'AAC-LC（通用）'), opt('aac_he', 'HE-AAC（低码率专用）')] },

  { group: '字幕与容器', key: 'subtitle_format', label: '外挂字幕格式',
    tip: 'SRT 是本地播放器兼容性最好的外挂字幕；WebVTT 适合网页播放器和 HTML5 字幕轨。两者时间轴来自同一份重映射结果，内容完全一致，封装进视频时内部仍用 SRT 转换。',
    source: () => 'SRT（读入时统一解析）',
    options: () => [opt('srt', 'SRT（本地播放器通用）'), opt('vtt', 'WebVTT（网页播放器）')] },
  { group: '字幕与容器', key: 'container', label: '输出容器',
    tip: 'MP4 兼容性最好；MKV 能容纳更多编码格式、多字幕轨，无损流拷贝遇到非 MP4 源片时会自动改用 MKV。容器本身不改变画质，只影响兼容性和能装哪些流。',
    source: () => 'MP4（或按源片自动）',
    options: () => [opt('', '沿用（默认 MP4 / 自动）'), opt('mp4', 'MP4'), opt('mkv', 'MKV')] },
  { group: '字幕与容器', key: 'faststart', label: 'MP4 faststart',
    tip: '把 MP4 的索引信息移到文件开头，网页/边下边播时能立刻开始播放，几乎不增加体积。MKV 输出时此选项自动忽略。',
    source: () => '开启',
    options: () => [opt('1', '开启（推荐，便于边下边播）'), opt('0', '关闭')] },
]

// Only these affect size/quality in a way a non-expert needs to touch. The
// rest stay available, but collapsed: "I don't understand half of these".
export const BASIC_KEYS = new Set([
  'video_codec', 'resolution', 'rate_control', 'video_kbps',
  'crf', 'maxrate_kbps', 'audio_kbps', 'subtitle_format', 'container',
])

export const CUSTOM_VALUE = '__custom__'

export function defaultEncode(): EncodeCfg {
  return {
    video_codec: '', width: 0, height: 0, scale_mode: '', fps: '', pix_fmt: '',
    profile: '', level: '', rate_control: 'source', crf: 18, video_kbps: 0,
    maxrate_kbps: 0, bufsize_kbps: 0, gop: 0, bframes: -1,
    audio_codec: '', audio_kbps: 0, sample_rate: 0, channels: 0, audio_profile: '',
    subtitle_format: 'srt', container: '', faststart: true,
  }
}

export function customConfig(spec: EncodeSpec) {
  if (!spec?.numeric) return null
  return Object.assign({ min: 0, max: 999999, step: 1, unit: '', hint: '' }, spec.custom || {})
}

/** Resolution dropdown value -> width/height/scale_mode. */
export function decodeResolution(raw: string) {
  if (!raw) return { width: 0, height: 0, scale_mode: '' }
  if (raw[0] === 'h') return { width: 0, height: Number(raw.slice(1)) || 0, scale_mode: 'height' }
  if (raw[0] === 'w') return { width: Number(raw.slice(1)) || 0, height: 0, scale_mode: 'width' }
  const parts = raw.split('x')
  return { width: Number(parts[0]) || 0, height: Number(parts[1]) || 0, scale_mode: '' }
}

export function encodeResolution(enc: EncodeCfg): string {
  if (enc.scale_mode === 'height' && enc.height) return `h${enc.height}`
  if (enc.scale_mode === 'width' && enc.width) return `w${enc.width}`
  return enc.width && enc.height ? `${enc.width}x${enc.height}` : ''
}

export type EncodeValues = Record<string, string>

/** Read the panel values into the flat EncodeCfg shape the backend expects.
 * `values` maps spec key -> select value; `customValues` maps key -> free text
 * when the select is on the custom option. */
export function collectEncode(values: EncodeValues, customValues: EncodeValues, matchSourceBitrate?: boolean): EncodeCfg {
  const enc = defaultEncode()
  for (const spec of ENCODE_SPECS) {
    let raw = values[spec.key]
    if (raw === undefined) continue
    if (raw === CUSTOM_VALUE) raw = customValues[spec.key] ?? ''
    if (spec.key === 'resolution') {
      Object.assign(enc, decodeResolution(raw))
    } else if (spec.key === 'faststart') {
      enc.faststart = raw !== '0'
    } else if (spec.key === 'bufsize_kbps' && raw === 'auto') {
      enc.bufsize_kbps = 0
    } else if (spec.numeric) {
      if (raw !== '') enc[spec.key] = Number(raw) || 0
    } else {
      enc[spec.key] = raw
    }
  }
  if (matchSourceBitrate !== undefined && !values.rate_control) {
    enc.rate_control = matchSourceBitrate ? 'source' : 'crf'
  }
  return enc
}

/** Split a saved EncodeCfg into select values + custom-box values. */
export function encodeToValues(encode: EncodeCfg, srcInfo: SrcInfo | null, matchSourceBitrate?: boolean): { values: EncodeValues; customValues: EncodeValues } {
  const enc: EncodeCfg = { ...defaultEncode(), ...(encode || {}) }
  const values: EncodeValues = {}
  const customValues: EncodeValues = {}
  for (const spec of ENCODE_SPECS) {
    let v: string
    if (spec.key === 'resolution') v = encodeResolution(enc)
    else if (spec.key === 'faststart') v = enc.faststart ? '1' : '0'
    else if (spec.key === 'rate_control') v = enc.rate_control || (matchSourceBitrate === false ? 'crf' : 'source')
    else if (spec.key === 'bufsize_kbps') v = enc.bufsize_kbps ? String(enc.bufsize_kbps) : 'auto'
    else v = spec.numeric ? String(enc[spec.key]) : String(enc[spec.key] ?? '')
    const offered = spec.options(srcInfo).map((o) => String(o.v))
    if (offered.includes(String(v))) {
      values[spec.key] = v
    } else if (customConfig(spec)) {
      values[spec.key] = CUSTOM_VALUE
      customValues[spec.key] = String(v ?? '')
    } else {
      values[spec.key] = v
    }
  }
  return { values, customValues }
}

export function countEncodeChanges(enc: EncodeCfg): number {
  const base = defaultEncode()
  return Object.keys(base).filter((k) => String(enc[k]) !== String(base[k])).length
}
