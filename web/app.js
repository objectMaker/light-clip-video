/* clip-video UI. No build step, no dependencies. */
const $ = (id) => document.getElementById(id);

const S = {
  project: null,
  state: null,
  activeSource: null,
  activeGroup: null,
  cueTrack: null,
  activeCue: null,
  cueStart: null,
  cueEnd: null,
  checked: new Set(),
  lastOutputMs: 0,
  drag: null,
  clipDrag: null,
  clipSort: null,
  selectedClip: null,
  syncTimer: null,
  browseCwd: '',
  browseParent: '',
  selected: [],
  config: null,
  srcInfo: null,
  profiles: [],
  profileMode: 'source',
  checkTimer: null,
  lastCheck: null,
  pendingExport: null,
  view: { startMs: 0, zoom: 1 },
  history: [],
  future: [],
  outDefault: null,
  outPathTimer: null,
  dirCwd: '',
  dirParent: '',
  followSeg: -1,
  lastJumpAt: 0,
  dragClip: null,
  lastRememberAt: 0,
  revealPath: '',
  cueLoopOn: false,
  wbWin: null,
  wbDragging: null,
  _wbPreview: null,
};

const video = $('video');

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--';
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms % 1000).padStart(3, '0')}`;
}
function shortFmt(ms) { return fmt(ms).slice(3, 12); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() { return 'c' + Math.random().toString(36).slice(2, 9); }
function setStatus(msg) { $('statusText').textContent = msg; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function timeBoundary(ms) { return { kind: 'time', ms: Math.round(ms), cue_ref: null, padding_ms: 0 }; }

/** HH:MM:SS.mmm | MM:SS.mmm | SS.mmm | plain milliseconds -> ms */
function parseTime(text) {
  const s = String(text).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':');
  if (parts.length > 3) return null;
  const nums = parts.map((p) => {
    const t = p.trim();
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  let ms;
  if (parts.length === 3) ms = (nums[0] * 3600 + nums[1] * 60 + nums[2]) * 1000;
  else if (parts.length === 2) ms = (nums[0] * 60 + nums[1]) * 1000;
  else ms = nums[0] * 1000;
  return Math.round(ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}
function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body) }); }
function q(params) { return new URLSearchParams(params).toString(); }

/* ---------- transcode parameters ----------
 * One declarative spec drives: the dropdowns, the source read-back labels, the
 * hover help, the cheat sheet and the JSON presets. Everything is a <select>
 * so the user never has to guess a legal ffmpeg value.
 */
function opt(v, t) { return { v: String(v), t: String(t) }; }
function uniqOpts(list) {
  const seen = new Set();
  return list.filter((o) => { if (seen.has(o.v)) return false; seen.add(o.v); return true; });
}
function nd(list) { return uniqOpts(list); }

const ENCODE_SPECS = [
  { group: '视频 · 画面', key: 'video_codec', label: '视频编码器',
    tip: '压缩算法。H.264 几乎所有设备都能播；H.265 同画质通常小 30~50%，但编码更慢、老设备/浏览器可能放不了。换编码器一定重新压缩，画质上限仍是原片，不会变清晰。',
    source: (i) => (i?.video?.codec ? String(i.video.codec).toUpperCase() : '自动'),
    options: () => nd([
      opt('', '沿用原片（H.264 / libx264）'),
      opt('libx264', 'H.264 / libx264（兼容性最好）'),
      opt('libx265', 'H.265 / libx265（省体积、编码慢）'),
    ]) },
  { group: '视频 · 画面', key: 'resolution', label: '分辨率',
    tip: '像素数决定细节上限，也几乎线性影响体积。放大（如 720p→1080p）只是把已有像素插值，细节不会变多，反而更占空间；缩小分辨率若不一起降码率，体积也不会自动变小。想省体积：先缩小，再调低目标码率。',
    source: (i) => (i?.video?.width ? `${i.video.width}×${i.video.height}` : '自动'),
    options: (i) => {
      const v = i?.video || {};
      const list = [opt('', '沿用原片分辨率')];
      if (v.width && v.height) {
        list.push(opt(`${v.width}x${v.height}`, `原片 ${v.width}×${v.height}`));
        const w = Math.max(2, Math.round(v.width / 4) * 2);
        const h = Math.max(2, Math.round(v.height / 4) * 2);
        list.push(opt(`${w}x${h}`, `缩小一半 ${w}×${h}（固定宽高）`));
      }
      // h720 = scale=-2:720: the width follows the source aspect ratio, so one
      // preset works for 16:9, 4:3, ultrawide and portrait alike.
      list.push(opt('h1080', '等比缩到 1080p（宽度自动，推荐高画质）'));
      list.push(opt('h720', '等比缩到 720p（宽度自动，省体积首选）'));
      list.push(opt('h480', '等比缩到 480p（宽度自动，最小体积）'));
      list.push(opt('w1280', '等比缩到宽 1280（高度自动）'));
      [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [854, 480], [640, 360]]
        .forEach(([w, h]) => list.push(opt(`${w}x${h}`, `固定 ${w}×${h}`)));
      return nd(list);
    } },
  { group: '视频 · 画面', key: 'fps', label: '帧率',
    tip: '每秒多少帧。提高到源片之上只是复制/插值画面，运动细节不会变多，体积和编码时间却会上升；调低会让运动画面不流畅但能省体积。原片是 23.976 这类分数帧率时，沿用精确分数可避免长时间累积漂移。',
    source: (i) => (i?.video?.fps ? `${(i.video.fps_float || 0).toFixed(3)} fps（${i.video.fps}）` : '自动'),
    options: (i) => {
      const v = i?.video || {};
      const list = [opt('', '沿用原片帧率')];
      if (v.fps) list.push(opt(v.fps, `原片精确值 ${v.fps}`));
      [['23.976', '23.976'], ['24', '24'], ['25', '25（PAL）'], ['29.97', '29.97'],
        ['30', '30'], ['50', '50'], ['60', '60（高帧率）']].forEach(([v0, t]) => list.push(opt(v0, t)));
      return nd(list);
    } },
  { group: '视频 · 画面', key: 'pix_fmt', label: '像素格式 / 位深',
    tip: '8-bit 是通用格式；10-bit 色阶更细腻、渐变不容易出现色带，但体积略大，且很多手机/老电视/浏览器无法硬解 H.264 10-bit。把 8-bit 原片转成 10-bit 补不回已丢失的色彩层次，只是白占空间。',
    source: (i) => (i?.video?.pix_fmt ? `${i.video.pix_fmt}（${/10/.test(i.video.pix_fmt) ? '10-bit' : '8-bit'}）` : '自动'),
    options: (i) => {
      const v = i?.video || {};
      const list = [opt('', '沿用原片位深')];
      if (v.pix_fmt) list.push(opt(v.pix_fmt, `原片 ${v.pix_fmt}`));
      list.push(opt('yuv420p', '8-bit yuv420p（兼容性最好）'));
      list.push(opt('yuv420p10le', '10-bit yuv420p10le（色阶更细）'));
      return nd(list);
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
      const src = i?.video?.video_kbps || 0;
      const list = [opt('0', src ? `沿用原片（${src} kbps）` : '沿用原片')];
      if (src) [0.25, 0.35, 0.5, 0.7, 1].forEach((r) => {
        const n = Math.max(50, Math.round(src * r));
        list.push(opt(n, `${n} kbps（约原片 ${Math.round(r * 100)}%）`));
      });
      [150, 300, 500, 800, 1200, 2000, 3000, 5000, 8000, 12000]
        .forEach((n) => list.push(opt(n, `${n} kbps`)));
      return nd(list);
    } },
  { group: '视频 · 画质与体积', key: 'crf', label: 'CRF 质量值', numeric: true,
    custom: { max: 51, unit: '', hint: '可填 0~51 任意整数或小数，例如 24.5；越小画质越好、体积越大。' },
    tip: '仅「CRF 恒定质量」生效。数值越小画质越好、体积越大；18 接近视觉无损，23 是常用网络分发值，28 以上能明显看到压缩痕迹。注意 H.265 的 CRF 刻度与 H.264 不同。',
    source: () => '原片码率模式，不启用',
    options: () => [[14, '14（近乎无损，体积很大）'], [16, '16'], [18, '18（默认，画质优先）'],
      [20, '20'], [22, '22'], [23, '23（网络分发常用）'], [25, '25（720p 预设）'],
      [26, '26（明显省体积）'], [28, '28'], [32, '32（画质明显下降）']]
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
];

function defaultEncode() {
  return {
    video_codec: '', width: 0, height: 0, scale_mode: '', fps: '', pix_fmt: '',
    profile: '', level: '', rate_control: 'source', crf: 18, video_kbps: 0,
    maxrate_kbps: 0, bufsize_kbps: 0, gop: 0, bframes: -1,
    audio_codec: '', audio_kbps: 0, sample_rate: 0, channels: 0, audio_profile: '',
    subtitle_format: 'srt', container: '', faststart: true,
  };
}

/* Numeric dropdowns always offer a free-text value as the LAST option. A
 * generated list can never cover every bitrate the user may want (1000 -> 1500
 * is far too coarse), so "自定义…" reveals a plain number input instead. */
const CUSTOM_VALUE = '__custom__';

function customConfig(spec) {
  if (!spec?.numeric) return null;
  return Object.assign({ min: 0, max: 999999, step: 1, unit: '', hint: '' }, spec.custom || {});
}

/** Resolve a spec's current DOM value, following the custom box when selected. */
function specRawValue(spec) {
  const el = $('enc_' + spec.key);
  if (!el) return null;
  const raw = String(el.value === undefined ? '' : el.value);
  if (raw !== CUSTOM_VALUE) return raw;
  const box = $('enc_custom_' + spec.key);
  return box ? String(box.value === undefined ? '' : box.value).trim() : '';
}

function syncCustomBox(sel, focusIt = true) {
  const key = sel?.dataset?.key;
  const spec = ENCODE_SPECS.find((s) => s.key === key);
  if (!spec || !customConfig(spec)) return;
  const on = sel.value === CUSTOM_VALUE;
  const box = $('enc_custom_' + key);
  const hint = $('enc_hint_' + key);
  if (box) {
    box.classList.toggle('hidden', !on);
    if (on && focusIt && typeof box.focus === 'function') box.focus();
  }
  if (hint) hint.classList.toggle('hidden', !on);
}

/** Resolution dropdown value -> width/height/scale_mode. */
function decodeResolution(raw) {
  if (!raw) return { width: 0, height: 0, scale_mode: '' };
  if (raw[0] === 'h') return { width: 0, height: Number(raw.slice(1)) || 0, scale_mode: 'height' };
  if (raw[0] === 'w') return { width: Number(raw.slice(1)) || 0, height: 0, scale_mode: 'width' };
  const parts = raw.split('x');
  // Plain WxH is the legacy fixed-size form; plan.py applies it whenever both
  // dimensions are set, so scale_mode stays empty here.
  return { width: Number(parts[0]) || 0, height: Number(parts[1]) || 0, scale_mode: '' };
}
function encodeResolution(enc) {
  if (enc.scale_mode === 'height' && enc.height) return `h${enc.height}`;
  if (enc.scale_mode === 'width' && enc.width) return `w${enc.width}`;
  return (enc.width && enc.height) ? `${enc.width}x${enc.height}` : '';
}

/** Read every dropdown into the flat EncodeCfg shape expected by the backend. */
function collectEncode() {
  const enc = defaultEncode();
  ENCODE_SPECS.forEach((spec) => {
    const raw = specRawValue(spec);
    if (raw === null) return;
    if (spec.key === 'resolution') {
      Object.assign(enc, decodeResolution(raw));
    } else if (spec.key === 'faststart') {
      enc.faststart = raw !== '0';
    } else if (spec.key === 'bufsize_kbps' && raw === 'auto') {
      // 0 = auto. core/plan.py derives maxrate * 1.8, so changing the ceiling
      // keeps the buffer in sync instead of freezing one stale number.
      enc.bufsize_kbps = 0;
    } else if (spec.numeric) {
      // An empty value (before the panel renders, or a custom box not filled
      // yet) must not turn a sensible default such as CRF 18 into 0.
      if (raw !== '') enc[spec.key] = Number(raw) || 0;
    } else {
      enc[spec.key] = raw;
    }
  });
  return enc;
}

/** Fill the dropdowns from a saved EncodeCfg (or from the source-faithful default). */
function applyEncodeToDom(encode) {
  const enc = Object.assign(defaultEncode(), encode || {});
  const match = S.project?.output?.match_source_bitrate;
  ENCODE_SPECS.forEach((spec) => {
    const el = $('enc_' + spec.key);
    if (!el) return;
    let v;
    if (spec.key === 'resolution') v = encodeResolution(enc);
    else if (spec.key === 'faststart') v = enc.faststart ? '1' : '0';
    else if (spec.key === 'rate_control') v = enc.rate_control || (match === false ? 'crf' : 'source');
    else if (spec.key === 'bufsize_kbps') v = enc.bufsize_kbps ? String(enc.bufsize_kbps) : 'auto';
    else v = spec.numeric ? String(enc[spec.key]) : String(enc[spec.key] ?? '');

    // Check the generated list explicitly rather than relying on a real
    // <select> rejecting unknown values: a preset carrying 1250 kbps belongs
    // in the custom box, not silently reset to "沿用原片".
    const offered = spec.options(S.srcInfo || null).map((o) => String(o.v));
    if (offered.includes(String(v))) {
      el.value = v;
    } else if (customConfig(spec)) {
      el.value = CUSTOM_VALUE;
      const box = $('enc_custom_' + spec.key);
      if (box) box.value = String(v ?? '');
    } else {
      el.value = v;
      if (el.value !== v && typeof document.createElement === 'function') {
        const extra = document.createElement('option');
        extra.value = v;
        extra.textContent = `自定义（${v || '沿用原片'}）`;
        el.appendChild(extra);
        el.value = v;
      }
    }
    syncCustomBox(el, false);
  });
}

// Only these affect size/quality in a way a non-expert needs to touch. The
// rest stay available, but collapsed: "I don't understand half of these".
const BASIC_KEYS = new Set(['video_codec', 'resolution', 'rate_control', 'video_kbps',
  'crf', 'maxrate_kbps', 'audio_kbps', 'subtitle_format', 'container']);

function buildEncodeGroups(info) {
  const field = (s) => {
    const custom = customConfig(s);
    const options = s.options(info || null)
      .map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('');
    // Always the LAST option, so preset values stay one keystroke away.
    const customOption = custom
      ? `<option value="${CUSTOM_VALUE}">自定义数值…（自己输入）</option>` : '';
    const source = s.source ? s.source(info || null) : '';
    const unit = custom?.unit ? `（${esc(custom.unit)}）` : '';
    const hint = custom ? (custom.hint || `可填任意数值${unit}，不受上面选项限制。`) : '';
    const customBox = custom ? `
      <input id="enc_custom_${esc(s.key)}" class="input custom-num hidden" type="number"
             min="${custom.min}" max="${custom.max}" step="${custom.step}"
             data-key="${esc(s.key)}" placeholder="输入任意数值${unit}">
      <span id="enc_hint_${esc(s.key)}" class="custom-hint hidden">${esc(hint)}</span>` : '';
    return `<label class="field param-field">
      <span class="param-label">${esc(s.label)}<span class="q" data-tip="${esc(s.tip)}" aria-label="${esc(s.label)}说明">?</span></span>
      <select id="enc_${esc(s.key)}" class="select" data-key="${esc(s.key)}">${options}${customOption}</select>
      ${customBox}
      ${source ? `<span class="orig">原片：${esc(source)}</span>` : ''}
    </label>`;
  };
  const group = (name, sub, specs, open) => `<details class="param-group"${open ? ' open' : ''}>
    <summary>${esc(name)}<span class="g-sub">${esc(sub)} · ${specs.length} 项</span></summary>
    ${specs.map(field).join('')}</details>`;
  const basic = ENCODE_SPECS.filter((s) => BASIC_KEYS.has(s.key));
  const advanced = ENCODE_SPECS.filter((s) => !BASIC_KEYS.has(s.key));
  return group('常用 · 决定体积和画质', '这几种最值得调', basic, true)
    + group('高级 · 兼容性与细节', '看不懂就别动，默认沿用原片', advanced, false);
}

function buildHelpTable() {
  return ENCODE_SPECS.map((s) =>
    `<div class="help-row"><b>${esc(s.label)}</b><span>${esc(s.tip)}</span></div>`).join('');
}

function countEncodeChanges(enc) {
  const base = defaultEncode();
  return Object.keys(base).filter((k) => String(enc[k]) !== String(base[k])).length;
}

function currentSource() {
  return (S.project?.sources || []).find((s) => s.id === S.activeSource) || null;
}
function currentTrack() {
  return (S.project?.tracks || []).find((t) => t.id === S.cueTrack)
    || (S.project?.tracks || []).find((t) => t.source_id === S.activeSource)
    || null;
}
function totalMs() { return S.state?.total_ms || 0; }

/* ---------- project ---------- */

/* ---------- clip history (undo / redo) ---------- */

const HISTORY_LIMIT = 50;

function updateHistoryUi() {
  const u = $('btnUndo'), r = $('btnRedo');
  if (u) u.disabled = !S.history.length;
  if (r) r.disabled = !S.future.length;
}
/** Call BEFORE any mutation of project.clips / tracks.cues / cue_edits.
 *  A single stack now governs clips, subtitle timing and the correction log. */
function snapshotProject() {
  if (!S.project) return;
  S.history.push(JSON.stringify({
    clips: S.project.clips || [],
    tracks: S.project.tracks || [],
    cue_edits: S.project.cue_edits || [],
  }));
  if (S.history.length > HISTORY_LIMIT) S.history.shift();
  S.future.length = 0;
  updateHistoryUi();
}
function restoreProject(json) {
  if (!S.project || json === undefined) return;
  const data = JSON.parse(json);
  S.project.clips = data.clips;
  S.project.tracks = data.tracks;
  S.project.cue_edits = data.cue_edits;
  S.selectedClip = null;
  updateHistoryUi();
  syncProject(true);
}
function undo() {
  if (!S.history.length) { setStatus('没有可撤销的操作'); return; }
  S.future.push(JSON.stringify({
    clips: S.project.clips || [], tracks: S.project.tracks || [], cue_edits: S.project.cue_edits || [],
  }));
  restoreProject(S.history.pop());
  setStatus('已撤销（可用 Ctrl+Shift+Z 重做）');
}
function redo() {
  if (!S.future.length) { setStatus('没有可重做的操作'); return; }
  S.history.push(JSON.stringify({
    clips: S.project.clips || [], tracks: S.project.tracks || [], cue_edits: S.project.cue_edits || [],
  }));
  restoreProject(S.future.pop());
  setStatus('已重做');
}

/* ---------- clip operations (pure, so they can be regression-tested) ---------- */

/** Split one clip into two at an absolute SOURCE time. `seg` is the resolved
 *  segment (in_ms/out_ms), so cue-anchored boundaries are handled correctly:
 *  the untouched edge keeps its original expression, only the cut becomes a
 *  plain time. Returns a NEW array, or null when the cut is not legal. */
function splitClipAt(clips, i, atMs, seg) {
  const c = clips[i];
  if (!c || !seg || !Number.isFinite(atMs)) return null;
  const at = Math.round(atMs);
  if (at <= seg.in_ms + 100 || at >= seg.out_ms - 100) return null;
  const out = JSON.parse(JSON.stringify(clips));
  const left = JSON.parse(JSON.stringify(c));
  const right = JSON.parse(JSON.stringify(c));
  const base = c.label || `片段 ${i + 1}`;
  left.end = timeBoundary(at);
  left.label = base + ' · 前';
  right.id = uid();
  right.start = timeBoundary(at);
  right.label = base + ' · 后';
  out.splice(i, 1, left, right);
  return out;
}

function copyClip(clips, i) {
  const c = clips[i];
  if (!c) return null;
  const out = JSON.parse(JSON.stringify(clips));
  const dup = JSON.parse(JSON.stringify(c));
  dup.id = uid();
  dup.label = (c.label || `片段 ${i + 1}`) + ' 副本';
  out.splice(i + 1, 0, dup);
  return out;
}

function renameClip(clips, i, label) {
  if (!clips[i]) return null;
  const out = JSON.parse(JSON.stringify(clips));
  out[i].label = String(label || '').trim().slice(0, 60);
  return out;
}

function moveClip(clips, from, to) {
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return null;
  const out = clips.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/* ---------- output timeline (pure) ---------- */

/** Lane cells for the concatenated result. Widths are proportional to each
 *  segment's duration, NOT to source time, so gaps simply disappear. */
function buildOutputLane(segments, total) {
  const segs = segments || [];
  const span = total || segs.reduce((a, s) => a + (s.duration_ms || 0), 0);
  if (!span || !segs.length) return [];
  let acc = 0;
  return segs.map((s, i) => {
    const cell = {
      i, left: acc / span * 100,
      width: (s.duration_ms || 0) / span * 100,
      offset_ms: s.offset_ms, label: String(i + 1),
    };
    acc += s.duration_ms || 0;
    return cell;
  });
}

/** OUTPUT time -> (segment index, source time). Clicking the output lane and
 *  "preview whole result" both go through this single mapping. */
function outputToSource(segments, outMs) {
  const segs = segments || [];
  if (!segs.length) return null;
  const total = segs.reduce((a, s) => a + (s.duration_ms || 0), 0);
  const t = clamp(Number(outMs) || 0, 0, Math.max(0, total - 1));
  let idx = 0;
  for (let i = 0; i < segs.length; i++) {
    if (t >= (segs[i].offset_ms || 0)) idx = i;
  }
  const seg = segs[idx];
  return {
    segIdx: idx, sourceId: seg.source_id,
    srcMs: (seg.in_ms || 0) + Math.max(0, t - (seg.offset_ms || 0)),
    outMs: t,
  };
}

/** null = stay where we are; {done:true} = end of the result; otherwise jump. */
function advanceOutput(segments, segIdx, srcMs) {
  const seg = (segments || [])[segIdx];
  if (!seg) return { done: true };
  if (srcMs < seg.out_ms - 40) return null;
  for (let n = segIdx + 1; n < segments.length; n++) {
    if ((segments[n].duration_ms || 0) > 0) {
      return { segIdx: n, srcMs: segments[n].in_ms };
    }
  }
  return { done: true };
}

function applyProject(project, state) {
  S.project = project;
  S.state = state;
  S.history.length = 0;
  S.future.length = 0;
  updateHistoryUi();
  if (!project.sources.some((s) => s.id === S.activeSource)) {
    S.activeSource = project.sources[0]?.id || null;
  }
  if (!project.tracks.some((t) => t.id === S.cueTrack)) {
    S.cueTrack = project.tracks[0]?.id || null;
  }
  S.checked.clear();
  S.cueStart = S.cueEnd = S.activeCue = null;
  S.selectedClip = null;
  S.clipDrag = null;
  S.followSeg = -1;
  S.lastOutputMs = 0;
  $('projectName').textContent = project.name || '未命名工程';
  $('videoPlaceholder').classList.add('hidden');
  const out = project.output || {};
  $('modeSel').value = out.mode || 'precise';
  $('presetSel').value = out.preset || 'medium';
  $('embedChk').checked = !!out.embed_subtitles;
  $('snapTol').value = out.snap_tolerance_ms ?? 500;
  applyEncodeToDom(out.encode || defaultEncode());
  S.profileMode = out.profile_mode || 'source';
  renderProfileSwitch();
  renderProfileCard();
  updateModeUi();

  renderSourceSel();
  renderTrackSel();
  renderGroupSel();
  resetView();
  setVideoSource(S.activeSource);
  renderTimeline();
  renderEverything();
  saveAutosave();
  rememberProject(true);
  loadSourceEncodeInfo();
  refreshExportPath();
}

function updateModeUi() {
  const lossless = $('modeSel').value === 'lossless';
  const custom = S.profileMode === 'custom';
  // Locked profiles hide the 20 dropdowns entirely: there is nothing to edit.
  $('encGroups').classList.toggle('hidden', !custom);
  $('paramsTitle').classList.toggle('hidden', !custom);
  $('presetBar').classList.toggle('hidden', !custom);
  $('profileCard').classList.toggle('hidden', custom);
  $('encGroups').classList.toggle('muted', lossless);
  const navParams = document.querySelector?.('#settingsNav .nav-opt[data-anchor="paramsTitle"]');
  if (navParams) navParams.classList.toggle('dim', !custom);
}

function renderEverything() {
  renderClips();
  renderCues();
  renderCueTrack();
  renderSegmentMarks();
  renderOutputLane();
  renderStatusMeta();
}

/* ---------- project persistence ---------- */

const PROJECT_STORE = 'clip-video.autosave.v1';

function projectPayload() {
  return {
    version: 1, app: 'clip-video', saved_at: new Date().toISOString(),
    project: S.project,
  };
}
function saveAutosave() {
  try {
    if (S.project?.sources?.length) {
      localStorage.setItem(PROJECT_STORE, JSON.stringify(projectPayload()));
      rememberProject();
    }
  } catch (e) { /* private mode / quota: autosave is best-effort only */ }
}
function readAutosave() {
  try { return JSON.parse(localStorage.getItem(PROJECT_STORE) || 'null'); }
  catch (e) { return null; }
}

/* A short history of FULL projects. Autosave holds only the current one; this
 * lets the user jump back to a different video without hunting for a .json.
 * Capped at 6 entries and written at most every few seconds (cues can be big). */
const RECENT_STORE = 'clip-video.recent.v1';
const RECENT_LIMIT = 6;

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_STORE) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}
function saveRecent(list) {
  try { localStorage.setItem(RECENT_STORE, JSON.stringify(list.slice(0, RECENT_LIMIT))); }
  catch (e) { /* quota / private mode: recents are best-effort */ }
}
function recentKey(project) {
  return (project?.sources || []).map((s) => s.path).join('|');
}
function rememberProject(force = false) {
  if (!S.project?.sources?.length) return;
  const now = Date.now();
  if (!force && now - S.lastRememberAt < 5000) return;
  S.lastRememberAt = now;
  const p = S.project;
  const item = {
    key: recentKey(p),
    name: p.name || '未命名工程',
    path: p.sources[0].path,
    clips: (p.clips || []).length,
    saved_at: new Date().toISOString(),
    project: JSON.parse(JSON.stringify(p)),
  };
  saveRecent([item, ...readRecent().filter((r) => r.key !== item.key)]);
}
/** Pure HTML builder so the recent list can be regression-tested. */
function buildRecentHtml(list) {
  const items = list || [];
  if (!items.length) {
    return '<div class="empty-state">还没有最近工程。<br>打开媒体或载入一次工程后，这里会自动记住（保存在本机浏览器里）。</div>';
  }
  return items.map((r, i) => {
    const when = String(r.saved_at || '').slice(0, 16).replace('T', ' ');
    return `<div class="recent-item"><span class="r-name"><b>${esc(r.name || '未命名工程')}</b>`
      + `<span title="${esc(r.path || '')}">${esc(r.path || '')}</span>`
      + `<span>${Number(r.clips) || 0} 段 · ${esc(when)}</span></span>`
      + `<button class="btn tiny" data-recent-load="${i}">载入</button>`
      + `<button class="btn tiny" data-recent-del="${i}">移除</button></div>`;
  }).join('');
}
function renderRecentList() {
  const box = $('recentList');
  box.innerHTML = buildRecentHtml(readRecent());
  box.querySelectorAll('[data-recent-load]').forEach((b) => {
    b.onclick = async () => {
      const item = readRecent()[+b.dataset.recentLoad];
      if (!item?.project) return;
      try {
        await loadProjectPayload({ project: item.project });
        $('recentDialog').classList.add('hidden');
        setStatus('已载入最近工程：' + (item.name || ''));
      } catch (err) { alert('工程载入失败: ' + err.message); }
    };
  });
  box.querySelectorAll('[data-recent-del]').forEach((b) => {
    b.onclick = () => {
      const list = readRecent();
      list.splice(+b.dataset.recentDel, 1);
      saveRecent(list);
      renderRecentList();
    };
  });
}

/* ---------- default export location ---------- */

/** Ask the backend (the only naming authority) where the next export lands.
 *  The same call also tells us when a batch would collide and be numbered. */
async function refreshExportPath() {
  if (!S.project?.sources?.length) return;
  const dir = $('outDir').value.trim();
  const name = $('outName').value.trim();
  const overwrite = !!$('overwriteChk').checked;
  try {
    const info = await api('/api/export/default?' + q({ dir, name, overwrite: overwrite ? 1 : 0 }));
    S.outDefault = info;
    $('outPath').value = info.path;
    const collision = info.renamed_from
      ? `<br><span class="warn">同名已存在，将自动改名为 <b>${esc(info.filename)}</b>，不会覆盖旧文件。</span>`
      : '';
    $('outPathInfo').innerHTML = `将导出到：<b>${esc(info.path)}</b><br>`
      + `默认位置：<span class="mono">${esc(info.default_dir)}</span>${collision}`;
  } catch (e) {
    $('outPathInfo').textContent = '无法计算默认路径：' + e.message;
  }
}
function scheduleExportPath() {
  clearTimeout(S.outPathTimer);
  S.outPathTimer = setTimeout(refreshExportPath, 180);
}

async function browseDirOnly(dir) {
  const res = await api('/api/browse?' + q({ dir, kind: 'dir' }));
  S.dirCwd = res.path;
  S.dirParent = res.parent || '';
  $('dirBrowsePath').value = res.path;
  const rows = [];
  if (res.parent) {
    rows.push(`<div class="browse-item" data-ddir="${esc(res.parent)}">`
      + '<span class="ico">↑</span><span class="name">.. 上级目录</span></div>');
  }
  res.entries.forEach((e) => rows.push(
    `<div class="browse-item" data-ddir="${esc(e.path)}">`
    + `<span class="ico">▸</span><span class="name">${esc(e.name)}</span></div>`));
  $('dirBrowseList').innerHTML = rows.join('') || '<div class="empty-state">此目录没有子文件夹</div>';
  $('dirBrowseList').querySelectorAll('[data-ddir]').forEach((el) => {
    el.onclick = () => browseDirOnly(el.dataset.ddir);
  });
}
function openDirDialog() {
  $('dirDialog').classList.remove('hidden');
  const start = S.dirCwd || $('outDir').value.trim()
    || S.outDefault?.default_dir || S.config?.cwd || '';
  browseDirOnly(start);
}

function saveProjectFile() {
  if (!S.project?.sources?.length) { alert('请先打开媒体'); return; }
  const blob = new Blob([JSON.stringify(projectPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = String(S.project.name || 'clip-video').replace(/[\\/:*?"<>|]/g, '_');
  a.href = url;
  a.download = base + '.clip-video.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('工程已导出为 JSON（片段、字幕轨与参数都在里面）');
}
async function loadProjectPayload(payload) {
  const proj = payload?.project;
  if (!proj?.sources?.length) throw new Error('文件里没有工程数据');
  const res = await post('/api/project/load', { project: proj });
  applyProject(res.project, res.state);
  setStatus('工程已载入');
}
async function loadProjectFile(file) {
  const text = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
  await loadProjectPayload(JSON.parse(text));
}

function syncProject(immediate = false) {
  clearTimeout(S.syncTimer);
  const run = async () => {
    try {
      const res = await post('/api/project', { project: S.project });
      S.state = res.state;
      renderEverything();
      saveAutosave();
      scheduleExportPath();
      setStatus('已同步');
    } catch (e) { setStatus('同步失败: ' + e.message); }
  };
  if (immediate) return run();
  S.syncTimer = setTimeout(run, 120);
}

function renderSourceSel() {
  const sel = $('sourceSel');
  sel.innerHTML = (S.project?.sources || []).map((s) =>
    `<option value="${esc(s.id)}">${esc(s.path.split(/[\\/]/).pop())}</option>`).join('');
  sel.value = S.activeSource || '';
}
function renderTrackSel() {
  const sel = $('cueTrackSel');
  sel.innerHTML = (S.project?.tracks || []).map((t) =>
    `<option value="${esc(t.id)}">${esc(t.label || t.group_id)} · ${t.cues.length} 条</option>`).join('');
  sel.value = S.cueTrack || '';
}
function renderGroupSel() {
  const groups = new Set(Object.keys(S.state?.groups || {}));
  (S.project?.tracks || []).forEach((t) => groups.add(t.group_id));
  const list = [...groups];
  if (!list.includes(S.activeGroup)) S.activeGroup = list[0] || null;
  $('groupSel').innerHTML = list.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
  $('groupSel').value = S.activeGroup || '';
}
function renderStatusMeta() {
  const clips = S.project?.clips?.length || 0;
  const estimated = S.state?.estimated_lossless_bytes;
  const sizeHint = estimated ? ` · 预计体积 ${(estimated / 1048576).toFixed(1)} MB` : '';
  $('statusMeta').textContent = `${clips} 段 · 输出 ${fmt(totalMs())} · ${(S.project?.tracks || []).length} 条字幕轨${sizeHint}`;
  updateViewUi();
}

/* ---------- player ---------- */

function updatePlayButton() {
  const b = $('btnPlay');
  if (b) b.textContent = video.paused ? '播放' : '暂停';
}
function togglePlay() {
  if (!S.project?.sources?.length) { setStatus('请先打开视频'); return; }
  if (video.paused) {
    const p = typeof video.play === 'function' ? video.play() : null;
    if (p?.catch) p.catch(() => setStatus('播放失败：视频尚未就绪'));
  } else if (typeof video.pause === 'function') {
    video.pause();
  }
}
function nudge(seconds) {
  if (!video.src) return;
  const dur = Number(video.duration) || 0;
  video.currentTime = clamp(video.currentTime + seconds, 0, Math.max(0, dur - 0.05));
}
function updateClipBadge(srcMs) {
  const badge = $('clipBadge');
  if (!badge) return;
  const segs = S.state?.segments || [];
  const i = segs.findIndex((s) => s.source_id === S.activeSource
    && srcMs >= s.in_ms && srcMs < s.out_ms);
  badge.textContent = !S.project?.sources?.length ? '—'
    : (i >= 0 ? `片段 ${i + 1} / ${segs.length}` : (segs.length ? '未保留区间' : '尚未添加片段'));
}
video.addEventListener('play', updatePlayButton);
video.addEventListener('pause', updatePlayButton);

function setVideoSource(sourceId, seekSeconds = null) {
  const src = (S.project?.sources || []).find((s) => s.id === sourceId);
  if (!src) return;
  const url = '/api/media?' + q({ path: src.path });
  if (video.dataset.path !== src.path) {
    const hadPreviousSource = Boolean(video.dataset.path);
    video.dataset.path = src.path;
    video.src = url;
    if (seekSeconds !== null) {
      video.addEventListener('loadedmetadata', () => { video.currentTime = seekSeconds; }, { once: true });
    }
    if (hadPreviousSource) renderTimeline();
  } else if (seekSeconds !== null) {
    video.currentTime = seekSeconds;
  }
  S.activeSource = sourceId;
  $('sourceSel').value = sourceId;
}

function findSegmentBySourceTime(srcMs) {
  return (S.state?.segments || []).find((s) => s.source_id === S.activeSource
    && srcMs >= s.in_ms - 60 && srcMs < s.out_ms - 20) || null;
}

/** Playback that follows the OUTPUT timeline: one index is tracked explicitly
 *  instead of guessing "the next segment" from a stale output timestamp. */
function playWhenReady() {
  const go = () => {
    const p = typeof video.play === 'function' ? video.play() : null;
    if (p?.catch) p.catch(() => setStatus('播放失败：视频尚未就绪'));
  };
  if (Number(video.readyState) >= 2) go();
  else video.addEventListener('loadedmetadata', go, { once: true });
}
function seekOutput(ms) {
  const hit = outputToSource(S.state?.segments || [], ms);
  if (!hit) return;
  S.followSeg = hit.segIdx;
  S.lastOutputMs = hit.outMs;
  setVideoSource(hit.sourceId, hit.srcMs / 1000);
  renderOutputLane();
  renderSubtitle(hit.outMs, hit.srcMs);
  updateClipBadge(hit.srcMs);
}
function startOutputPreview() {
  const segs = S.state?.segments || [];
  if (!segs.length) { setStatus('请先添加片段，再预览成片'); return; }
  $('followChk').checked = true;
  seekOutput(0);
  playWhenReady();
  setStatus('正在按输出顺序预览成片（跳过未保留部分）');
}
function renderOutputLane() {
  const segs = S.state?.segments || [];
  const cells = buildOutputLane(segs, totalMs());
  const box = $('outSegments');
  box.innerHTML = cells.map((c) =>
    `<div class="out-seg${c.i % 2 ? ' alt' : ''}${S.followSeg === c.i ? ' active' : ''}"`
    + ` style="left:${c.left.toFixed(3)}%;width:${c.width.toFixed(3)}%"`
    + ` title="片段 ${c.i + 1} · 输出 ${fmt(c.offset_ms)}">${c.width > 3 ? c.label : ''}</div>`).join('');
  $('outLaneInfo').textContent = segs.length
    ? `${segs.length} 段 · 共 ${fmt(totalMs())} · 单击定位` : '尚未添加片段';
  updateOutPlayhead(S.lastOutputMs);
}
function updateOutPlayhead(outMs) {
  const ph = $('outPlayhead');
  const total = totalMs();
  if (!total || outMs === null || outMs === undefined) { ph.classList.add('hidden'); return; }
  ph.classList.remove('hidden');
  ph.style.left = clamp(outMs / total * 100, 0, 100) + '%';
}
function bindOutputLane() {
  const lane = $('outputTrack');
  if (!lane) return;
  lane.onclick = (e) => {
    const rect = lane.getBoundingClientRect();
    const x = clamp((e.clientX || 0) - (rect.left || 0), 0, rect.width || 1);
    seekOutput(x / (rect.width || 1) * totalMs());
  };
  $('followChk').onchange = (e) => {
    if (e.target.checked && S.state?.segments?.length) seekOutput(S.lastOutputMs || 0);
  };
}

video.addEventListener('timeupdate', () => {
  if (!S.project) return;
  const srcMs = video.currentTime * 1000;
  wbTick(srcMs);
  const follow = $('followChk').checked;
  const segs = S.state?.segments || [];
  let outputMs = null;
  if (follow && segs.length) {
    // If the user scrubbed the source manually, re-detect which output
    // segment we are in instead of blindly trusting the tracked index.
    const detected = segs.findIndex((s) => s.source_id === S.activeSource
      && srcMs >= s.in_ms - 60 && srcMs < s.out_ms - 20);
    if (detected >= 0) S.followSeg = detected;
    else S.followSeg = -1;  // scrubbing into an unretained gap = free browsing
    const seg = S.followSeg >= 0 ? segs[S.followSeg] : null;
    if (seg) {
      outputMs = seg.offset_ms + Math.max(0, srcMs - seg.in_ms);
      S.lastOutputMs = outputMs;
      if (!video.paused && srcMs >= seg.out_ms - 40
          && Date.now() - S.lastJumpAt > 600) {
        const jump = advanceOutput(segs, S.followSeg, srcMs);
        if (jump) {
          S.lastJumpAt = Date.now();
          if (jump.done) {
            video.pause();
          } else {
            S.followSeg = jump.segIdx;
            S.lastOutputMs = segs[jump.segIdx].offset_ms || 0;
            setVideoSource(segs[jump.segIdx].source_id, jump.srcMs / 1000);
            playWhenReady();
            renderOutputLane();
          }
        }
      }
    }
  }
  renderSubtitle(outputMs, srcMs);
  $('timeLabel').textContent = `原片 ${fmt(srcMs)} / 输出 ${outputMs === null ? '--' : fmt(outputMs)} / 共 ${fmt(totalMs())}`;
  if (currentSource()) $('playhead').style.left = msToPct(srcMs) + '%';
  updateOutPlayhead(outputMs);
  updateClipBadge(srcMs);
});

function renderSubtitle(outputMs, srcMs) {
  const overlay = $('subtitleOverlay');
  const group = S.activeGroup;
  let cues = [], t = srcMs;
  if (outputMs !== null && S.state?.groups?.[group]) {
    cues = S.state.groups[group]; t = outputMs;
  } else {
    cues = currentTrack()?.cues || [];
  }
  const hit = cues.find((c) => c.start_ms <= t && t < c.end_ms);
  overlay.innerHTML = hit && hit.lines?.length ? `<span>${esc(hit.lines.join('\n'))}</span>` : '';
}

/* ---------- timeline ---------- */

// The timeline shows a WINDOW into the source, not always the whole file. At
// 1x a 20-minute video maps to ~800px, so 1 second is 0.6px and impossible to
// pick precisely. Zooming makes the same width cover a much shorter span.
const ZOOM_STEPS = [1, 2, 4, 8, 16, 32];

function sourceDuration() { return currentSource()?.duration_ms || 1; }
function viewSpanMs() { return sourceDuration() / S.view.zoom; }
function viewEndMs() { return S.view.startMs + viewSpanMs(); }
function clampViewStart() {
  S.view.startMs = clamp(S.view.startMs, 0, Math.max(0, sourceDuration() - viewSpanMs()));
}
function resetView() { S.view.startMs = 0; S.view.zoom = 1; }

function xToMs(x) {
  const w = $('videoTrack').clientWidth || 1;
  return Math.round(S.view.startMs + x / w * viewSpanMs());
}
function msToPct(ms) {
  // Deliberately NOT clamped: the track has overflow:hidden, so off-window
  // marks are simply clipped instead of piling up at 0% / 100%.
  return (ms - S.view.startMs) / viewSpanMs() * 100;
}

function applyViewTransform() {
  const d = sourceDuration();
  const shift = (S.view.startMs / d * 100).toFixed(4);
  ['thumbs', 'waveImg'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.style.width = (S.view.zoom * 100) + '%';
    el.style.transform = `translateX(-${shift}%)`;
  });
}

function updateViewUi() {
  const d = sourceDuration();
  const max = Math.max(0, d - viewSpanMs());
  const out = $('btnZoomOut'), fit = $('btnZoomFit'), inn = $('btnZoomIn');
  if (out) out.disabled = S.view.zoom <= ZOOM_STEPS[0];
  if (inn) inn.disabled = S.view.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
  if (fit) fit.disabled = S.view.zoom === 1 && S.view.startMs === 0;
  const label = $('zoomLabel');
  if (label) label.textContent = S.view.zoom + '×';
  const slider = $('viewScroll');
  if (slider) {
    slider.value = max > 0 ? String(Math.round(S.view.startMs / max * 1000)) : '0';
    slider.disabled = max <= 0;
  }
  const info = $('tlInfo');
  if (info) info.textContent = currentSource()
    ? `可视 ${fmt(Math.round(S.view.startMs))} → ${fmt(Math.round(Math.min(d, viewEndMs())))} / 全长 ${fmt(d)}`
    : '';
}

function zoomBy(delta, anchorMs = null) {
  const idx = ZOOM_STEPS.indexOf(S.view.zoom);
  const next = ZOOM_STEPS[clamp((idx < 0 ? 0 : idx) + delta, 0, ZOOM_STEPS.length - 1)];
  if (next === S.view.zoom) return;
  const oldSpan = viewSpanMs();
  const anchor = anchorMs === null ? S.view.startMs + oldSpan / 2 : anchorMs;
  const frac = clamp((anchor - S.view.startMs) / oldSpan, 0, 1);
  S.view.zoom = next;
  S.view.startMs = anchor - frac * viewSpanMs();
  clampViewStart();
  renderTimeline();
}
function zoomFit() {
  resetView();
  renderTimeline();
}
function panTo(value) {
  const max = Math.max(0, sourceDuration() - viewSpanMs());
  S.view.startMs = max * (Number(value) / 1000);
  clampViewStart();
  renderTimeline();
}
function panByMs(delta) {
  S.view.startMs += delta;
  clampViewStart();
  renderTimeline();
}
function seekToMs(ms) {
  const src = currentSource();
  if (!src) return;
  setVideoSource(src.id, clamp(ms, 0, Math.max(0, src.duration_ms - 50)) / 1000);
}

function renderTimeline() {
  const src = currentSource();
  if (!src) return;
  clampViewStart();
  const span = viewSpanMs();
  $('ruler').innerHTML = Array.from({ length: 9 }, (_, i) =>
    `<span style="left:${(i / 8 * 100).toFixed(2)}%">${esc(shortFmt(S.view.startMs + span * i / 8))}</span>`).join('');
  // Thumbnails and the waveform are sampled across the WHOLE source once, then
  // stretched/translated with the view. Re-generating 8 ffmpeg thumbnails on
  // every zoom step would be visibly slow.
  const thumbs = $('thumbs');
  if (thumbs.dataset.path !== src.path) {
    thumbs.dataset.path = src.path;
    thumbs.innerHTML = Array.from({ length: 8 }, (_, i) =>
      `<img src="/api/thumb?${q({ path: src.path, t: (src.duration_ms * (i + 0.5) / 8 / 1000).toFixed(2) })}" alt="">`).join('');
  }
  const wave = $('waveImg');
  if (wave.dataset.path !== src.path) {
    wave.dataset.path = src.path;
    wave.src = '/api/waveform?' + q({ path: src.path });
  }
  applyViewTransform();
  updateViewUi();
  renderCueTrack();
  renderSegmentMarks();
}

function renderCueTrack() {
  const box = $('cueTrack');
  const src = currentSource();
  const track = currentTrack();
  if (!src || !track || track.source_id !== src.id) { box.innerHTML = ''; return; }
  // Only render cues inside the visible window; keep their ORIGINAL index so
  // clicking still selects the right subtitle line in the side list.
  const visible = track.cues.map((c, i) => ({ c, i }))
    .filter(({ c }) => c.end_ms > S.view.startMs && c.start_ms < viewEndMs())
    .slice(0, 400);
  box.innerHTML = visible.map(({ c, i }) => {
    const left = msToPct(c.start_ms);
    const width = Math.max(0.4, (c.end_ms - c.start_ms) / viewSpanMs() * 100);
    return `<div class="cue-block" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" data-i="${i}" title="${esc(c.lines.join(' '))}">${esc((c.lines[0] || '').slice(0, 18))}</div>`;
  }).join('');
  box.querySelectorAll('.cue-block').forEach((el) => {
    el.onclick = () => {
      const c = track.cues[+el.dataset.i];
      selectCue(+el.dataset.i, true);
      setVideoSource(S.activeSource, c.start_ms / 1000);
    };
  });
}

