//! Turn a capture folder into sensor packs and clip reports (see [`crate::sense`] and
//! [`crate::motion`]). `de-shot` calls this after every run; `de sense <dir>` re-runs it.

use std::{collections::BTreeMap, path::Path};

use crate::{
    Island,
    image::Rgba,
    motion,
    sense::{self, CameraShot, SEA_LEVEL_M, World},
};

/// Frames per second of game time that captures run at.
pub const FPS: f32 = 60.0;

/// Sensor buffers are cast at most this many pixels wide (the rendered PNG keeps its size).
pub const SENSE_MAX_W: u32 = 640;

/// Read `<out>/shots.json` and write, next to the images:
/// - per shot: `<name>.sense.json`, `<name>.labels.png`, `<name>.depth.png`, `<name>.normal.png`
/// - per clip: `<clip>.motion.json`, `<clip>.sheet.png`, `<clip>.flicker.png`
/// - `<out>/sense.md`: every shot's and clip's description, the one file to read first.
pub fn write(out: &Path, content: &Path, island_id: &str) -> Result<String, String> {
    let manifest = out.join("shots.json");
    let text = std::fs::read_to_string(&manifest).map_err(|e| format!("{}: {e}", manifest.display()))?;
    let cams: Vec<CameraShot> = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", manifest.display()))?;
    let island = Island::load(content, island_id).map_err(|e| e.to_string())?;
    let field = island.heightfield(content, island_id).map_err(|e| e.to_string())?;
    let world = World::new(&island, &field);

    let mut md = format!("# Capture: {} ({island_id})\n\n", island.name);
    let mut clips: BTreeMap<String, Vec<CameraShot>> = BTreeMap::new();
    for cam in &cams {
        if let Some((clip, _)) = cam.name.split_once('/') {
            clips.entry(clip.to_string()).or_default().push(cam.clone());
            continue;
        }
        let png = out.join(format!("{}.png", cam.name));
        let image = Rgba::load(&png).ok();
        let buf = world.buffers(cam, SENSE_MAX_W);
        let report = sense::report(&world, cam, &buf, image.as_ref());
        let base = |ext: &str| out.join(format!("{}.{ext}", cam.name));
        std::fs::write(base("sense.json"), serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        buf.labels_png().save(&base("labels.png"))?;
        buf.depth_png().save(&base("depth.png"))?;
        buf.normal_png().save(&base("normal.png"))?;
        md.push_str(&format!("## {} (shot)\n\n{}\n\n", cam.name, report.text));
    }
    let altitude = |p: [f32; 3]| {
        let g = if field.contains(p[0], p[2]) { field.height(p[0], p[2]).max(SEA_LEVEL_M) } else { SEA_LEVEL_M };
        p[1] - g
    };
    for (clip, cams) in &clips {
        let frames = motion::load_frames(&out.join(clip))?;
        if frames.is_empty() {
            continue;
        }
        let (report, map, sheet) = motion::analyse(clip, &frames, cams, altitude, FPS);
        std::fs::write(
            out.join(format!("{clip}.motion.json")),
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        map.save(&out.join(format!("{clip}.flicker.png")))?;
        sheet.save(&out.join(format!("{clip}.sheet.png")))?;
        md.push_str(&format!("## {clip} (clip)\n\n{}\n\n", report.text));
    }
    std::fs::write(out.join("sense.md"), &md).map_err(|e| e.to_string())?;
    Ok(md)
}
