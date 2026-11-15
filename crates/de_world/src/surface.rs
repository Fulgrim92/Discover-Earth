//! The ground as the renderer draws it: the heightmap followed smoothly, with seeded small
//! relief and water cut in. The sensor casts against it so its labels match the render.

use crate::island::Look;
use crate::water::Water;
use crate::{Heightfield, Rng};

/// The ground's height on the render mesh's grid: the heightmap followed smoothly
/// (Catmull-Rom) plus `look.relief_m` of seeded small relief, with stream channels and lake
/// beds cut in when water is given. [`Surface::height`] matches the mesh's triangles exactly,
/// so water can sit on it.
#[derive(Clone)]
pub struct Surface {
    pub w: usize,
    pub d: usize,
    pub step: [f32; 2],
    pub extent: [f32; 2],
    /// Height per vertex before the seabed drop.
    pub heights: Vec<f32>,
}
impl Surface {
    pub fn new(h: &Heightfield, look: &Look, seed_name: &str, water: Option<(&Water, f32)>) -> Self {
        let sub = look.subdivide.clamp(1, 4) as usize;
        let (w, d) = ((h.width - 1) * sub + 1, (h.depth - 1) * sub + 1);
        let step = [h.spacing[0] / sub as f32, h.spacing[1] / sub as f32];
        let seed = seed_name.bytes().fold(2166136261u32, |a, b| (a ^ u32::from(b)).wrapping_mul(16777619));
        let relief = relief(w, d, seed);
        let extent = h.extent();
        let bank = step[0].max(step[1]) * 1.2;
        let mut heights = vec![0.0f32; w * d];
        for row in 0..d {
            for col in 0..w {
                let (fx, fz) = (col as f32 / sub as f32, row as f32 / sub as f32);
                let y0 = bicubic(h, fx, fz);
                let (x, z) = (col as f32 * step[0] - extent[0] / 2.0, row as f32 * step[1] - extent[1] / 2.0);
                // Relief only on land, fading in above the shoreline, and none in or by water.
                let mut r = relief[row * w + col] * look.relief_m * (y0 / 8.0).clamp(0.0, 1.0);
                let mut y = y0;
                if let Some((water, depth)) = water {
                    let carved = water.carve(x, z, y0, depth, bank);
                    if carved < y0 {
                        r = 0.0;
                        y = carved;
                    }
                }
                heights[row * w + col] = y + r;
            }
        }
        Self { w, d, step, extent, heights }
    }

    pub fn at(&self, c: usize, r: usize) -> f32 {
        self.heights[r.min(self.d - 1) * self.w + c.min(self.w - 1)]
    }

    /// Height of the mesh's surface at world x, z (on its triangles, as drawn).
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let fx = ((x + self.extent[0] / 2.0) / self.step[0]).clamp(0.0, (self.w - 1) as f32 - 1e-3);
        let fz = ((z + self.extent[1] / 2.0) / self.step[1]).clamp(0.0, (self.d - 1) as f32 - 1e-3);
        let (c, r) = (fx.floor() as usize, fz.floor() as usize);
        let (tx, tz) = (fx - c as f32, fz - r as f32);
        let (i, rt, b, br) = (self.at(c, r), self.at(c + 1, r), self.at(c, r + 1), self.at(c + 1, r + 1));
        // Triangles (i, b, rt) and (rt, b, br), split along rt-b.
        if tx + tz <= 1.0 {
            i + (rt - i) * tx + (b - i) * tz
        } else {
            br + (b - br) * (1.0 - tx) + (rt - br) * (1.0 - tz)
        }
    }
}

/// Height at fractional pixel (fx, fz), Catmull-Rom in both directions.
fn bicubic(h: &Heightfield, fx: f32, fz: f32) -> f32 {
    let (c, r) = (fx.floor() as isize, fz.floor() as isize);
    let (tx, tz) = (fx - c as f32, fz - r as f32);
    let px = |c: isize, r: isize| h.at(c.max(0) as usize, r.max(0) as usize);
    let cr = |p0: f32, p1: f32, p2: f32, p3: f32, t: f32| {
        p1 + 0.5 * t * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)))
    };
    let rows: Vec<f32> =
        (-1..=2).map(|dr| cr(px(c - 1, r + dr), px(c, r + dr), px(c + 1, r + dr), px(c + 2, r + dr), tx)).collect();
    cr(rows[0], rows[1], rows[2], rows[3], tz)
}

/// Smooth seeded relief in -1..1 on a w x d grid: random values blurred twice.
fn relief(w: usize, d: usize, seed: u32) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    let mut v: Vec<f32> = (0..w * d).map(|_| rng.next_f64() as f32 * 2.0 - 1.0).collect();
    for _ in 0..2 {
        let src = v.clone();
        for r in 0..d {
            for c in 0..w {
                let mut sum = 0.0;
                for (dc, dr) in [(-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] {
                    let cc = (c as isize + dc).clamp(0, w as isize - 1) as usize;
                    let rr = (r as isize + dr).clamp(0, d as isize - 1) as usize;
                    sum += src[rr * w + cc];
                }
                v[r * w + c] = sum / 9.0;
            }
        }
    }
    // Blurring shrinks the range; stretch it back to roughly -1..1.
    let max = v.iter().fold(0.0f32, |m, x| m.max(x.abs())).max(1e-6);
    v.iter().map(|x| x / max).collect()
}
