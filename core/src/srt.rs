//! SRT / WebVTT parsing and serialization.
//!
//! Pure text functions only. Milliseconds are the canonical internal unit.

use std::fs;
use std::sync::OnceLock;

use crate::model::Cue;

/// Regex-free tolerant SRT timestamp scanner. Matches:
/// `HH:MM:SS,mmm --> HH:MM:SS,mmm` (comma or dot as fraction separator).
fn parse_ts(token: &str) -> Option<i64> {
    // token like 00:00:01,234 or 01:02:03.456
    let parts: Vec<&str> = token.split([':', ',', '.']).collect();
    if parts.len() < 4 {
        return None;
    }
    let h: i64 = parts[0].parse().ok()?;
    let m: i64 = parts[1].parse().ok()?;
    let s: i64 = parts[2].parse().ok()?;
    // fraction may be 1..3 digits
    let frac_raw = parts[3];
    let frac: i64 = if frac_raw.is_empty() {
        0
    } else {
        let padded = format!("{:0<3}", &frac_raw[..frac_raw.len().min(3)]);
        padded.parse().ok()?
    };
    Some(((h * 60 + m) * 60 + s) * 1000 + frac)
}

fn is_timestamp_line(line: &str) -> Option<(i64, i64)> {
    // find the arrow
    let arrow = line.find("-->")?;
    let left = line[..arrow].trim();
    let right = line[arrow + 3..].trim();
    // right may have trailing metadata (positioning); take first token
    let right_ts = right.split_whitespace().next().unwrap_or(right);
    let start = parse_ts(left)?;
    let end = parse_ts(right_ts)?;
    Some((start, end))
}

fn is_index_line(line: &str) -> bool {
    let t = line.trim();
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())
}

pub fn ms_to_ts(ms: i64, sep: &str) -> String {
    let ms = ms.max(0) as u64;
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let f = ms % 1000;
    format!("{:02}:{:02}:{:02}{}{:03}", h, m, s, sep, f)
}

/// Tolerant SRT reader: BOM, CRLF, missing indices and extra blank lines.
pub fn parse_srt(text: &str) -> Vec<Cue> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    let mut cues: Vec<Cue> = Vec::new();
    let mut current: Option<Cue> = None;
    let mut _pending_index: i64 = 0;

    for raw in text.split('\n') {
        let line = raw.trim_end();
        if let Some((start, end)) = is_timestamp_line(line) {
            if let Some(c) = current.take() {
                cues.push(c);
            }
            current = Some(Cue {
                start_ms: start,
                end_ms: end,
                lines: Vec::new(),
                index: (cues.len() + 1) as i64,
            });
            continue;
        }
        if is_index_line(line) {
            match &mut current {
                None => {
                    _pending_index = line.trim().parse().unwrap_or(0);
                }
                Some(c) if c.lines.is_empty() => {
                    // index line belonging to the next cue; ignore here
                }
                Some(c) => {
                    c.lines.push(line.to_string());
                }
            }
            continue;
        }
        if current.is_none() {
            continue;
        }
        if line.trim().is_empty() {
            let mut c = current.take().unwrap();
            while c.lines.last().map_or(false, |l| l.trim().is_empty()) {
                c.lines.pop();
            }
            cues.push(c);
        } else if let Some(c) = current.as_mut() {
            c.lines.push(line.to_string());
        }
    }
    if let Some(mut c) = current.take() {
        while c.lines.last().map_or(false, |l| l.trim().is_empty()) {
            c.lines.pop();
        }
        cues.push(c);
    }

    for (i, c) in cues.iter_mut().enumerate() {
        c.index = (i + 1) as i64;
    }
    cues
}

pub fn write_srt(cues: &[Cue]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(cues.len());
    for (i, c) in cues.iter().enumerate() {
        let body = if c.lines.is_empty() {
            String::new()
        } else {
            c.lines.join("\n")
        };
        parts.push(format!(
            "{}\n{} --> {}\n{}",
            i + 1,
            ms_to_ts(c.start_ms, ","),
            ms_to_ts(c.end_ms, ","),
            body
        ));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("{}\n", parts.join("\n\n"))
    }
}

/// Browser preview format. Cues are already in output-timeline coordinates.
pub fn to_vtt(cues: &[Cue]) -> String {
    let mut parts: Vec<String> = vec!["WEBVTT".to_string(), String::new()];
    for c in cues {
        parts.push(format!(
            "{} --> {}",
            ms_to_ts(c.start_ms, "."),
            ms_to_ts(c.end_ms, ".")
        ));
        if c.lines.is_empty() {
            parts.push(String::new());
        } else {
            parts.extend(c.lines.iter().cloned());
        }
        parts.push(String::new());
    }
    format!("{}\n", parts.join("\n"))
}

/// Decode bytes trying the encodings that actually show up in the wild.
fn decode_bytes(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    static DEC: OnceLock<Vec<&'static encoding_rs::Encoding>> = OnceLock::new();
    let decoders = DEC.get_or_init(|| {
        vec![
            encoding_rs::GB18030,
            encoding_rs::BIG5,
            encoding_rs::EUC_KR,
            encoding_rs::WINDOWS_1252,
        ]
    });
    for enc in decoders {
        let (cow, had_errors) = enc.decode_without_bom_handling(bytes);
        if !had_errors {
            return cow.into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Read a subtitle file trying several encodings.
pub fn read_srt_file(path: &str) -> std::io::Result<Vec<Cue>> {
    let raw = fs::read(path)?;
    Ok(parse_srt(&decode_bytes(&raw)))
}

/// Subtitles on the unchanged timeline, for "correct only, no cutting".
pub struct WholeSubtitle {
    pub srt: String,
    pub vtt: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_srt() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\n世界\n";
        let cues = parse_srt(srt);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_ms, 1000);
        assert_eq!(cues[0].end_ms, 2500);
        assert_eq!(cues[0].lines, vec!["你好".to_string()]);
        assert_eq!(cues[1].end_ms, 4000);
    }

    #[test]
    fn write_and_reparse_roundtrip() {
        let cues = vec![
            Cue {
                start_ms: 0,
                end_ms: 1500,
                lines: vec!["a".into()],
                index: 1,
            },
            Cue {
                start_ms: 2000,
                end_ms: 3000,
                lines: vec!["b".into(), "c".into()],
                index: 2,
            },
        ];
        let text = write_srt(&cues);
        let reparsed = parse_srt(&text);
        assert_eq!(reparsed.len(), 2);
        assert_eq!(reparsed[1].lines, vec!["b".to_string(), "c".to_string()]);
    }

    #[test]
    fn vtt_has_header() {
        let cues = vec![Cue {
            start_ms: 1000,
            end_ms: 2000,
            lines: vec!["x".into()],
            index: 1,
        }];
        let vtt = to_vtt(&cues);
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:02.000"));
    }

    #[test]
    fn dot_fraction_parsed() {
        let srt = "1\n00:00:01.234 --> 00:00:02.000\nhi\n";
        let cues = parse_srt(srt);
        assert_eq!(cues[0].start_ms, 1234);
    }
}