function renderSegmentMarks() {
  const box = $('segmentMarks');
  const src = currentSource();
  if (!src || !S.state) { box.innerHTML = ''; return; }
  box.innerHTML = S.state.segments.map((s, i) => {
    if (s.source_id !== src.id) return '';
    if (s.out_ms <= S.view.startMs || s.in_ms >= viewEndMs()) return '';
    const left = msToPct(s.in_ms);
    const width = Math.max(0.3, s.duration_ms / viewSpanMs() * 100);
    const selected = S.selectedClip === i ? ' selected' : '';
    return `<div class="tl-clip${selected}" data-i="${i}" style="left:${left}%;width:${width}%"
      title="片段 ${i + 1}  ${fmt(s.in_ms)} → ${fmt(s.out_ms)}（拖两端改单边，拖中间平移）">
      <span class="handle left" data-edge="start" title="只改起点，终点不动"></span>
      <span class="body">${i + 1}</span>
      <span class="handle right" data-edge="end" title="只改终点，起点不动"></span>
    </div>`;
  }).join('');
}

function updateDragTip(x) {
  const d = S.clipDrag;
  if (!d) return;
  const tip = $('dragTip');
  tip.classList.remove('hidden');
  tip.textContent = `#${d.i + 1}  ${fmt(d.start)} → ${fmt(d.end)}  ·  时长 ${fmt(d.end - d.start)}`;
  tip.style.left = clamp(x, 90, $('videoTrack').clientWidth - 90) + 'px';
}

