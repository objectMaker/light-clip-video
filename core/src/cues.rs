//! Subtitle timing correction: pure, framework-independent functions.
//!
//! The source `.srt` is READ ONLY. Corrections live on the copy of cues
//! embedded in `Project.tracks`; remap and preview already read that copy, so a
//! correction takes effect immediately with no "apply" step. An export is only
//! needed to obtain a standalone file for use elsewhere.
//!
//! All functions here return NEW cue lists; nothing mutates its arguments.

use std::collections::{HashMap, HashSet};

use crate::model::{Cue, CueEdit, Project};
use crate::srt::{to_vtt, write_srt};

pub const MIN_CUE_MS: i64 = 20;
pub const STEP_OPTIONS: [i64; 5] = [50, 100, 200, 500, 1000];
pub const EDIT_LOG_LIMIT: usize = 5000;

fn clamp(v: i64, lo: i64, hi: Option<i64>) -> i64 {
    match hi {
        None => v.max(lo),
        Some(h) => v.max(lo).min(h.max(lo)),
    }
}

/// Return `(new_start, new_end, ACTUALLY applied delta)`.
///
/// `both` keeps the duration fixed; `start`/`end` change only one edge and
/// therefore change the duration. Values are clamped to `[lower, upper]` with at
/// least [`MIN_CUE_MS`] left between the two edges.
pub fn shift_one(
    start_ms: i64,
    end_ms: i64,
    delta_ms: i64,
    edge: &str,
    lower: i64,
    upper: Option<i64>,
) -> (i64, i64, i64) {
    let delta = delta_ms as i64;
    match edge {
        "start" => {
            let ns = clamp(start_ms + delta, lower, Some(end_ms - MIN_CUE_MS));
            (ns, end_ms, ns - start_ms)
        }
        "end" => {
            let hi = upper.unwrap_or(1 << 62);
            let ne = clamp(end_ms + delta, start_ms + MIN_CUE_MS, Some(hi));
            (start_ms, ne, ne - end_ms)
        }
        _ => {
            let duration = (end_ms - start_ms).max(MIN_CUE_MS);
            let hi = upper.map(|u| u - duration).unwrap_or(1 << 62);
            let ns = clamp(start_ms + delta, lower, Some(hi));
            (ns, ns + duration, ns - start_ms)
        }
    }
}

/// One UNIFORM delta for a whole track. Clamping each cue separately would
/// stretch the track; instead find the largest single delta every cue can take,
/// so a global shift really is a translation of the entire timeline.
pub fn global_delta(cues: &[Cue], delta_ms: i64, upper: Option<i64>) -> i64 {
    let mut d = delta_ms as i64;
    for c in cues {
        if d > 0 {
            if let Some(u) = upper {
                d = d.min((u - c.end_ms).max(0));
            }
        } else if d < 0 {
            d = d.max(-c.start_ms);
        }
        if d == 0 {
            break;
        }
    }
    d
}

fn make_record(
    track_id: &str,
    i: i64,
    kind: &str,
    delta: i64,
    before: (i64, i64),
    after: (i64, i64),
    at: &str,
) -> CueEdit {
    CueEdit {
        track_id: track_id.to_string(),
        cue_index: i,
        kind: kind.to_string(),
        delta_ms: delta,
        before_start_ms: before.0,
        before_end_ms: before.1,
        after_start_ms: after.0,
        after_end_ms: after.1,
        at: at.to_string(),
    }
}

/// Apply a shift to selected cues. Returns `(new_cues, edit_records,
/// clamped_count, applied_delta)`. `uniform = true` is for whole-track moves.
#[allow(clippy::too_many_arguments)]
pub fn shift_cues(
    cues: &[Cue],
    indices: &[i64],
    delta_ms: i64,
    track_id: &str,
    edge: &str,
    lower: i64,
    upper: Option<i64>,
    kind: &str,
    at: &str,
    uniform: bool,
) -> (Vec<Cue>, Vec<CueEdit>, i64, i64) {
    let mut new: Vec<Cue> = cues
        .iter()
        .map(|c| Cue {
            start_ms: c.start_ms,
            end_ms: c.end_ms,
            lines: c.lines.clone(),
            index: c.index,
        })
        .collect();
    let d = if uniform {
        global_delta(cues, delta_ms, upper)
    } else {
        delta_ms as i64
    };
    let mut records: Vec<CueEdit> = Vec::new();
    let mut clamped: i64 = 0;
    for &i in indices {
        if i < 0 || i >= new.len() as i64 {
            continue;
        }
        let idx = i as usize;
        let c = &mut new[idx];
        let before = (c.start_ms, c.end_ms);
        let (ns, ne, applied) = shift_one(c.start_ms, c.end_ms, d, edge, lower, upper);
        if applied != d {
            clamped += 1;
        }
        c.start_ms = ns;
        c.end_ms = ne;
        records.push(make_record(track_id, i, kind, applied, before, (ns, ne), at));
    }
    (new, records, clamped, d)
}

