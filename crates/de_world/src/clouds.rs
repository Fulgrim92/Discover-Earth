//! Clouds: a layer of volumetric cloud over the island, as data and noise.
//!
//! The client ray-marches the layer in a shader (`crates/de_client/src/clouds.wesl`); this
//! module holds what both sides need: the settings in `look.clouds`, the tileable noise volume
//! the shader samples (seeded through [`Rng`], so every capture is identical), and a CPU copy of
//! the density so tests and tools can ask where the clouds are without a GPU.
//!
//! The noise is the Perlin-Worley recipe from Schneider's Nubis talks (Guerrilla, SIGGRAPH 2015
//! and 2017) and Hillaire's "Physically based sky, atmosphere and cloud rendering in Frostbite"
//! (2016): billowy Perlin-Worley for the shape, finer Worley to erode the edges, and a slow
//! Perlin field for where the cover breaks.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Rng;

/// Side of the noise volume in voxels. One tile covers `scale_m` metres.
pub const NOISE_SIZE: usize = 64;

/// How the sky is clouded. Every field has a default; `cover` 0 (the default) means a clear sky.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Clouds {
    /// How much of the sky the clouds cover: 0 clear, 0.4 broken cumulus, 0.7 mostly cloudy,
    /// 1 overcast.
    pub cover: f32,
    /// Height of the cloud base above sea level, metres. Below the ridge tops the clouds sit on
    /// the hills, as they often do in the Faroes.
    pub base_m: f32,
    /// Height of the cloud tops above sea level, metres.
    pub top_m: f32,
    /// Horizontal size of one tile of cloud shapes, metres (cells are about a quarter of this).
    pub scale_m: f32,
    /// Light extinction inside a full cloud, per metre (0.02 is a thin stratocumulus, 0.08 a
    /// thick one). Thicker clouds have darker bellies.
    pub density: f32,
    /// How much fine noise eats into the cloud edges (0 smooth blobs .. 1 wispy).
    pub detail: f32,
    /// Wind that moves the clouds, metres per second, east then south.
    pub wind: [f32; 2],
    /// Brightness of the clouds' sunlit and skylit parts (1 physical).
    pub light: f32,
    /// How dark cloud shadows are on the ground (0 none .. 1 physical).
    pub shadows: f32,
    /// Ray-march steps through the layer per pixel (more is smoother and slower).
    pub steps: u32,
    /// Distance at which the clouds have faded into the sky, metres.
    pub reach_m: f32,
}

impl Default for Clouds {
    fn default() -> Self {
        Self {
            cover: 0.0,
            base_m: 600.0,
            top_m: 1400.0,
            scale_m: 6000.0,
            density: 0.04,
            detail: 0.35,
            wind: [6.0, 2.0],
            light: 1.0,
            shadows: 1.0,
            steps: 48,
            reach_m: 40_000.0,
        }
    }
}

impl Clouds {
    pub fn on(&self) -> bool {
        self.cover > 0.0
    }