/** Pure drag math. 'start'/'end' keep the OTHER edge exactly where it was. */
function computeClipDrag(d, ms, originMs) {
  const delta = ms - originMs;
  if (d.mode === 'start') return { start: clamp(ms, 0, d.end0 - 100), end: d.end0 };
  if (d.mode === 'end') return { start: d.start0, end: clamp(ms, d.start0 + 100, d.duration) };
  const ns = clamp(d.start0 + delta, 0, d.duration - d.len);
  return { start: ns, end: ns + d.len };
}

function drawSelection(x0, x1) {
  const el = $('selection');
  const left = Math.min(x0, x1), right = Math.max(x0, x1);
  el.classList.remove('hidden');
  el.style.left = (left / $('videoTrack').clientWidth * 100) + '%';
  el.style.width = ((right - left) / $('videoTrack').clientWidth * 100) + '%';
}

function bindTimelineDrag() {
  const track = $('videoTrack');
  const marks = $('segmentMarks');

  // Wheel pans; Ctrl+wheel zooms around the cursor. Bound to the whole pane so
  // it also works over the ruler, waveform and subtitle lanes.
  const wheel = (e) => {
    if (!S.project) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      zoomBy(e.deltaY < 0 ? 1 : -1, xToMs(clamp(e.clientX - rect.left, 0, rect.width)));
    } else {
      panByMs(viewSpanMs() * (e.deltaY > 0 ? 0.12 : -0.12));
    }
  };
  const pane = $('timelinePane');
  if (pane) pane.addEventListener('wheel', wheel, { passive: false });

  // Clicking any lane seeks. Cue blocks keep their own click handler.
  ['ruler', 'waveTrack', 'cueTrack'].forEach((id) => {
    const lane = $(id);
    if (!lane) return;
    lane.addEventListener('click', (e) => {
      if (e.target?.closest?.('.cue-block')) return;
      const r = lane.getBoundingClientRect();
      seekToMs(xToMs(clamp(e.clientX - r.left, 0, r.width)));
    });
  });

  // An existing clip: drag a handle to resize ONE edge, or the body to move it.
  marks.addEventListener('mousedown', (e) => {
    if (!S.project || e.button !== 0) return;
    const el = e.target.closest('.tl-clip');
    if (!el) return;
    e.stopPropagation();
    e.preventDefault();
    const i = +el.dataset.i;
    const seg = S.state?.segments?.[i];
    if (!seg) return;
    const rect = track.getBoundingClientRect();
    // Alt + drag a timeline clip = change its position in the merge order
    // (plain drag still edits its boundaries / time position).
    if (e.altKey) {
      S.clipSort = { i, el, target: null };
      S.selectedClip = i;
      el.classList.add('dragging', 'selected');
      const tip = $('dragTip');
      tip.classList.remove('hidden');
      tip.textContent = `#${i + 1} 拖到另一个片段上 = 改变合并顺序`;
      tip.style.left = clamp(e.clientX - rect.left, 90, $('videoTrack').clientWidth - 90) + 'px';
      renderClips();
      return;
    }
    const handle = e.target.closest('.handle');
    S.clipDrag = {
      i, el,
      mode: handle ? handle.dataset.edge : 'move',
      originX: clamp(e.clientX - rect.left, 0, rect.width),
      start0: seg.in_ms, end0: seg.out_ms,
      start: seg.in_ms, end: seg.out_ms,
      len: seg.out_ms - seg.in_ms,
      duration: currentSource()?.duration_ms || 1,
      moved: false,
    };
    S.selectedClip = i;
    el.classList.add('dragging', 'selected');
    updateDragTip(S.clipDrag.originX);
    renderClips();
  });

  // Blank track: rubber-band a NEW clip (unchanged behaviour).
  track.addEventListener('mousedown', (e) => {
    if (!S.project || e.button !== 0 || S.clipDrag || S.clipSort) return;
    const rect = track.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    S.drag = { x0: x, x1: x };
    drawSelection(x, x);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    const rect = track.getBoundingClientRect();
    if (S.clipSort) {
      const under = document.elementFromPoint?.(e.clientX, e.clientY)?.closest?.('.tl-clip');
      const target = under && under !== S.clipSort.el ? +under.dataset.i : null;
      S.clipSort.target = target;
      marks.querySelectorAll('.tl-clip').forEach((el) => {
        el.classList.toggle('sort-target', +el.dataset.i === target);
      });
      const tip = $('dragTip');
      tip.textContent = target === null
        ? `#${S.clipSort.i + 1} 拖到另一个片段上 = 改变合并顺序`
        : `#${S.clipSort.i + 1} → 第 ${target + 1} 位`;
      tip.style.left = clamp(e.clientX - rect.left, 90, $('videoTrack').clientWidth - 90) + 'px';
      return;
    }
    if (S.clipDrag) {
      const d = S.clipDrag;
      const x = clamp(e.clientX - rect.left, 0, rect.width);
      const next = computeClipDrag(d, xToMs(x), xToMs(d.originX));
      d.start = next.start;
      d.end = next.end;
      d.moved = true;
      d.el.style.left = msToPct(d.start) + '%';
      d.el.style.width = Math.max(0.3, (d.end - d.start) / d.duration * 100) + '%';
      updateDragTip(x);
      return;
    }
    if (S.drag) {
      S.drag.x1 = clamp(e.clientX - rect.left, 0, rect.width);
      drawSelection(S.drag.x0, S.drag.x1);
    }
  });

  window.addEventListener('mouseup', async () => {
    if (S.clipSort) {
      const { i, el, target } = S.clipSort;
      S.clipSort = null;
      $('dragTip').classList.add('hidden');
      el.classList.remove('dragging');
      marks.querySelectorAll('.tl-clip').forEach((n) => n.classList.remove('sort-target'));
      if (target !== null && target !== undefined) {
        const next = moveClip(S.project.clips || [], i, target);
        if (next) {
          snapshotProject();
          S.project.clips = next;
          S.selectedClip = target;
          await syncProject(true);
          setStatus(`时间轴排序：片段 ${i + 1} → 第 ${target + 1} 位（Ctrl+Z 可撤销）`);
          return;
        }
      }
      renderSegmentMarks();
      return;
    }
    if (S.clipDrag) {
      const d = S.clipDrag;
      S.clipDrag = null;
      $('dragTip').classList.add('hidden');
      d.el.classList.remove('dragging');
      if (!d.moved) {
        const seg = S.state?.segments?.[d.i];
        if (seg) setVideoSource(seg.source_id, seg.in_ms / 1000);
        renderSegmentMarks();
        return;
      }
      await commitClipDrag(d);
      return;
    }
    if (!S.drag) return;
    const { x0, x1 } = S.drag;
    S.drag = null;
    $('selection').classList.add('hidden');
    const a = Math.min(x0, x1), b = Math.max(x0, x1);
    // A click (or a drag too short to be a clip) should still move the playhead.
    // Previously it silently did nothing, which felt broken.
    if (b - a < 3) { seekToMs(xToMs(a)); return; }
    const msStart = xToMs(a), msEnd = xToMs(b);
    if (msEnd - msStart < 100) { seekToMs(msStart); return; }
    await addTimeClip(msStart, msEnd);
  });
}

