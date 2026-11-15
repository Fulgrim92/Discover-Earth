//! A blind visual critic: a reviewer that sees only the renders, never the code, the diff or
//! the reasoning behind a change, so it can't be talked into liking it.
//!
//! `de critic pack <shots-dir>` copies the shot PNGs, each clip's keyframe sheet and its motion
//! stats into one folder (default `out/critic/`) with `brief.md`, a fixed rubric. A fresh agent
//! is given that folder and nothing else, and writes `critic.json` there. `de critic check`
//! reads it back: it prints the defects worst first and fails while any is above `minor`, which
//! is the "done when" gate.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How bad a defect is, worst first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Breaks the picture: wrong or missing things, black or white areas, obvious artefacts.
    Blocker,
    /// Clearly wrong to anyone who looks: shimmer, popping, banding, a fake-looking material.
    Major,
    /// Noticeable on a second look.
    Moderate,
    /// Polish.
    Minor,
}

/// One defect the critic saw.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defect {
    /// File name it is in (e.g. `valley.png`, `down-the-valley.sheet.png`).
    pub shot: String,
    pub severity: Severity,
    /// Where in the picture (e.g. "left third, the far ridge").
    #[serde(rename = "where")]
    pub place: String,
    /// What is wrong, concretely, and what it should look like instead.
    pub what: String,
}

/// `critic.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub defects: Vec<Defect>,
    /// One or two sentences on the whole set.
    #[serde(default)]
    pub overall: String,
}

const BRIEF: &str = include_str!("critic_brief.md");

/// Copy what the critic may see into `out` and write the brief. Returns the files copied.
pub fn pack(shots: &Path, out: &Path) -> Result<Vec<String>, String> {
    let manifest = shots.join("shots.json");
    let text =
        std::fs::read_to_string(&manifest).map_err(|e| format!("{}: {e} (run de-shot first)", manifest.display()))?;
    let cams: Vec<de_world::sense::CameraShot> =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", manifest.display()))?;
    if out.exists() {
        std::fs::remove_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    }
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let mut files = Vec::new();
    let mut clips = std::collections::BTreeSet::new();
    for c in &cams {
        match c.name.split_once('/') {
            Some((clip, _)) => {
                clips.insert(clip.to_string());
            }
            None => files.push(format!("{}.png", c.name)),
        }
    }
    for clip in clips {
        files.push(format!("{clip}.sheet.png"));
        files.push(format!("{clip}.motion.json"));
    }
    let mut copied = Vec::new();
    for f in files {
        let from = shots.join(&f);
        if from.exists() {
            std::fs::copy(&from, out.join(&f)).map_err(|e| format!("{}: {e}", from.display()))?;
            copied.push(f);
        }
    }
    if copied.is_empty() {
        return Err(format!("{}: no shots or clip sheets to review", shots.display()));
    }
    let list: String = copied.iter().map(|f| format!("- `{f}`\n")).collect();
    std::fs::write(out.join("brief.md"), BRIEF.replace("{files}", &list)).map_err(|e| e.to_string())?;
    Ok(copied)
}

/// Read `critic.json`, sort its defects worst first, and say whether the gate passes.
pub fn check(path: &Path) -> Result<(Review, bool), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut review: Review =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e} (see brief.md)", path.display()))?;
    review.defects.sort_by_key(|d| d.severity);
    let pass = review.defects.iter().all(|d| d.severity == Severity::Minor);
    Ok((review, pass))
}

/// Default folder for the pack.
pub fn default_out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out/critic")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_fails_on_anything_above_minor() {
        let dir = std::env::temp_dir().join(format!("de-critic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("critic.json");
        let d = |s: &str| format!(r#"{{"shot":"a.png","severity":"{s}","where":"sky","what":"banding"}}"#);
        std::fs::write(&path, format!(r#"{{"defects":[{},{}]}}"#, d("minor"), d("major"))).unwrap();
        let (r, pass) = check(&path).unwrap();
        assert!(!pass);
        assert_eq!(r.defects[0].severity, Severity::Major, "worst first");
        std::fs::write(&path, format!(r#"{{"defects":[{}],"overall":"fine"}}"#, d("minor"))).unwrap();
        assert!(check(&path).unwrap().1);
        std::fs::write(&path, r#"{"defects":[{"shot":"a.png","severity":"awful","where":"","what":""}]}"#).unwrap();
        assert!(check(&path).is_err(), "unknown severities are refused");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn brief_lists_the_files_and_the_format() {
        assert!(BRIEF.contains("{files}"));
        assert!(BRIEF.contains("critic.json"));
        for s in ["blocker", "major", "moderate", "minor"] {
            assert!(BRIEF.contains(s), "brief names severity {s}");
        }
    }
}