    /// Problems with the settings, as messages naming the field.
    pub fn problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        if !(0.0..=1.0).contains(&self.cover) {
            out.push(format!("look.clouds.cover {} must be within 0..1", self.cover));
        }
        if self.top_m <= self.base_m {
            out.push(format!("look.clouds.top_m {} must be above base_m {}", self.top_m, self.base_m));
        }
        if self.scale_m < 100.0 {
            out.push(format!("look.clouds.scale_m {} is too small; use 100 m or more", self.scale_m));
        }
        if !(1..=256).contains(&self.steps) {
            out.push(format!("look.clouds.steps {} must be within 1..256", self.steps));
        }
        if self.density <= 0.0 {
            out.push(format!("look.clouds.density {} must be above 0", self.density));
        }
        out
    }

    /// Cloud density (extinction per metre) at world position `p` and game time `t` seconds,
    /// the same formula as `clouds.wesl`.
    pub fn density_at(&self, noise: &Noise, p: [f32; 3], t: f32) -> f32 {
        let h = (p[1] - self.base_m) / (self.top_m - self.base_m);
        if !(0.0..=1.0).contains(&h) || !self.on() {
            return 0.0;
        }
        let x = (p[0] - self.wind[0] * t) / self.scale_m;
        let z = (p[2] - self.wind[1] * t) / self.scale_m;
        let y = p[1] / self.scale_m;
        let weather = noise.sample([x * 0.25, 0.5, z * 0.25])[2];
        let s = noise.sample([x, y, z]);
        let d = self.shape(weather, s[0], h);
        if d <= 0.0 {
            return 0.0;
        }
        let e = noise.sample([x * 5.0, y * 5.0, z * 5.0])[1];
        self.erode(d, e, h) * self.density
    }

    /// Cover where the sky's slow `weather` noise is, and the cloud's base shape there.
    pub fn shape(&self, weather: f32, shape: f32, h: f32) -> f32 {
        let cover = (self.cover * (0.55 + 0.9 * weather)).clamp(0.0, 1.0);
        // Flat bottoms, tops rounding off; broken cover makes the clouds thinner too.
        let profile = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.35 + 0.6 * cover, 1.0, h));
        remap(shape * profile, 1.0 - cover, 1.0)
    }

    /// Fine noise wears away the edges, more at the bottom (wisps) than the top.
    pub fn erode(&self, d: f32, fine: f32, h: f32) -> f32 {
        let amount = self.detail * (0.6 - 0.3 * h);
        remap(d, fine * amount, 1.0).max(0.0)
    }

    /// Fraction of a square `half_m` either side of the origin that has cloud overhead at the
    /// middle of the layer, from a `n` x `n` grid of columns (for sensor packs and tests).
    pub fn cover_fraction(&self, noise: &Noise, half_m: f32, n: usize, t: f32) -> f32 {
        let mid = 0.5 * (self.base_m + self.top_m);
        let mut hit = 0;
        for i in 0..n {
            for j in 0..n {
                let x = -half_m + 2.0 * half_m * (i as f32 + 0.5) / n as f32;
                let z = -half_m + 2.0 * half_m * (j as f32 + 0.5) / n as f32;
                // A column is cloudy if any of a few heights is.
                let cloudy = (0..6).any(|k| {
                    let y = self.base_m + (self.top_m - self.base_m) * (k as f32 + 0.5) / 6.0;
                    self.density_at(noise, [x, y.min(mid * 2.0), z], t) > 0.0
                });
                hit += cloudy as usize;
            }
        }
        hit as f32 / (n * n) as f32
    }
}

/// The tileable noise volume: per voxel r = Perlin-Worley shape, g = fine Worley for erosion,
/// b = slow Perlin for where the cover breaks (sampled as a plane), a = 1.
#[derive(Clone, Debug)]
pub struct Noise {
    pub size: usize,
    /// RGBA8, x fastest, then y, then z.
    pub rgba: Vec<u8>,
}

impl Noise {
    /// Builds the volume from a seed (the island's name hashed). Takes about a second.
    pub fn new(seed: u64) -> Self {
        let n = NOISE_SIZE;
        let mut rng = Rng::new(seed);
        let perlin = Perlin::new(&mut rng);
        let worley: Vec<Worley> = [4, 8, 16, 32, 64].iter().map(|&c| Worley::new(c, &mut rng)).collect();
        let mut chans = vec![[0f32; 3]; n * n * n];
        for z in 0..n {
            for y in 0..n {
                for x in 0..n {
                    let p = [(x as f32 + 0.5) / n as f32, (y as f32 + 0.5) / n as f32, (z as f32 + 0.5) / n as f32];
                    let w = |i: usize| 1.0 - worley[i].at(p);
                    let wl = 0.625 * w(0) + 0.25 * w(1) + 0.125 * w(2);
                    let pf = perlin.fbm(p, 4, 3) * 0.5 + 0.5;
                    let shape = remap(pf, wl - 1.0, 1.0);
                    let fine = 0.625 * w(2) + 0.25 * w(3) + 0.125 * w(4);
                    let slow = perlin.fbm(p, 2, 3);
                    chans[x + n * (y + n * z)] = [shape, fine, slow];
                }
            }
        }
        // Equalise each channel to 0..1, so `cover` reads as the share of the sky in cloud.
        let mut rgba = vec![255u8; n * n * n * 4];
        for c in 0..3 {
            let mut order: Vec<usize> = (0..chans.len()).collect();
            order.sort_by(|&a, &b| chans[a][c].total_cmp(&chans[b][c]));
            for (rank, &i) in order.iter().enumerate() {
                rgba[4 * i + c] = (rank * 256 / order.len()) as u8;
            }
        }
        Self { size: n, rgba }
    }

