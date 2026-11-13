//! `de compare`: perceptual difference between captures, with NVIDIA FLIP.
//!
//! Exact pixel equality breaks across GPUs and drivers; FLIP scores how different two images
//! look to a person (0 same .. 1 opposite) and draws where. For each shot in both folders this
//! writes `<name>.flip.png` (the heatmap) and `<name>.compare.png` (before | after | heatmap),
//! and `compare.json` with the scores.

use std::path::Path;

use de_world::image::{Cell, Rgba, sheet};
use serde::Serialize;

/// Mean FLIP below this reads as the same picture (driver noise, tiny shimmer).
pub const SAME_BELOW: f32 = 0.005;

#[derive(Serialize)]
pub struct Score {
    pub name: String,
    pub mean: f32,
    pub p95: f32,
    pub max: f32,
    /// `same`, `changed` or `new` / `missing`.
    pub verdict: String,
}

/// FLIP error map of two equal-sized images: (mean, 95th percentile, max, magma heatmap).
pub fn flip(a: &Rgba, b: &Rgba) -> (f32, f32, f32, Rgba) {
    let rgb = |i: &Rgba| -> Vec<u8> { i.pixels.iter().flat_map(|p| [p[0], p[1], p[2]]).collect() };
    let ra = nv_flip::FlipImageRgb8::with_data(a.width, a.height, &rgb(a));
    let rb = nv_flip::FlipImageRgb8::with_data(b.width, b.height, &rgb(b));
    let err = nv_flip::flip(ra, rb, nv_flip::DEFAULT_PIXELS_PER_DEGREE);
    let mut pool = nv_flip::FlipPool::from_image(&err);
    let heat = err.apply_color_lut(&nv_flip::magma_lut()).to_vec();
    let mut img = Rgba::new(a.width, a.height, [0, 0, 0, 255]);
    img.pixels = heat.chunks_exact(3).map(|c| [c[0], c[1], c[2], 255]).collect();
    (pool.mean(), pool.get_percentile(0.95, false), pool.max_value(), img)
}

/// Is this a rendered shot (not a sensor buffer, sheet or heatmap)?
pub fn is_shot(name: &str) -> bool {
    name.ends_with(".png") && name.matches('.').count() == 1
}

/// Compare every shot in `reference` with the same name in `test`; write results to `out`.
pub fn dirs(reference: &Path, test: &Path, out: &Path) -> Result<Vec<Score>, String> {
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let names = |d: &Path| -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| is_shot(n))
            .collect();
        v.sort();
        v
    };
    let (rn, tn) = (names(reference), names(test));
    let mut scores = Vec::new();
    for n in &tn {
        let stem = n.trim_end_matches(".png").to_string();
        if !rn.contains(n) {
            scores.push(Score { name: stem, mean: 0.0, p95: 0.0, max: 0.0, verdict: "new".into() });
            continue;
        }
        let (a, b) = (Rgba::load(&reference.join(n))?, Rgba::load(&test.join(n))?);
        if (a.width, a.height) != (b.width, b.height) {
            return Err(format!("{n}: sizes differ ({}x{} vs {}x{})", a.width, a.height, b.width, b.height));
        }
        let (mean, p95, max, heat) = flip(&a, &b);
        heat.save(&out.join(format!("{stem}.flip.png")))?;
        let verdict = if mean < SAME_BELOW { "same" } else { "changed" };
        let cells = [
            Cell { image: a, label: "BEFORE".into() },
            Cell { image: b, label: "AFTER".into() },
            Cell { image: heat, label: format!("FLIP MEAN {mean:.3}") },
        ];
        sheet(&format!("{stem}: {verdict}"), &cells, 3, 480).save(&out.join(format!("{stem}.compare.png")))?;
        scores.push(Score { name: stem, mean, p95, max, verdict: verdict.into() });
    }
    for n in rn.iter().filter(|n| !tn.contains(n)) {
        scores.push(Score {
            name: n.trim_end_matches(".png").into(),
            mean: 0.0,
            p95: 0.0,
            max: 0.0,
            verdict: "missing".into(),
        });
    }
    std::fs::write(out.join("compare.json"), serde_json::to_string_pretty(&scores).expect("serialises"))
        .map_err(|e| e.to_string())?;
    Ok(scores)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_is_zero_and_different_is_not() {
        let mut a = Rgba::new(32, 32, [100, 120, 90, 255]);
        let (m, ..) = flip(&a, &a.clone());
        assert_eq!(m, 0.0);
        let b = a.clone();
        a.fill_rect(8, 8, 16, 16, [250, 250, 250, 255]);
        let (m, _, max, heat) = flip(&a, &b);
        assert!(m > SAME_BELOW && max > 0.5, "{m} {max}");
        assert_eq!((heat.width, heat.height), (32, 32));
    }

    #[test]
    fn only_shots_are_compared() {
        assert!(is_shot("valley.png"));
        assert!(!is_shot("valley.labels.png"));
        assert!(!is_shot("valley.sense.json"));
    }
}
