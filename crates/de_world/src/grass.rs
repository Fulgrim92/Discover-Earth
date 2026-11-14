//! Where grass grows and how tall: tufts scattered over the land by rules, from the satellite's
//! land cover (ESA WorldCover) plus the terrain's slope, height and exposure.
//!
//! The island is cut into square chunks. Each chunk scatters its candidate tufts from its own
//! seed (the rules' seed and the chunk's coordinates), so a chunk is the same whichever way the
//! camera reaches it, and every capture is identical run to run. Each tuft carries a `keep`
//! number: a view far away draws only the tufts whose `keep` is under its level of detail, so
//! the near tufts are a superset of the far ones and nothing pops when the camera moves in.
//!
//! The rules are `grass` in `content/islands/<id>/rules.json` (`de schema rules`); the budgets
//! (`max_tufts` at any view) are checked by this module's tests on the real island.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Heightfield, Rng, truth::Truth};

/// How grass is scattered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct GrassRules {
    /// Tufts per square metre by WorldCover class name (`tree`, `shrub`, `grass`, `crop`,
    /// `built`, `bare`, `wetland`, `moss`, ...). Classes not listed get none. Without land
    /// cover data every land cell counts as `grass`.
    pub density: BTreeMap<String, f32>,
    /// Tuft height in metres, shortest and tallest, on sheltered low ground.
    pub height_m: [f32; 2],
    /// Gradient (metres up per metre across) where grass stops: cliffs and scree stay bare.
    pub max_gradient: f32,
    /// Grass thins and shortens with altitude: half as dense and tall this many metres up.
    pub half_at_m: f32,
    /// Ridges and knolls (ground this many metres above its surroundings) get half the height,
    /// as wind and grazing keep exposed grass short.
    pub exposed_m: f32,
    /// No grass within this many metres above the sea (beach, spray).
    pub above_sea_m: f32,
    /// Chunk size in metres.
    pub chunk_m: f32,
    /// Full density out to this distance from the camera...
    pub near_m: f32,
    /// ...thinning with distance squared (so it looks equally dense on screen), and none past this.
    pub far_m: f32,
    /// Most tufts any one view may draw. A test checks every view of the island against it.
    pub max_tufts: usize,
    /// How far the wind bends the tips, metres per metre of grass at 10 m/s.
    pub sway: f32,
    pub seed: u64,
}

impl Default for GrassRules {
    fn default() -> Self {
        let density =
            [("grass", 24.0), ("crop", 24.0), ("shrub", 12.0), ("moss", 8.0), ("wetland", 12.0), ("tree", 12.0)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
        Self {
            density,
            height_m: [0.06, 0.2],
            max_gradient: 1.1,
            half_at_m: 350.0,
            exposed_m: 12.0,
            above_sea_m: 2.5,
            chunk_m: 16.0,
            near_m: 6.0,
            far_m: 40.0,
            max_tufts: 20_000,
            sway: 0.35,
            seed: 1,
        }
    }
}

/// One tuft of grass on the ground at (x, z).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Tuft {
    pub x: f32,
    pub z: f32,
    /// Height in metres.
    pub height: f32,
    /// Which way the tuft leans at rest, radians from +x.
    pub turn: f32,
    /// 0 green and lush, 1 dry and straw-coloured (high, exposed or thin ground).
    pub dry: f32,
    /// Drawn only when the view's level of detail is above this (0..1).
    pub keep: f32,
}

/// Where grass may grow and how it grows there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Growth {
    /// Tufts per square metre.
    pub density: f32,
    /// 0..1 between `height_m[0]` and `height_m[1]`.
    pub tall: f32,
    pub dry: f32,
}

impl GrassRules {
    /// Growth at world x, z, from land cover (when there is any) and the terrain.
    pub fn growth(&self, field: &Heightfield, truth: Option<&Truth>, sea_level: f32, x: f32, z: f32) -> Growth {
        let none = Growth { density: 0.0, tall: 0.0, dry: 0.0 };
        if !field.contains(x, z) {
            return none;
        }
        let h = field.height(x, z);
        if h < sea_level + self.above_sea_m {
            return none;
        }
        let class = match truth.and_then(|t| t.cover_at(field, x, z)) {
            Some(code) => crate::truth::cover_name(code),
            None => "grass",
        };
        let base = self.density.get(class).copied().unwrap_or(0.0);
        if base <= 0.0 {
            return none;
        }
        let e = field.spacing[0].max(field.spacing[1]);
        let gx = (field.height(x + e, z) - field.height(x - e, z)) / (2.0 * e);
        let gz = (field.height(x, z + e) - field.height(x, z - e)) / (2.0 * e);
        let grad = gx.hypot(gz);
        // Thinning towards the steepest slopes grass holds on, gone beyond.
        let steep = 1.0 - smoothstep(self.max_gradient * 0.6, self.max_gradient, grad);
        let alt = 1.0 / (1.0 + (h / self.half_at_m.max(1.0)).powi(2));
        // Exposure: how far the ground stands above the ring around it (~4 cells out).
        let r = e * 4.0;
        let ring =
            (field.height(x + r, z) + field.height(x - r, z) + field.height(x, z + r) + field.height(x, z - r)) / 4.0;
        let exposed = smoothstep(0.0, self.exposed_m.max(0.1), h - ring);
        let density = base * steep * (0.4 + 0.6 * alt);
        let tall = (alt * (1.0 - 0.5 * exposed) * (0.5 + 0.5 * steep)).clamp(0.0, 1.0);
        let dry = (1.0 - alt + exposed * 0.5 + (1.0 - steep) * 0.4).clamp(0.0, 1.0);
        Growth { density, tall, dry }
    }