async function commitClipDrag(d) {
  const clip = S.project.clips[d.i];
  if (!clip) return;
  snapshotProject();
  // Only the dragged edge changes. The other edge keeps its resolved value.
  if (d.mode === 'start' || d.mode === 'move') clip.start = timeBoundary(d.start);
  if (d.mode === 'end' || d.mode === 'move') clip.end = timeBoundary(d.end);
  clip.label = `${shortFmt(d.start)}-${shortFmt(d.end)}`;
  if ($('snapChk').checked && d.mode !== 'move') {
    const ms = d.mode === 'start' ? d.start : d.end;
    try {
      const res = await post('/api/snap', {
        source_id: S.activeSource, ms, tolerance_ms: +$('snapTol').value || 500,
      });
      if (res.boundary) {
        if (d.mode === 'start') clip.start = res.boundary;
        else clip.end = res.boundary;
      }
    } catch (err) { setStatus('吸附失败: ' + err.message); }
  }
  await syncProject(true);
  setStatus(`片段 ${d.i + 1} 已调整：${fmt(d.start)} → ${fmt(d.end)}（另一端保持不变）`);
}

async function addTimeClip(msStart, msEnd) {
  let start = { kind: 'time', ms: msStart, cue_ref: null, padding_ms: 0 };
  let end = { kind: 'time', ms: msEnd, cue_ref: null, padding_ms: 0 };
  if ($('snapChk').checked) {
    const tolerance_ms = +$('snapTol').value || 500;
    try {
      const [a, b] = await Promise.all([
        post('/api/snap', { source_id: S.activeSource, ms: msStart, tolerance_ms }),
        post('/api/snap', { source_id: S.activeSource, ms: msEnd, tolerance_ms }),
      ]);
      if (a.boundary) start = a.boundary;
      if (b.boundary) end = b.boundary;
    } catch (e) { setStatus('吸附失败: ' + e.message); }
  }
  snapshotProject();
  S.project.clips.push({
    id: uid(), source_id: S.activeSource, start, end,
    track_ids: [],
    label: `${shortFmt(msStart)}-${shortFmt(msEnd)}`,
  });
  S.selectedClip = S.project.clips.length - 1;
  await syncProject(true);
  const kind = start.kind === 'cue' || end.kind === 'cue' ? '（已吸附到字幕）' : '';
  setStatus(`已添加片段 ${fmt(msStart)} → ${fmt(msEnd)}${kind}`);
}

/* ---------- whole-file mode: compress without cutting ---------- */

// Pure: one 0 -> full-length clip per source, in source order. An untouched
// timeline means the original .srt stays valid after a simple rename.
function makeWholeClips(sources) {
  return (sources || [])
    .filter((s) => (s.duration_ms || 0) > 0)
    .map((s, i) => ({
      id: uid(),
      source_id: s.id,
      start: timeBoundary(0),
      end: timeBoundary(s.duration_ms),
      track_ids: [],
      label: `整片 ${i + 1}`,
    }));
}

function isWholeFileProject(project) {
  const clips = project?.clips || [];
  if (!clips.length) return false;
  const sources = project?.sources || [];
  return clips.every((c) => {
    const src = sources.find((s) => s.id === c.source_id);
    return c.start?.kind === 'time' && c.start.ms === 0
      && c.end?.kind === 'time' && !!src && c.end.ms >= src.duration_ms;
  });
}

