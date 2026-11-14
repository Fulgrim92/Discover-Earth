//! Where grass, heather and moss grow and how tall: tufts scattered over the land by rules,
//! from the satellite's land cover (ESA WorldCover) plus the terrain's slope, height, exposure
//! and shelter. Faroese ground is grazed turf in the valleys, taller grass in sheltered hollows,
//! heather on the drier upland slopes and moss (woolly fringe-moss heath, bog moss) on the high
//! plateaus and the wet flats.
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
    /// Grass tuft height in metres, shortest and tallest, on open low ground.
    pub height_m: [f32; 2],
    /// Tallest grass in fully sheltered spots (hollows, gullies, valley floors under slopes),
    /// metres: out of the wind and away from the sheep, grass grows long.
    pub sheltered_height_m: f32,
    /// Ground this many metres below the ring around it counts as fully sheltered.
    pub sheltered_m: f32,
    /// Share of tufts that are heather, by land cover class; plus `heather_upland` on the
    /// slopes between `upland_m[0]` and `upland_m[1]` metres up.
    pub heather: BTreeMap<String, f32>,
    pub heather_upland: f32,
    /// Share of tufts that are moss, by land cover class; plus `moss_high` above `upland_m[1]`,
    /// and `moss_wet` on flat sheltered ground (bog).
    pub moss: BTreeMap<String, f32>,
    pub moss_high: f32,
    pub moss_wet: f32,
    /// Where the upland begins and where it is fully upland, metres above the sea.
    pub upland_m: [f32; 2],
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
        let map = |v: &[(&str, f32)]| v.iter().map(|&(k, v)| (k.to_string(), v)).collect();
        Self {
            density: map(&[
                ("grass", 24.0),
                ("crop", 24.0),
                ("shrub", 16.0),
                ("tree", 16.0),
                ("moss", 16.0),
                ("wetland", 16.0),
                ("bare", 3.0),
            ]),
            height_m: [0.06, 0.2],
            sheltered_height_m: 0.45,
            sheltered_m: 8.0,
            // WorldCover's few "tree" pixels on the Faroes are dark heath, not woods.
            heather: map(&[("shrub", 0.75), ("tree", 0.7), ("grass", 0.03)]),
            heather_upland: 0.5,
            moss: map(&[("moss", 0.85), ("wetland", 0.5), ("bare", 0.9), ("grass", 0.03)]),
            moss_high: 0.55,
            moss_wet: 0.35,
            upland_m: [150.0, 400.0],
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

/// What a tuft is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Plant {
    Grass,
    Heather,
    Moss,
}

/// One tuft of grass, heather or moss on the ground at (x, z).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Tuft {
    pub x: f32,
    pub z: f32,
    pub plant: Plant,
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
    /// 0 open, 1 fully sheltered (grass grows towards `sheltered_height_m`).
    pub shelter: f32,
    /// Shares of the tufts that are heather and moss (the rest is grass).
    pub heather: f32,
    pub moss: f32,
}

