//! Ground truth from satellites: what the island's ground really looks like and what covers it.
//!
//! `scripts/truth/fetch.py` writes, next to `terrain.json`, `satellite.png` (a cloud-free median
//! of Sentinel-2 surface reflectance, i.e. the ground's real albedo seen from above) and
//! `landcover.png` (ESA WorldCover classes), both on a grid twice as fine as the heightmap. With
//! them a render can be checked against the real place: per ground layer, how far our albedo is
//! from the satellite's ([`Fit`]), whether we draw rock where the map says grass ([`Agreement`]),
//! and per shot, the same view painted with satellite colour ([`paint`]).

// Several per-pixel buffers (class, position, normal, colour) are walked together by index.
#![allow(clippy::needless_range_loop)]

use std::{collections::BTreeMap, path::Path};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Heightfield, Island,
    image::Rgba,
    island::{Look, Vec3, layer_weights},
    sense::{Buffers, Class, to_sun},
};

/// The four ground layers, in `layer_weights` order.
pub const LAYERS: [&str; 4] = ["grass", "rock", "shore", "moss"];

/// Satellite colour and land cover on a grid over the island.
pub struct Truth {
    pub width: u32,
    pub height: u32,
    /// Linear albedo (surface reflectance) per pixel; zero where never seen clear.
    pub albedo: Vec<[f32; 3]>,
    /// ESA WorldCover class code per pixel.
    pub cover: Vec<u8>,
    /// Grid pixels per heightmap pixel along each side.
    pub per_px: f32,
}

/// sRGB 0..255 to linear 0..1.
pub fn to_linear(c: u8) -> f32 {
    let c = f32::from(c) / 255.0;
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// Linear 0..1 to sRGB 0..255.
pub fn to_srgb(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0 + 0.5) as u8
}

/// CIE L*a*b* (D65) of a linear sRGB colour.
pub fn lab(c: Vec3) -> Vec3 {
    let x = 0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2];
    let y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let z = 0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2];
    let f = |t: f32| if t > 0.008_856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x / 0.950_47), f(y), f(z / 1.088_83));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// Colour difference (CIE76 ΔE) between two linear colours: about 2 is just noticeable, over 10
/// is clearly a different colour.
pub fn delta_e(a: Vec3, b: Vec3) -> f32 {
    let (a, b) = (lab(a), lab(b));
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// WorldCover class name.
pub fn cover_name(code: u8) -> &'static str {
    match code {
        10 => "tree",
        20 => "shrub",
        30 => "grass",
        40 => "crop",
        50 => "built",
        60 => "bare",
        70 => "snow",
        80 => "water",
        90 => "wetland",
        95 => "mangrove",
        100 => "moss",
        _ => "none",
    }
}

/// WorldCover's own colours, for `<shot>.cover.png` and the island map.
pub fn cover_colour(code: u8) -> [u8; 4] {
    match code {
        10 => [0, 100, 0, 255],
        20 => [255, 187, 34, 255],
        30 => [255, 255, 76, 255],
        40 => [240, 150, 255, 255],
        50 => [250, 0, 0, 255],
        60 => [180, 180, 180, 255],
        70 => [240, 240, 240, 255],
        80 => [0, 100, 200, 255],
        90 => [0, 150, 160, 255],
        95 => [0, 207, 117, 255],
        100 => [250, 230, 160, 255],
        _ => [0, 0, 0, 255],
    }
}

/// Which WorldCover classes count as agreeing with each of our classes.
pub fn agrees(ours: Class, cover: u8) -> bool {
    match ours {
        Class::Grass => matches!(cover, 30 | 40 | 20),
        Class::Moss => matches!(cover, 100 | 20 | 90 | 30),
        Class::Rock => matches!(cover, 60),
        Class::Shore => matches!(cover, 60 | 80 | 90 | 30),
        Class::Sea => cover == 80 || cover == 0,
        Class::Water => cover == 80,
        Class::Sky => true,
    }
}

impl Truth {
    /// Loads `satellite.png` and `landcover.png` for an island. `Ok(None)` when they don't exist
    /// (run `scripts/truth/fetch.py <island>`).
    pub fn load(content: &Path, id: &str, island: &Island) -> Result<Option<Self>, String> {
        let dir = content.join("islands").join(id);
        let (sat, lc) = (dir.join("satellite.png"), dir.join("landcover.png"));
        if !sat.is_file() || !lc.is_file() {
            return Ok(None);
        }
        let sat = Rgba::load(&sat)?;
        let lc = Rgba::load(&lc)?;
        if (sat.width, sat.height) != (lc.width, lc.height) {
            return Err(format!("{id}: satellite.png and landcover.png differ in size"));
        }
        let albedo = sat.pixels.iter().map(|p| [to_linear(p[0]), to_linear(p[1]), to_linear(p[2])]).collect();
        let cover = lc.pixels.iter().map(|p| p[0]).collect();
        let per_px = sat.width as f32 / island.size_px[0] as f32;
        Ok(Some(Self { width: sat.width, height: sat.height, albedo, cover, per_px }))
    }