// Only shown after a successful whole-file export with no subtitle tracks.
function wholeFileReuseNote(project, result) {
  if ((project?.tracks || []).length || !isWholeFileProject(project)) return '';
  if (Object.keys(result?.subtitles || {}).length) return '';
  const file = String(result?.video || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const name = file ? `${esc(file)}.srt` : '与视频同名的 .srt';
  return '<div class="reuse-note">这次是「整片压缩」，时间轴没有变化：把原来的字幕文件改名成 '
    + `<b>${name}</b> 放在视频旁边就能直接继续使用，不需要重新生成字幕。</div>`;
}

async function applyWholeClips() {
  if (!S.project?.sources?.length) { alert('请先打开视频'); return; }
  const clips = makeWholeClips(S.project.sources);
  if (!clips.length) { alert('没有探测到可用的视频时长'); return; }
  if (S.project.clips.length) {
    const ask = (typeof window !== 'undefined' && window.confirm) ? window.confirm.bind(window) : null;
    if (ask && !ask(`已有 ${S.project.clips.length} 个片段，替换为整片（不剪辑）吗？`)) return;
  }
  snapshotProject();
  S.project.clips = clips;
  S.selectedClip = null;
  S.checked.clear();
  await syncProject(true);
  setStatus(`已按 ${clips.length} 个源片铺满全长（0 → 片尾），时间轴不变`
    + ((S.project.tracks || []).length ? '' : '；原字幕可直接改名复用'));
}

/* ---------- clips ---------- */

function renderClips() {
  const list = $('clipList');
  const segs = S.state?.segments || [];
  const clips = S.project?.clips || [];
  if (!clips.length) {
    list.innerHTML = `<div class="empty-state">还没有片段。<br>在时间轴上空白处拖拽框选，或到「字幕」页按字幕行选点。</div>`;
    return;
  }
  list.innerHTML = clips.map((c, i) => {
    const s = segs[i] || {};
    const tag = (k) => k === 'cue' ? `<span class="tag">字幕锚点</span>` : `<span class="tag">时间</span>`;
    const shift = s.keyframe_shift_ms || 0;
    const shiftTag = shift > 0
      ? `<span class="tag" style="border-color:var(--amber-line);color:var(--amber-text)">关键帧提前 ${(shift / 1000).toFixed(2)}s</span>`
      : '';
    const selected = S.selectedClip === i ? ' selected' : '';
    const label = c.label ? `<span class="clip-label" title="${esc(c.label)}">${esc(c.label)}</span>` : '';
    return `<div class="clip-card${selected}" data-i="${i}" draggable="true" title="拖动卡片可调整合并顺序">
      <div class="row1">
        <span class="idx">${i + 1}</span>
        <span class="range">${fmt(s.in_ms)} → ${fmt(s.out_ms)}</span>
        ${label}
        <span class="ops">
          <button draggable="false" data-op="up" title="上移">↑</button><button draggable="false" data-op="down" title="下移">↓</button>
          <button draggable="false" data-op="split" title="在播放头处拆分（播放头不在片段内则取中点）">✂</button>
          <button draggable="false" data-op="copy" title="复制这个片段">⧉</button>
          <button draggable="false" data-op="rename" title="重命名">✎</button>
          <button draggable="false" data-op="del" title="删除">✕</button>
        </span>
      </div>
      <div class="row2">
        <span>输出 ${fmt(s.offset_ms)} · 时长 ${fmt(s.duration_ms)}</span>
        ${tag(c.start.kind)}${tag(c.end.kind)}${shiftTag}
      </div>
      <div class="clip-edit">
        <span>起点</span><input draggable="false" class="time-input" data-edit="start" value="${fmt(s.in_ms)}" title="HH:MM:SS.mmm / MM:SS.mmm / 秒数，回车生效">
        <span>→</span><input draggable="false" class="time-input" data-edit="end" value="${fmt(s.out_ms)}" title="HH:MM:SS.mmm / MM:SS.mmm / 秒数，回车生效">
        <span>回车生效</span>
      </div></div>`;
  }).join('');
  list.querySelectorAll('.clip-card').forEach((card) => {
    const i = +card.dataset.i;
    card.onclick = (e) => {
      if (e.target.dataset.op || e.target.tagName === 'INPUT') return;
      S.selectedClip = i;
      const s = segs[i];
      if (s) setVideoSource(s.source_id, s.in_ms / 1000);
      renderClips();
      renderSegmentMarks();
    };
    card.querySelectorAll('button').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const op = btn.dataset.op;
        const clips = S.project.clips || [];
        const seg = segs[i] || null;
        let next = null;
        let note = '';
        let selectAt = i;
        const ask = (typeof window !== 'undefined' && window.prompt) ? window.prompt.bind(window) : null;
        if (op === 'del') {
          next = clips.filter((_, n) => n !== i);
          selectAt = null;
          note = `已删除片段 ${i + 1}`;
        } else if (op === 'up' && i > 0) {
          next = moveClip(clips, i, i - 1);
          selectAt = i - 1;
          note = `片段已上移到第 ${i} 位`;
        } else if (op === 'down' && i < clips.length - 1) {
          next = moveClip(clips, i, i + 1);
          selectAt = i + 2;
          note = `片段已下移到第 ${i + 2} 位`;
        } else if (op === 'copy') {
          next = copyClip(clips, i);
          selectAt = i + 1;
          note = `已复制片段 ${i + 1}（Ctrl+Z 可撤销）`;
        } else if (op === 'rename') {
          const name = ask ? ask('给这个片段起个名字（只影响列表显示）：', clips[i]?.label || `片段 ${i + 1}`) : null;
          if (name === null || !String(name).trim()) return;
          next = renameClip(clips, i, name.trim());
          note = '已重命名';
        } else if (op === 'split') {
          const playMs = Number(video.currentTime || 0) * 1000;
          const usable = seg && S.activeSource === seg.source_id
            && playMs > seg.in_ms + 100 && playMs < seg.out_ms - 100;
          const at = usable ? playMs : (seg ? (seg.in_ms + seg.out_ms) / 2 : null);
          next = splitClipAt(clips, i, at, seg);
          if (!next) { setStatus('片段太短或拆分点太靠边，请先把播放头移到片段中间'); return; }
          note = `已在 ${fmt(Math.round(at))} 拆成两段（${usable ? '按播放头' : '按中点'}）`;
        }
        if (!next) return;
        snapshotProject();
        S.project.clips = next;
        S.selectedClip = selectAt;
        syncProject(true);
        setStatus(note);
      };
    });
    card.querySelectorAll('input[data-edit]').forEach((input) => {
      input.onclick = (e) => e.stopPropagation();
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitTimeInput(i, input); input.blur(); }
        if (e.key === 'Escape') { input.dataset.done = '1'; input.blur(); renderClips(); }
      };
      input.onblur = () => commitTimeInput(i, input);
    });
  });

  // Drag a card onto another card to change the merge order. The drop target
  // index is the FINAL position, so dragging 1 onto 3 puts it at index 3.
  list.ondragstart = (e) => {
    // Form controls must keep normal text selection / clicking behaviour.
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'BUTTON') {
      if (e.preventDefault) e.preventDefault();
      return;
    }
    const card = e.target?.closest?.('.clip-card');
    if (!card) return;
    S.dragClip = +card.dataset.i;
    card.classList.add('being-dragged');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(S.dragClip));
    }
  };
  list.ondragover = (e) => {
    const card = e.target?.closest?.('.clip-card');
    if (!card || S.dragClip === null) return;
    if (e.preventDefault) e.preventDefault();
    list.querySelectorAll('.clip-card').forEach((c) => c.classList.remove('drag-over'));
    card.classList.add('drag-over');
  };
  list.ondrop = (e) => {
    if (e.preventDefault) e.preventDefault();
    const card = e.target?.closest?.('.clip-card');
    const from = S.dragClip;
    S.dragClip = null;
    const clips = S.project?.clips || [];
    const to = card ? +card.dataset.i : clips.length - 1;
    const next = from === null ? null : moveClip(clips, from, to);
    if (!next) { renderClips(); return; }
    snapshotProject();
    S.project.clips = next;
    S.selectedClip = to;
    syncProject(true);
    setStatus(`片段 ${from + 1} 已移到第 ${to + 1} 位（Ctrl+Z 可撤销）`);
  };
  list.ondragend = () => {
    S.dragClip = null;
    list.querySelectorAll('.clip-card').forEach((c) => {
      c.classList.remove('drag-over');
      c.classList.remove('being-dragged');
    });
  };
}

function commitTimeInput(i, input) {
  if (input.dataset.done === '1') return;
  const ms = parseTime(input.value);
  if (ms === null) {
    const seg0 = S.state?.segments?.[i];
    setStatus('时间格式应为 HH:MM:SS.mmm');
    if (seg0) input.value = fmt(input.dataset.edit === 'start' ? seg0.in_ms : seg0.out_ms);
    return;
  }
  const clip = S.project.clips[i];
  const seg = S.state?.segments?.[i];
  if (!clip || !seg) return;
  const edge = input.dataset.edit;
  // The clip may belong to a different source than the one currently shown;
  // clamp against ITS length, not the active source's.
  const owner = (S.project?.sources || []).find((s) => s.id === clip.source_id);
  const dur = owner?.duration_ms || 0;
  const value = edge === 'start'
    ? clamp(ms, 0, seg.out_ms - 100)
    : clamp(ms, seg.in_ms + 100, dur || ms);
  // Unchanged: do NOT re-render, or a pending click on the ops buttons is lost.
  if (value === (edge === 'start' ? seg.in_ms : seg.out_ms)) return;
  input.dataset.done = '1';
  snapshotProject();
  clip[edge] = timeBoundary(value);
  clip.label = `${shortFmt(edge === 'start' ? value : seg.in_ms)}-${shortFmt(edge === 'end' ? value : seg.out_ms)}`;
  S.selectedClip = i;
  syncProject(true);
  setStatus(`片段 ${i + 1} 的${edge === 'start' ? '起点' : '终点'}改为 ${fmt(value)}（另一端不变）`);
}

/* ---------- subtitle list (cue mode) ---------- */

function selectCue(index, seek) {
  S.activeCue = index;
  renderCues();
  if (seek) {
    const c = currentTrack()?.cues[index];
    if (c) setVideoSource(currentTrack().source_id, c.start_ms / 1000);
  }
  if (!$('cueProofArea').classList.contains('hidden')) renderCueWorkbench();
}

function visibleCueIndices() {
  const track = currentTrack();
  if (!track) return [];
  const needle = $('cueSearch').value.trim().toLowerCase();
  return track.cues.map((c, i) => ({ c, i }))
    .filter(({ c }) => !needle || c.lines.join(' ').toLowerCase().includes(needle))
    .map(({ i }) => i);
}

function renderCues() {
  const list = $('cueList');
  const track = currentTrack();
  if (!track) {
    list.innerHTML = '<div class="empty-state">尚未载入字幕</div>';
    $('cueCount').textContent = '';
    return;
  }
  const needle = $('cueSearch').value.trim().toLowerCase();
  const indices = visibleCueIndices();
  list.innerHTML = indices.map((i) => {
    const c = track.cues[i];
    const cls = ['cue-row'];
    if (S.activeCue === i) cls.push('active');
    if (S.cueStart === i) cls.push('start-mark');
    if (S.cueEnd === i) cls.push('end-mark');
    const mark = S.cueStart === i ? '起 ' : (S.cueEnd === i ? '终 ' : '');
    return `<div class="${cls.join(' ')}" data-i="${i}">
      <input type="checkbox" data-check="${i}" ${S.checked.has(i) ? 'checked' : ''}>
      <span class="n">${i + 1}</span>
      <span class="t">${mark}${shortFmt(c.start_ms)}</span>
      <span class="txt">${esc(c.lines.join(' / ') || '(空)')}</span>
      <span class="cue-ops">
        <button data-ep="start" class="${S.cueStart === i ? 'on-start' : ''}" title="设为起点">起</button>
        <button data-ep="end" class="${S.cueEnd === i ? 'on-end' : ''}" title="设为终点">终</button>
      </span></div>`;
  }).join('') || '<div class="empty-state">没有匹配的字幕</div>';

  list.querySelectorAll('.cue-row').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.type !== 'checkbox' && !e.target.dataset.ep) selectCue(+row.dataset.i, true);
    };
  });
  list.querySelectorAll('input[data-check]').forEach((box) => {
    box.onchange = () => {
      const i = +box.dataset.check;
      if (box.checked) S.checked.add(i); else S.checked.delete(i);
      $('cueCount').textContent = `共 ${track.cues.length} 条${needle ? ` · 匹配 ${indices.length} 条` : ''} · 已勾选 ${S.checked.size} 条`;
    };
  });
  list.querySelectorAll('[data-ep]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const i = +btn.closest('.cue-row').dataset.i;
      if (btn.dataset.ep === 'start') S.cueStart = i; else S.cueEnd = i;
      S.activeCue = i;
      renderCues();
    };
  });
  $('cueCount').textContent = `共 ${track.cues.length} 条${needle ? ` · 匹配 ${indices.length} 条` : ''} · 已勾选 ${S.checked.size} 条`;
  $('endpointInfo').textContent = (S.cueStart !== null || S.cueEnd !== null)
    ? `起点行 ${S.cueStart === null ? '未设' : S.cueStart + 1} · 终点行 ${S.cueEnd === null ? '未设' : S.cueEnd + 1}`
    : '未设置起止行（点行尾的「起 / 终」，或选中行后用上方按钮）';
}

function cueBoundary(index, edge, padding) {
  return { kind: 'cue', ms: 0, padding_ms: padding,
    cue_ref: { track_id: S.cueTrack, cue_index: index, edge } };
}

async function addClipsFromEndpoints() {
  if (S.cueStart === null || S.cueEnd === null) { alert('请先分别设置起点行和终点行'); return; }
  if (S.cueStart > S.cueEnd) { alert('起点行不能晚于终点行'); return; }
  const track = currentTrack();
  snapshotProject();
  S.project.clips.push({
    id: uid(), source_id: track.source_id,
    start: cueBoundary(S.cueStart, 'start', +$('padStart').value || 0),
    end: cueBoundary(S.cueEnd, 'end', +$('padEnd').value || 0),
    track_ids: [track.id],
    label: `字幕 ${S.cueStart + 1}-${S.cueEnd + 1}`,
  });
  S.selectedClip = S.project.clips.length - 1;
  await syncProject(true);
  setStatus(`已按字幕 ${S.cueStart + 1}–${S.cueEnd + 1} 行生成片段`);
}

async function addClipsFromChecked() {
  if (!S.checked.size) { alert('请先勾选字幕行'); return; }
  const track = currentTrack();
  snapshotProject();
  const res = await post('/api/clips/from-cues', {
    source_id: track.source_id,
    track_id: track.id,
    indices: [...S.checked],
    padding_start_ms: +$('padStart').value || 0,
    padding_end_ms: +$('padEnd').value || 0,
    merge_gap_ms: 0,
    replace: false,
  });
  if (res.project) S.project = res.project;
  S.state = res.state;
  S.checked.clear();
  S.selectedClip = S.project.clips.length ? S.project.clips.length - 1 : null;
  renderEverything();
  setStatus(`已由勾选字幕生成 ${res.clips.length} 个片段`);
}

/* ---------- file browser ---------- */

async function browseDir(dir) {
  const res = await api('/api/browse?' + q({ dir, kind: 'all' }));
  S.browseCwd = res.path;
  S.browseParent = res.parent || '';
  $('browsePath').value = res.path;
  const list = $('browseList');
  const rows = [];
  if (res.parent) rows.push(`<div class="browse-item" data-dir="${esc(res.parent)}"><span class="ico">↑</span><span class="name">.. 上级目录</span></div>`);
  res.entries.forEach((e) => rows.push(
    `<div class="browse-item" data-${e.is_dir ? 'dir' : 'file'}="${esc(e.path)}">
      <span class="ico">${e.is_dir ? '▸' : '·'}</span><span class="name">${esc(e.name)}</span>
      <span class="sz">${e.is_dir ? '' : (e.size / 1048576).toFixed(1) + ' MB'}</span></div>`));
  list.innerHTML = rows.join('') || '<div class="empty-state">此目录没有可选的媒体文件</div>';
  list.querySelectorAll('[data-dir]').forEach((el) => el.onclick = () => browseDir(el.dataset.dir));
  list.querySelectorAll('[data-file]').forEach((el) => el.onclick = () => addSelected(el.dataset.file));
}

function addSelected(path) {
  if (S.selected.some((s) => s.path === path)) return;
  S.selected.push({ path, source_id: null });
  renderSelected();
}
function fileKind(path) { return /\.(srt|vtt|ass|ssa)$/i.test(path) ? '字幕' : '视频'; }

function renderSelected() {
  const box = $('selectedList');
  const videos = S.selected.filter((s) => fileKind(s.path) === '视频');
  box.innerHTML = S.selected.map((s, i) => {
    const kind = fileKind(s.path);
    const name = s.path.split(/[\\/]/).pop();
    let sourceSel = '';
    if (kind === '字幕' && videos.length) {
      if (!videos.some((v) => v.path === s.source_id)) {
        const stem = s.path.replace(/\.(srt|vtt|ass|ssa)$/i, '');
        const match = videos.find((v) => v.path.replace(/\.[^.]+$/, '') === stem);
        s.source_id = (match || videos[0]).path;
      }
      sourceSel = `<select class="select small" data-sel="${i}">${videos.map((v) =>
        `<option value="${esc(v.path)}" ${s.source_id === v.path ? 'selected' : ''}>${esc(v.path.split(/[\\/]/).pop())}</option>`).join('')}</select>`;
    }
    return `<div class="sel-item"><span class="kind">${kind}</span><span class="name" title="${esc(s.path)}">${esc(name)}</span>
      ${sourceSel}<button class="btn tiny" data-rm="${i}">移除</button></div>`;
  }).join('') || '<div class="empty-state">尚未选择文件，单击目录进入，单击文件加入</div>';
  box.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => { S.selected.splice(+b.dataset.rm, 1); renderSelected(); });
  box.querySelectorAll('[data-sel]').forEach((sel) => sel.onchange = () => {
    S.selected[+sel.dataset.sel].source_id = sel.value;
  });
}

