# HTTP API 参考

`clip-server` 在 `127.0.0.1:<随机端口>` 上提供以下接口，前端全部通过 `fetch` 调用。所有响应为 UTF-8 JSON；出错时返回 `{"error": "..."}`（HTTP 500，个别接口 400/403/404）。状态码见各接口。

> 调试：`cargo run -p clip-server --example serve -- 8765`，然后访问 `http://127.0.0.1:8765/`。
> 注意本机如果设置了 `HTTP(S)_PROXY`，用 `curl` 测本地端口要加 `--noproxy '*'`。

## 通用数据结构

**Project**

```json
{
  "name": "sample",
  "sources": [{"id":"s1","path":"D:/v/sample.mp4","duration_ms":3000,"fps":25.0,
               "bitrate_bps":121794,"keyframes_ms":[0]}],
  "tracks": [{"id":"t1","source_id":"s1","group_id":"zh","label":"中文","lang":"zh",
              "path":"D:/v/sample.srt","origin":"external","enabled":true,
              "cues":[{"start_ms":500,"end_ms":1500,"lines":["你好"],"index":1}]}],
  "clips": [{"id":"c1","source_id":"s1",
             "start":{"kind":"time","ms":500,"cue_ref":null,"padding_ms":0},
             "end":{"kind":"cue","ms":0,"padding_ms":0,
                    "cue_ref":{"track_id":"t1","cue_index":1,"edge":"end"}},
             "track_ids":["t1"],"label":"字幕 1-2"}],
  "output": {"mode":"precise","crf":18,"preset":"medium","match_source_bitrate":true,
             "embed_subtitles":false,"snap_to_cue":false,"snap_tolerance_ms":500,
             "profile_mode":"source","encode":{ /* EncodeCfg 19 项 */ }},
  "cue_edits": []
}
```

**state（预览结果）**

```json
{
  "segments": [{"clip_id":"c1","source_id":"s1","in_ms":500,"out_ms":2800,
                "duration_ms":2300,"offset_ms":0,"requested_in_ms":500,
                "track_ids":["t1"],"label":"字幕 1-2"}],
  "total_ms": 2300,
  "groups": {"zh":[{"start_ms":0,"end_ms":1000,"lines":["你好"],"index":1}]},
  "srt":    {"zh":"1\n00:00:00,000 --> 00:00:01,000\n你好\n"},
  "vtt":    {"zh":"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好\n"},
  "estimated_lossless_bytes": 45000
}
```

- `segments` 就是**唯一坐标系**：`in_ms/out_ms` 在源时间轴，`offset_ms` 是它在成片里的起点。
- `groups/srt/vtt` 是按**成片时间轴**重映射后的字幕（只在有片段时非空）。

## GET

| 路径 | 参数 | 返回 |
| --- | --- | --- |
| `/`、`/index.html` | — | 前端页面 |
| `/app.js`、`/style.css` | — | 静态资源 |
| `/api/project` | — | `{project, state}` |
| `/api/project/recover` | — | 磁盘快照 `{project, state, saved_at, file}`，没有则 `{project:null}` |
| `/api/browse` | `dir`,`kind`(`all`/`video`/`sub`/`dir`) | `{path, parent, entries:[{name,path,is_dir,size}]}`；`dir` 空时列盘符 |
| `/api/config` | — | `{ffmpeg, ffprobe, outdir, cwd}` |
| `/api/profiles` | — | `{profiles:[...], ...}`：三档方案目录（标签、人话摘要、原始命令） |
| `/api/export/default` | `dir`,`name`,`overwrite`(`1`/`true`) | 导出目标映射（见下） |
| `/api/encode-params` | `path` | `{video:{codec,supported,profile,level,pix_fmt,fps,fps_float,width,height,video_kbps,b_frames,color_*}, audio:{...}, format:{duration_ms,size_bytes,bitrate_kbps}}`；未登记媒体返回 403 |
| `/api/export/status` | `id` | `{status, percent, message, result, error}` |
| `/api/media` | `path` | 视频流（支持 `Range`，返回 200/206）；未登记返回 403 |
| `/api/thumb` | `path`,`t`(秒) | JPEG 缩略图 |
| `/api/waveform` | `path` | PNG 波形图 |

**导出目标映射**（`/api/export/default` 与 `/api/export` 共用 `paths::resolve_export_target`）：