    /// Grid index under world x, z, if inside.
    pub fn index(&self, field: &Heightfield, x: f32, z: f32) -> Option<usize> {
        let [ew, ed] = field.extent();
        let col = ((x + ew / 2.0) / field.spacing[0] + 0.5) * self.per_px;
        let row = ((z + ed / 2.0) / field.spacing[1] + 0.5) * self.per_px;
        if col < 0.0 || row < 0.0 || col >= self.width as f32 || row >= self.height as f32 {
            return None;
        }
        Some(row as usize * self.width as usize + col as usize)
    }

    pub fn albedo_at(&self, field: &Heightfield, x: f32, z: f32) -> Option<Vec3> {
        self.index(field, x, z).map(|i| self.albedo[i]).filter(|a| a.iter().any(|&v| v > 0.0))
    }

    pub fn cover_at(&self, field: &Heightfield, x: f32, z: f32) -> Option<u8> {
        self.index(field, x, z).map(|i| self.cover[i])
    }
}

fn look_layer(look: &Look, i: usize) -> Vec3 {
    [look.grass, look.rock, look.shore, look.moss][i]
}

/// How our ground layer albedos compare with the satellite, island-wide.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Fit {
    /// Per layer: our albedo now, the albedo that best explains the satellite given where we draw
    /// each layer, and the colour difference between them.
    pub layers: BTreeMap<String, LayerFit>,
    /// Colour difference between the satellite and our ground, averaged over land, before and
    /// after using the fitted albedos.
    pub mean_delta_e_now: f32,
    pub mean_delta_e_fitted: f32,
    /// Land samples used.
    pub samples: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LayerFit {
    pub now: Vec3,
    pub fitted: Vec3,
    pub delta_e: f32,
    /// Share of land where this layer dominates.
    pub share: f32,
}

/// Where we draw each layer vs what WorldCover says is there, island-wide.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Agreement {
    /// Share of land pixels where our dominant layer agrees with WorldCover ([`agrees`]).
    pub agree: f32,
    /// For each of our layers, the WorldCover classes under it (share of that layer's pixels).
    pub under: BTreeMap<String, BTreeMap<String, f32>>,
}

/// Land samples on the satellite grid: (layer weights, satellite albedo, cover, dominant layer).
fn samples(island: &Island, field: &Heightfield, truth: &Truth) -> Vec<([f32; 4], Vec3, u8, usize)> {
    let top = field.max_height().max(1.0);
    let mut out = Vec::new();
    let [ew, ed] = field.extent();
    let step = 1.0 / truth.per_px;
    let (cols, rows) = (field.width as f32 / step, field.depth as f32 / step);
    for r in 0..rows as usize {
        for c in 0..cols as usize {
            let (fx, fz) = (c as f32 * step, r as f32 * step);
            let (x, z) = (fx * field.spacing[0] - ew / 2.0, fz * field.spacing[1] - ed / 2.0);
            if !field.contains(x, z) {
                continue;
            }
            let y = field.height(x, z);
            if y <= 0.5 {
                continue;
            }
            let Some(a) = truth.albedo_at(field, x, z) else { continue };
            let cover = truth.cover_at(field, x, z).unwrap_or(0);
            if cover == 80 {
                // Lakes and the lagoon are water on the map but ground in our heightfield.
                continue;
            }
            let n = field.normal(fx.round() as usize, fz.round() as usize);
            let w = layer_weights(y, 1.0 - n[1], top, &island.look);
            let dom = (0..4).max_by(|&a, &b| w[a].total_cmp(&w[b])).unwrap_or(0);
            out.push((w, a, cover, dom));
        }
    }
    out
}