    /// Trilinear, wrapping sample at `p` in tiles (1 = one volume), channels 0..1, the same as
    /// the GPU's repeat sampler.
    pub fn sample(&self, p: [f32; 3]) -> [f32; 4] {
        let n = self.size;
        let mut base = [0usize; 3];
        let mut f = [0f32; 3];
        for k in 0..3 {
            let v = p[k] * n as f32 - 0.5;
            let fl = v.floor();
            f[k] = v - fl;
            base[k] = (fl as i64).rem_euclid(n as i64) as usize;
        }
        let mut out = [0f32; 4];
        for corner in 0..8 {
            let (dx, dy, dz) = (corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
            let wgt = (if dx == 1 { f[0] } else { 1.0 - f[0] })
                * (if dy == 1 { f[1] } else { 1.0 - f[1] })
                * (if dz == 1 { f[2] } else { 1.0 - f[2] });
            let (x, y, z) = ((base[0] + dx) % n, (base[1] + dy) % n, (base[2] + dz) % n);
            let i = 4 * (x + n * (y + n * z));
            for (c, o) in out.iter_mut().enumerate() {
                *o += wgt * self.rgba[i + c] as f32 / 255.0;
            }
        }
        out
    }
}

/// A seed for an island's clouds from its id, so every island gets its own sky.
pub fn seed(island: &str) -> u64 {
    island.bytes().fold(0xC10D_5EED_u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01B3))
}

pub fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `x` from `lo..hi` to `0..1` (not clamped).
pub fn remap(x: f32, lo: f32, hi: f32) -> f32 {
    (x - lo) / (hi - lo).max(1e-6)
}

/// Tileable gradient noise (Perlin 2002) on the unit cube, period = frequency.
struct Perlin {
    perm: [u8; 256],
}

impl Perlin {
    fn new(rng: &mut Rng) -> Self {
        let mut perm = [0u8; 256];
        for (i, p) in perm.iter_mut().enumerate() {
            *p = i as u8;
        }
        for i in (1..256).rev() {
            let j = (rng.next_u64() % (i as u64 + 1)) as usize;
            perm.swap(i, j);
        }
        Self { perm }
    }

    fn hash(&self, x: i64, y: i64, z: i64, period: i64) -> u8 {
        let (x, y, z) = (x.rem_euclid(period) as usize, y.rem_euclid(period) as usize, z.rem_euclid(period) as usize);
        self.perm[(self.perm[(self.perm[x & 255] as usize + y) & 255] as usize + z) & 255]
    }

    /// Noise at `p` (unit cube) with `freq` cells per side, about -1..1.
    fn at(&self, p: [f32; 3], freq: i64) -> f32 {
        let v = [p[0] * freq as f32, p[1] * freq as f32, p[2] * freq as f32];
        let i = [v[0].floor() as i64, v[1].floor() as i64, v[2].floor() as i64];
        let f = [v[0] - i[0] as f32, v[1] - i[1] as f32, v[2] - i[2] as f32];
        let fade = |t: f32| t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
        let u = [fade(f[0]), fade(f[1]), fade(f[2])];
        let grad = |h: u8, x: f32, y: f32, z: f32| {
            // The 12 cube-edge gradients (Perlin 2002).
            match h % 12 {
                0 => x + y,
                1 => -x + y,
                2 => x - y,
                3 => -x - y,
                4 => x + z,
                5 => -x + z,
                6 => x - z,
                7 => -x - z,
                8 => y + z,
                9 => -y + z,
                10 => y - z,
                _ => -y - z,
            }
        };
        let mut acc = [0f32; 8];
        for (c, a) in acc.iter_mut().enumerate() {
            let d = [(c & 1) as i64, ((c >> 1) & 1) as i64, ((c >> 2) & 1) as i64];
            let h = self.hash(i[0] + d[0], i[1] + d[1], i[2] + d[2], freq);
            *a = grad(h, f[0] - d[0] as f32, f[1] - d[1] as f32, f[2] - d[2] as f32);
        }
        let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
        let x00 = lerp(acc[0], acc[1], u[0]);
        let x10 = lerp(acc[2], acc[3], u[0]);
        let x01 = lerp(acc[4], acc[5], u[0]);
        let x11 = lerp(acc[6], acc[7], u[0]);
        lerp(lerp(x00, x10, u[1]), lerp(x01, x11, u[1]), u[2])
    }

    fn fbm(&self, p: [f32; 3], freq: i64, octaves: u32) -> f32 {
        let (mut sum, mut amp, mut f, mut norm) = (0.0, 1.0, freq, 0.0);
        for _ in 0..octaves {
            sum += amp * self.at(p, f);
            norm += amp;
            amp *= 0.5;
            f *= 2;
        }
        sum / norm
    }
}

/// Tileable cellular noise (Worley 1996): distance to the nearest of one random point per cell.
struct Worley {
    cells: usize,
    points: Vec<[f32; 3]>,
}

impl Worley {
    fn new(cells: usize, rng: &mut Rng) -> Self {
        let points = (0..cells * cells * cells)
            .map(|_| [rng.next_f64() as f32, rng.next_f64() as f32, rng.next_f64() as f32])
            .collect();
        Self { cells, points }
    }

