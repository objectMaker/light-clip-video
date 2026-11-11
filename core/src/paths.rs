//! Default export naming and "never overwrite" numbering.
//!
//! The FIRST source video is the single naming source of truth:
//!
//! ```text
//! <source folder>/<stem>_剪辑/<stem>_剪辑.mp4
//! <source folder>/<stem>_剪辑/<stem>_剪辑.zh.srt
//! ```
//!
//! Every subtitle is derived from the SAME video base. Repeated exports never
//! overwrite: the batch is numbered as a unit (`<stem>_剪辑_2.mp4` + `..._2.zh.srt`).
//!
//! Pure logic only: no ffmpeg, no filesystem writes. The `exists` probe is
//! injectable so the numbering rule can be unit-tested without touching disk.

use std::path::{Path, PathBuf};

use crate::model::Project;
use crate::presets::resolve_profile;

pub const FOLDER_SUFFIX: &str = "_剪辑";
pub const MP4_LIKE: &[&str] = &[".mp4", ".m4v", ".mov"];
pub const KNOWN_EXT: &[&str] = &[".mp4", ".m4v", ".mov", ".mkv", ".webm", ".ts"];

fn is_bad(c: char) -> bool {
    matches!(
        c,
        '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
    ) || (c as u32) < 0x20
}

pub fn safe_stem(path: &str) -> String {
    let p = Path::new(path);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let cleaned: String = stem.chars().filter(|c| !is_bad(*c)).collect();
    let trimmed = cleaned.trim_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "video".to_string()
    } else {
        trimmed
    }
}

pub fn export_base_name(project: &Project) -> Result<String, String> {
    let src = project
        .sources
        .first()
        .ok_or_else(|| "工程里没有源视频，无法生成默认文件名".to_string())?;
    Ok(format!("{}{}", safe_stem(&src.path), FOLDER_SUFFIX))
}

pub fn default_export_dir(project: &Project) -> Result<String, String> {
    let src = project
        .sources
        .first()
        .ok_or_else(|| "工程里没有源视频，无法生成默认文件名".to_string())?;
    let folder = Path::new(&src.path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    Ok(folder.join(export_base_name(project)?).to_string_lossy().to_string())
}

pub fn source_paths(project: &Project) -> Vec<String> {
    project
        .sources
        .iter()
        .map(|s| {
            Path::new(&s.path)
                .canonicalize()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| s.path.clone())
        })
        .collect()
}

/// The container `plan.export_project` will FORCE; '' = keep the ext. Shared by
/// the default-name calculation and the ffmpeg command.
pub fn forced_container(project: &Project, paths: Option<&[String]>) -> String {
    let profile = resolve_profile(
        &project.output.profile_mode,
        &project.output.encode,
        &project.output.preset,
        project.output.embed_subtitles,
    );
    let cfg = &profile.encode;
    let container = if cfg.container == "mp4" || cfg.container == "mkv" {
        cfg.container.clone()
    } else {
        String::new()
    };
    if project.output.mode == crate::model::ExportMode::Lossless && container == "mp4" {
        let owned;
        let candidates: &[String] = match paths {
            Some(p) => p,
            None => {
                owned = source_paths(project);
                &owned
            }
        };
        if candidates
            .iter()
            .any(|p| !MP4_LIKE.contains(&Path::new(p).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str()))
        {
            return "mkv".to_string();
        }
    }
    container
}

fn default_extension(project: &Project, paths: Option<&[String]>) -> String {
    let forced = forced_container(project, paths);
    if !forced.is_empty() {
        return format!(".{forced}");
    }
    if project.output.mode == crate::model::ExportMode::Lossless {
        let owned;
        let candidates: &[String] = match paths {
            Some(p) => p,
            None => {
                owned = source_paths(project);
                &owned
            }
        };
        if candidates.iter().any(|p| {
            !MP4_LIKE.contains(
                &Path::new(p)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase()
                    .as_str(),
            )
        }) {
            return ".mkv".to_string();
        }
    }
    ".mp4".to_string()
}

pub fn default_export_path(project: &Project) -> Result<HashMap<String, String>, String> {
    let name = export_base_name(project)?;
    let folder = default_export_dir(project)?;
    let ext = default_extension(project, None);
    let src = &project.sources[0];
    let source_dir = Path::new(&src.path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    Ok(HashMap::from([
        (
            "path".into(),
            Path::new(&folder).join(format!("{name}{ext}")).to_string_lossy().to_string(),
        ),
        ("dir".into(), folder),
        ("name".into(), name.clone()),
        ("ext".into(), ext),
        ("source_dir".into(), source_dir),
    ]))
}

pub fn safe_group(group: &str) -> String {
    let cleaned: String = group
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "sub".to_string()
    } else {
        cleaned
    }
}

pub fn numbered_path(path: &str, n: i64) -> String {
    let p = Path::new(path);
    let parent = p.parent().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let joined = if parent.is_empty() {
        format!("{stem}_{n}{ext}")
    } else {
        format!("{parent}/{stem}_{n}{ext}")
    };
    joined
}