    /// Chunk coordinates of the chunk holding world x, z.
    pub fn chunk_of(&self, x: f32, z: f32) -> [i32; 2] {
        [(x / self.chunk_m).floor() as i32, (z / self.chunk_m).floor() as i32]
    }

    /// Every candidate tuft of one chunk (all `keep` values), in a fixed order.
    pub fn scatter(&self, field: &Heightfield, truth: Option<&Truth>, sea_level: f32, chunk: [i32; 2]) -> Vec<Tuft> {
        let max_density = self.density.values().copied().fold(0.0f32, f32::max);
        let area = self.chunk_m * self.chunk_m;
        let n = (max_density * area).round() as usize;
        let seed = self.seed ^ (chunk[0] as u32 as u64).wrapping_mul(0x9E37_79B9) ^ ((chunk[1] as u32 as u64) << 32);
        let mut rng = Rng::new(seed);
        let mut f = || rng.next_f64() as f32;
        let (x0, z0) = (chunk[0] as f32 * self.chunk_m, chunk[1] as f32 * self.chunk_m);
        let mut out = Vec::new();
        for _ in 0..n {
            let (x, z) = (x0 + f() * self.chunk_m, z0 + f() * self.chunk_m);
            let (accept, keep, turn, vary) = (f(), f(), f(), f());
            let g = self.growth(field, truth, sea_level, x, z);
            if accept * max_density >= g.density {
                continue;
            }
            let t = (g.tall * (0.6 + 0.8 * vary)).clamp(0.0, 1.0);
            out.push(Tuft {
                x,
                z,
                height: self.height_m[0] + (self.height_m[1] - self.height_m[0]) * t,
                turn: turn * std::f32::consts::TAU,
                dry: (g.dry + (vary - 0.5) * 0.3).clamp(0.0, 1.0),
                keep,
            });
        }
        out
    }

    /// Level of detail at a distance: 1 up to `near_m`, then (near / d)², 0 past `far_m`.
    pub fn lod(&self, dist: f32) -> f32 {
        if dist >= self.far_m {
            0.0
        } else if dist <= self.near_m {
            1.0
        } else {
            (self.near_m / dist).powi(2)
        }
    }

    /// The chunks a camera at `eye` draws, each with the level of detail of its nearest point
    /// (an upper bound for its tufts). Chunks wholly past `far_m` are left out.
    pub fn chunks_near(&self, eye: [f32; 3], ground: impl Fn(f32, f32) -> f32) -> Vec<([i32; 2], f32)> {
        let reach = (self.far_m / self.chunk_m).ceil() as i32 + 1;
        let [cx, cz] = self.chunk_of(eye[0], eye[2]);
        let mut out = Vec::new();
        for dz in -reach..=reach {
            for dx in -reach..=reach {
                let c = [cx + dx, cz + dz];
                let (x0, z0) = (c[0] as f32 * self.chunk_m, c[1] as f32 * self.chunk_m);
                let nx = eye[0].clamp(x0, x0 + self.chunk_m);
                let nz = eye[2].clamp(z0, z0 + self.chunk_m);
                let dy = (eye[1] - ground(nx, nz)).max(0.0);
                let d = ((nx - eye[0]).powi(2) + (nz - eye[2]).powi(2) + dy * dy).sqrt();
                let lod = self.lod(d);
                if lod > 0.0 {
                    out.push((c, lod));
                }
            }
        }
        out
    }

