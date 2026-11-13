//! `de sweep`: render one view with a terrain.json value (or two) set to several values, and lay
//! the results out as one labelled contact sheet, so a look decision is a pick, not a guess.
//!
//! Each cell is a separate `de-shot` run with the changed `terrain.json` in an overlay folder
//! (`DE_OVERLAY`), so `content/` is never touched.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use de_world::{
    Island,
    image::{Cell, Rgba, sheet},
    sense::Report,
};
use serde_json::Value;

pub struct Axis {
    pub path: String,
    pub values: Vec<Value>,
}

/// Parse `look.fog_half_m=4000,8000` or `look.horizon=[0.6,0.7,0.8],[0.5,0.6,0.7]`.
pub fn parse_axis(s: &str) -> Result<Axis, String> {
    let (path, list) = s.split_once('=').ok_or_else(|| format!("`{s}`: expected path=v1,v2,..."))?;
    let mut values = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    let bytes = list.as_bytes();
    for i in 0..=bytes.len() {
        let end = i == bytes.len();
        if !end {
            match bytes[i] {
                b'[' | b'{' => depth += 1,
                b']' | b'}' => depth -= 1,
                _ => {}
            }
        }
        if end || (bytes[i] == b',' && depth == 0) {
            let raw = list[start..i].trim();
            if !raw.is_empty() {
                values.push(serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string())));
            }
            start = i + 1;
        }
    }
    if values.is_empty() {
        return Err(format!("`{s}`: no values"));
    }
    Ok(Axis { path: path.to_string(), values })
}

/// Set a dotted path in a JSON document. The path must already exist, so a typo is an error
/// that lists the keys that do exist.
pub fn set_path(doc: &mut Value, path: &str, v: Value) -> Result<(), String> {
    let mut cur = doc;
    let parts: Vec<&str> = path.split('.').collect();
    for (i, part) in parts.iter().enumerate() {
        let obj = cur.as_object_mut().ok_or_else(|| format!("`{}` is not an object", parts[..i].join(".")))?;
        if !obj.contains_key(*part) {
            let have: Vec<_> = obj.keys().cloned().collect();
            return Err(format!(
                "no `{part}` in `{}` (have: {})",
                if i == 0 { "terrain.json" } else { parts[i - 1] },
                have.join(", ")
            ));
        }
        if i + 1 == parts.len() {
            obj.insert((*part).to_string(), v);
            return Ok(());
        }
        cur = obj.get_mut(*part).expect("checked above");
    }
    Ok(())
}

fn short(path: &str) -> &str {
    path.rsplit('.').next().unwrap_or(path)
}

fn show(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string().replace(' ', ""),
    }
}

pub struct Sweep {
    pub island: String,
    pub view: String,
    pub axes: Vec<Axis>,
    pub tier: String,
    pub out: PathBuf,
}

