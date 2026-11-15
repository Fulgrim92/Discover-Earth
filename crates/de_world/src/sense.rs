//! Sensor packs: what a shot shows, as numbers, label images and a sentence.
//!
//! A model judging a PNG is good at "does this look like a Faroese valley" and poor at "is
//! the fog 10% too dense". So next to every shot `de-shot` writes what the camera sees,
//! computed by casting a ray per pixel against the island's heightfield and the sea with the
//! shot's exact camera: which class each pixel is (sky, sea, grass, rock, shore, moss), how
//! far away it is and which way it faces. Combined with the rendered PNG that gives coverage,
//! distances, colour and brightness per class, a 3x3 composition grid, sun and fog, and a
//! plain text description. It runs on the CPU from data, so it needs no GPU and can't drift
//! from the island.
//!
//! The rays see the heightfield (bilinear), not the render mesh with its sub-pixel relief, so
//! labels can be a pixel or two off at silhouettes.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Heightfield, Island,
    image::{Rgba, luma},
    island::{Look, Vec3, layer_weights},
};

/// Height of the sea surface in metres.
pub const SEA_LEVEL_M: f32 = 0.6;

/// Where a shot's camera was: written by `de-shot` to `<out>/shots.json` for every saved frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CameraShot {
    /// File name without `.png`, relative to the output folder (`valley`, `flyover/frame_0001`).
    pub name: String,
    /// Frame number of game time (60 per second) when it was taken.
    pub frame: u64,
    pub pos: Vec3,
    pub forward: Vec3,
    pub up: Vec3,
    pub right: Vec3,
    /// Vertical field of view, degrees.
    pub fov_y_deg: f32,
    /// Image size in pixels.
    pub size: [u32; 2],
}

/// What a pixel shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    Sky,
    Sea,
    Grass,
    Rock,
    Shore,
    Moss,
    /// Streams and lakes (see [`crate::water`]).
    Water,
}

impl Class {
    pub const ALL: [Class; 7] =
        [Class::Sky, Class::Sea, Class::Grass, Class::Rock, Class::Shore, Class::Moss, Class::Water];

    pub fn name(self) -> &'static str {
        match self {
            Class::Sky => "sky",
            Class::Sea => "sea",
            Class::Grass => "grass",
            Class::Rock => "rock",
            Class::Shore => "shore",
            Class::Moss => "moss",
            Class::Water => "water",
        }
    }

    /// Colour in `<shot>.labels.png`.
    pub fn colour(self) -> [u8; 4] {
        match self {
            Class::Sky => [120, 180, 255, 255],
            Class::Sea => [20, 40, 160, 255],
            Class::Grass => [90, 200, 60, 255],
            Class::Rock => [140, 110, 90, 255],
            Class::Shore => [230, 210, 130, 255],
            Class::Moss => [30, 100, 40, 255],
            Class::Water => [0, 200, 255, 255],
        }
    }

    pub fn is_land(self) -> bool {
        matches!(self, Class::Grass | Class::Rock | Class::Shore | Class::Moss | Class::Water)
    }
}

/// Per-pixel buffers at the sensor's resolution.
pub struct Buffers {
    pub width: u32,
    pub height: u32,
    pub class: Vec<Class>,
    /// Distance along the ray in metres; infinite for sky.
    pub depth: Vec<f32>,
    pub normal: Vec<Vec3>,
    /// Whether the land at this pixel is in the sun's shadow (terrain between it and the sun).
    pub shaded: Vec<bool>,
    /// World position the ray hit; meaningless for sky.
    pub pos: Vec<Vec3>,
}

/// The island as the sensor sees it.
pub struct World<'a> {
    pub island: &'a Island,
    pub field: &'a Heightfield,
    pub water: Option<&'a crate::water::Water>,
    /// The ground as the renderer draws it; the heightmap when none is given.
    pub surface: Option<&'a crate::Surface>,
    top: f32,
}

impl<'a> World<'a> {
    pub fn new(island: &'a Island, field: &'a Heightfield) -> Self {
        Self { island, field, water: None, surface: None, top: field.max_height().max(1.0) }
    }

