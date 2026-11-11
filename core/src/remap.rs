//! Timeline mapping: the SINGLE source of truth for preview and export.
//!
//! ```text
//! in  = resolved start boundary (lossless: snapped to a keyframe up front)
//! out = resolved end boundary
//! cue' = offset + (clamp(cue, in, out) - in)
//! offset += out - in
//! ```
//!
//! Video cutting and subtitle remapping read the very same `[in, out]`. No
//! ffprobe readback, no compensation, no persisted "real" values.

use std::collections::HashMap;

use crate::model::{Boundary, Clip, Cue, Edge, Project, SubTrack};
use crate::srt::{to_vtt, write_srt};

#[derive(Debug)]
pub struct RemapError(pub String);

impl std::fmt::Display for RemapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for RemapError {}

pub fn resolve_boundary(project: &Project, clip: &Clip, boundary: &Boundary, is_start: bool) -> Result<i64, RemapError> {
    let base = if boundary.kind == crate::model::BoundaryKind::Time {
        boundary.ms as i64
    } else {
        let ref_ = boundary
            .cue_ref
            .as_ref()
            .ok_or_else(|| RemapError(format!("clip {}: cue boundary has no cue_ref", clip.id)))?;
        let track = project
            .track(&ref_.track_id)
            .ok_or_else(|| RemapError(format!("clip {}: unknown track {}", clip.id, ref_.track_id)))?;
        if ref_.cue_index < 0 || ref_.cue_index as usize >= track.cues.len() {
            return Err(RemapError(format!(
                "clip {}: cue index out of range: {}",
                clip.id, ref_.cue_index
            )));
        }
        let cue = &track.cues[ref_.cue_index as usize];
        if ref_.edge == Edge::Start {
            cue.start_ms
        } else {
            cue.end_ms
        }
    };
    let pad = boundary.padding_ms as i64;
    let ms = if is_start { base - pad } else { base + pad };
    let src = project
        .source(&clip.source_id)
        .ok_or_else(|| RemapError(format!("clip {}: unknown source {}", clip.id, clip.source_id)))?;
    let upper = if src.duration_ms > 0 {
        src.duration_ms
    } else {
        1 << 62
    };
    Ok(ms.max(0).min(upper))
}

pub fn tracks_for_clip<'a>(project: &'a Project, clip: &Clip) -> Vec<&'a SubTrack> {
    let ids: Vec<&str> = if !clip.track_ids.is_empty() {
        clip.track_ids.iter().map(|s| s.as_str()).collect()
    } else {
        project
            .tracks
            .iter()
            .filter(|t| t.source_id == clip.source_id && t.enabled)
            .map(|t| t.id.as_str())
            .collect()
    };
    ids.iter().filter_map(|id| project.track(id)).collect()
}

/// ONE coordinate system: `[in_ms, out_ms]` on the source timeline.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    pub clip_id: String,
    pub source_id: String,
    pub in_ms: i64,
    pub out_ms: i64,
    pub duration_ms: i64,
    pub offset_ms: i64,
    pub requested_in_ms: i64,
    pub track_ids: Vec<String>,
    pub label: String,
}

impl Segment {
    /// How far the (lossless) cut was pushed back to the previous keyframe.
    pub fn keyframe_shift_ms(&self) -> i64 {
        self.in_ms - self.requested_in_ms
    }
}

pub fn build_segments(project: &Project) -> Result<Vec<Segment>, RemapError> {
    let mut offset: i64 = 0;
    let mut segments: Vec<Segment> = Vec::new();
    for clip in &project.clips {
        let requested_in = resolve_boundary(project, clip, &clip.start, true)?;
        let mut in_ms = requested_in;
        let mut out_ms = resolve_boundary(project, clip, &clip.end, false)?;

        if project.output.mode == crate::model::ExportMode::Lossless {
            // Stream copy can only begin on a keyframe. Snap ONCE, up front, and
            // make the snapped value the single truth shared by video + subtitles.
            let source = project
                .source(&clip.source_id)
                .ok_or_else(|| RemapError(format!("clip {}: unknown source", clip.id)))?;
            let snapped = source
                .keyframes_ms
                .iter()
                .copied()
                .filter(|k| *k <= requested_in)
                .max()
                .unwrap_or(requested_in);
            in_ms = snapped;
            // Re-resolve the end against the (possibly adjusted) source window.
            out_ms = resolve_boundary(project, clip, &clip.end, false)?;
        }

        if out_ms <= in_ms {
            return Err(RemapError(format!(
                "clip {}: empty range {}..{}",
                clip.id, in_ms, out_ms
            )));
        }
        let duration = out_ms - in_ms;
        segments.push(Segment {
            clip_id: clip.id.clone(),
            source_id: clip.source_id.clone(),
            in_ms,
            out_ms,
            duration_ms: duration,
            offset_ms: offset,
            requested_in_ms: requested_in,
            track_ids: tracks_for_clip(project, clip)
                .iter()
                .map(|t| t.id.clone())
                .collect(),
            label: clip.label.clone(),
        });
        offset += duration;
    }
    Ok(segments)
}