    /// Distance to the nearest point, in cell sizes, clamped to 0..1.
    fn at(&self, p: [f32; 3]) -> f32 {
        let c = self.cells as i64;
        let v = [p[0] * c as f32, p[1] * c as f32, p[2] * c as f32];
        let i = [v[0].floor() as i64, v[1].floor() as i64, v[2].floor() as i64];
        let mut best = f32::MAX;
        for dz in -1..=1 {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let cell = [i[0] + dx, i[1] + dy, i[2] + dz];
                    let w = |k: usize| cell[k].rem_euclid(c) as usize;
                    let pt = self.points[w(0) + self.cells * (w(1) + self.cells * w(2))];
                    let mut d2 = 0.0;
                    for k in 0..3 {
                        let d = cell[k] as f32 + pt[k] - v[k];
                        d2 += d * d;
                    }
                    best = best.min(d2);
                }
            }
        }
        best.sqrt().min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn noise() -> &'static Noise {
        static N: OnceLock<Noise> = OnceLock::new();
        N.get_or_init(|| Noise::new(seed("saksun")))
    }

    #[test]
    fn noise_is_seeded_and_uses_its_range() {
        let a = noise();
        assert_eq!(a.rgba.len(), NOISE_SIZE.pow(3) * 4);
        let b = Noise::new(seed("saksun"));
        assert_eq!(a.rgba, b.rgba);
        assert_ne!(seed("saksun"), seed("tjornuvik"));
        for c in 0..3 {
            let v: Vec<u8> = a.rgba.iter().skip(c).step_by(4).copied().collect();
            let (lo, hi) = (*v.iter().min().unwrap(), *v.iter().max().unwrap());
            assert!(hi - lo > 120, "channel {c} spans only {lo}..{hi}");
        }
    }

    #[test]
    fn noise_tiles_without_a_seam() {
        // Neighbouring voxels across the wrap differ no more than neighbours inside.
        let n = noise();
        let s = n.size;
        let at = |x: usize, y: usize, z: usize| n.rgba[4 * (x + s * (y + s * z))] as i32;
        let (mut inside, mut seam) = (0i64, 0i64);
        for z in 0..s {
            for y in 0..s {
                inside += (at(s / 2, y, z) - at(s / 2 - 1, y, z)).abs() as i64;
                seam += (at(0, y, z) - at(s - 1, y, z)).abs() as i64;
            }
        }
        assert!((seam as f64) < inside as f64 * 1.5, "seam {seam} vs inside {inside}");
        // The sampler wraps: one tile over gives the same value.
        let p = [0.3, 0.6, 0.1];
        let (a, b) = (n.sample(p), n.sample([p[0] + 1.0, p[1] - 2.0, p[2] + 3.0]));
        assert!(a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-3), "{a:?} vs {b:?}");
    }

    #[test]
    fn more_cover_more_cloud_and_none_outside_the_layer() {
        let n = noise();
        let mut c = Clouds { cover: 0.0, ..Default::default() };
        assert_eq!(c.cover_fraction(n, 8000.0, 24, 0.0), 0.0);
        let mut last = 0.0;
        for cover in [0.3, 0.6, 1.0] {
            c.cover = cover;
            let f = c.cover_fraction(n, 8000.0, 24, 0.0);
            assert!(f > last, "cover {cover}: {f} not above {last}");
            // Cover reads as the share of sky in cloud.
            assert!((f - cover).abs() < 0.2, "cover {cover} covers {f}");
            last = f;
        }
        assert!(last > 0.95, "overcast covers {last}");
        assert_eq!(c.density_at(n, [0.0, c.base_m - 1.0, 0.0], 0.0), 0.0);
        assert_eq!(c.density_at(n, [0.0, c.top_m + 1.0, 0.0], 0.0), 0.0);
    }

    #[test]
    fn wind_moves_the_clouds() {
        let n = noise();
        let c = Clouds { cover: 0.5, wind: [10.0, 0.0], ..Default::default() };
        let p = [1234.0, 900.0, -567.0];
        let later = c.density_at(n, [p[0] + 10.0 * 60.0, p[1], p[2]], 60.0);
        assert!((c.density_at(n, p, 0.0) - later).abs() < 1e-4);
    }

    #[test]
    fn settings_are_checked() {
        assert!(Clouds::default().problems().is_empty());
        let bad = Clouds { cover: 1.5, top_m: 100.0, ..Default::default() };
        let p = bad.problems();
        assert!(p.iter().any(|m| m.contains("cover")) && p.iter().any(|m| m.contains("top_m")), "{p:?}");
    }
}