    /// Also see streams and lakes: ground under them is [`Class::Water`].
    pub fn with_water(mut self, water: &'a crate::water::Water) -> Self {
        self.water = Some(water);
        self
    }

    /// Cast against the render's ground ([`crate::Surface`]: smooth, with relief and water
    /// cut in) instead of the bilinear heightmap, so labels and depth match the image.
    pub fn with_surface(mut self, surface: &'a crate::Surface) -> Self {
        self.surface = Some(surface);
        self
    }

    /// Ground height at world x, z.
    pub fn ground(&self, x: f32, z: f32) -> f32 {
        match self.surface {
            Some(s) => s.height(x, z),
            None => self.field.height(x, z),
        }
    }

    fn look(&self) -> &Look {
        &self.island.look
    }

    /// Cast one ray. Returns (distance, class, normal), or None for sky.
    pub fn cast(&self, o: Vec3, d: Vec3, max_t: f32) -> Option<(f32, Class, Vec3)> {
        let sea = SEA_LEVEL_M + self.look().tide_m;
        let t_sea = if d[1] < -1e-6 { (sea - o[1]) / d[1] } else { f32::INFINITY };
        let t_sea = if t_sea >= 0.0 { t_sea } else { f32::INFINITY };
        let end = t_sea.min(max_t);
        let at = |t: f32| [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
        let f = self.field;
        // Above ground and land: how far the ray is above the terrain at t, or None if there is
        // no land under that point.
        let gap = |p: Vec3| -> Option<f32> {
            if !f.contains(p[0], p[2]) {
                return None;
            }
            let h = self.ground(p[0], p[2]);
            if h <= 0.5 { None } else { Some(p[1] - h) }
        };
        let mut t = 0.0f32;
        let mut prev = 0.0f32;
        while t < end {
            let p = at(t);
            if p[1] > self.top + 1.0 && d[1] >= 0.0 {
                break;
            }
            match gap(p) {
                Some(g) if g <= 0.0 => {
                    // Refine between the last point above ground and this one.
                    let (mut lo, mut hi) = (prev, t);
                    for _ in 0..12 {
                        let mid = 0.5 * (lo + hi);
                        if gap(at(mid)).is_some_and(|g| g <= 0.0) {
                            hi = mid;
                        } else {
                            lo = mid;
                        }
                    }
                    let p = at(hi);
                    return Some((hi, self.ground_class(p), self.normal(p)));
                }
                Some(g) => {
                    prev = t;
                    t += (g * 0.5).max(0.25 + t * 0.0015);
                }
                None => {
                    prev = t;
                    t += (2.0 + t * 0.004).max(f.spacing[0] * 0.5);
                }
            }
        }
        (t_sea <= max_t).then_some((t_sea, Class::Sea, [0.0, 1.0, 0.0]))
    }

    /// How close a ray from `o` along `d` comes to land at least `above_m` over the sea within
    /// its first `within_m` metres (least height above that land; infinite if it passes none).
    pub fn clearance(&self, o: Vec3, d: Vec3, within_m: f32, above_m: f32) -> f32 {
        let f = self.field;
        let sea = SEA_LEVEL_M + self.look().tide_m;
        let mut least = f32::INFINITY;
        let mut t = 0.25;
        while t < within_m {
            let p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
            if f.contains(p[0], p[2]) {
                let h = self.ground(p[0], p[2]);
                if h > sea + above_m {
                    least = least.min(p[1] - h);
                }
            }
            t += 0.25 + t * 0.01;
        }
        least
    }

    fn normal(&self, p: Vec3) -> Vec3 {
        let f = self.field;
        let (sx, sz) = (f.spacing[0], f.spacing[1]);
        let (l, r) = (self.ground(p[0] - sx, p[2]), self.ground(p[0] + sx, p[2]));
        let (u, dn) = (self.ground(p[0], p[2] - sz), self.ground(p[0], p[2] + sz));
        let n = [(l - r) / (2.0 * sx), 1.0, (u - dn) / (2.0 * sz)];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        [n[0] / len, n[1] / len, n[2] / len]
    }

    /// The dominant ground layer at a point, by the same weights the terrain shader blends.
    fn ground_class(&self, p: Vec3) -> Class {
        if self.water.is_some_and(|w| w.channel(p[0], p[2], 0.0).is_some()) {
            return Class::Water;
        }
        let n = self.normal(p);
        let w = layer_weights(p[1], 1.0 - n[1], self.top, self.look());
        let i = (0..4).max_by(|&a, &b| w[a].total_cmp(&w[b])).unwrap_or(0);
        [Class::Grass, Class::Rock, Class::Shore, Class::Moss][i]
    }

    /// Cast a ray per pixel for `cam`, at most `max_w` pixels wide.
    pub fn buffers(&self, cam: &CameraShot, max_w: u32) -> Buffers {
        let w = cam.size[0].min(max_w).max(1);
        let h = ((cam.size[1] as f32 * w as f32 / cam.size[0] as f32).round() as u32).max(1);
        let tan = (cam.fov_y_deg.to_radians() * 0.5).tan();
        let aspect = cam.size[0] as f32 / cam.size[1] as f32;
        let mut class = Vec::with_capacity((w * h) as usize);
        let mut depth = Vec::with_capacity((w * h) as usize);
        let mut normal = Vec::with_capacity((w * h) as usize);
        let mut shaded = Vec::with_capacity((w * h) as usize);
        let mut pos = Vec::with_capacity((w * h) as usize);
        let sun = to_sun(self.look());
        for py in 0..h {
            for px in 0..w {
                let x = (2.0 * (px as f32 + 0.5) / w as f32 - 1.0) * tan * aspect;
                let y = (1.0 - 2.0 * (py as f32 + 0.5) / h as f32) * tan;
                let d = norm(add3(cam.forward, add3(scale(cam.right, x), scale(cam.up, y))));
                match self.cast(cam.pos, d, 80_000.0) {
                    Some((t, c, n)) => {
                        let p = add3(add3(cam.pos, scale(d, t)), scale(n, 2.0));
                        shaded.push(c.is_land() && (dot(n, sun) <= 0.0 || self.blocks(p, sun)));
                        pos.push(add3(cam.pos, scale(d, t)));
                        class.push(c);
                        depth.push(t);
                        normal.push(n);
                    }
                    None => {
                        class.push(Class::Sky);
                        depth.push(f32::INFINITY);
                        normal.push([0.0, 0.0, 0.0]);
                        shaded.push(false);
                        pos.push([0.0; 3]);
                    }
                }
            }
        }
        Buffers { width: w, height: h, class, depth, normal, shaded, pos }
    }

    /// Whether terrain lies on the way from `p` towards `dir` (for sun shadows).
    fn blocks(&self, p: Vec3, dir: Vec3) -> bool {
        self.cast(p, dir, 30_000.0).is_some_and(|(_, c, _)| c.is_land())
    }
}

impl Buffers {
    pub fn labels_png(&self) -> Rgba {
        let mut img = Rgba::new(self.width, self.height, [0, 0, 0, 255]);
        // Land in the sun's shadow is drawn at half brightness.
        img.pixels = self
            .class
            .iter()
            .zip(&self.shaded)
            .map(|(c, &s)| {
                let k = c.colour();
                if s { [k[0] / 2, k[1] / 2, k[2] / 2, 255] } else { k }
            })
            .collect();
        img
    }