/// Least squares: the layer albedos that, blended by our weights, best reproduce the satellite.
/// A small pull towards the current albedo keeps rare layers (shore) from running away.
pub fn fit(island: &Island, field: &Heightfield, truth: &Truth) -> Fit {
    let s = samples(island, field, truth);
    let n = s.len().max(1) as f32;
    let look = &island.look;
    let lambda = 0.002 * n;
    let mut fitted = [[0f32; 3]; 4];
    for ch in 0..3 {
        let mut a = [[0f64; 4]; 4];
        let mut b = [0f64; 4];
        for (w, alb, ..) in &s {
            for i in 0..4 {
                b[i] += f64::from(w[i] * alb[ch]);
                for j in 0..4 {
                    a[i][j] += f64::from(w[i] * w[j]);
                }
            }
        }
        for i in 0..4 {
            a[i][i] += f64::from(lambda);
            b[i] += f64::from(lambda * look_layer(look, i)[ch]);
        }
        let x = solve4(a, b);
        for i in 0..4 {
            fitted[i][ch] = (x[i] as f32).clamp(0.005, 0.9);
        }
    }
    let blend =
        |w: &[f32; 4], cols: &[Vec3; 4]| -> Vec3 { std::array::from_fn(|ch| (0..4).map(|i| w[i] * cols[i][ch]).sum()) };
    let now: [Vec3; 4] = std::array::from_fn(|i| look_layer(look, i));
    let (mut de_now, mut de_fit) = (0.0, 0.0);
    let mut dom_count = [0usize; 4];
    for (w, alb, _, dom) in &s {
        de_now += delta_e(blend(w, &now), *alb);
        de_fit += delta_e(blend(w, &fitted), *alb);
        dom_count[*dom] += 1;
    }
    let layers = (0..4)
        .map(|i| {
            (
                LAYERS[i].to_string(),
                LayerFit {
                    now: now[i],
                    fitted: fitted[i].map(|v| (v * 1000.0).round() / 1000.0),
                    delta_e: delta_e(now[i], fitted[i]),
                    share: dom_count[i] as f32 / n,
                },
            )
        })
        .collect();
    Fit { layers, mean_delta_e_now: de_now / n, mean_delta_e_fitted: de_fit / n, samples: s.len() }
}

fn solve4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> [f64; 4] {
    for col in 0..4 {
        let piv = (col..4).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs())).unwrap_or(col);
        a.swap(col, piv);
        b.swap(col, piv);
        let d = if a[col][col].abs() < 1e-12 { 1e-12 } else { a[col][col] };
        for row in 0..4 {
            if row != col {
                let f = a[row][col] / d;
                for k in col..4 {
                    a[row][k] -= f * a[col][k];
                }
                b[row] -= f * b[col];
            }
        }
    }
    std::array::from_fn(|i| b[i] / if a[i][i].abs() < 1e-12 { 1e-12 } else { a[i][i] })
}

pub fn agreement(island: &Island, field: &Heightfield, truth: &Truth) -> Agreement {
    let s = samples(island, field, truth);
    let classes = [Class::Grass, Class::Rock, Class::Shore, Class::Moss];
    let mut under: BTreeMap<String, BTreeMap<String, f32>> = BTreeMap::new();
    let mut per = [0usize; 4];
    let mut ok = 0usize;
    for (_, _, cover, dom) in &s {
        per[*dom] += 1;
        *under.entry(LAYERS[*dom].into()).or_default().entry(cover_name(*cover).into()).or_default() += 1.0;
        if agrees(classes[*dom], *cover) {
            ok += 1;
        }
    }
    for (i, l) in LAYERS.iter().enumerate() {
        if let Some(m) = under.get_mut(*l) {
            m.values_mut().for_each(|v| *v /= per[i].max(1) as f32);
        }
    }
    Agreement { agree: ok as f32 / s.len().max(1) as f32, under }
}

/// Per-shot comparison with the satellite. Written into `<shot>.sense.json` as `truth`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ShotTruth {
    /// Share of visible land where our layer agrees with WorldCover.
    pub cover_agree: f32,
    /// WorldCover classes under the visible land (share of land pixels).
    pub cover: BTreeMap<String, f32>,
    /// Per visible layer: our albedo vs the satellite's median under it, and their ΔE.
    pub layers: BTreeMap<String, ShotLayer>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ShotLayer {
    pub ours: Vec3,
    pub satellite: Vec3,
    pub delta_e: f32,
}