/// Exact times, used by the draggable mini timeline and the text inputs.
#[allow(clippy::too_many_arguments)]
pub fn set_cue_times(
    cues: &[Cue],
    index: i64,
    start_ms: i64,
    end_ms: i64,
    track_id: &str,
    lower: i64,
    upper: Option<i64>,
    at: &str,
) -> (Vec<Cue>, Vec<CueEdit>, i64, i64) {
    let mut new: Vec<Cue> = cues
        .iter()
        .map(|c| Cue {
            start_ms: c.start_ms,
            end_ms: c.end_ms,
            lines: c.lines.clone(),
            index: c.index,
        })
        .collect();
    if index < 0 || index >= new.len() as i64 {
        return (new, Vec::new(), 0, 0);
    }
    let idx = index as usize;
    let c = &mut new[idx];
    let before = (c.start_ms, c.end_ms);
    let ns = clamp(start_ms as i64, lower, upper.map(|u| u - MIN_CUE_MS));
    let hi = upper.unwrap_or(1 << 62);
    let ne = clamp(end_ms as i64, ns + MIN_CUE_MS, Some(hi));
    c.start_ms = ns;
    c.end_ms = ne;
    let rec = make_record(track_id, index, "set", ns - before.0, before, (ns, ne), at);
    (new, vec![rec], 0, ns - before.0)
}

/// How many neighbouring pairs overlap in time. Reported, never auto-fixed.
pub fn detect_overlaps(cues: &[Cue]) -> i64 {
    let mut ordered: Vec<&Cue> = cues.iter().collect();
    ordered.sort_by_key(|c| (c.start_ms, c.end_ms));
    let mut count = 0;
    for pair in ordered.windows(2) {
        if pair[1].start_ms < pair[0].end_ms {
            count += 1;
        }
    }
    count
}

pub fn corrected_cue_indices(edits: &[CueEdit], track_id: &str) -> HashSet<i64> {
    edits
        .iter()
        .filter(|e| e.track_id == track_id && e.kind != "reload")
        .map(|e| e.cue_index)
        .collect()
}

/// Subtitles on the UNCHANGED timeline, for "correct only, no cutting".
pub fn whole_subtitle_text(project: &Project) -> HashMap<String, crate::srt::WholeSubtitle> {
    let mut groups: HashMap<String, Vec<Cue>> = HashMap::new();
    for track in &project.tracks {
        if !track.enabled {
            continue;
        }
        let bucket = groups.entry(track.effective_group().to_string()).or_default();
        for c in &track.cues {
            bucket.push(Cue {
                start_ms: c.start_ms,
                end_ms: c.end_ms,
                lines: c.lines.clone(),
                index: 0,
            });
        }
    }
    let mut out: HashMap<String, crate::srt::WholeSubtitle> = HashMap::new();
    for (g, mut cues) in groups {
        cues.sort_by_key(|c| (c.start_ms, c.end_ms));
        for (i, cue) in cues.iter_mut().enumerate() {
            cue.index = (i + 1) as i64;
        }
        out.insert(
            g,
            crate::srt::WholeSubtitle {
                srt: write_srt(&cues),
                vtt: to_vtt(&cues),
            },
        );
    }
    out
}

pub fn append_edits(
    project: &mut Project,
    records: &[CueEdit],
    kind: &str,
    track_id: &str,
    at: &str,
) {
    let mut records: Vec<CueEdit> = records.to_vec();
    if kind == "reload" {
        records = vec![CueEdit {
            track_id: track_id.to_string(),
            cue_index: -1,
            kind: "reload".to_string(),
            delta_ms: 0,
            before_start_ms: 0,
            before_end_ms: 0,
            after_start_ms: 0,
            after_end_ms: 0,
            at: at.to_string(),
        }];
    }
    project.cue_edits.extend(records);
    if project.cue_edits.len() > EDIT_LOG_LIMIT {
        let excess = project.cue_edits.len() - EDIT_LOG_LIMIT;
        project.cue_edits.drain(0..excess);
    }
}