/// Run every cell, write `<out>/sheet.png` and `<out>/sweep.md`, return the markdown.
pub fn run(content: &Path, s: &Sweep) -> Result<String, String> {
    let island = Island::load(content, &s.island).map_err(|e| e.to_string())?;
    if island.view(&s.view).is_none() {
        let have: Vec<_> = island.views.iter().map(|v| v.name.as_str()).collect();
        return Err(format!("island `{}` has no view `{}` (have: {})", s.island, s.view, have.join(", ")));
    }
    let base: Value = serde_json::to_value(&island).map_err(|e| e.to_string())?;
    let shot = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name(if cfg!(windows) {
        "de-shot.exe"
    } else {
        "de-shot"
    });
    if !shot.is_file() {
        return Err(format!("{} is missing: run `cargo build -p de_client --bin de-shot` first", shot.display()));
    }
    let (a, b) = (&s.axes[0], s.axes.get(1));
    let rows = b.map(|b| b.values.len()).unwrap_or(1);
    std::fs::create_dir_all(&s.out).map_err(|e| e.to_string())?;

    let mut cells = Vec::new();
    let mut md = format!("# Sweep of `{}` on {} ({})\n\n", s.view, s.island, s.tier);
    for r in 0..rows {
        for (c, va) in a.values.iter().enumerate() {
            let mut doc = base.clone();
            set_path(&mut doc, &a.path, va.clone())?;
            let mut label = format!("{}={}", short(&a.path), show(va));
            if let Some(b) = b {
                set_path(&mut doc, &b.path, b.values[r].clone())?;
                label.push_str(&format!(" {}={}", short(&b.path), show(&b.values[r])));
            }
            // Fail early, with the schema's message, on a value of the wrong type.
            serde_json::from_value::<Island>(doc.clone()).map_err(|e| format!("{label}: {e}"))?;

            let id = format!("cell{}", r * a.values.len() + c + 1);
            let dir = s.out.join(&id);
            let overlay = dir.join("overlay");
            let tj = overlay.join("islands").join(&s.island);
            std::fs::create_dir_all(&tj).map_err(|e| e.to_string())?;
            std::fs::write(tj.join("terrain.json"), serde_json::to_string_pretty(&doc).expect("serialises"))
                .map_err(|e| e.to_string())?;
            let steps = serde_json::json!({
                "island": s.island,
                "steps": [{"view": s.view}, {"wait": 2}, {"shot": id}],
            });
            let steps_path = dir.join("steps.json");
            std::fs::write(&steps_path, steps.to_string()).map_err(|e| e.to_string())?;
            eprintln!("{id}: {label}");
            let status = Command::new(&shot)
                .arg(&steps_path)
                .arg(&dir)
                .args(["--tier", &s.tier])
                .env("DE_OVERLAY", &overlay)
                .env("DE_CONTENT", content)
                .stdout(std::process::Stdio::null())
                .stderr(std::fs::File::create(dir.join("de-shot.log")).map_err(|e| e.to_string())?)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!("{id} ({label}) failed: see {}", dir.join("de-shot.log").display()));
            }
            let image = Rgba::load(&dir.join(format!("{id}.png")))?;
            let report: Report = std::fs::read_to_string(dir.join(format!("{id}.sense.json")))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .ok_or_else(|| format!("{id}: no sense.json"))?;
            let facts = report.image.as_ref();
            md.push_str(&format!(
                "- **{id}** `{label}`: brightness {:.2}, shadow ratio {}, fog keeps {:.0}% at median land distance.\n",
                facts.map(|f| f.mean_luma).unwrap_or(0.0),
                facts
                    .and_then(|f| Some(f.land_sunlit_luma? / f.land_shadow_luma?.max(1e-3)))
                    .map(|r| format!("{r:.1}:1"))
                    .unwrap_or_else(|| "n/a".into()),
                report.fog.left_at_median_land.unwrap_or(1.0) * 100.0,
            ));
            cells.push(Cell { image, label: format!("{} {label}", id.replace("cell", "#")) });
        }
    }
    let title = match b {
        Some(b) => format!("{}: {} (across) x {} (down)", s.view, short(&a.path), short(&b.path)),
        None => format!("{}: {}", s.view, short(&a.path)),
    };
    let cell_w = if a.values.len() > 3 { 400 } else { 560 };
    sheet(&title, &cells, a.values.len(), cell_w).save(&s.out.join("sheet.png"))?;
    md.push_str(&format!(
        "\nSheet: `{}`. Record a pick with `de taste --sheet {} --pick <cell> --why \"...\"`.\n",
        s.out.join("sheet.png").display(),
        s.out.join("sheet.png").display()
    ));
    std::fs::write(s.out.join("sweep.md"), &md).map_err(|e| e.to_string())?;
    Ok(md)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axes_parse_numbers_and_arrays() {
        let a = parse_axis("look.fog_half_m=4000, 8000").unwrap();
        assert_eq!(a.values, vec![serde_json::json!(4000), serde_json::json!(8000)]);
        let b = parse_axis("look.horizon=[0.6,0.7,0.8],[0.5,0.6,0.7]").unwrap();
        assert_eq!(b.values.len(), 2);
        assert!(parse_axis("look.fog_half_m").is_err());
    }

    #[test]
    fn set_path_names_the_keys_on_a_typo() {
        let mut doc = serde_json::json!({"look": {"fog_half_m": 1}});
        set_path(&mut doc, "look.fog_half_m", serde_json::json!(5)).unwrap();
        assert_eq!(doc["look"]["fog_half_m"], 5);
        let e = set_path(&mut doc, "look.fog", serde_json::json!(5)).unwrap_err();
        assert!(e.contains("have: fog_half_m"), "{e}");
    }
}