impl GrassRules {
    /// Growth at world x, z, from land cover (when there is any) and the terrain.
    pub fn growth(&self, field: &Heightfield, truth: Option<&Truth>, sea_level: f32, x: f32, z: f32) -> Growth {
        let none = Growth { density: 0.0, tall: 0.0, dry: 0.0, shelter: 0.0, heather: 0.0, moss: 0.0 };
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
        let shelter = smoothstep(0.0, self.sheltered_m.max(0.1), ring - h) * alt;
        let density = base * steep * (0.4 + 0.6 * alt);
        let tall = (alt * (1.0 - 0.5 * exposed) * (0.5 + 0.5 * steep)).clamp(0.0, 1.0);
        let dry = (1.0 - alt + exposed * 0.5 + (1.0 - steep) * 0.4).clamp(0.0, 1.0);
        let up = smoothstep(self.upland_m[0], self.upland_m[1], h);
        let high = smoothstep(self.upland_m[1] * 0.85, self.upland_m[1] * 1.3, h);
        // Heather likes drained upland slopes, not the plateaus or the flats.
        let drained = smoothstep(0.03, 0.15, grad);
        let flat = 1.0 - smoothstep(0.02, 0.08, grad);
        let share = |m: &BTreeMap<String, f32>| m.get(class).copied().unwrap_or(0.0);
        let mut moss =
            share(&self.moss) + self.moss_high * high + self.moss_wet * flat * shelter.max(0.5 * (1.0 - alt));
        moss = moss.clamp(0.0, 1.0);
        let heather =
            ((share(&self.heather) + self.heather_upland * up * (1.0 - high) * drained) * (1.0 - moss)).clamp(0.0, 1.0);
        // Heather and moss grow in patches a few metres across, not evenly mixed into the grass.
        let (ph, pm) = (patch(x, z, self.seed), patch(x + 517.0, z - 211.0, self.seed));
        let moss = (moss * 2.0 * pm).clamp(0.0, 1.0);
        let heather = (heather * 2.0 * ph).clamp(0.0, 1.0 - moss);
        Growth { density, tall, dry, shelter, heather, moss }
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
            let (accept, keep, turn, vary, pick) = (f(), f(), f(), f(), f());
            let g = self.growth(field, truth, sea_level, x, z);
            if accept * max_density >= g.density {
                continue;
            }
            let t = (g.tall * (0.6 + 0.8 * vary)).clamp(0.0, 1.0);
            let plant = if pick < g.moss {
                Plant::Moss
            } else if pick < g.moss + g.heather {
                Plant::Heather
            } else {
                Plant::Grass
            };
            let open = self.height_m[0] + (self.height_m[1] - self.height_m[0]) * t;
            let height = match plant {
                Plant::Grass => open + (self.sheltered_height_m * (0.6 + 0.4 * vary) - open).max(0.0) * g.shelter,
                Plant::Heather => 0.12 + 0.25 * t,
                Plant::Moss => 0.03 + 0.04 * vary,
            };
            out.push(Tuft {
                x,
                z,
                plant,
                height,
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

/// Smooth seeded noise in 0..1 with features about `PATCH_M` across (value noise, smoothstep
/// interpolation), for patches of heather and moss.
fn patch(x: f32, z: f32, seed: u64) -> f32 {
    const PATCH_M: f32 = 6.0;
    let (fx, fz) = (x / PATCH_M, z / PATCH_M);
    let (ix, iz) = (fx.floor(), fz.floor());
    let corner = |a: f32, b: f32| {
        let h = (a as i32 as u32 as u64) << 32 | (b as i32 as u32 as u64);
        Rng::new(h ^ seed.wrapping_mul(0x9E37_79B9_7F4A_7C15)).next_f64() as f32
    };
    let (tx, tz) = (smoothstep(0.0, 1.0, fx - ix), smoothstep(0.0, 1.0, fz - iz));
    let top = corner(ix, iz) + (corner(ix + 1.0, iz) - corner(ix, iz)) * tx;
    let bottom = corner(ix, iz + 1.0) + (corner(ix + 1.0, iz + 1.0) - corner(ix, iz + 1.0)) * tx;
    top + (bottom - top) * tz
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
    fn heather_on_upland_slopes_moss_up_high_and_long_grass_in_hollows() {
        let g = GrassRules::default();
        // A slope rising 0.15 m per metre east from the sea to 600 m, with a hollow at 60 m.
        let (w, d) = (160, 20);
        let mut heights: Vec<f32> = (0..w * d).map(|i| (i % w) as f32 * 30.0 * 0.15).collect();
        for r in 0..d {
            for c in 12..15 {
                heights[r * w + c] -= 12.0;
            }
        }
        let f = Heightfield { width: w, depth: d, spacing: [30.0, 30.0], heights };
        let at = |c: usize| {
            let [x, z] = f.world_xz(c, d / 2);
            g.growth(&f, None, 0.6, x, z)
        };
        let low = at(30); // 135 m, open slope
        let mid = at(60); // 270 m
        let top = at(140); // 630 m
        assert!(mid.heather > low.heather + 0.2, "{mid:?} vs {low:?}");
        assert!(top.moss > 0.4 && top.moss > mid.moss, "{top:?}");
        let hollow = at(13);
        assert!(hollow.shelter > 0.5 && low.shelter < 0.1, "{hollow:?} {low:?}");
        // So grass in the hollow grows longer than on the open slope.
        let tufts = |c: usize| {
            let [x, z] = f.world_xz(c, d / 2);
            g.scatter(&f, None, 0.6, g.chunk_of(x, z))
        };
        let tallest = |v: Vec<Tuft>| v.iter().filter(|t| t.plant == Plant::Grass).map(|t| t.height).fold(0.0, f32::max);
        assert!(tallest(tufts(13)) > tallest(tufts(30)) + 0.1);
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