// Whole-file compression keeps the timeline unchanged, so loading the .srt
// is optional. The checkbox lets the user skip the same-named .srt lookup.
function autoSubtitlesEnabled() {
  const el = $('autoSubChk');
  return el ? !!el.checked : true;
}

async function loadSelected() {
  const videos = S.selected.filter((s) => fileKind(s.path) === '视频').map((s) => s.path);
  if (!videos.length) { alert('请至少选择一个视频'); return; }
  const subtitles = S.selected.filter((s) => fileKind(s.path) === '字幕').map((s, i) => {
    let source_id = s.source_id;
    if (!source_id) {
      const stem = videos.find((v) => v.replace(/\.[^.]+$/, '') === s.path.replace(/\.(srt|vtt|ass|ssa)$/i, ''));
      source_id = stem || videos[0];
    }
    const idx = videos.indexOf(source_id) + 1;
    return { path: s.path, source_id: `s${Math.max(1, idx)}`, group_id: `g${i + 1}`,
      label: s.path.split(/[\\/]/).pop(), lang: '' };
  });
  setStatus('正在载入媒体…');
  try {
    const res = await post('/api/open', {
      videos, subtitles, auto_subtitles: autoSubtitlesEnabled(),
    });
    applyProject(res.project, res.state);
    $('fileDialog').classList.add('hidden');
    const trackCount = res.project.tracks?.length || 0;
    setStatus(`已载入 ${videos.length} 个视频、${trackCount} 条字幕轨`
      + (trackCount ? '' : '（未载入字幕：整片压缩时把原 .srt 改名即可复用）'));
  } catch (e) { alert('载入失败: ' + e.message); setStatus('载入失败'); }
}

/* ---------- encode panel: read-back, live check, presets ---------- */

const PRESET_STORE = 'clip-video.encode-presets.v1';

/* ---------- three profiles: source / built-in 720p / custom ---------- */

function profileById(id) {
  return (S.profiles || []).find((p) => p.id === id) || null;
}

function renderProfileSwitch() {
  document.querySelectorAll('#profileSwitch .profile-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.profile === S.profileMode);
  });
}

/** Pure HTML builder so the card can be unit-tested without a DOM. */
function buildProfileCard(profile, mode) {
  if (!profile || mode === 'custom') return '';
  let html = `<div class="pc-head"><b>${esc(profile.label)}</b><span>${esc(profile.tagline)}</span></div>
    <div class="pc-detail">${esc(profile.detail)}</div>`;
  if (mode === 'source') {
    html += '<div class="pc-lock">已锁定：视频编码、分辨率、码率、音频、字幕格式等全部沿用原片，不能修改。'
      + '想压缩体积请选 ② 720p 省体积，或 ③ 自定义。</div>';
  } else if (profile.bullets && profile.bullets.length) {
    html += '<div class="pc-list">' + profile.bullets.map((b) =>
      `<div class="pc-row"><b>${esc(b.name)}</b><span class="pc-val">${esc(b.value)}</span>`
      + `<span class="pc-why">${esc(b.why)}</span></div>`).join('') + '</div>';
    if (profile.command) {
      html += `<details class="pc-cmd"><summary>查看对应的 ffmpeg 命令</summary>`
        + `<code>${esc(profile.command)}</code></details>`;
    }
    html += '<div class="pc-actions"><button id="btnTuneFromProfile" class="btn tiny">'
      + '以此为基础微调 →</button></div>';
  }
  return html;
}

function renderProfileCard() {
  const box = $('profileCard');
  if (box) box.innerHTML = buildProfileCard(profileById(S.profileMode), S.profileMode);
}

/** Switch the whole settings page between locked recipes and free editing. */
function setProfileMode(mode) {
  S.profileMode = mode;
  if (S.project?.output) S.project.output.profile_mode = mode;
  if (mode === 'builtin_720p' && $('modeSel').value === 'lossless') {
    // A stream copy cannot transcode, so the recipe would silently do nothing.
    $('modeSel').value = 'precise';
    if (S.project?.output) S.project.output.mode = 'precise';
    setStatus('720p 预设需要重新编码，已自动切到精确模式');
  }
  renderProfileSwitch();
  renderProfileCard();
  updateModeUi();
  persistProject();
  scheduleEncodeCheck();
}

/** "Micro-tune": pre-fill the custom panel with the built-in recipe. */
function applyBuiltinAsCustom() {
  const p = profileById('builtin_720p');
  if (p?.encode) applyEncodeToDom(p.encode);
  if (p?.speed) {
    $('presetSel').value = p.speed;
    if (S.project?.output) S.project.output.preset = p.speed;
  }
  $('embedChk').checked = false;
  $('modeSel').value = 'precise';
  if (S.project?.output) {
    S.project.output.embed_subtitles = false;
    S.project.output.mode = 'precise';
  }
  setProfileMode('custom');
  setStatus('已把 720p 预设填入自定义参数，现在可以微调');
}

function renderSourceInfo() {
  const el = $('srcInfo');
  if (!el) return;
  const v = S.srcInfo?.video || {};
  const a = S.srcInfo?.audio || {};
  const f = S.srcInfo?.format || {};
  if (!S.srcInfo || !v.width) {
    el.textContent = '打开视频后自动读取并回显原片参数（编码、分辨率、帧率、位深、码率、音频、体积）。';
    return;
  }
  const mb = f.size_bytes ? (f.size_bytes / 1048576).toFixed(1) + ' MB' : '未知';
  const src = currentSource();
  el.innerHTML =
    `<b>${esc(src ? src.path.split(/[\\/]/).pop() : '源片')}</b> · ` +
    `${esc(v.width)}×${esc(v.height)} · ${esc(String(v.codec || '').toUpperCase())} ` +
    `${esc(v.profile || '')} · ${esc(v.pix_fmt || '')} · ${esc((v.fps_float || 0).toFixed(3))} fps<br>` +
    `视频 ${esc(v.video_kbps || 0)} kbps · 音频 ${esc(String(a.codec || '无').toUpperCase())} ` +
    `${esc(a.audio_kbps || 0)} kbps / ${esc(a.sample_rate || 0)} Hz / ${esc(a.channels || 0)} 声道 · ` +
    `全长 ${fmt(f.duration_ms || 0)} · ${esc(mb)}`;
}

function renderEncodePanel(info) {
  S.srcInfo = info || null;
  const box = $('encGroups');
  if (box) box.innerHTML = buildEncodeGroups(S.srcInfo);
  const help = $('encHelp');
  if (help) help.innerHTML = buildHelpTable();
  renderSourceInfo();
}

async function loadSourceEncodeInfo() {
  const src = currentSource();
  if (!src) { renderEncodePanel(null); return; }
  try {
    renderEncodePanel(await api('/api/encode-params?' + q({ path: src.path })));
  } catch (e) {
    renderEncodePanel(null);
    setStatus('原片参数读取失败: ' + e.message);
  }
  applyEncodeToDom(S.project?.output?.encode || defaultEncode());
  scheduleEncodeCheck();
}

/** Keep OutputCfg's legacy fields in sync with the panel, then persist quietly. */
function syncOutputFromEncode() {
  if (!S.project) return null;
  if (!S.project.output) S.project.output = {};
  const enc = collectEncode();
  S.project.output.encode = enc;
  S.project.output.crf = enc.crf;
  S.project.output.match_source_bitrate = enc.rate_control === 'source';
  S.project.output.profile_mode = S.profileMode;
  return enc;
}

async function persistProject() {
  if (!S.project) return;
  try {
    await post('/api/project', { project: S.project });
    // Container / subtitle format / embedding change the set of files the
    // next export will produce, so re-ask the backend for the final name.
    refreshExportPath();
  } catch (e) { setStatus('参数同步失败: ' + e.message); }
}

function scheduleEncodeCheck() {
  clearTimeout(S.checkTimer);
  S.checkTimer = setTimeout(runEncodeCheck, 260);
}

async function runEncodeCheck() {
  if (!S.project?.sources?.length) return;
  const enc = syncOutputFromEncode();
  await persistProject();
  const lossless = $('modeSel').value === 'lossless';
  try {
    const res = await post('/api/check-params', {
      encode: enc,
      total_ms: totalMs(),
      mode: lossless ? 'lossless' : 'precise',
      match_source_bitrate: enc.rate_control === 'source',
      profile_mode: S.profileMode,
    });
    S.lastCheck = res;
    renderEncodeCheck(res, enc);
  } catch (e) {
    const box = $('encCheck');
    if (box) box.innerHTML = `<div class="check-item warn"><b>参数检查失败</b>${esc(e.message)}</div>`;
  }
}

function renderEncodeCheck(res, enc) {
  const changed = countEncodeChanges(enc || collectEncode());
  const est = res?.estimated_bytes;
  const equiv = res?.source_equivalent_bytes;
  const ratio = res?.ratio;
  let estimate = 'CRF 模式无法预估体积';
  if (est !== null && est !== undefined) {
    estimate = `${res?.is_upper_bound ? '体积上限' : '预计体积'} <b>${(est / 1048576).toFixed(1)} MB</b>`;
    if (ratio !== null && ratio !== undefined) estimate += `　·　约为原片按保留时长的 <b>${ratio.toFixed(2)}×</b>`;
    if (equiv) estimate += `　·　原片等比 ${(equiv / 1048576).toFixed(1)} MB`;
  }
  const sum = $('encSummary');
  if (sum) sum.innerHTML = `${estimate}<br>${changed ? `已修改 <b>${changed}</b> 项参数` : '全部沿用原片参数'} · ${esc(res?.estimate_note || '')}`;
  const items = (res?.warnings || []).map((w) =>
    `<div class="check-item ${esc(w.level)}"><b>${esc(w.title)}</b>${esc(w.text)}</div>`).join('');
  const box = $('encCheck');
  if (box) box.innerHTML = items || '<div class="check-item ok">当前参数没有发现浪费或风险。</div>';
}

function loadPresets() {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(PRESET_STORE) || '{}') || {};
  } catch (e) { return {}; }
}
function savePresets(data) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(PRESET_STORE, JSON.stringify(data)); }
  catch (e) { setStatus('预设保存失败: ' + e.message); }
}
function renderPresetList(selected) {
  const sel = $('savedPresetSel');
  if (!sel) return;
  const data = loadPresets();
  const names = Object.keys(data).sort();
  sel.innerHTML = '<option value="">— 已保存的预设 —</option>' +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (selected && names.includes(selected)) sel.value = selected;
}
function currentPreset() {
  return {
    encode: collectEncode(),
    preset: $('presetSel').value || 'medium',
    embed_subtitles: !!$('embedChk').checked,
    updated: Date.now(),
  };
}
function applyPreset(p) {
  if (!p) return;
  applyEncodeToDom(p.encode || defaultEncode());
  if (p.preset) $('presetSel').value = p.preset;
  $('embedChk').checked = !!p.embed_subtitles;
  syncOutputFromEncode();
  scheduleEncodeCheck();
  setStatus('已应用参数预设');
}
function showExportConfirm(res, enc, onConfirm) {
  const warns = (res?.warnings || []).filter((w) => w.level === 'warn');
  if (!warns.length) { onConfirm(); return; }
  S.pendingExport = onConfirm;
  const est = res?.estimated_bytes;
  $('confirmSize').innerHTML = est !== null && est !== undefined
    ? `当前预计体积 <b>${(est / 1048576).toFixed(1)} MB</b>（已修改 ${countEncodeChanges(enc)} 项参数）。`
    : '当前使用 CRF，体积无法预估。';
  $('confirmList').innerHTML = warns.map((w) =>
    `<div class="check-item warn"><b>${esc(w.title)}</b>${esc(w.text)}</div>`).join('');
  $('confirmDialog').classList.remove('hidden');
}

function bindTooltips() {
  const panel = $('panel-settings');
  const tip = $('tipBox');
  const place = (e) => {
    if (!tip || tip.classList.contains('hidden')) return;
    const x = (e.clientX || 0) + 16, y = (e.clientY || 0) + 16;
    tip.style.left = Math.min(x, (window.innerWidth || 1200) - 340) + 'px';
    tip.style.top = Math.min(y, (window.innerHeight || 800) - 180) + 'px';
  };
  panel.addEventListener('mouseover', (e) => {
    const q = e.target?.closest?.('.q');
    if (!q) return;
    tip.textContent = q.dataset.tip || '';
    tip.classList.remove('hidden');
    place(e);
  });
  panel.addEventListener('mousemove', place);
  panel.addEventListener('mouseout', (e) => {
    if (e.target?.closest?.('.q')) tip.classList.add('hidden');
  });
}

/* ---------- export ---------- */

async function startExport() {
  if (!S.project?.sources?.length) { alert('请先打开视频'); return; }
  if (!S.project?.clips?.length) { alert('请先添加至少一个片段'); return; }
  const p = S.project;
  const enc = syncOutputFromEncode();
  Object.assign(p.output, {
    mode: $('modeSel').value,
    crf: enc.crf,
    preset: $('presetSel').value || 'medium',
    match_source_bitrate: enc.rate_control === 'source',
    embed_subtitles: !!$('embedChk').checked,
    snap_to_cue: !!$('snapChk').checked,
    snap_tolerance_ms: +$('snapTol').value || 500,
    profile_mode: S.profileMode,
  });

  // Always ask the rule engine right before exporting, so a stale live check
  // can never hide a "720p -> 1080p" style waste.
  let evaluation = S.lastCheck;
  try {
    evaluation = await post('/api/check-params', {
      encode: enc, total_ms: totalMs(), mode: p.output.mode,
      match_source_bitrate: p.output.match_source_bitrate,
      profile_mode: p.output.profile_mode,
    });
    S.lastCheck = evaluation;
    renderEncodeCheck(evaluation, enc);
  } catch (e) { setStatus('导出前检查失败: ' + e.message); }

  const proceed = async () => {
    $('exportDialog').classList.remove('hidden');
    $('exportStatus').textContent = '准备中…';
    $('progressBar').style.width = '0%';
    $('exportResult').innerHTML = '';
    $('exportActions').classList.add('hidden');
    S.revealPath = '';
    try {
      await post('/api/project', { project: p });
      const res = await post('/api/export', {
        output_dir: $('outDir').value.trim(),
        output_name: $('outName').value.trim(),
        overwrite: !!$('overwriteChk').checked,
      });
      if (res.output_path) $('outPath').value = res.output_path;
      pollExport(res.task_id);
    } catch (e) {
      $('exportStatus').textContent = '导出失败: ' + e.message;
    }
  };
  showExportConfirm(evaluation, enc, proceed);
}