/// Map every cue onto the output timeline, grouped by output subtitle group.
pub fn remap_cues(project: &Project, segments: &[Segment]) -> HashMap<String, Vec<Cue>> {
    let clip_by_id: HashMap<&str, &Clip> = project.clips.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut groups: HashMap<String, Vec<Cue>> = HashMap::new();

    for seg in segments {
        let clip = match clip_by_id.get(seg.clip_id.as_str()) {
            Some(c) => *c,
            None => continue,
        };
        for track in tracks_for_clip(project, clip) {
            for cue in &track.cues {
                let s = cue.start_ms.max(seg.in_ms);
                let e = cue.end_ms.min(seg.out_ms);
                if e <= s {
                    continue;
                }
                let bucket = groups.entry(track.effective_group().to_string()).or_default();
                bucket.push(Cue {
                    start_ms: seg.offset_ms + (s - seg.in_ms),
                    end_ms: seg.offset_ms + (e - seg.in_ms),
                    lines: cue.lines.clone(),
                    index: 0,
                });
            }
        }
    }

    for cues in groups.values_mut() {
        cues.sort_by_key(|c| (c.start_ms, c.end_ms));
        for (i, cue) in cues.iter_mut().enumerate() {
            cue.index = (i + 1) as i64;
        }
    }
    groups
}

/// Turn a dragged time edge into a cue reference when close enough.
pub fn snap_to_cue(
    project: &Project,
    source_id: &str,
    ms: i64,
    tolerance_ms: i64,
) -> Option<Boundary> {
    let mut best: Option<(i64, Boundary)> = None;
    for track in &project.tracks {
        if track.source_id != source_id || !track.enabled {
            continue;
        }
        for (i, cue) in track.cues.iter().enumerate() {
            for edge in [Edge::Start, Edge::End] {
                let value = if edge == Edge::Start {
                    cue.start_ms
                } else {
                    cue.end_ms
                };
                let distance = (value - ms).abs();
                if distance <= tolerance_ms
                    && (best.is_none() || distance < best.as_ref().unwrap().0)
                {
                    best = Some((
                        distance,
                        Boundary::at_cue(&track.id, i as i64, edge, 0),
                    ));
                }
            }
        }
    }
    best.map(|(_, b)| b)
}

/// Build clips from selected subtitle lines (the "subtitle as time point" mode).
#[allow(clippy::too_many_arguments)]
pub fn clips_from_cue_selection(
    project: &Project,
    source_id: &str,
    indices: &[i64],
    track_id: Option<&str>,
    padding_start_ms: i64,
    padding_end_ms: i64,
    merge_gap_ms: i64,
    id_prefix: &str,
) -> Result<Vec<Clip>, RemapError> {
    if indices.is_empty() {
        return Ok(Vec::new());
    }
    let track = match track_id {
        Some(id) => project.track(id),
        None => project
            .tracks
            .iter()
            .find(|t| t.source_id == source_id && t.enabled),
    };
    let track = track.ok_or_else(|| RemapError(format!("no subtitle track for source {source_id}")))?;
    let mut ordered: Vec<i64> = indices.iter().copied().collect();
    ordered.sort();
    ordered.dedup();
    for &i in &ordered {
        if i < 0 || i as usize >= track.cues.len() {
            return Err(RemapError(format!("cue index out of range: {i}")));
        }
    }

    let mut runs: Vec<Vec<i64>> = Vec::new();
    let mut current = vec![ordered[0]];
    for &i in &ordered[1..] {
        let prev_end = track.cues[current[current.len() - 1] as usize].end_ms;
        let gap = track.cues[i as usize].start_ms - prev_end;
        let should_merge = if merge_gap_ms > 0 {
            gap <= merge_gap_ms
        } else {
            i == current[current.len() - 1] + 1
        };
        if should_merge {
            current.push(i);
        } else {
            runs.push(std::mem::take(&mut current));
            current = vec![i];
        }
    }
    runs.push(current);

    let mut clips: Vec<Clip> = Vec::new();
    for (n, run) in runs.iter().enumerate() {
        clips.push(Clip {
            id: format!("{}_{}", id_prefix, n + 1),
            source_id: source_id.to_string(),
            start: Boundary::at_cue(&track.id, run[0], Edge::Start, padding_start_ms),
            end: Boundary::at_cue(&track.id, run[run.len() - 1], Edge::End, padding_end_ms),
            track_ids: vec![track.id.clone()],
            label: format!("字幕 {}-{}", run[0] + 1, run[run.len() - 1] + 1),
        });
    }
    Ok(clips)
}