fn norm_path(p: &str) -> String {
    let abs = Path::new(p)
        .canonicalize()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string());
    abs.to_lowercase()
}

pub fn unique_batch_paths(
    paths: &[String],
    overwrite: bool,
    protected: &[String],
    exists: &dyn Fn(&str) -> bool,
    limit: i64,
) -> Result<(Vec<String>, Option<String>), String> {
    let batch: Vec<String> = paths.to_vec();
    if batch.is_empty() {
        return Ok((Vec::new(), None));
    }
    let blocked_set: std::collections::HashSet<String> =
        protected.iter().map(|p| norm_path(p)).collect();

    let blocked = |candidates: &[String]| -> bool {
        for p in candidates {
            if blocked_set.contains(&norm_path(p)) {
                return true;
            }
            if !overwrite && exists(p) {
                return true;
            }
        }
        false
    };

    if !blocked(&batch) {
        return Ok((batch, None));
    }
    let mut n = 2;
    while n <= limit + 1 {
        let candidates: Vec<String> = batch.iter().map(|p| numbered_path(p, n)).collect();
        if !blocked(&candidates) {
            return Ok((candidates, Some(batch[0].clone())));
        }
        n += 1;
    }
    Err("同名文件太多，无法生成新的导出编号，请手动换个文件名".to_string())
}

fn batch_paths(
    video_path: &str,
    groups: &[String],
    sub_fmt: &str,
    embed_subtitles: bool,
) -> Vec<String> {
    let p = Path::new(video_path);
    let base = p
        .with_extension("")
        .to_string_lossy()
        .to_string();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let _ = ext;
    let mut out = vec![video_path.to_string()];
    for g in groups {
        out.push(format!("{base}.{}.{}", safe_group(g), sub_fmt));
    }
    if embed_subtitles {
        let pext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        out.push(format!("{base}_sub{pext}"));
    }
    out
}

/// Return `(final video path, original path if it had to be renamed)`.
pub fn unique_export_path(
    video_path: &str,
    groups: &[String],
    source_videos: &[String],
    exists: &dyn Fn(&str) -> bool,
    limit: i64,
    sub_fmt: &str,
    embed_subtitles: bool,
    overwrite: bool,
) -> Result<(String, Option<String>), String> {
    let protected: std::collections::HashSet<String> =
        source_videos.iter().map(|p| norm_path(p)).collect();

    let is_source = |candidate: &str| protected.contains(&norm_path(candidate));
    let blocked = |candidate: &str| -> bool {
        if is_source(candidate) {
            return true;
        }
        if overwrite {
            return false;
        }
        batch_paths(candidate, groups, sub_fmt, embed_subtitles)
            .iter()
            .any(|p| exists(p.as_str()))
    };

    if !blocked(video_path) {
        return Ok((video_path.to_string(), None));
    }
    let mut n = 2;
    while n <= limit + 1 {
        let candidate = numbered_path(video_path, n);
        if !blocked(&candidate) {
            return Ok((candidate, Some(video_path.to_string())));
        }
        n += 1;
    }
    Err("同名文件太多，无法生成新的导出编号，请手动换个文件名".to_string())
}

fn is_dir_request(path: &str) -> bool {
    let p = Path::new(path);
    if p.is_dir() || path.ends_with('/') || path.ends_with('\\') {
        return true;
    }
    p.extension().is_none()
}

fn clean_name(name: &str, fallback: &str) -> (String, String) {
    let text = name.trim().trim_matches(['\\', '/']).to_string();
    if text.is_empty() {
        return (fallback.to_string(), String::new());
    }
    let (stem, ext) = {
        let p = Path::new(&text);
        let ext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        (stem, ext)
    };
    let explicit = if KNOWN_EXT.contains(&ext.as_str()) {
        ext.clone()
    } else {
        String::new()
    };
    let cleaned: String = stem.chars().filter(|c| !is_bad(*c)).collect();
    let trimmed = cleaned.trim_matches(['.', ' ']).to_string();
    (
        if trimmed.is_empty() {
            fallback.to_string()
        } else {
            trimmed
        },
        explicit,
    )
}