function pollExport(taskId) {
  const tick = async () => {
    let res;
    try { res = await api('/api/export/status?' + q({ id: taskId })); }
    catch (e) { $('exportStatus').textContent = '状态查询失败: ' + e.message; return; }
    $('exportStatus').textContent = `${res.message} (${res.percent}%)`;
    $('progressBar').style.width = res.percent + '%';
    if (res.status === 'running') { setTimeout(tick, 500); return; }
    if (res.status === 'error') { $('exportResult').innerHTML = `<span style="color:var(--red)">${esc(res.error)}</span>`; return; }
    const r = res.result || {};
    const subs = Object.entries(r.subtitles || {}).map(([g, path]) => `${esc(g)}: ${esc(path)}`).join('<br>');
    const warns = (r.warnings || []).map((w) => `· ${esc(w)}`).join('<br>');
    const renamed = r.renamed_from
      ? `<div class="reuse-note">同名文件已存在，本次自动改名为 <b>${esc(String(r.video || '').split(/[\\/]/).pop())}</b>，旧文件没有被覆盖。</div>`
      : '';
    const folder = r.video || r.output_dir || '';
    $('exportResult').innerHTML =
      `视频: <b>${esc(r.video)}</b><br>输出时长: ${fmt(r.total_ms)}<br>字幕:<br>${subs || '（无）'}` +
      (warns ? `<br><br>提示:<br>${warns}` : '') +
      renamed + wholeFileReuseNote(S.project, r);
    $('exportActions').classList.remove('hidden');
    S.revealPath = folder;
    refreshExportPath();
    api('/api/project').then((cur) => { S.project = cur.project; S.state = cur.state; renderEverything(); });
  };
  setTimeout(tick, 300);
}

/* ---------- wiring ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    ['clips', 'cues', 'settings'].forEach((n) => $('panel-' + n).classList.toggle('hidden', n !== tab.dataset.tab));
  });

  // Settings anchor nav: the scroll container is the right-hand panel, so a
  // plain scrollIntoView keeps the fixed toolbar where it is.
  const settingsNav = $('settingsNav');
  if (settingsNav) settingsNav.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.nav-opt');
    if (!btn) return;
    document.querySelectorAll('#settingsNav .nav-opt').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    const target = $(btn.dataset.anchor);
    if (btn.dataset.anchor === 'paramsTitle' && S.profileMode !== 'custom') {
      setStatus('转码参数在 ② 720p / ① 沿用原片 下是锁定的；选 ③ 自定义 才能修改');
      return;
    }
    if (target?.scrollIntoView) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  bindOutputLane();
  $('btnPreviewOutput').onclick = startOutputPreview;

  $('outDir').oninput = scheduleExportPath;
  $('outName').oninput = scheduleExportPath;
  $('overwriteChk').onchange = scheduleExportPath;
  $('btnPickOutDir').onclick = openDirDialog;
  $('btnResetOutDir').onclick = () => {
    $('outDir').value = '';
    $('outName').value = '';
    refreshExportPath();
    setStatus('已恢复默认导出位置（原视频旁边的新建文件夹）');
  };
  $('dirCancel').onclick = () => $('dirDialog').classList.add('hidden');
  $('dirUseDefault').onclick = () => {
    $('outDir').value = '';
    $('dirDialog').classList.add('hidden');
    refreshExportPath();
  };
  $('dirChoose').onclick = () => {
    const dir = $('dirBrowsePath').value.trim() || S.dirCwd;
    if (!dir) { alert('请先选择一个文件夹'); return; }
    $('outDir').value = dir;
    $('dirDialog').classList.add('hidden');
    refreshExportPath();
    setStatus('导出文件夹已设为：' + dir);
  };
  $('dirBrowseGo').onclick = () => browseDirOnly($('dirBrowsePath').value.trim());
  $('dirBrowseUp').onclick = () => browseDirOnly(S.dirParent);
  $('dirBrowsePath').onkeydown = (e) => {
    if (e.key === 'Enter') browseDirOnly($('dirBrowsePath').value.trim());
  };
  $('dirBrowseNew').onclick = async () => {
    const ask = (typeof window !== 'undefined' && window.prompt) ? window.prompt.bind(window) : null;
    const name = ask ? ask('在「' + (S.dirCwd || '当前目录') + '」下新建文件夹，名称：', '剪辑') : null;
    if (!name || !name.trim()) return;
    try {
      const res = await post('/api/mkdir', { parent: S.dirCwd, name: name.trim() });
      await browseDirOnly(res.path);
      setStatus('已新建文件夹：' + res.path);
    } catch (err) { alert('新建失败: ' + err.message); }
  };

  $('btnRecent').onclick = () => { renderRecentList(); $('recentDialog').classList.remove('hidden'); };
  $('recentClose').onclick = () => $('recentDialog').classList.add('hidden');
  $('recentImport').onclick = () => { $('recentDialog').classList.add('hidden'); $('projectFile').click(); };

  document.querySelectorAll('#profileSwitch .profile-opt').forEach((b) => {
    b.onclick = () => setProfileMode(b.dataset.profile);
  });
  $('profileCard').addEventListener('click', (e) => {
    if (e.target?.id === 'btnTuneFromProfile') applyBuiltinAsCustom();
  });

  bindTooltips();
  $('encGroups').addEventListener('change', (e) => {
    if (!e.target?.dataset?.key) return;
    if (e.target.tagName === 'SELECT') syncCustomBox(e.target);
    syncOutputFromEncode();
    scheduleEncodeCheck();
  });
  // Typing in a custom box should refresh the live size/quality check too.
  $('encGroups').addEventListener('input', (e) => {
    if (!e.target?.classList?.contains('custom-num')) return;
    syncOutputFromEncode();
    scheduleEncodeCheck();
  });
  $('modeSel').onchange = () => {
    updateModeUi();
    if (S.project?.output) S.project.output.mode = $('modeSel').value;
    persistProject();
    scheduleEncodeCheck();
  };
  $('presetSel').onchange = (e) => {
    if (S.project?.output) S.project.output.preset = e.target.value;
    scheduleEncodeCheck();
  };
  $('embedChk').onchange = (e) => {
    if (S.project?.output) S.project.output.embed_subtitles = e.target.checked;
    persistProject();
    scheduleEncodeCheck();
  };
  $('snapTol').onchange = (e) => {
    if (S.project?.output) S.project.output.snap_tolerance_ms = +e.target.value || 500;
    scheduleEncodeCheck();
  };

  $('confirmCancel').onclick = () => {
    $('confirmDialog').classList.add('hidden');
    S.pendingExport = null;
  };
  $('confirmGo').onclick = () => {
    const fn = S.pendingExport;
    S.pendingExport = null;
    $('confirmDialog').classList.add('hidden');
    if (fn) fn();
  };

  $('btnSavePreset').onclick = () => {
    const ask = (typeof window !== 'undefined' && window.prompt) ? window.prompt.bind(window) : null;
    const name = ask ? ask('给这套参数起个名字：', '我的预设') : null;
    if (!name || !name.trim()) return;
    const data = loadPresets();
    data[name.trim()] = currentPreset();
    savePresets(data);
    renderPresetList(name.trim());
    setStatus('已保存预设：' + name.trim());
  };
  $('btnApplyPreset').onclick = () => {
    const name = $('savedPresetSel').value;
    if (!name) return alert('请先选择一个预设');
    applyPreset(loadPresets()[name]);
  };
  $('btnDeletePreset').onclick = () => {
    const name = $('savedPresetSel').value;
    if (!name) return alert('请先选择一个预设');
    const ask = (typeof window !== 'undefined' && window.confirm) ? window.confirm.bind(window) : null;
    if (ask && !ask(`删除预设「${name}」？`)) return;
    const data = loadPresets();
    delete data[name];
    savePresets(data);
    renderPresetList();
    setStatus('已删除预设：' + name);
  };
  $('btnShrinkPreset').onclick = () => {
    const src = S.srcInfo?.video || {};
    const enc = defaultEncode();
    enc.rate_control = 'bitrate';
    enc.video_kbps = Math.max(150, Math.round((src.video_kbps || 800) * 0.5));
    enc.audio_kbps = 96;
    applyEncodeToDom(enc);
    syncOutputFromEncode();
    scheduleEncodeCheck();
    setStatus(`已应用「省体积」：视频目标码率 ${enc.video_kbps} kbps、音频 96 kbps（画质会下降，可继续微调）`);
  };
  $('btnResetEncode').onclick = () => {
    applyEncodeToDom(defaultEncode());
    syncOutputFromEncode();
    scheduleEncodeCheck();
    setStatus('已恢复为沿用原片参数');
  };
  $('btnExportPresets').onclick = () => {
    const data = loadPresets();
    if (!Object.keys(data).length) return alert('还没有保存过预设');
    const blob = new Blob([JSON.stringify({ version: 1, presets: data }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'clip-video-presets.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('预设已导出为 JSON');
  };
  $('btnImportPresets').onclick = () => $('presetFile').click();
  $('presetFile').onchange = (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const incoming = parsed.presets || parsed;
        const data = loadPresets();
        let n = 0;
        Object.keys(incoming).forEach((k) => {
          if (incoming[k]?.encode) { data[k] = incoming[k]; n++; }
        });
        savePresets(data);
        renderPresetList();
        setStatus(`已导入 ${n} 个预设`);
      } catch (err) { alert('预设文件解析失败: ' + err.message); }
    };
    reader.readAsText(file);
  };
  $('btnOpen').onclick = () => {
    $('fileDialog').classList.remove('hidden');
    browseDir(S.browseCwd || S.config?.cwd || '');
    renderSelected();
  };
  $('browseCancel').onclick = () => $('fileDialog').classList.add('hidden');
  $('browseGo').onclick = () => browseDir($('browsePath').value.trim());
  $('browseUp').onclick = () => browseDir(S.browseParent);
  $('browseLoad').onclick = loadSelected;
  $('browsePath').onkeydown = (e) => { if (e.key === 'Enter') browseDir($('browsePath').value.trim()); };

  $('btnPlay').onclick = togglePlay;
  $('btnBack').onclick = () => nudge(-5);
  $('btnFwd').onclick = () => nudge(5);
  $('volSlider').oninput = (e) => { video.volume = Number(e.target.value) / 100; video.muted = false; };
  $('btnHelp').onclick = () => $('helpDialog').classList.remove('hidden');
  $('helpClose').onclick = () => $('helpDialog').classList.add('hidden');
  $('btnSaveProject').onclick = saveProjectFile;
  $('btnLoadProject').onclick = () => $('projectFile').click();
  $('projectFile').onchange = async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    try { await loadProjectFile(file); }
    catch (err) { alert('工程载入失败: ' + err.message); setStatus('工程载入失败'); }
    e.target.value = '';
  };

  $('btnExport').onclick = startExport;
  $('exportClose').onclick = () => $('exportDialog').classList.add('hidden');
  $('btnReveal').onclick = async () => {
    if (!S.revealPath) return;
    try {
      await post('/api/reveal', { path: S.revealPath });
      setStatus('已在文件管理器中打开输出文件夹');
    } catch (err) { setStatus('打开文件夹失败: ' + err.message); }
  };
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('btnClearClips').onclick = () => {
    if (!S.project?.clips?.length) return;
    const ask = (typeof window !== 'undefined' && window.confirm) ? window.confirm.bind(window) : null;
    if (ask && !ask(`清空全部 ${S.project.clips.length} 个片段？可以用 Ctrl+Z 撤销。`)) return;
    snapshotProject();
    S.project.clips = [];
    S.selectedClip = null;
    syncProject(true);
    setStatus('已清空片段（Ctrl+Z 可撤销）');
  };
  $('btnWholeClip').onclick = applyWholeClips;

  $('sourceSel').onchange = (e) => {
    S.activeSource = e.target.value;
    const track = S.project?.tracks.find((t) => t.source_id === S.activeSource);
    if (track) { S.cueTrack = track.id; $('cueTrackSel').value = track.id; }
    S.checked.clear();
    setVideoSource(S.activeSource, 0);
    resetView();
    renderTimeline();
    renderCues();
    renderCueTrack();
    renderStatusMeta();
    loadSourceEncodeInfo();
  };
  $('cueTrackSel').onchange = (e) => { S.cueTrack = e.target.value; S.checked.clear(); renderCues(); renderCueTrack(); };
  $('cueSearch').oninput = renderCues;
  $('groupSel').onchange = (e) => { S.activeGroup = e.target.value; };

  $('btnSetStart').onclick = () => { if (S.activeCue === null) return alert('请先点击一条字幕'); S.cueStart = S.activeCue; renderCues(); };
  $('btnSetEnd').onclick = () => { if (S.activeCue === null) return alert('请先点击一条字幕'); S.cueEnd = S.activeCue; renderCues(); };
  $('btnFromEndpoints').onclick = addClipsFromEndpoints;
  $('btnFromCues').onclick = addClipsFromChecked;
  $('btnSelectAll').onclick = () => { visibleCueIndices().forEach((i) => S.checked.add(i)); renderCues(); };
  $('btnSelectNone').onclick = () => { S.checked.clear(); renderCues(); };

  // 字幕时间校准工作台
  document.querySelectorAll('.subtab[data-sub]').forEach((b) => {
    b.onclick = () => showCueSub(b.dataset.sub);
  });
  $('wbLoop').onclick = toggleCueLoop;
  $('wbExportSubs').onclick = exportSubtitlesOnly;
  $('wbReload').onclick = wbReload;
  $('wbSetTime').onclick = () => {
    const s = parseTime($('wbStart').value), e = parseTime($('wbEnd').value);
    if (s == null || e == null) { setStatus('时间格式不对（用 00:00:01.200 或毫秒）'); return; }
    if (e <= s) { setStatus('终点必须晚于起点'); return; }
    wbSetExact(s, e);
  };
  $('wbStart').onkeydown = (e) => { if (e.key === 'Enter') $('wbSetTime').click(); };
  $('wbEnd').onkeydown = (e) => { if (e.key === 'Enter') $('wbSetTime').click(); };
  $('wbTrackApply').onclick = () => {
    const d = Number($('wbTrackDelta').value || 0);
    if (!d) { setStatus('整轨偏移量为 0'); return; }
    wbShiftWholeTrack(d, false);
  };
  $('wbTrackApplyAll').onclick = () => {
    const d = Number($('wbTrackDelta').value || 0);
    if (!d) { setStatus('整轨偏移量为 0'); return; }
    wbShiftWholeTrack(d, true);
  };
  document.querySelectorAll('[data-wb]').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.wb;
      if (act === 'prev') return gotoCueRelative(-1);
      if (act === 'next') return gotoCueRelative(1);
      const m = act.endsWith('+') ? 1 : -1;
      const edge = act.startsWith('start') ? 'start' : act.startsWith('end') ? 'end' : 'both';
      wbShift(wbStepMs(1) * m, edge);
    };
  });
  bindWbMiniTl();

  $('btnZoomIn').onclick = () => zoomBy(1);
  $('btnZoomOut').onclick = () => zoomBy(-1);
  $('btnZoomFit').onclick = zoomFit;
  $('viewScroll').oninput = (e) => panTo(e.target.value);

  bindTimelineDrag();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.clipSort) {
        S.clipSort.el.classList.remove('dragging');
        S.clipSort = null;
        $('dragTip').classList.add('hidden');
        renderSegmentMarks();
        setStatus('已取消时间轴排序');
      } else if (S.clipDrag) {
        S.clipDrag = null;
        $('dragTip').classList.add('hidden');
        renderSegmentMarks();
        setStatus('已取消片段调整');
      } else {
        $('helpDialog').classList.add('hidden');
        $('confirmDialog').classList.add('hidden');
        S.pendingExport = null;
      }
      return;
    }
    const typing = e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT'
      || e.target?.isContentEditable;
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudge(5); }
    if (e.key === '?') { $('helpDialog').classList.remove('hidden'); }
    if (e.key === 'i' || e.key === 'I') { S.cueStart = S.activeCue; renderCues(); }
    if (e.key === 'o' || e.key === 'O') { S.cueEnd = S.activeCue; renderCues(); }
    // Subtitle proofreading shortcuts (also available as on-screen buttons).
    if (e.key === ',' || e.key === '<') { e.preventDefault(); wbShift(-wbStepMs(e.shiftKey ? 5 : 1), 'both'); }
    else if (e.key === '.' || e.key === '>') { e.preventDefault(); wbShift(wbStepMs(e.shiftKey ? 5 : 1), 'both'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); gotoCueRelative(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); gotoCueRelative(1); }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); syncProject(true); setStatus('已保存工程'); }
    if (mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportSubtitlesOnly(); }
  });
}

/* ---------- 字幕时间校准工作台 ---------- */
// Graphical proofreading: drag a mini timeline, nudge with buttons (or , / .),
// loop a single sentence (with optional padding) and hear the correction at
// once. Every change goes through /api/cues/shift so the server owns the
// correction log and the disk snapshot — a crash mid-proof never loses work.