    /// Nearer is brighter, on a log scale from 10 m (white) to 50 km (black); sky is black.
    pub fn depth_png(&self) -> Rgba {
        let mut img = Rgba::new(self.width, self.height, [0, 0, 0, 255]);
        img.pixels = self
            .depth
            .iter()
            .map(|&t| {
                if !t.is_finite() {
                    return [0, 0, 0, 255];
                }
                let v = 1.0 - ((t.max(10.0) / 10.0).ln() / (5000.0f32).ln()).clamp(0.0, 1.0);
                let g = (v * 255.0) as u8;
                [g, g, g, 255]
            })
            .collect();
        img
    }

    /// World normals as colour (x east, y up, z south mapped to r, g, b).
    pub fn normal_png(&self) -> Rgba {
        let mut img = Rgba::new(self.width, self.height, [0, 0, 0, 255]);
        img.pixels = self
            .normal
            .iter()
            .map(|n| n.map(|v| ((v * 0.5 + 0.5) * 255.0) as u8))
            .map(|n| [n[0], n[1], n[2], 255])
            .collect();
        img
    }
}

/// Everything known about one shot. Written as `<shot>.sense.json`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Report {
    pub name: String,
    pub camera: CameraFacts,
    /// Share of the frame per class (sky, sea, grass, rock, shore, moss) and `land` for all ground.
    pub coverage: BTreeMap<String, f32>,
    /// Dominant class in each cell of a 3x3 grid, top row first, left to right.
    pub grid: [[String; 3]; 3],
    pub distance_m: Distances,
    /// Mean height of the skyline from the top of the frame, 0 (top) .. 1 (bottom); null when
    /// no sky is visible.
    pub skyline: Option<f32>,
    pub sun: SunFacts,
    pub fog: FogFacts,
    /// From the rendered PNG, when it exists.
    pub image: Option<ImageFacts>,
    /// Against the satellite (`scripts/truth/fetch.py`), when the island has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truth: Option<crate::truth::ShotTruth>,
    /// The above as sentences.
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CameraFacts {
    pub pos: Vec3,
    /// Compass bearing the camera faces, degrees (0 north, 90 east).
    pub heading_deg: f32,
    /// Up (+) or down (-) from level, degrees.
    pub pitch_deg: f32,
    /// Height above the ground or sea below the camera, metres.
    pub altitude_m: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Distances {
    pub nearest_land: Option<f32>,
    pub median_land: Option<f32>,
    pub farthest_land: Option<f32>,
    pub nearest_sea: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SunFacts {
    pub elevation_deg: f32,
    pub azimuth_deg: f32,
    /// Angle between where the camera looks and the sun, degrees (0 = straight into the sun).
    pub from_view_deg: f32,
    /// Where the sun is relative to the camera: ahead, behind, left, right, ahead-left, ...
    pub side: String,
    pub in_frame: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FogFacts {
    pub half_m: f32,
    /// Share of a surface's own colour left after fog at 1 km (1 = no fog).
    pub left_at_1km: f32,
    /// The same at the median land distance in this shot.
    pub left_at_median_land: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ImageFacts {
    /// Mean perceptual brightness, 0..1.
    pub mean_luma: f32,
    /// Share of pixels in each sixteenth of brightness, darkest first.
    pub luma_histogram: [f32; 16],
    /// Share of pixels at or below 2/255 and at or above 253/255.
    pub clipped_black: f32,
    pub clipped_white: f32,
    /// Mean sRGB colour (0..255) and brightness per visible class.
    pub classes: BTreeMap<String, ClassColour>,
    /// Mean brightness of land in sun and in shadow; their ratio is the shadow contrast.
    pub land_sunlit_luma: Option<f32>,
    pub land_shadow_luma: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ClassColour {
    pub srgb: [u8; 3],
    pub luma: f32,
}

fn add3(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: Vec3, s: f32) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: Vec3) -> Vec3 {
    let l = dot(a, a).sqrt().max(1e-9);
    scale(a, 1.0 / l)
}

/// Direction to the sun for a look (azimuth from north, clockwise towards east).
pub fn to_sun(look: &Look) -> Vec3 {
    let (el, az) = (look.sun_elevation_deg.to_radians(), look.sun_azimuth_deg.to_radians());
    [az.sin() * el.cos(), el.sin(), -az.cos() * el.cos()]
}

fn compass(deg: f32) -> &'static str {
    const N: [&str; 8] = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    N[(((deg.rem_euclid(360.0) + 22.5) / 45.0) as usize) % 8]
}

fn pct(x: f32) -> String {
    format!("{:.0}%", x * 100.0)
}

fn metres(m: f32) -> String {
    if m >= 1000.0 { format!("{:.1} km", m / 1000.0) } else { format!("{m:.0} m") }
}

/// Build the report for a shot from its buffers and (optionally) the rendered image.
pub fn report(world: &World, cam: &CameraShot, buf: &Buffers, image: Option<&Rgba>) -> Report {
    let n = buf.class.len().max(1) as f32;
    let mut counts: BTreeMap<Class, usize> = BTreeMap::new();
    for c in &buf.class {
        *counts.entry(*c).or_default() += 1;
    }
    let share = |c: Class| counts.get(&c).copied().unwrap_or(0) as f32 / n;
    let mut coverage: BTreeMap<String, f32> = Class::ALL.iter().map(|&c| (c.name().to_string(), share(c))).collect();
    let land: f32 = Class::ALL.iter().filter(|c| c.is_land()).map(|&c| share(c)).sum();
    coverage.insert("land".into(), land);
    let shaded = buf.shaded.iter().filter(|&&s| s).count() as f32 / n;
    // Share of the visible land that is in the sun's shadow.
    coverage.insert("land_in_shadow".into(), if land > 0.0 { shaded / land } else { 0.0 });

    // 3x3 composition grid.
    let grid = std::array::from_fn(|gy| {
        std::array::from_fn(|gx| {
            let mut cc: BTreeMap<Class, usize> = BTreeMap::new();
            let (x0, x1) = (buf.width * gx as u32 / 3, buf.width * (gx as u32 + 1) / 3);
            let (y0, y1) = (buf.height * gy as u32 / 3, buf.height * (gy as u32 + 1) / 3);
            for y in y0..y1 {
                for x in x0..x1 {
                    *cc.entry(buf.class[(y * buf.width + x) as usize]).or_default() += 1;
                }
            }
            cc.into_iter().max_by_key(|(_, k)| *k).map(|(c, _)| c.name().to_string()).unwrap_or_default()
        })
    });

    let mut land_d: Vec<f32> = buf.class.iter().zip(&buf.depth).filter(|(c, _)| c.is_land()).map(|(_, &d)| d).collect();
    land_d.sort_by(f32::total_cmp);
    let sea_near = buf
        .class
        .iter()
        .zip(&buf.depth)
        .filter(|(c, _)| **c == Class::Sea)
        .map(|(_, &d)| d)
        .fold(None, |m: Option<f32>, d| Some(m.map_or(d, |m| m.min(d))));
    let distance_m = Distances {
        nearest_land: land_d.first().copied(),
        median_land: land_d.get(land_d.len() / 2).copied(),
        farthest_land: land_d.last().copied(),
        nearest_sea: sea_near,
    };

    // Skyline: per column, the first non-sky row from the top, for columns that start in sky.
    let mut rows = Vec::new();
    for x in 0..buf.width {
        if buf.class[x as usize] != Class::Sky {
            continue;
        }
        let first =
            (0..buf.height).find(|&y| buf.class[(y * buf.width + x) as usize] != Class::Sky).unwrap_or(buf.height);
        rows.push(first as f32 / buf.height as f32);
    }
    let skyline = (!rows.is_empty()).then(|| rows.iter().sum::<f32>() / rows.len() as f32);

    // Camera.
    let f = cam.forward;
    // `+ 0.0` turns -0 into 0.
    let heading_deg = f[0].atan2(-f[2]).to_degrees().rem_euclid(360.0) % 360.0 + 0.0;
    let pitch_deg = f[1].clamp(-1.0, 1.0).asin().to_degrees();
    let field = world.field;
    let below = if field.contains(cam.pos[0], cam.pos[2]) {
        field.height(cam.pos[0], cam.pos[2]).max(SEA_LEVEL_M)
    } else {
        SEA_LEVEL_M
    };
    let camera = CameraFacts { pos: cam.pos, heading_deg, pitch_deg, altitude_m: cam.pos[1] - below };

    // Sun.
    let look = world.island.look.clone();
    let s = to_sun(&look);
    let from_view_deg = dot(s, f).clamp(-1.0, 1.0).acos().to_degrees();
    let (sx, sy) = (dot(s, cam.right), dot(s, cam.up));
    let ahead = dot(s, f);
    let side = match (ahead > 0.3, ahead < -0.3, sx > 0.3, sx < -0.3) {
        (true, _, true, _) => "ahead-right",
        (true, _, _, true) => "ahead-left",
        (true, ..) => "ahead",
        (_, true, true, _) => "behind-right",
        (_, true, _, true) => "behind-left",
        (_, true, ..) => "behind",
        (_, _, true, _) => "right",
        _ => "left",
    }
    .to_string();
    let tan = (cam.fov_y_deg.to_radians() * 0.5).tan();
    let aspect = cam.size[0] as f32 / cam.size[1] as f32;
    let in_frame = ahead > 0.0 && (sx / ahead).abs() <= tan * aspect && (sy / ahead).abs() <= tan;
    let sun = SunFacts {
        elevation_deg: look.sun_elevation_deg,
        azimuth_deg: look.sun_azimuth_deg,
        from_view_deg,
        side,
        in_frame,
    };

    let left = |d: f32| 0.5f32.powf(d / look.fog_half_m.max(1.0));
    let fog = FogFacts {
        half_m: look.fog_half_m,
        left_at_1km: left(1000.0),
        left_at_median_land: distance_m.median_land.map(left),
    };

    let image = image.map(|img| image_facts(img, buf));
    let mut r = Report {
        name: cam.name.clone(),
        camera,
        coverage,
        grid,
        distance_m,
        skyline,
        sun,
        fog,
        image,
        truth: None,
        text: String::new(),
    };
    r.text = describe(&r);
    r
}

fn image_facts(img: &Rgba, buf: &Buffers) -> ImageFacts {
    let n = img.pixels.len().max(1) as f32;
    let mut hist = [0f32; 16];
    let (mut sum, mut black, mut white) = (0.0, 0.0, 0.0);
    let mut per: BTreeMap<Class, ([f64; 3], f64, usize)> = BTreeMap::new();
    let (mut lit, mut shade) = ((0.0f64, 0usize), (0.0f64, 0usize));
    for y in 0..img.height {
        for x in 0..img.width {
            let p = img.get(x, y);
            let l = luma(p);
            sum += l;
            hist[((l * 16.0) as usize).min(15)] += 1.0;
            if p[..3].iter().all(|&c| c <= 2) {
                black += 1.0;
            }
            if p[..3].iter().all(|&c| c >= 253) {
                white += 1.0;
            }
            let (bx, by) = (x * buf.width / img.width, y * buf.height / img.height);
            let k = (by * buf.width + bx) as usize;
            let c = buf.class[k];
            if c.is_land() {
                let acc = if buf.shaded[k] { &mut shade } else { &mut lit };
                acc.0 += f64::from(l);
                acc.1 += 1;
            }
            let e = per.entry(c).or_insert(([0.0; 3], 0.0, 0));
            (0..3).for_each(|i| e.0[i] += f64::from(p[i]));
            e.1 += f64::from(l);
            e.2 += 1;
        }
    }
    let classes = per
        .into_iter()
        .map(|(c, (rgb, l, k))| {
            let k = k.max(1) as f64;
            (c.name().to_string(), ClassColour { srgb: rgb.map(|v| (v / k).round() as u8), luma: (l / k) as f32 })
        })
        .collect();
    ImageFacts {
        mean_luma: sum / n,
        luma_histogram: hist.map(|h| h / n),
        clipped_black: black / n,
        clipped_white: white / n,
        classes,
        land_sunlit_luma: (lit.1 > 0).then(|| (lit.0 / lit.1 as f64) as f32),
        land_shadow_luma: (shade.1 > 0).then(|| (shade.0 / shade.1 as f64) as f32),
    }
}

/// The report as a few plain sentences.
pub fn describe(r: &Report) -> String {
    let mut s = Vec::new();
    let c = &r.camera;
    s.push(format!(
        "Camera {} above ground, facing {} ({:.0}°), {} {:.0}°.",
        metres(c.altitude_m),
        compass(c.heading_deg),
        c.heading_deg,
        if c.pitch_deg < 0.0 { "pitched down" } else { "pitched up" },
        c.pitch_deg.abs()
    ));
    let cov = |k: &str| r.coverage.get(k).copied().unwrap_or(0.0);
    let mut land: Vec<(&str, f32)> =
        ["grass", "rock", "moss", "shore"].iter().map(|&k| (k, cov(k))).filter(|(_, v)| *v >= 0.005).collect();
    land.sort_by(|a, b| b.1.total_cmp(&a.1));
    let land_txt = land.iter().map(|(k, v)| format!("{k} {}", pct(*v))).collect::<Vec<_>>().join(", ");
    s.push(format!(
        "Frame: sky {}, sea {}, land {}{}.",
        pct(cov("sky")),
        pct(cov("sea")),
        pct(cov("land")),
        if land_txt.is_empty() { String::new() } else { format!(" ({land_txt})") }
    ));
    let rows: Vec<String> = r
        .grid
        .iter()
        .zip(["top", "middle", "bottom"])
        .map(|(row, name)| {
            if row[0] == row[1] && row[1] == row[2] {
                format!("{name} all {}", row[0])
            } else {
                format!("{name} {}", row.join(" | "))
            }
        })
        .collect();
    if cov("land") > 0.0 {
        s.push(format!("{} of the visible land is in the sun's shadow.", pct(cov("land_in_shadow"))));
    }
    s.push(format!("Composition (left | centre | right): {}.", rows.join("; ")));
    if let Some(sk) = r.skyline {
        s.push(format!("Skyline on average {} down from the top.", pct(sk)));
    }
    let d = &r.distance_m;
    if let (Some(n), Some(m), Some(f)) = (d.nearest_land, d.median_land, d.farthest_land) {
        s.push(format!("Land from {} to {}, median {}.", metres(n), metres(f), metres(m)));
    }
    if let Some(sea) = d.nearest_sea {
        s.push(format!("Nearest sea {}.", metres(sea)));
    }
    s.push(format!(
        "Sun {:.0}° high, {} of the view ({:.0}° off centre){}.",
        r.sun.elevation_deg,
        r.sun.side,
        r.sun.from_view_deg,
        if r.sun.in_frame { ", in frame" } else { "" }
    ));
    match r.fog.left_at_median_land {
        Some(m) => s.push(format!(
            "Fog keeps {} of a surface's colour at 1 km and {} at the median land distance.",
            pct(r.fog.left_at_1km),
            pct(m)
        )),
        None => s.push(format!("Fog keeps {} of a surface's colour at 1 km.", pct(r.fog.left_at_1km))),
    }
    if let Some(t) = &r.truth {
        let mut cov: Vec<_> = t.cover.iter().filter(|(_, v)| **v >= 0.02).collect();
        cov.sort_by(|a, b| b.1.total_cmp(a.1));
        let gaps: Vec<String> = t.layers.iter().map(|(k, l)| format!("{k} ΔE {:.0}", l.delta_e)).collect();
        s.push(format!(
            "Satellite: the land in view is {} (WorldCover); our ground layers agree on {}. Colour gap to the satellite: {} (2 is barely visible, over 10 clearly different).",
            cov.iter().map(|(k, v)| format!("{k} {}", pct(**v))).collect::<Vec<_>>().join(", "),
            pct(t.cover_agree),
            if gaps.is_empty() { "n/a".to_string() } else { gaps.join(", ") }
        ));
    }
    if let Some(img) = &r.image {
        let mut parts: Vec<(String, f32)> = img.classes.iter().map(|(k, v)| (k.clone(), v.luma)).collect();
        parts.sort_by(|a, b| b.1.total_cmp(&a.1));
        s.push(format!(
            "Image brightness {:.2} (0..1), {} crushed black, {} blown white. Brightest to darkest: {}.",
            img.mean_luma,
            pct(img.clipped_black),
            pct(img.clipped_white),
            parts.iter().map(|(k, l)| format!("{k} {l:.2}")).collect::<Vec<_>>().join(", ")
        ));
        if let (Some(a), Some(b)) = (img.land_sunlit_luma, img.land_shadow_luma) {
            s.push(format!("Land in sun {a:.2}, in shadow {b:.2} (ratio {:.1}:1).", a / b.max(1e-3)));
        }
    }
    s.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn island() -> (Island, Heightfield) {
        // 21x21 px, 10 m spacing: a 100 m hill in the middle, sea around the edge.
        let mut heights = Vec::new();
        for r in 0..21 {
            for c in 0..21 {
                let (dx, dz) = (c as f32 - 10.0, r as f32 - 10.0);
                heights.push((100.0 - (dx * dx + dz * dz) * 1.5).max(0.0));
            }
        }
        let field = Heightfield { width: 21, depth: 21, spacing: [10.0, 10.0], heights };
        let island: Island = serde_json::from_str(
            r#"{"name":"t","heightmap":"h.png","size_px":[21,21],"metres_per_px":[10,10],"height_range_m":[0,100],
                "origin":{"north_lat":0,"west_lon":0},"source":{"dataset":"","tile":"","attribution":""},
                "views":[{"name":"v","pos":[0,300,400],"look_at":[0,0,0]}]}"#,
        )
        .unwrap();
        (island, field)
    }

    fn cam(pos: Vec3, forward: Vec3) -> CameraShot {
        let f = norm(forward);
        let right = norm([-f[2], 0.0, f[0]]);
        let up =
            [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
        CameraShot { name: "t".into(), frame: 0, pos, forward: f, up, right, fov_y_deg: 55.0, size: [64, 36] }
    }

    #[test]
    fn rays_hit_hill_sea_and_sky() {
        let (island, field) = island();
        let w = World::new(&island, &field);
        let down = w.cast([0.0, 300.0, 0.0], [0.0, -1.0, 0.0], 1e5).unwrap();
        assert!((down.0 - 200.0).abs() < 1.0, "hill top is 100 m: {down:?}");
        assert!(down.1.is_land());
        let sea = w.cast([500.0, 50.0, 0.0], [0.0, -1.0, 0.0], 1e5).unwrap();
        assert_eq!(sea.1, Class::Sea);
        assert!(w.cast([0.0, 300.0, 0.0], [0.0, 1.0, 0.0], 1e5).is_none(), "up is sky");
    }

    #[test]
    fn report_sees_the_scene() {
        let (island, field) = island();
        let w = World::new(&island, &field);
        // Level camera south of the hill looking north: sky on top, hill in the middle.
        let c = cam([0.0, 60.0, 400.0], [0.0, -0.05, -1.0]);
        let buf = w.buffers(&c, 64);
        let r = report(&w, &c, &buf, None);
        assert!(r.coverage["sky"] > 0.3, "{:?}", r.coverage);
        assert!(r.coverage["land"] > 0.02, "{:?}", r.coverage);
        assert_eq!(r.grid[0][1], "sky");
        assert!((r.camera.heading_deg - 0.0).abs() < 1.0 || (r.camera.heading_deg - 360.0).abs() < 1.0);
        assert!(r.text.contains("facing north"), "{}", r.text);
        // Same input, same report.
        assert_eq!(serde_json::to_string(&r).unwrap(), serde_json::to_string(&report(&w, &c, &buf, None)).unwrap());
    }

    #[test]
    fn image_facts_split_by_class() {
        let (island, field) = island();
        let w = World::new(&island, &field);
        let c = cam([0.0, 60.0, 400.0], [0.0, -0.05, -1.0]);
        let buf = w.buffers(&c, 64);
        let mut img = Rgba::new(64, 36, [255, 255, 255, 255]);
        for (i, cl) in buf.class.iter().enumerate() {
            if *cl != Class::Sky {
                img.pixels[i] = [0, 0, 0, 255];
            }
        }
        let r = report(&w, &c, &buf, Some(&img));
        let facts = r.image.unwrap();
        assert_eq!(facts.classes["sky"].srgb, [255, 255, 255]);
        assert!(facts.clipped_white > 0.3 && facts.clipped_black > 0.0);
    }
}