/// Single entry point for both the preview API and the real export.
pub fn resolve_export_target(
    project: &Project,
    output_path: &str,
    output_dir: &str,
    output_name: &str,
    overwrite: bool,
    groups: &[String],
    subtitle_format: &str,
    embed_subtitles: bool,
    exists: &dyn Fn(&str) -> bool,
) -> Result<HashMap<String, String>, String> {
    if project.sources.is_empty() {
        return Err("请先打开视频".to_string());
    }
    let default = default_export_path(project)?;
    let mut requested_dir = output_dir.trim().to_string();

    let mut explicit_file = String::new();
    let raw_path = output_path.trim().to_string();
    if !raw_path.is_empty() && requested_dir.is_empty() && output_name.trim().is_empty() {
        let absolute = Path::new(&raw_path)
            .canonicalize()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(raw_path.clone());
        if is_dir_request(&absolute) {
            requested_dir = absolute;
        } else {
            explicit_file = absolute;
        }
    }

    let (folder, stem, ext);
    if !explicit_file.is_empty() {
        let p = Path::new(&explicit_file);
        folder = p
            .parent()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let st = p
            .file_stem()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        let cleaned: String = st.chars().filter(|c| !is_bad(*c)).collect();
        stem = trimmed_or(cleaned, &default["name"]);
        let explicit_ext = p
            .extension()
            .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        ext = if explicit_ext.is_empty() {
            default["ext"].clone()
        } else {
            explicit_ext
        };
    } else {
        let requested_dir = if requested_dir.is_empty() {
            default["dir"].clone()
        } else {
            requested_dir
        };
        let (s, typed_ext) = clean_name(output_name, &default["name"]);
        folder = requested_dir;
        stem = s;
        ext = if typed_ext.is_empty() {
            default["ext"].clone()
        } else {
            typed_ext
        };
    }

    let forced = forced_container(project, None);
    let ext = if !forced.is_empty() {
        format!(".{forced}")
    } else {
        ext
    };

    let base_path = Path::new(&folder)
        .join(format!("{stem}{ext}"))
        .to_string_lossy()
        .to_string();
    let (final_path, renamed_from) = unique_export_path(
        &base_path,
        groups,
        &source_paths(project),
        exists,
        999,
        subtitle_format,
        embed_subtitles,
        overwrite,
    )?;
    Ok(HashMap::from([
        ("path".into(), final_path.clone()),
        (
            "dir".into(),
            Path::new(&final_path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
        (
            "filename".into(),
            Path::new(&final_path)
                .file_name()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
        ("base_path".into(), base_path),
        ("renamed_from".into(), renamed_from.unwrap_or_default()),
        ("default_path".into(), default["path"].clone()),
        ("default_dir".into(), default["dir"].clone()),
        ("default_name".into(), default["name"].clone()),
        ("source_dir".into(), default["source_dir"].clone()),
        ("overwrite".into(), overwrite.to_string()),
    ]))
}

fn trimmed_or(s: String, fallback: &str) -> String {
    let t = s.trim_matches(['.', ' ']).to_string();
    if t.is_empty() {
        fallback.to_string()
    } else {
        t
    }
}

use std::collections::HashMap;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{OutputCfg, Project, Source};

    fn proj() -> Project {
        let mut p = Project::default();
        p.sources.push(Source {
            id: "s1".into(),
            path: "D:/videos/我的视频.mp4".into(),
            ..Default::default()
        });
        p
    }

    #[test]
    fn safe_stem_strips_bad_chars() {
        assert_eq!(safe_stem("D:/a/b/我的视频.mp4"), "我的视频");
        assert_eq!(safe_stem("weird:name?.mp4"), "weirdname");
    }

    #[test]
    fn default_export_path_nesting() {
        let p = proj();
        let d = default_export_dir(&p).unwrap();
        assert!(d.replace('\\', "/").ends_with("videos/我的视频_剪辑"));
        let dp = default_export_path(&p).unwrap();
        assert!(dp["path"].ends_with("我的视频_剪辑.mp4"));
    }

    #[test]
    fn unique_export_path_renumbers() {
        let mut seen = std::collections::HashSet::new();
        seen.insert(norm_path("D:/videos/我的视频_剪辑.mp4"));
        let exists = |p: &str| seen.contains(&norm_path(p));
        let (final_p, renamed) = unique_export_path(
            "D:/videos/我的视频_剪辑.mp4",
            &[],
            &[],
            &exists,
            999,
            "srt",
            false,
            false,
        )
        .unwrap();
        assert_eq!(final_p, "D:/videos/我的视频_剪辑_2.mp4");
        assert!(renamed.is_some());
    }

    #[test]
    fn source_video_never_overwritten() {
        let mut seen = std::collections::HashSet::new();
        seen.insert(norm_path("D:/videos/我的视频.mp4"));
        let exists = |p: &str| seen.contains(&norm_path(p));
        // output target equals the SOURCE itself -> must be renumbered, not overwritten
        let (final_p, _) = unique_export_path(
            "D:/videos/我的视频.mp4",
            &[],
            &["D:/videos/我的视频.mp4".into()],
            &exists,
            999,
            "srt",
            false,
            true, // even with overwrite=true
        )
        .unwrap();
        assert_ne!(final_p, "D:/videos/我的视频.mp4");
    }

    #[test]
    fn empty_name_keeps_default_extension() {
        let p = proj();
        let r = resolve_export_target(&p, "", "", "", false, &[], "srt", false, &|_| false).unwrap();
        assert!(r["path"].ends_with(".mp4"), "path={}", r["path"]);
        assert!(r["filename"].ends_with(".mp4"), "filename={}", r["filename"]);
    }
}