/// Human-readable proofreading progress for the workbench status line.
#[derive(serde::Serialize)]
pub struct EditSummary {
    pub edit_count: i64,
    pub track_edit_count: i64,
    pub corrected_indices: Vec<i64>,
    pub global_applied_ms: i64,
    pub overlaps: i64,
}

pub fn edit_summary(project: &Project, track_id: &str) -> EditSummary {
    let edits: Vec<&CueEdit> = project
        .cue_edits
        .iter()
        .filter(|e| e.kind != "reload")
        .collect();
    let mine: Vec<&CueEdit> = edits.iter().copied().filter(|e| e.track_id == track_id).collect();
    let global_applied: i64 = mine
        .iter()
        .filter(|e| e.kind == "global")
        .map(|e| e.delta_ms)
        .sum();
    let corrected: Vec<i64> = {
        let mut v: Vec<i64> = corrected_cue_indices(&project.cue_edits, track_id)
            .into_iter()
            .collect();
        v.sort();
        v
    };
    let track = project.track(track_id);
    EditSummary {
        edit_count: edits.len() as i64,
        track_edit_count: mine.len() as i64,
        corrected_indices: corrected,
        global_applied_ms: global_applied,
        overlaps: track.map(|t| detect_overlaps(&t.cues)).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SubTrack;

    fn cue(s: i64, e: i64) -> Cue {
        Cue {
            start_ms: s,
            end_ms: e,
            lines: vec![],
            index: 0,
        }
    }

    #[test]
    fn shift_one_both_keeps_duration() {
        // shifting "both" keeps duration; clamp to [0, None]
        let (ns, ne, ap) = shift_one(1000, 2000, 500, "both", 0, None);
        assert_eq!((ns, ne), (1500, 2500));
        assert_eq!(ap, 500);
    }

    #[test]
    fn shift_one_lower_clamp() {
        let (ns, ne, _ap) = shift_one(1000, 2000, -5000, "both", 0, None);
        assert_eq!((ns, ne), (0, 1000));
    }

    #[test]
    fn shift_one_end_edge() {
        let (ns, ne, _ap) = shift_one(1000, 2000, 300, "end", 0, None);
        assert_eq!((ns, ne), (1000, 2300));
    }

    #[test]
    fn global_delta_clamps_to_uppermost() {
        let cues = vec![cue(0, 1000), cue(500, 1200)];
        // delta +100 but second cue ends at 1200, upper 1250 -> max +50
        assert_eq!(global_delta(&cues, 100, Some(1250)), 50);
        // negative: first starts at 0 -> max -0
        assert_eq!(global_delta(&cues, -100, None), 0);
    }

    #[test]
    fn shift_cues_reports_clamp() {
        let cues = vec![cue(0, 1000), cue(2000, 3000)];
        let (new, recs, clamped, applied) =
            shift_cues(&cues, &[0, 1], -500, "t", "both", 0, None, "shift", "", false);
        // cue 0 clamped to 0 (cannot go negative), cue 1 moves to 1500..2500
        assert_eq!(clamped, 1);
        assert_eq!(new[1].start_ms, 1500);
        assert_eq!(applied, -500);
        assert_eq!(recs.len(), 2);
    }

    #[test]
    fn set_cue_times_exact() {
        let cues = vec![cue(1000, 2000)];
        let (new, recs, _, _) = set_cue_times(&cues, 0, 1500, 2500, "t", 0, None, "");
        assert_eq!((new[0].start_ms, new[0].end_ms), (1500, 2500));
        assert_eq!(recs.len(), 1);
    }

    #[test]
    fn detect_overlaps_counts() {
        let cues = vec![cue(0, 1000), cue(900, 2000), cue(2000, 3000)];
        assert_eq!(detect_overlaps(&cues), 1);
    }

    #[test]
    fn whole_subtitle_groups_by_group() {
        let mut p = Project::default();
        p.tracks.push(SubTrack {
            id: "tr1".into(),
            source_id: "s1".into(),
            group_id: "zh".into(),
            cues: vec![cue(0, 1000)],
            ..Default::default()
        });
        let w = whole_subtitle_text(&p);
        assert!(w.contains_key("zh"));
        assert!(w["zh"].srt.contains("00:00:00,000 --> 00:00:01,000"));
    }
}