function wbStepMs(mult = 1) { return Number($('wbStep')?.value || 100) * mult; }

function cueWindow(cue) {
  const dur = currentSource()?.duration_ms || (cue.end_ms + 16000);
  const span = Math.max(4000, cue.end_ms - cue.start_ms + 16000);
  let w0 = cue.start_ms - span / 2 + (cue.end_ms - cue.start_ms) / 2;
  let w1 = w0 + span;
  if (w0 < 0) { w0 = 0; w1 = span; }
  if (w1 > dur) { w1 = dur; w0 = Math.max(0, dur - span); }
  return { start: w0, end: w1 };
}

function renderCueWorkbench() {
  const body = $('wbBody'), empty = $('wbEmpty');
  const track = currentTrack();
  const i = S.activeCue;
  if (!track || i == null || !track.cues[i]) {
    if (body) body.classList.add('hidden');
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  if (body) body.classList.remove('hidden');
  const c = track.cues[i];
  S.wbWin = cueWindow(c);
  $('wbCueLabel').textContent = `第 ${i + 1} 句 / 共 ${track.cues.length} 句`;
  $('wbStart').value = fmt(c.start_ms);
  $('wbEnd').value = fmt(c.end_ms);
  const win = S.wbWin, span = (win.end - win.start) || 1;
  const bar = $('wbCueBar');
  bar.style.left = ((c.start_ms - win.start) / span * 100) + '%';
  bar.style.width = ((c.end_ms - c.start_ms) / span * 100) + '%';
  updateWbPlayhead();
  updateWbStatus();
}

function updateWbPlayhead() {
  const ph = $('wbPlayhead');
  if (!ph || !S.wbWin) return;
  const srcMs = video.currentTime * 1000;
  const span = (S.wbWin.end - S.wbWin.start) || 1;
  ph.style.left = clamp((srcMs - S.wbWin.start) / span * 100, 0, 100) + '%';
}

function wbComputeSummary() {
  const track = currentTrack();
  if (!track) return null;
  const edits = (S.project.cue_edits || []).filter((e) => e.kind !== 'reload');
  const mine = edits.filter((e) => e.track_id === track.id);
  const corrected = new Set(mine.map((e) => e.cue_index));
  const cs = track.cues.slice().sort((a, b) => a.start_ms - b.start_ms);
  let overlaps = 0;
  for (let k = 1; k < cs.length; k++) if (cs[k].start_ms < cs[k - 1].end_ms) overlaps++;
  return { track_edit_count: mine.length, corrected_indices: [...corrected], overlaps };
}

function updateWbStatus() {
  const el = $('wbStatus');
  if (!el) return;
  const s = wbComputeSummary();
  if (!s) { el.textContent = ''; return; }
  const corrected = s.corrected_indices.includes(S.activeCue) ? '已校准' : '未改';
  const overlaps = s.overlaps ? ` · 重叠 ${s.overlaps} 处` : '';
  el.textContent = `${corrected} · 本轨已改 ${s.track_edit_count} 句${overlaps}`;
}

async function commitCueEdit(body) {
  const track = currentTrack();
  if (!track) return;
  body.track_id = track.id;
  snapshotProject();
  try {
    const res = await post('/api/cues/shift', body);
    S.project = res.project;
    S.state = res.state;
    renderCues();
    renderCueTrack();
    renderCueWorkbench();
    const msg = res.clamped
      ? `已保存 · ${res.clamped} 句被夹到边界`
      : `已保存矫正（本轨已改 ${res.summary?.track_edit_count ?? '?'} 句）`;
    setStatus(msg);
    if (S.cueLoopOn) {
      const c = currentTrack()?.cues[S.activeCue];
      if (c) { video.currentTime = c.start_ms / 1000; if (video.paused) playWhenReady(); }
    }
  } catch (e) {
    S.history.pop(); updateHistoryUi();
    setStatus('矫正失败: ' + e.message);
  }
}

async function wbShift(delta, edge) {
  if (S.activeCue == null) { setStatus('先选一句字幕'); return; }
  await commitCueEdit({ action: 'shift', indices: [S.activeCue], delta_ms: delta, edge });
}
async function wbShiftWholeTrack(delta, all) {
  await commitCueEdit({ action: 'shift', scope: all ? 'all_tracks' : 'track', indices: [], delta_ms: delta, edge: 'both' });
}
async function wbSetExact(start, end) {
  if (S.activeCue == null) { setStatus('先选一句字幕'); return; }
  await commitCueEdit({ action: 'set', index: S.activeCue, start_ms: start, end_ms: end });
}
async function wbReload() {
  const track = currentTrack();
  if (!track) return;
  if (!window.confirm('从源字幕文件重新载入本轨，将放弃本轨所有矫正，确定？')) return;
  snapshotProject();
  try {
    const res = await post('/api/cues/shift', { action: 'reload', track_id: track.id });
    S.project = res.project; S.state = res.state;
    renderCues(); renderCueTrack(); renderCueWorkbench();
    setStatus('已从源文件重载本轨字幕');
  } catch (e) {
    S.history.pop(); updateHistoryUi();
    setStatus('重载失败: ' + e.message);
  }
}

function bindWbMiniTl() {
  const tl = $('wbMiniTl');
  if (!tl || tl.dataset.bound) return;
  tl.dataset.bound = '1';
  const start = (mode, e) => {
    const c = currentTrack()?.cues[S.activeCue];
    if (!c || !S.wbWin) return;
    const rect = tl.getBoundingClientRect();
    S.wbDragging = { mode, x: e.clientX, win: S.wbWin, origStart: c.start_ms, origEnd: c.end_ms, w: rect.width };
    e.preventDefault();
  };
  const move = (e) => {
    const d = S.wbDragging;
    if (!d) return;
    const msPerPx = (d.win.end - d.win.start) / (d.w || 1);
    const dms = (e.clientX - d.x) * msPerPx;
    const dur = d.origEnd - d.origStart;
    let ns = d.origStart, ne = d.origEnd;
    if (d.mode === 'l') ns = clamp(d.origStart + dms, d.win.start, d.origEnd - 20);
    else if (d.mode === 'r') ne = clamp(d.origEnd + dms, d.origStart + 20, d.win.end);
    else {
      const maxStart = Math.max(d.win.start, d.win.end - dur);
      const s = clamp(d.origStart + dms, d.win.start, maxStart);
      ns = s; ne = s + dur;
    }
    const span = (d.win.end - d.win.start) || 1;
    const bar = $('wbCueBar');
    bar.style.left = ((ns - d.win.start) / span * 100) + '%';
    bar.style.width = ((ne - ns) / span * 100) + '%';
    $('wbStart').value = fmt(ns);
    $('wbEnd').value = fmt(ne);
    S._wbPreview = { ns, ne };
  };
  const up = async () => {
    const d = S.wbDragging; S.wbDragging = null;
    if (!d || !S._wbPreview) return;
    const p = S._wbPreview; S._wbPreview = null;
    await wbSetExact(p.ns, p.ne);
  };
  $('wbHandleL').addEventListener('pointerdown', (e) => start('l', e));
  $('wbHandleR').addEventListener('pointerdown', (e) => start('r', e));
  $('wbCueBar').addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('wb-handle')) return;
    start('b', e);
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function toggleCueLoop() {
  if (!S.cueLoopOn) {
    if (S.activeCue == null) {
      const track = currentTrack();
      if (!track) { setStatus('先选一句字幕再开循环'); return; }
      S.activeCue = 0;
      renderCues();
      renderCueWorkbench();
    }
    S.cueLoopOn = true;
    const c = currentTrack()?.cues[S.activeCue];
    if (c) video.currentTime = c.start_ms / 1000;
    playWhenReady();
  } else {
    S.cueLoopOn = false;
  }
  updateWbLoopBtn();
}
function updateWbLoopBtn() {
  const b = $('wbLoop');
  if (!b) return;
  b.textContent = S.cueLoopOn ? '单句循环：开' : '单句循环：关';
  b.classList.toggle('on', S.cueLoopOn);
}

function wbTick(srcMs) {
  if (S.cueLoopOn && !video.paused) {
    const track = currentTrack();
    const c = track?.cues[S.activeCue];
    if (!c) { S.cueLoopOn = false; updateWbLoopBtn(); }
    else if (srcMs >= c.end_ms - 3) { video.currentTime = c.start_ms / 1000; }
  }
  const track = currentTrack();
  if (track && track.cues.length) {
    let hit = -1;
    for (let i = 0; i < track.cues.length; i++) {
      const c = track.cues[i];
      if (srcMs >= c.start_ms && srcMs < c.end_ms) { hit = i; break; }
    }
    if (hit !== S.activeCue) {
      S.activeCue = hit;
      highlightActiveCueRow(hit);
      const inProof = !$('cueProofArea').classList.contains('hidden');
      const typing = document.activeElement === $('wbStart') || document.activeElement === $('wbEnd');
      if (inProof && !typing) renderCueWorkbench();
      if (hit >= 0 && inProof) scrollCueIntoView(hit);
    }
  }
  updateWbPlayhead();
}

function highlightActiveCueRow(idx) {
  const list = $('cueList');
  if (!list) return;
  list.querySelectorAll('.cue-row.active').forEach((r) => r.classList.remove('active'));
  if (idx == null || idx < 0) return;
  const row = list.querySelector(`.cue-row[data-i="${idx}"]`);
  if (row) row.classList.add('active');
}
function scrollCueIntoView(idx) {
  const list = $('cueList');
  if (!list) return;
  const row = list.querySelector(`.cue-row[data-i="${idx}"]`);
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function gotoCueRelative(dir) {
  const track = currentTrack();
  if (!track) return;
  let i = S.activeCue == null ? (dir > 0 ? 0 : track.cues.length - 1) : S.activeCue + dir;
  i = clamp(i, 0, track.cues.length - 1);
  selectCueEdit(i, { seek: true });
}
function selectCueEdit(i, opts = {}) {
  if (i == null || i < 0) return;
  S.activeCue = i;
  const c = currentTrack()?.cues[i];
  if (c && opts.seek) setVideoSource(currentTrack().source_id, c.start_ms / 1000);
  renderCueWorkbench();
}

function showCueSub(sub) {
  document.querySelectorAll('.subtab[data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  $('cuePickArea').classList.toggle('hidden', sub !== 'pick');
  $('cueProofArea').classList.toggle('hidden', sub !== 'proof');
  if (sub === 'proof') renderCueWorkbench();
}

async function exportSubtitlesOnly() {
  const track = currentTrack();
  if (!track || !track.cues.length) { alert('没有可导出的字幕'); return; }
  const fmtMode = S.project.output?.encode?.subtitle_format || 'srt';
  try {
    const res = await post('/api/export-subtitles', {
      format: fmtMode,
      output_dir: $('outDir')?.value || '',
      output_name: $('outName')?.value || '',
      overwrite: $('overwriteChk')?.checked || false,
    });
    const files = Object.entries(res.subtitles || {}).map(([g, p]) => `${g}: ${p}`).join('<br>');
    $('exportStatus').textContent = res.remapped ? '已按当前片段重映射并导出字幕' : '已导出矫正后的字幕（未剪辑）';
    $('exportResult').innerHTML = `<div class="exp-line">位置：${esc(res.dir)}</div><div class="exp-line">${files}</div>`
      + (res.renamed_from?.length ? `<div class="exp-line warn">已避免覆盖：${esc(res.renamed_from.join(', '))}</div>` : '');
    S.revealPath = res.dir;
    $('exportActions').classList.remove('hidden');
    $('exportDialog').classList.remove('hidden');
    setStatus('字幕已导出');
  } catch (e) { setStatus('导出字幕失败: ' + e.message); }
}

async function init() {
  bindEvents();
  renderEncodePanel(null);
  applyEncodeToDom(defaultEncode());
  renderPresetList();
  renderProfileSwitch();
  renderProfileCard();
  updateModeUi();
  // Non-blocking: the catalogue is backend-owned; a slow/failed load just
  // leaves the card empty until the next render, never blocks the UI.
  api('/api/profiles').then((res) => {
    S.profiles = res.profiles || [];
    renderProfileCard();
  }).catch(() => {});
  try {
    S.config = await api('/api/config');
    $('envInfo').innerHTML = `ffmpeg: ${esc(S.config.ffmpeg)}<br>ffprobe: ${esc(S.config.ffprobe)}<br>工作目录: ${esc(S.config.cwd)}`;
  } catch (e) { setStatus('配置读取失败: ' + e.message); }
  try {
    const cur = await api('/api/project');
    if (cur.project?.sources?.length) {
      applyProject(cur.project, cur.state);
    } else {
      // The server keeps the project in memory only. After a restart, restore
      // the last autosave so a crash never costs the user their whole edit.
      const saved = readAutosave();
      if (saved?.project?.sources?.length) {
        try {
          const res = await post('/api/project/load', { project: saved.project });
          applyProject(res.project, res.state);
          const when = String(saved.saved_at || '').slice(0, 16).replace('T', ' ');
          setStatus(`已自动恢复上次工程${when ? '（' + when + '）' : ''} · 点「打开媒体」可换片子`);
        } catch (err) {
          // localStorage copy is gone/corrupt — fall back to the server's disk
          // snapshot, which is what actually survives a power cut.
          const rec = await api('/api/project/recover').catch(() => null);
          if (rec?.project?.sources?.length) {
            applyProject(rec.project, rec.state);
            const when = String(rec.saved_at || '').slice(0, 16).replace('T', ' ');
            setStatus(`已从磁盘自动恢复上次校正进度${when ? '（' + when + '）' : ''}`);
          } else {
            setStatus('上次工程无法恢复（视频文件可能已移动）：' + err.message + ' · 点「打开媒体」开始');
          }
        }
      } else {
        // No browser copy, but the server may still hold a disk snapshot that
        // outlived a restart or a cleared cache.
        const rec = await api('/api/project/recover').catch(() => null);
        if (rec?.project?.sources?.length) {
          applyProject(rec.project, rec.state);
          const when = String(rec.saved_at || '').slice(0, 16).replace('T', ' ');
          setStatus(`已从磁盘自动恢复上次校正进度${when ? '（' + when + '）' : ''}`);
        } else {
          setStatus('就绪 · 点击「打开媒体」开始');
        }
      }
    }
  } catch (e) { setStatus('初始化失败: ' + e.message); }
}

init();
