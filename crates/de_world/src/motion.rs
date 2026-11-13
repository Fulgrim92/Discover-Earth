//! Clips as something a model can read: a keyframe contact sheet, motion stats per frame and a
//! flicker score with a map of where it happens.
//!
//! A model can't watch an mp4, and a stutter or shimmer is easy to miss in a handful of
//! frames. So every clip `de-shot` records also gets `<clip>.sheet.png` (labelled keyframes),
//! `<clip>.motion.json` and `<clip>.flicker.png`.
//!
//! Flicker is counted per pixel: a pixel flickers at frame t when its brightness goes up then
//! down (or down then up) by more than [`FLICKER_STEP`] across frames t-1, t, t+1. A camera
//! moving smoothly shifts edges one way, so it mostly doesn't trip this; shimmering detail,
//! aliasing, z-fighting and popping do.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    image::{Cell, Rgba, luma, sheet},
    sense::CameraShot,
};

/// Brightness change (0..1) that counts as a flicker step: about 10/255.
pub const FLICKER_STEP: f32 = 0.04;

/// Written as `<clip>.motion.json`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MotionReport {
    pub clip: String,
    pub frames: usize,
    /// Mean share of pixels flickering per frame, in percent. Under ~0.5 reads as stable.
    pub flicker_pct: f32,
    /// The frame with the most flicker and its share in percent.
    pub worst_flicker_frame: usize,
    pub worst_flicker_pct: f32,
    /// Mean brightness change between consecutive frames (0..1).
    pub mean_change: f32,
    /// Frames whose change from the previous one is over 3x the clip's median: cuts, pops, jumps.
    pub jumps: Vec<usize>,
    /// Camera speed (metres per second of game time) and altitude, when camera data exists.
    pub speed_mps: Option<Stats>,
    pub altitude_m: Option<Stats>,
    pub per_frame: Vec<FrameStats>,
    /// The above as sentences.
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Stats {
    pub min: f32,
    pub mean: f32,
    pub max: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FrameStats {
    pub frame: usize,
    pub mean_luma: f32,
    /// Mean brightness change from the previous frame.
    pub change: f32,
    pub flicker_pct: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<[f32; 3]>,
}

fn stats(v: &[f32]) -> Option<Stats> {
    (!v.is_empty()).then(|| Stats {
        min: v.iter().copied().fold(f32::MAX, f32::min),
        mean: v.iter().sum::<f32>() / v.len() as f32,
        max: v.iter().copied().fold(f32::MIN, f32::max),
    })
}

/// Analyse `frames` (in order). `cams` are the matching camera records, if any, with
/// `altitude(pos)` giving height above ground. Returns the report, the flicker map and the sheet.
pub fn analyse(
    clip: &str,
    frames: &[Rgba],
    cams: &[CameraShot],
    altitude: impl Fn([f32; 3]) -> f32,
    fps: f32,
) -> (MotionReport, Rgba, Rgba) {
    let lum: Vec<Vec<f32>> = frames.iter().map(|f| f.pixels.iter().map(|&p| luma(p)).collect()).collect();
    let (w, h) = frames.first().map(|f| (f.width, f.height)).unwrap_or((1, 1));
    let npx = (w * h) as usize;
    let mut counts = vec![0u32; npx];
    let mut per_frame = Vec::with_capacity(frames.len());
    for (i, l) in lum.iter().enumerate() {
        let mean_luma = l.iter().sum::<f32>() / npx.max(1) as f32;
        let change =
            if i == 0 { 0.0 } else { l.iter().zip(&lum[i - 1]).map(|(a, b)| (a - b).abs()).sum::<f32>() / npx as f32 };
        let mut flick = 0usize;
        if i > 0 && i + 1 < lum.len() {
            let (p, n) = (&lum[i - 1], &lum[i + 1]);
            for k in 0..npx {
                let (d1, d2) = (l[k] - p[k], n[k] - l[k]);
                if d1 * d2 < 0.0 && d1.abs() > FLICKER_STEP && d2.abs() > FLICKER_STEP {
                    flick += 1;
                    counts[k] += 1;
                }
            }
        }
        per_frame.push(FrameStats {
            frame: i + 1,
            mean_luma,
            change,
            flicker_pct: 100.0 * flick as f32 / npx.max(1) as f32,
            pos: cams.get(i).map(|c| c.pos),
        });
    }
    let inner = per_frame.len().saturating_sub(2).max(1) as f32;
    let flicker_pct = per_frame.iter().map(|f| f.flicker_pct).sum::<f32>() / inner;
    let worst = per_frame.iter().max_by(|a, b| a.flicker_pct.total_cmp(&b.flicker_pct));
    let mut changes: Vec<f32> = per_frame.iter().skip(1).map(|f| f.change).collect();
    let mean_change = changes.iter().sum::<f32>() / changes.len().max(1) as f32;
    changes.sort_by(f32::total_cmp);
    let median = changes.get(changes.len() / 2).copied().unwrap_or(0.0);
    let jumps = per_frame.iter().skip(1).filter(|f| median > 0.0 && f.change > 3.0 * median).map(|f| f.frame).collect();

    let speeds: Vec<f32> = cams
        .windows(2)
        .map(|c| {
            let d: f32 = (0..3).map(|i| (c[1].pos[i] - c[0].pos[i]).powi(2)).sum::<f32>().sqrt();
            let dt = (c[1].frame.saturating_sub(c[0].frame)).max(1) as f32 / fps;
            d / dt
        })
        .collect();
    let alts: Vec<f32> = cams.iter().map(|c| altitude(c.pos)).collect();

    let mut r = MotionReport {
        clip: clip.to_string(),
        frames: frames.len(),
        flicker_pct,
        worst_flicker_frame: worst.map(|f| f.frame).unwrap_or(0),
        worst_flicker_pct: worst.map(|f| f.flicker_pct).unwrap_or(0.0),
        mean_change,
        jumps,
        speed_mps: stats(&speeds),
        altitude_m: stats(&alts),
        per_frame,
        text: String::new(),
    };
    r.text = describe(&r);

    // Flicker map: black where steady, through red to yellow where pixels flicker most.
    let max = counts.iter().copied().max().unwrap_or(0).max(1) as f32;
    let mut map = Rgba::new(w, h, [0, 0, 0, 255]);
    for (k, &c) in counts.iter().enumerate() {
        let v = (c as f32 / max).sqrt();
        map.pixels[k] = [((v * 2.0).min(1.0) * 255.0) as u8, ((v * 2.0 - 1.0).max(0.0) * 255.0) as u8, 0, 255];
    }
    // Faint copy of the middle frame underneath, so the map shows where things are.
    if let Some(mid) = frames.get(frames.len() / 2) {
        for (k, px) in map.pixels.iter_mut().enumerate() {
            if counts[k] == 0 {
                let g = (luma(mid.pixels[k]) * 70.0) as u8;
                *px = [g, g, g, 255];
            }
        }
    }

    // Keyframe sheet: 12 evenly spaced frames, 4 across.
    let picks = keyframes(frames.len(), 12);
    let cells: Vec<Cell> = picks
        .iter()
        .map(|&i| Cell {
            image: frames[i].clone(),
            label: format!(
                "F{} {:.1}S{}",
                i + 1,
                i as f32 / fps,
                cams.get(i).map(|c| format!(" {:.0}M", altitude(c.pos))).unwrap_or_default()
            ),
        })
        .collect();
    let title = format!("{clip}  {} frames  flicker {:.2}%", frames.len(), r.flicker_pct);
    let sheet = sheet(&title, &cells, 4, 320);
    (r, map, sheet)
}

/// `n` evenly spread frame indices out of `len`, always including the first and last.
pub fn keyframes(len: usize, n: usize) -> Vec<usize> {
    if len == 0 {
        return vec![];
    }
    let n = n.min(len).max(1);
    if n == 1 {
        return vec![0];
    }
    (0..n).map(|i| i * (len - 1) / (n - 1)).collect()
}

fn describe(r: &MotionReport) -> String {
    let mut s = vec![format!(
        "{} frames. Flicker {:.2}% of pixels per frame on average ({}), worst {:.2}% at frame {}.",
        r.frames,
        r.flicker_pct,
        if r.flicker_pct < 0.5 {
            "stable"
        } else if r.flicker_pct < 2.0 {
            "some shimmer"
        } else {
            "visible flicker"
        },
        r.worst_flicker_pct,
        r.worst_flicker_frame
    )];
    s.push(format!("Mean change between frames {:.3}.", r.mean_change));
    if r.jumps.is_empty() {
        s.push("No sudden jumps.".into());
    } else {
        s.push(format!("Sudden jumps at frames {:?}.", r.jumps));
    }
    if let Some(sp) = &r.speed_mps {
        s.push(format!("Camera speed {:.1} to {:.1} m/s (mean {:.1}).", sp.min, sp.max, sp.mean));
    }
    if let Some(a) = &r.altitude_m {
        s.push(format!("Altitude {:.0} to {:.0} m.", a.min, a.max));
    }
    s.join(" ")
}

/// Load `dir/frame_0001.png`, `frame_0002.png`, ... in order.
pub fn load_frames(dir: &Path) -> Result<Vec<Rgba>, String> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("frame_") && n.ends_with(".png"))
        })
        .collect();
    paths.sort();
    paths.iter().map(|p| Rgba::load(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(v: u8) -> Rgba {
        Rgba::new(8, 8, [v, v, v, 255])
    }

    #[test]
    fn steady_fade_has_no_flicker_but_alternation_does() {
        let fade: Vec<Rgba> = (0..10).map(|i| frame(i * 20)).collect();
        let (r, _, _) = analyse("fade", &fade, &[], |_| 0.0, 60.0);
        assert_eq!(r.flicker_pct, 0.0);
        let blink: Vec<Rgba> = (0..10).map(|i| frame(if i % 2 == 0 { 50 } else { 150 })).collect();
        let (r, map, sheet) = analyse("blink", &blink, &[], |_| 0.0, 60.0);
        assert!((r.flicker_pct - 100.0).abs() < 1e-3, "{}", r.flicker_pct);
        assert!(r.text.contains("visible flicker"));
        assert_eq!(map.get(0, 0)[1], 255, "every pixel flickers the most");
        assert!(sheet.width > 0);
    }

    #[test]
    fn jumps_are_found() {
        let mut v: Vec<Rgba> = (0..10).map(|i| frame(10 + i * 2)).collect();
        v[6] = frame(200);
        for f in v.iter_mut().skip(7) {
            *f = frame(200);
        }
        let (r, _, _) = analyse("cut", &v, &[], |_| 0.0, 60.0);
        assert_eq!(r.jumps, vec![7]);
    }

    #[test]
    fn keyframes_spread_evenly() {
        assert_eq!(keyframes(100, 4), vec![0, 33, 66, 99]);
        assert_eq!(keyframes(3, 12), vec![0, 1, 2]);
        assert!(keyframes(0, 4).is_empty());
    }
}