pub fn shot(island: &Island, field: &Heightfield, truth: &Truth, buf: &Buffers) -> ShotTruth {
    let mut cover: BTreeMap<String, f32> = BTreeMap::new();
    let (mut land, mut ok) = (0usize, 0usize);
    let mut per: BTreeMap<Class, Vec<Vec3>> = BTreeMap::new();
    for (k, &c) in buf.class.iter().enumerate() {
        if !c.is_land() {
            continue;
        }
        let p = buf.pos[k];
        let Some(code) = truth.cover_at(field, p[0], p[2]) else { continue };
        land += 1;
        *cover.entry(cover_name(code).into()).or_default() += 1.0;
        if agrees(c, code) {
            ok += 1;
        }
        if let Some(a) = truth.albedo_at(field, p[0], p[2]) {
            per.entry(c).or_default().push(a);
        }
    }
    cover.values_mut().for_each(|v| *v /= land.max(1) as f32);
    let look = &island.look;
    let layers = per
        .into_iter()
        .filter(|(_, v)| v.len() >= 20)
        .map(|(c, mut v)| {
            let sat: Vec3 = std::array::from_fn(|ch| {
                v.sort_by(|a, b| a[ch].total_cmp(&b[ch]));
                v[v.len() / 2][ch]
            });
            let ours = match c {
                Class::Grass => look.grass,
                Class::Rock => look.rock,
                Class::Shore => look.shore,
                Class::Water => look.stream,
                _ => look.moss,
            };
            (c.name().to_string(), ShotLayer { ours, satellite: sat, delta_e: delta_e(ours, sat) })
        })
        .collect();
    ShotTruth { cover_agree: ok as f32 / land.max(1) as f32, cover, layers }
}

/// The shot's view painted with satellite albedo under simple sun shading, brightness matched
/// to the render's land, with the render's own sky: what our colours would be if they matched
/// the real ground. Also returns the view coloured by WorldCover class.
pub fn paint(
    island: &Island,
    field: &Heightfield,
    truth: &Truth,
    buf: &Buffers,
    render: Option<&Rgba>,
) -> (Rgba, Rgba) {
    let sun = to_sun(&island.look);
    let (w, h) = (buf.width, buf.height);
    let mut lin = vec![[0f32; 3]; (w * h) as usize];
    let mut cov = Rgba::new(w, h, [0, 0, 0, 255]);
    for k in 0..lin.len() {
        let c = buf.class[k];
        if c == Class::Sky {
            continue;
        }
        let p = buf.pos[k];
        let n = buf.normal[k];
        let lit = (n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]).max(0.0) * if buf.shaded[k] { 0.0 } else { 1.0 };
        let a = truth.albedo_at(field, p[0], p[2]).unwrap_or(if c == Class::Sea { island.look.sea } else { [0.05; 3] });
        lin[k] = a.map(|v| v * (0.35 + 0.65 * lit));
        cov.pixels[k] = if c == Class::Sea {
            cover_colour(80)
        } else {
            cover_colour(truth.cover_at(field, p[0], p[2]).unwrap_or(0))
        };
    }
    // Match the render's median land brightness, so the comparison is about colour, not exposure.
    let lum = |c: Vec3| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let sample = |img: &Rgba, k: usize| {
        let (x, y) = ((k as u32 % w) * img.width / w, (k as u32 / w) * img.height / h);
        img.get(x, y)
    };
    let mut ours: Vec<f32> = Vec::new();
    let mut theirs: Vec<f32> = Vec::new();
    for k in 0..lin.len() {
        if buf.class[k].is_land() {
            theirs.push(lum(lin[k]));
            if let Some(r) = render {
                let p = sample(r, k);
                ours.push(lum([to_linear(p[0]), to_linear(p[1]), to_linear(p[2])]));
            }
        }
    }
    let median = |v: &mut Vec<f32>| {
        v.sort_by(f32::total_cmp);
        v.get(v.len() / 2).copied().unwrap_or(0.0)
    };
    let k_exp = if ours.is_empty() { 4.0 } else { median(&mut ours) / median(&mut theirs).max(1e-4) };
    let mut out = Rgba::new(w, h, [120, 180, 255, 255]);
    for k in 0..lin.len() {
        out.pixels[k] = if buf.class[k] == Class::Sky {
            render.map(|r| sample(r, k)).unwrap_or([150, 180, 220, 255])
        } else {
            let c = lin[k].map(|v| to_srgb(v * k_exp));
            [c[0], c[1], c[2], 255]
        };
    }
    for (k, c) in buf.class.iter().enumerate() {
        if *c == Class::Sky {
            cov.pixels[k] = [255, 255, 255, 255];
        }
    }
    (out, cov)
}