/// Everything the UI needs, computed from one pass over the same core logic.
#[derive(serde::Serialize)]
pub struct PreviewState {
    pub segments: Vec<Segment>,
    pub total_ms: i64,
    pub groups: HashMap<String, Vec<Cue>>,
    pub srt: HashMap<String, String>,
    pub vtt: HashMap<String, String>,
    pub estimated_lossless_bytes: Option<i64>,
}

pub fn preview_state(project: &Project) -> Result<PreviewState, RemapError> {
    let segments = build_segments(project)?;
    let groups = remap_cues(project, &segments);
    let mut estimated: f64 = 0.0;
    let mut have_bitrate = false;
    for seg in &segments {
        if let Some(source) = project.source(&seg.source_id) {
            let bps = source.bitrate_bps;
            if bps > 0 {
                have_bitrate = true;
                estimated += bps as f64 * seg.duration_ms as f64 / 1000.0 / 8.0;
            }
        }
    }
    let srt: HashMap<String, String> = groups
        .iter()
        .map(|(g, cs)| (g.clone(), write_srt(cs)))
        .collect();
    let vtt: HashMap<String, String> = groups
        .iter()
        .map(|(g, cs)| (g.clone(), to_vtt(cs)))
        .collect();
    Ok(PreviewState {
        segments,
        total_ms: groups.values().map(|c| c.last().map(|x| x.end_ms).unwrap_or(0)).sum(),
        groups,
        srt,
        vtt,
        estimated_lossless_bytes: if have_bitrate {
            Some(estimated as i64)
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Boundary, Clip, Cue, EncodeCfg, OutputCfg, Project, Source, SubTrack};

    fn sample_project() -> Project {
        let mut p = Project::default();
        p.sources.push(Source {
            id: "s1".into(),
            path: "x.mp4".into(),
            duration_ms: 10_000,
            fps: 30.0,
            bitrate_bps: 8_000_000,
            keyframes_ms: vec![0, 5000],
        });
        p.tracks.push(SubTrack {
            id: "tr1".into(),
            source_id: "s1".into(),
            group_id: "zh".into(),
            cues: vec![
                Cue { start_ms: 1000, end_ms: 2000, lines: vec!["a".into()], index: 1 },
                Cue { start_ms: 3000, end_ms: 4000, lines: vec!["b".into()], index: 2 },
                Cue { start_ms: 6000, end_ms: 7000, lines: vec!["c".into()], index: 3 },
            ],
            enabled: true,
            ..Default::default()
        });
        p.clips.push(Clip {
            id: "c1".into(),
            source_id: "s1".into(),
            start: Boundary::at_time(1000, 0),
            end: Boundary::at_time(4000, 0),
            track_ids: vec!["tr1".into()],
            label: "clip1".into(),
        });
        p.clips.push(Clip {
            id: "c2".into(),
            source_id: "s1".into(),
            start: Boundary::at_time(6000, 0),
            end: Boundary::at_time(7000, 0),
            track_ids: vec!["tr1".into()],
            label: "clip2".into(),
        });
        p
    }

    #[test]
    fn builds_segments_and_remaps() {
        let p = sample_project();
        let segs = build_segments(&p).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].in_ms, 1000);
        assert_eq!(segs[0].out_ms, 4000);
        assert_eq!(segs[1].offset_ms, 3000);
        let st = preview_state(&p).unwrap();
        // clip1 (1000..4000): cue a 1000-2000 -> 0..1000, cue b 3000-4000 -> 2000..3000
        // clip2 (6000..7000, offset 3000): cue c 6000-7000 -> 3000..4000
        let zh = &st.groups["zh"];
        assert_eq!(zh.len(), 3);
        assert_eq!(zh[0].start_ms, 0);
        assert_eq!(zh[1].start_ms, 2000);
        assert_eq!(zh[2].start_ms, 3000);
    }

    #[test]
    fn lossless_snaps_to_keyframe() {
        let mut p = sample_project();
        p.output.mode = crate::model::ExportMode::Lossless;
        // clip1 in=1000 -> snaps DOWN to previous keyframe 0
        let segs = build_segments(&p).unwrap();
        assert_eq!(segs[0].in_ms, 0);
        assert_eq!(segs[0].keyframe_shift_ms(), 0 - 1000);
    }

    #[test]
    fn clips_from_cue_selection_merges_consecutive() {
        let p = sample_project();
        let clips = clips_from_cue_selection(
            &p, "s1", &[0, 1], Some("tr1"), 0, 0, 0, "cue_clip",
        )
        .unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].start.cue_ref.as_ref().unwrap().cue_index, 0);
        assert_eq!(clips[0].end.cue_ref.as_ref().unwrap().cue_index, 1);
    }
}