```json
{
  "path": "D:/v/sample_剪辑/sample_剪辑.mp4",
  "dir": "D:/v/sample_剪辑",
  "filename": "sample_剪辑.mp4",
  "base_path": "D:/v/sample_剪辑/sample_剪辑.mp4",
  "renamed_from": null,
  "default_path": "D:/v/sample_剪辑/sample_剪辑.mp4",
  "default_dir": "D:/v/sample_剪辑",
  "default_name": "sample_剪辑",
  "source_dir": "D:/v",
  "overwrite": false
}
```

## POST

### `POST /api/open`
打开视频（可带字幕）。
```json
{ "videos": ["D:/v/sample.mp4"],
  "subtitles": [{"path":"D:/v/sample.srt","source_id":"s1","group_id":"zh","label":"中文","lang":"zh"}],
  "auto_subtitles": true }
```
- `videos` 与 `video` 二选一；`subtitles` 为空且 `auto_subtitles=true` 时，自动在视频同目录找 `片名.srt`/`.vtt` 及 `片名.语言.srt`。
- 返回 `{project, state}`。

### `POST /api/project`
用前端传来的完整工程覆盖服务端状态并写快照。
```json
{ "project": { ... } }   // 返回 {state}
```

### `POST /api/cues/shift`
字幕时间矫正的**唯一入口**。
```json
{ "action": "shift", "track_id": "t1", "scope": "cue",
  "indices": [0], "delta_ms": 300, "edge": "both" }
```
- `action`：`shift`（按 `delta_ms` 移动）| `set`（设精确时间，需 `index`、`start_ms`、`end_ms`）| `reload`（从源文件重载本轨）。
- `scope`：`cue`（单句/多选）| `track`（整轨）| `all_tracks`（同源所有轨）。
- `edge`：`both`（整体，不改时长）| `start` | `end`。
- 返回：
```json
{ "project": {...}, "state": {...}, "records": [...],
  "clamped": 0, "applied_delta_ms": 300,
  "summary": {"edit_count":1,"track_edit_count":1,"corrected_indices":[0],
              "global_applied_ms":0,"overlaps":0},
  "saved_at": "2026-11-10T15:00:00+00:00" }
```

### `POST /api/export-subtitles`
只导出字幕，不生成视频。
```json
{ "format": "srt", "output_dir": "", "output_name": "", "overwrite": false }
```
- 有片段时用 `preview_state()`（与视频同一坐标）重映射；无片段时按原时间轴导出。
- 返回 `{subtitles:{group:path}, dir, format, renamed_from, count, remapped, default_path}`。

### `POST /api/project/load`
载入工程（比 `/api/project` 更严格：源视频必须仍存在）。`{project}` → `{project, state}`。

### `POST /api/preview`
只算预览、不改状态。`{project}` → `{state}`。

### `POST /api/check-params`
设置页实时检查 / 导出前确认。
```json
{ "encode": { ... }, "total_ms": 2300, "mode": "precise",
  "match_source_bitrate": true, "profile_mode": "custom" }
```
返回 `EncodeEvaluation`：`{warnings:[{level,title,text}], estimated_bytes, source_equivalent_bytes, ratio, estimate_note, is_upper_bound}`。

### `POST /api/snap`
把拖拽时间吸附到字幕边界。`{source_id, ms, tolerance_ms}` → `{boundary: Boundary|null}`。

### `POST /api/clips/from-cues`
按勾选的字幕行生成片段。
```json
{ "source_id":"s1", "indices":[0,1], "track_id":"t1",
  "padding_start_ms":200, "padding_end_ms":300, "merge_gap_ms":0,
  "id_prefix":"cue", "replace": false }
```
返回 `{clips, project, state}`。

### `POST /api/export`
开始后台导出。
```json
{ "output_dir": "", "output_name": "", "overwrite": false }
```
返回 `{task_id, output_path, renamed_from}`；随后轮询 `GET /api/export/status?id=...` 直到 `status` 为 `done`/`error`。完成时 `result` 含 `{video, output_dir, subtitles, warnings, srt, vtt, segments, total_ms}`。

### `POST /api/reveal`
在文件管理器中定位/打开。`{path, dry_run}` → `{ok, opened}`。

### `POST /api/mkdir`
新建文件夹。`{parent, name}` → `{path}`。

## 前端与后端的约定

- 前端发来的 `project` 就是后端上次返回的 JSON，字段名一一对应（`start_ms`、`source_id` 等 snake_case）。
- `mode` / `edge` / `kind` 都是小写字符串：`precise`/`lossless`、`start`/`end`/`both`、`time`/`cue`。
- 任意 `project` 变化后，前端会 `POST /api/project` 同步；打开/矫正/生成片段这类接口则直接返回最新 `project + state`。