    /// The tufts a camera at `eye` draws: what [`GrassRules::chunks_near`] picks, each tuft kept
    /// when its own distance's level of detail is over its `keep`.
    pub fn view(&self, field: &Heightfield, truth: Option<&Truth>, sea_level: f32, eye: [f32; 3]) -> Vec<Tuft> {
        let mut out = Vec::new();
        for (c, _) in self.chunks_near(eye, |x, z| field.height(x, z)) {
            for t in self.scatter(field, truth, sea_level, c) {
                let dy = eye[1] - field.height(t.x, t.z);
                let d = ((t.x - eye[0]).powi(2) + (t.z - eye[2]).powi(2) + dy * dy).sqrt();
                if t.keep < self.lod(d) {
                    out.push(t);
                }
            }
        }
        out
    }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A coast: sea in the south, a meadow rising gently north to a cliff and a high plateau.
    fn coast() -> Heightfield {
        let (w, d) = (60, 60);
        let mut heights = vec![0.0; w * d];
        for r in 0..d {
            for c in 0..w {
                let from_sea = (50 - r as i32).max(0) as f32; // rows from the shore, going north
                let mut h = if r >= 50 { 0.0 } else { 3.0 + from_sea * 2.0 };
                if r < 20 {
                    h += 300.0; // a cliff at row 20 and a plateau above it
                }
                heights[r * w + c] = h + c as f32 * 0.0;
            }
        }
        Heightfield { width: w, depth: d, spacing: [30.0, 30.0], heights }
    }

    fn xz(f: &Heightfield, c: usize, r: usize) -> (f32, f32) {
        let [x, z] = f.world_xz(c, r);
        (x, z)
    }

    #[test]
    fn meadows_grow_cliffs_and_sea_stay_bare() {
        let f = coast();
        let g = GrassRules::default();
        let (x, z) = xz(&f, 30, 40);
        let meadow = g.growth(&f, None, 0.6, x, z);
        assert!(meadow.density > 16.0, "{meadow:?}");
        let (x, z) = xz(&f, 30, 55);
        assert_eq!(g.growth(&f, None, 0.6, x, z).density, 0.0, "sea");
        let (x, z) = xz(&f, 30, 20);
        assert!(g.growth(&f, None, 0.6, x, z - 15.0).density < 0.5, "cliff face");
        // Up on the plateau: thinner, shorter and drier than the meadow.
        let (x, z) = xz(&f, 30, 8);
        let high = g.growth(&f, None, 0.6, x, z);
        assert!(high.density < meadow.density && high.tall < meadow.tall && high.dry > meadow.dry, "{high:?}");
    }

    #[test]
    fn chunks_are_seeded_and_near_is_a_superset_of_far() {
        let f = coast();
        let g = GrassRules::default();
        let c = g.chunk_of(0.0, 400.0);
        assert_eq!(g.scatter(&f, None, 0.6, c), g.scatter(&f, None, 0.6, c));
        assert_ne!(g.scatter(&f, None, 0.6, c), g.scatter(&f, None, 0.6, [c[0] + 1, c[1]]));
        let ground = f.height(0.0, 400.0);
        let near = g.view(&f, None, 0.6, [0.0, ground + 1.7, 400.0]);
        let far = g.view(&f, None, 0.6, [0.0, ground + 30.0, 400.0]);
        assert!(!near.is_empty() && far.len() < near.len(), "{} {}", near.len(), far.len());
        assert!(far.iter().all(|t| near.contains(t)), "every far tuft is drawn near too");
        // High above the ground nothing is drawn.
        assert!(g.view(&f, None, 0.6, [0.0, ground + 200.0, 400.0]).is_empty());
    }

    #[test]
    fn every_view_of_every_island_fits_the_budget() {
        let content = crate::content_dir();
        for id in crate::island_ids(&content) {
            let island = crate::Island::load(&content, &id).unwrap();
            let field = island.heightfield(&content, &id).unwrap();
            let truth = Truth::load(&content, &id, &island).unwrap();
            let rules = crate::water::Rules::load(&content, &id).unwrap().grass;
            let sea = crate::sense::SEA_LEVEL_M + island.look.tide_m;
            // Each view, and standing on the land on a 2 km grid (the densest case: grass all
            // around at full detail).
            let mut eyes: Vec<(String, [f32; 3])> = island.views.iter().map(|v| (v.name.clone(), v.pos)).collect();
            let [w, d] = field.extent();
            let mut z = -d / 2.0 + 1000.0;
            while z < d / 2.0 {
                let mut x = -w / 2.0 + 1000.0;
                while x < w / 2.0 {
                    let g = field.height(x, z);
                    if g > sea + 3.0 {
                        eyes.push((format!("standing at ({x}, {z})"), [x, g + 1.7, z]));
                    }
                    x += 2000.0;
                }
                z += 2000.0;
            }
            let mut most = (0, String::new());
            for (name, eye) in eyes {
                let n = rules.view(&field, truth.as_ref(), sea, eye).len();
                assert!(n <= rules.max_tufts, "{id} {name}: {n} tufts > {}", rules.max_tufts);
                if n > most.0 {
                    most = (n, name);
                }
            }
            eprintln!("{id}: most tufts {} ({}), budget {}", most.0, most.1, rules.max_tufts);
            assert!(most.0 > 0, "{id}: no grass anywhere");
        }
    }
}