/// Top-down maps on the satellite grid: the satellite, our ground now, our ground with `fitted`
/// albedos, and the land cover. Our maps are lit the same flat way as the satellite (not at all),
/// and all three colour maps share one exposure so they compare directly.
pub fn maps(island: &Island, field: &Heightfield, truth: &Truth, fitted: &[Vec3; 4]) -> [Rgba; 4] {
    let (w, h) = (truth.width, truth.height);
    let top = field.max_height().max(1.0);
    let now: [Vec3; 4] = std::array::from_fn(|i| look_layer(&island.look, i));
    let [ew, ed] = field.extent();
    let mut maps = [(); 3].map(|_| vec![[0f32; 3]; (w * h) as usize]);
    let mut cover = Rgba::new(w, h, [0, 0, 0, 255]);
    for r in 0..h {
        for c in 0..w {
            let k = (r * w + c) as usize;
            cover.pixels[k] = cover_colour(truth.cover[k]);
            maps[0][k] = truth.albedo[k];
            let (fx, fz) = ((c as f32 + 0.5) / truth.per_px - 0.5, (r as f32 + 0.5) / truth.per_px - 0.5);
            let (x, z) = (fx * field.spacing[0] - ew / 2.0, fz * field.spacing[1] - ed / 2.0);
            let y = field.height(x, z);
            if !field.contains(x, z) || y <= 0.5 {
                maps[1][k] = island.look.sea;
                maps[2][k] = island.look.sea;
                continue;
            }
            let n = field.normal(fx.round().max(0.0) as usize, fz.round().max(0.0) as usize);
            let wts = layer_weights(y, 1.0 - n[1], top, &island.look);
            maps[1][k] = std::array::from_fn(|ch| (0..4).map(|i| wts[i] * now[i][ch]).sum());
            maps[2][k] = std::array::from_fn(|ch| (0..4).map(|i| wts[i] * fitted[i][ch]).sum());
        }
    }
    // One exposure for all three: bring the satellite's median land brightness to mid grey.
    let mut l: Vec<f32> =
        maps[0].iter().map(|a| 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]).filter(|&v| v > 0.0).collect();
    l.sort_by(f32::total_cmp);
    let k_exp = 0.18 / l.get(l.len() / 2).copied().unwrap_or(0.1).max(1e-3);
    let img = |m: &Vec<Vec3>| {
        let mut out = Rgba::new(w, h, [0, 0, 0, 255]);
        out.pixels = m
            .iter()
            .map(|a| {
                let c = a.map(|v| to_srgb(v * k_exp));
                [c[0], c[1], c[2], 255]
            })
            .collect();
        out
    };
    [img(&maps[0]), img(&maps[1]), img(&maps[2]), cover]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_maths() {
        assert_eq!(to_srgb(to_linear(200)), 200);
        assert!(delta_e([0.2, 0.2, 0.2], [0.2, 0.2, 0.2]) < 1e-4);
        assert!(delta_e([0.1, 0.2, 0.05], [0.2, 0.1, 0.05]) > 20.0, "green vs red");
        let l = lab([1.0, 1.0, 1.0]);
        assert!((l[0] - 100.0).abs() < 0.5 && l[1].abs() < 0.5 && l[2].abs() < 0.5, "{l:?}");
    }

    #[test]
    fn solve_recovers_known_mix() {
        let a = [[4.0, 1.0, 0.0, 0.0], [1.0, 3.0, 0.0, 0.0], [0.0, 0.0, 2.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
        let x = [1.0, 2.0, 3.0, 4.0];
        let b = std::array::from_fn(|i| (0..4).map(|j| a[i][j] * x[j]).sum());
        let got = solve4(a, b);
        for i in 0..4 {
            assert!((got[i] - x[i]).abs() < 1e-9, "{got:?}");
        }
    }

    #[test]
    fn fit_finds_the_satellite_colour() {
        // Flat 10x10 island at 100 m: all grass. The satellite says grass is (0.05, 0.10, 0.02).
        let field = Heightfield { width: 10, depth: 10, spacing: [10.0, 10.0], heights: vec![100.0; 100] };
        let island: Island = serde_json::from_str(
            r#"{"name":"t","heightmap":"h.png","size_px":[10,10],"metres_per_px":[10,10],"height_range_m":[0,100],
                "origin":{"north_lat":0,"west_lon":0},"source":{"dataset":"","tile":"","attribution":""}}"#,
        )
        .unwrap();
        let truth =
            Truth { width: 20, height: 20, albedo: vec![[0.05, 0.10, 0.02]; 400], cover: vec![30; 400], per_px: 2.0 };
        let f = fit(&island, &field, &truth);
        let g = &f.layers["grass"];
        assert!(g.share > 0.5, "{f:?}");
        // Grass and moss always blend together here, so check the blend, not one layer.
        assert!(f.mean_delta_e_fitted < 3.0, "{f:?}");
        assert!(f.mean_delta_e_fitted < f.mean_delta_e_now, "{f:?}");
        let a = agreement(&island, &field, &truth);
        assert!(a.agree > 0.5, "{a:?}");
    }
}
