//! Real photos of the island as ground truth: where each one was taken from, and how far a render
//! from that camera is from the photo in colour and light.
//!
//! `content/references/<island>/references.json` lists CC-licensed photos (fetched with
//! `scripts/truth/photos.py`, which also records author and licence). For each photo:
//!
//! 1. [`skyline`] finds where sky meets land or sea in every column of the photo.
//! 2. [`solve`] finds the camera (position, heading, pitch, roll, field of view) whose skyline,
//!    cast against the heightfield with the Earth's curvature, best fits the photo's, starting
//!    from a rough hand-written guess and the photo's GPS tag when it has one.
//! 3. [`compare`] measures the render from the solved camera against the photo, region by region
//!    (sky, sea, land near and far, from the sensor's ray cast of that same camera): mean colour
//!    difference (ΔE), the gap between the two lightness distributions, and the gap between the
//!    images' six-colour palettes. Their mean is the photo gap: lower is more like the place.

// Per-pixel and per-column buffers are walked together by index.
#![allow(clippy::needless_range_loop)]

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    Heightfield, Island, Vec3,
    image::Rgba,
    sense::{CameraShot, Class, World},
    truth::{lab, to_linear},
};

/// Earth radius times (1 - refraction coefficient 0.13): how much a distant point drops below a
/// flat horizon, as a photo sees it.
const EARTH_R_EFFECTIVE: f32 = 6_371_000.0 / 0.87;

/// The photo references of one island.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct References {
    pub island: String,
    pub photos: Vec<Photo>,
}

/// One reference photo, its licence and where it was taken from.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Photo {
    /// Short name; the image is `<id>.jpg` next to `references.json`.
    pub id: String,
    /// Wikimedia Commons file title (`File:...`). `scripts/truth/photos.py` fetches it.
    pub commons: String,
    /// Written by `photos.py` from Commons: page, author, licence, date, GPS and focal length.
    #[serde(default)]
    pub source: Option<Source>,
    /// A rough idea of the camera, written by hand from the photo and a map; the solve starts here.
    pub guess: Guess,
    /// Columns to leave out of the skyline fit, as fractions of the width (e.g. a house roof or a
    /// cloud sitting on a ridge): `[[0.0, 0.1]]`.
    #[serde(default)]
    pub ignore_columns: Vec<[f32; 2]>,
    /// The solved camera, written by `de photo solve`.
    #[serde(default)]
    pub camera: Option<Solved>,
    /// When the photo was taken and how it was exposed, from its EXIF (`photos.py --meta`), so a
    /// render can be lit as the place was (`de photo match --photo-light`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<PhotoLight>,
}

/// The light a photo was taken in.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PhotoLight {
    /// When, in UTC (`2019-05-20T16:54:07Z`).
    pub taken_utc: String,
    /// False when only the date is known and the time is a guess (early afternoon).
    pub time_known: bool,
    /// The camera's exposure as EV100 (from shutter, aperture and ISO), if the EXIF has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exposure_ev100: Option<f32>,
    /// Cloud cover in the photo, 0 clear .. 1 overcast, written by hand from looking at it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<f32>,
}

impl PhotoLight {
    /// The sun's compass azimuth and elevation, degrees, seen from `lat_lon` at `taken_utc`.
    pub fn sun(&self, lat_lon: [f64; 2]) -> Result<(f32, f32), String> {
        let when = crate::sun::Utc::parse(&self.taken_utc)?;
        let (az, el) = crate::sun::position(lat_lon[0], lat_lon[1], &when);
        Ok((az as f32, el as f32))
    }
}

/// Where the photo comes from and the credit its licence asks for.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub page: String,
    pub author: String,
    pub licence: String,
    pub licence_url: String,
    pub date: String,
    /// Camera latitude and longitude from the photo's geotag, if it has one.
    pub gps: Option<[f64; 2]>,
    /// Focal length in 35 mm terms from EXIF, if known.
    pub focal_35mm: Option<f32>,
    /// Full width and height of the original on Commons (the stored copy is smaller).
    pub original_size: [u32; 2],
    /// One line to print wherever the photo is shown.
    pub credit: String,
}

/// A starting point for the camera solve.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Guess {
    /// Camera latitude and longitude. Leave out to use the photo's GPS tag.
    #[serde(default)]
    pub lat_lon: Option<[f64; 2]>,
    /// How far from that point the camera may be, metres.
    pub within_m: f32,
    /// Camera height above the ground, metres (1.7 for someone standing).
    pub above_ground_m: f32,
    /// Compass heading the photo looks along (0 north, 90 east), degrees.
    pub heading_deg: f32,
    /// How far the heading may be off, degrees.
    #[serde(default = "default_heading_within")]
    pub heading_within_deg: f32,
    /// Vertical field of view, degrees. Leave out to use the focal length, else search 25..75.
    #[serde(default)]
    pub fov_y_deg: Option<f32>,
}

fn default_heading_within() -> f32 {
    30.0
}

/// A camera found from the photo's skyline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Solved {
    pub pos: Vec3,
    pub heading_deg: f32,
    pub pitch_deg: f32,
    /// Rotation about the view direction; positive tips the right side down.
    pub roll_deg: f32,
    pub fov_y_deg: f32,
    /// Median distance between the photo's skyline and the heightfield's, degrees.
    pub median_error_deg: f32,
    /// Share of skyline columns within 0.5 degrees.
    pub inliers: f32,
}

impl Solved {
    /// The camera as `de-shot` and the sensor record it, for an image `size` pixels.
    pub fn shot(&self, name: &str, size: [u32; 2]) -> CameraShot {
        let (f, u, r) = basis(self.heading_deg, self.pitch_deg, self.roll_deg);
        CameraShot {
            name: name.into(),
            frame: 0,
            pos: self.pos,
            forward: f,
            up: u,
            right: r,
            fov_y_deg: self.fov_y_deg,
            size,
        }
    }

    /// A point the camera looks at, for a `camera` step.
    pub fn look_at(&self) -> Vec3 {
        let (f, _, _) = basis(self.heading_deg, self.pitch_deg, 0.0);
        [self.pos[0] + f[0] * 1000.0, self.pos[1] + f[1] * 1000.0, self.pos[2] + f[2] * 1000.0]
    }
}

/// Forward, up and right in world space (+X east, +Y up, +Z south) for a compass heading,
/// pitch up and roll, all in degrees.
pub fn basis(heading: f32, pitch: f32, roll: f32) -> (Vec3, Vec3, Vec3) {
    let (sh, ch) = heading.to_radians().sin_cos();
    let (sp, cp) = pitch.to_radians().sin_cos();
    let (sr, cr) = roll.to_radians().sin_cos();
    let f = [sh * cp, sp, -ch * cp];
    let u0 = [-sh * sp, cp, ch * sp];
    let r0 = [ch, 0.0, sh];
    let r = [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr];
    let u = [u0[0] * cr + r0[0] * sr, u0[1] * cr + r0[1] * sr, u0[2] * cr + r0[2] * sr];
    (f, u, r)
}

impl References {
    pub fn dir(content: &Path, island: &str) -> PathBuf {
        content.join("references").join(island)
    }

    /// Load `content/references/<island>/references.json`; `Ok(None)` when the island has none.
    pub fn load(content: &Path, island: &str) -> Result<Option<Self>, String> {
        let path = Self::dir(content, island).join("references.json");
        if !path.is_file() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map(Some).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn save(&self, content: &Path) -> Result<(), String> {
        let path = Self::dir(content, &self.island).join("references.json");
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())? + "\n";
        std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Problems a person should fix: missing images, ids, guesses outside the island.
    pub fn check(&self, content: &Path, island: &Island) -> Vec<String> {
        let mut out = Vec::new();
        let dir = Self::dir(content, &self.island);
        for (i, p) in self.photos.iter().enumerate() {
            let at = format!("references/{}/references.json photos[{i}] ({})", self.island, p.id);
            if self.photos.iter().filter(|q| q.id == p.id).count() > 1 {
                out.push(format!("{at}: id is used twice; give each photo its own id"));
            }
            if !dir.join(format!("{}.jpg", p.id)).is_file() {
                out.push(format!(
                    "{at}: {}.jpg is missing; run `python3 scripts/truth/photos.py {}`",
                    p.id, self.island
                ));
            }
            if let Some(l) = &p.light
                && let Err(e) = crate::sun::Utc::parse(&l.taken_utc)
            {
                out.push(format!("{at}: light.taken_utc: {e}"));
            }
            if p.source.is_none() {
                out.push(format!(
                    "{at}: no `source` (licence and author); run `python3 scripts/truth/photos.py {}`",
                    self.island
                ));
            }
            match guess_lat_lon(p) {
                None => {
                    out.push(format!("{at}: guess has no `lat_lon` and the photo has no GPS tag; add `guess.lat_lon`"))
                }
                Some(ll) => {
                    let [x, z] = to_world(island, ll);
                    let [w, d] = [
                        island.size_px[0] as f32 * island.metres_per_px[0],
                        island.size_px[1] as f32 * island.metres_per_px[1],
                    ];
                    if x.abs() > w / 2.0 || z.abs() > d / 2.0 {
                        out.push(format!(
                            "{at}: guess {ll:?} is outside the island's heightmap; check `guess.lat_lon`"
                        ));
                    }
                }
            }
            for c in &p.ignore_columns {
                if !(0.0..=1.0).contains(&c[0]) || !(0.0..=1.0).contains(&c[1]) || c[0] >= c[1] {
                    out.push(format!("{at}: ignore_columns {c:?} must be [from, to] with 0 <= from < to <= 1"));
                }
            }
        }
        out
    }
}

/// Where the photo was taken from: the hand guess, else its GPS tag.
pub fn guess_lat_lon(p: &Photo) -> Option<[f64; 2]> {
    p.guess.lat_lon.or_else(|| p.source.as_ref().and_then(|s| s.gps))
}

/// World x, z of a latitude and longitude, the way `scripts/terrain/import.py` lays the heightmap.
pub fn to_world(island: &Island, lat_lon: [f64; 2]) -> [f32; 2] {
    let [mx, mz] = island.metres_per_px.map(f64::from);
    let (w, d) = (f64::from(island.size_px[0] - 1) * mx, f64::from(island.size_px[1] - 1) * mz);
    let metres_lat = mz * 3600.0; // one arc-second per pixel north-south
    let mid_lat = island.origin.north_lat - f64::from(island.size_px[1]) * mz / metres_lat / 2.0;
    let metres_lon = 111_320.0 * mid_lat.to_radians().cos();
    let x = (lat_lon[1] - island.origin.west_lon) * metres_lon - w / 2.0;
    let z = (island.origin.north_lat - lat_lon[0]) * metres_lat - d / 2.0;
    [x as f32, z as f32]
}

/// Load a reference photo (baseline JPEG).
pub fn load_jpeg(path: &Path) -> Result<Rgba, String> {
    use zune_jpeg::{
        JpegDecoder,
        zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions},
    };
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let opts = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut dec = JpegDecoder::new_with_options(ZCursor::new(bytes), opts);
    let px = dec.decode().map_err(|e| format!("{}: {e:?}", path.display()))?;
    let (w, h) = dec.dimensions().ok_or_else(|| format!("{}: no size", path.display()))?;
    let pixels = px.chunks_exact(3).map(|c| [c[0], c[1], c[2], 255]).collect();
    Ok(Rgba { width: w as u32, height: h as u32, pixels })
}

// ---------------------------------------------------------------------------------------------
// Skyline in the photo

/// Per column, the row (in pixels, may be fractional) where sky ends; `None` where the column is
/// all land or all sky.
pub struct Skyline {
    pub width: u32,
    pub height: u32,
    pub rows: Vec<Option<f32>>,
}

/// Find the sky/ground boundary in every column: a two-class colour model (sky from the top rows,
/// ground from the bottom) gives each pixel a sky probability; dynamic programming then picks the
/// one boundary per column that misclassifies fewest pixels, with a small cost for jumping
/// between neighbouring columns. Three rounds, each re-learning the ground's colours from below
/// the last boundary.
pub fn skyline(img: &Rgba) -> Skyline {
    let (w, h) = (img.width as usize, img.height as usize);
    let labs: Vec<Vec3> = img.pixels.iter().map(|p| lab([to_linear(p[0]), to_linear(p[1]), to_linear(p[2])])).collect();
    // Sky: colour clusters of the top 8% of rows (blue sky and white cloud), learned once,
    // leaving out clusters 25 L* darker than the brightest (a mountain reaching the top edge).
    // Learning it again from everything above a boundary would let a grey sea or lagoon that
    // looks like the sky pull the boundary down to the shore.
    let light: Vec<f32> = labs.iter().map(|c| c[0]).collect();
    let top: Vec<Vec3> = labs[..w * (h * 8 / 100).max(1)].to_vec();
    let mut sky = mixture(&top, 3);
    let brightest = sky.iter().map(|m| m.mean[0]).fold(0.0, f32::max);
    sky.retain(|m| m.mean[0] >= brightest - 25.0);
    // Ground: the bottom 35% at first, then everything below the last boundary.
    let mut boundary: Vec<usize> = vec![h * 65 / 100; w];
    for _ in 0..3 {
        let below: Vec<Vec3> =
            (0..w).flat_map(|x| ((boundary[x] + 2).min(h)..h).map(move |y| y * w + x)).map(|i| labs[i]).collect();
        let ground = mixture(&below, 3);
        let nll = |ms: &[Model], c: Vec3| ms.iter().map(|m| m.nll(c)).fold(f32::INFINITY, f32::min);
        // Cost of calling each pixel sky / ground: how unlikely it is under that model.
        let mut not_sky = vec![0f32; w * h];
        for i in 0..w * h {
            let (ls, lg) = (nll(&sky, labs[i]), nll(&ground, labs[i]));
            let p_sky = 1.0 / (1.0 + (ls - lg).clamp(-30.0, 30.0).exp());
            not_sky[i] = 1.0 - p_sky;
        }
        boundary = dp_boundary(&not_sky, &light, w, h, 0.6);
    }
    let rows = boundary.iter().map(|&b| (b > 0 && b < h).then_some(b as f32)).collect();
    Skyline { width: w as u32, height: h as u32, rows }
}

/// Misclassified pixels one unit of L* step down at the skyline is worth (see [`dp_boundary`]).
const EDGE_REWARD: f32 = 3.0;

/// For each column, the boundary row b (sky above, ground from b down) minimising misclassified
/// pixels plus `jump` per pixel of change between neighbouring columns.
fn dp_boundary(not_sky: &[f32], light: &[f32], w: usize, h: usize, jump: f32) -> Vec<usize> {
    // cost[b] for one column = sum_{y<b} not_sky + sum_{y>=b} (1 - not_sky), minus a reward for
    // a step down in lightness at b: sky is brighter than the land or sea right under it, which
    // tells a grey sea from a grey sky when their colours alone don't.
    let col_cost = |x: usize| -> Vec<f32> {
        let mut c = vec![0f32; h + 1];
        let l = |y: usize| light[y.min(h - 1) * w + x];
        let mean = |a: usize, b: usize| (a..b).map(l).sum::<f32>() / (b - a).max(1) as f32;
        let total_sky: f32 = (0..h).map(|y| 1.0 - not_sky[y * w + x]).sum();
        let mut above = 0.0;
        let mut sky_above = 0.0;
        for b in 0..=h {
            let step = if b >= 3 && b + 3 <= h { (mean(b - 3, b) - mean(b, b + 3)).clamp(0.0, 40.0) } else { 0.0 };
            c[b] = above + (total_sky - sky_above) - EDGE_REWARD * step;
            if b < h {
                above += not_sky[b * w + x];
                sky_above += 1.0 - not_sky[b * w + x];
            }
        }
        c
    };
    let mut acc = col_cost(0);
    let mut from: Vec<Vec<u32>> = Vec::with_capacity(w);
    from.push((0..=h as u32).collect());
    for x in 1..w {
        // L1 distance transform of acc: best predecessor for each b with cost jump*|b-b'|.
        let mut best = acc.clone();
        let mut arg: Vec<u32> = (0..=h as u32).collect();
        for b in 1..=h {
            if best[b - 1] + jump < best[b] {
                best[b] = best[b - 1] + jump;
                arg[b] = arg[b - 1];
            }
        }
        for b in (0..h).rev() {
            if best[b + 1] + jump < best[b] {
                best[b] = best[b + 1] + jump;
                arg[b] = arg[b + 1];
            }
        }
        let c = col_cost(x);
        acc = (0..=h).map(|b| best[b] + c[b]).collect();
        from.push(arg);
    }
    let mut b = (0..=h).min_by(|&a, &b| acc[a].total_cmp(&acc[b])).unwrap_or(0);
    let mut out = vec![0; w];
    for x in (0..w).rev() {
        out[x] = b;
        b = from[x][b] as usize;
    }
    out
}

/// A diagonal Gaussian colour model in L*a*b*.
#[derive(Default)]
struct Gauss {
    n: f32,
    s: [f32; 3],
    ss: [f32; 3],
}

struct Model {
    mean: Vec3,
    var: Vec3,
}

impl Gauss {
    fn add(&mut self, c: Vec3) {
        self.n += 1.0;
        for i in 0..3 {
            self.s[i] += c[i];
            self.ss[i] += c[i] * c[i];
        }
    }
    fn finish(&self) -> Model {
        let n = self.n.max(1.0);
        let mean = self.s.map(|s| s / n);
        let var = [0, 1, 2].map(|i| (self.ss[i] / n - mean[i] * mean[i]).max(if i == 0 { 36.0 } else { 16.0 }));
        Model { mean, var }
    }
}

/// `k` colour clusters (k-means seeded at lightness quantiles, so deterministic), each a diagonal
/// Gaussian; empty clusters are dropped.
fn mixture(px: &[Vec3], k: usize) -> Vec<Model> {
    if px.is_empty() {
        return vec![Gauss::default().finish()];
    }
    let centres = palette(px, k);
    let mut g: Vec<Gauss> = (0..centres.len()).map(|_| Gauss::default()).collect();
    for &p in px {
        let j = (0..centres.len()).min_by(|&a, &b| dist(p, centres[a]).total_cmp(&dist(p, centres[b]))).unwrap_or(0);
        g[j].add(p);
    }
    g.iter().filter(|g| g.n >= 1.0).map(Gauss::finish).collect()
}

impl Model {
    fn nll(&self, c: Vec3) -> f32 {
        (0..3).map(|i| (c[i] - self.mean[i]).powi(2) / (2.0 * self.var[i]) + 0.5 * self.var[i].ln()).sum()
    }
}

// ---------------------------------------------------------------------------------------------
// Skyline from the heightfield

/// Elevation angle (radians) of the highest terrain, or of the sea horizon, seen from `pos` along
/// compass azimuth `az` (radians), with the Earth's curvature.
pub fn horizon(field: &Heightfield, pos: Vec3, az: f32) -> f32 {
    let (dx, dz) = (az.sin(), -az.cos());
    let sea = -(2.0 * pos[1].max(0.5) / EARTH_R_EFFECTIVE).sqrt();
    let mut best = sea;
    let mut t = 15.0f32;
    let step0 = field.spacing[0].min(field.spacing[1]) * 0.5;
    loop {
        let (x, z) = (pos[0] + dx * t, pos[2] + dz * t);
        if !field.contains(x, z) {
            break;
        }
        let h = field.height(x, z);
        if h > 0.5 {
            let drop = t * t / (2.0 * EARTH_R_EFFECTIVE);
            let e = ((h - pos[1] - drop) / t).atan();
            if e > best {
                best = e;
            }
        }
        t += step0.max(t * 0.004);
    }
    best
}

/// Compass azimuth and elevation (radians) of a direction.
fn az_el(d: Vec3) -> (f32, f32) {
    (d[0].atan2(-d[2]), d[1].clamp(-1.0, 1.0).asin())
}

/// Ray through pixel (px, py) of a `w` x `h` image for a camera basis and vertical fov (degrees).
fn pixel_dir((f, u, r): (Vec3, Vec3, Vec3), fov: f32, [w, h]: [f32; 2], [px, py]: [f32; 2]) -> Vec3 {
    let tan = (fov.to_radians() * 0.5).tan();
    let x = (2.0 * px / w - 1.0) * tan * (w / h);
    let y = (1.0 - 2.0 * py / h) * tan;
    let d = [f[0] + r[0] * x + u[0] * y, f[1] + r[1] * x + u[1] * y, f[2] + r[2] * x + u[2] * y];
    let l = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    [d[0] / l, d[1] / l, d[2] / l]
}

/// Where a world direction lands in the image, or None if behind the camera.
#[cfg(test)]
fn project((f, u, r): (Vec3, Vec3, Vec3), fov: f32, [w, h]: [f32; 2], d: Vec3) -> Option<(f32, f32)> {
    let dot = |a: Vec3, b: Vec3| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let z = dot(d, f);
    if z <= 1e-3 {
        return None;
    }
    let tan = (fov.to_radians() * 0.5).tan();
    let x = dot(d, r) / z / (tan * w / h);
    let y = dot(d, u) / z / tan;
    Some(((x + 1.0) * 0.5 * w, (1.0 - y) * 0.5 * h))
}

/// The heightfield's skyline row in every column for a camera, found by bisection on the
/// elevation of each pixel's ray against the horizon in its direction.
pub fn model_skyline(field: &Heightfield, cam: &Solved, w: u32, h: u32) -> Vec<Option<f32>> {
    let (f, u, r) = basis(cam.heading_deg, cam.pitch_deg, cam.roll_deg);
    let (wf, hf) = (w as f32, h as f32);
    (0..w)
        .map(|x| {
            let px = x as f32 + 0.5;
            // Above the skyline when the ray's elevation exceeds the horizon in its azimuth.
            let above = |py: f32| {
                let (az, el) = az_el(pixel_dir((f, u, r), cam.fov_y_deg, [wf, hf], [px, py]));
                el > horizon(field, cam.pos, az)
            };
            if !above(0.0) {
                return None;
            }
            if above(hf) {
                return None;
            }
            let (mut lo, mut hi) = (0.0, hf);
            for _ in 0..16 {
                let mid = 0.5 * (lo + hi);
                if above(mid) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            Some(0.5 * (lo + hi))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Camera solve

/// Skyline points used for the fit: pixel coordinates in the skyline's image.
struct Points {
    w: f32,
    h: f32,
    pts: Vec<(f32, f32)>,
}

fn points(sky: &Skyline, ignore: &[[f32; 2]], n: usize) -> Points {
    let w = sky.width as usize;
    let mut pts = Vec::new();
    for k in 0..n {
        let x = ((k as f32 + 0.5) / n as f32 * w as f32) as usize;
        let fx = x as f32 / w as f32;
        if ignore.iter().any(|c| fx >= c[0] && fx <= c[1]) {
            continue;
        }
        if let Some(y) = sky.rows[x.min(w - 1)] {
            pts.push((x as f32 + 0.5, y));
        }
    }
    Points { w: sky.width as f32, h: sky.height as f32, pts }
}

/// Cauchy loss scale in radians: residuals well beyond it (a house on the skyline, a cloud on a
/// ridge) barely pull on the fit.
const SCALE: f32 = 0.004;

/// Per-point vertical angle between the photo's skyline and the heightfield's, radians.
fn residuals(field: &Heightfield, p: &Points, c: &Solved, table: Option<&HorizonTable>) -> Vec<f32> {
    let (f, u, r) = basis(c.heading_deg, c.pitch_deg, c.roll_deg);
    p.pts
        .iter()
        .map(|&(x, y)| {
            let (az, el) = az_el(pixel_dir((f, u, r), c.fov_y_deg, [p.w, p.h], [x, y]));
            let hz = match table {
                Some(t) => t.at(az),
                None => horizon(field, c.pos, az),
            };
            el - hz
        })
        .collect()
}

fn cost(res: &[f32]) -> f32 {
    if res.is_empty() {
        return f32::INFINITY;
    }
    res.iter().map(|e| (1.0 + (e / SCALE).powi(2)).ln()).sum::<f32>() / res.len() as f32
}

/// The horizon all round one position, every 0.05 degrees.
struct HorizonTable {
    el: Vec<f32>,
}

impl HorizonTable {
    const N: usize = 7200;
    fn new(field: &Heightfield, pos: Vec3) -> Self {
        let el = (0..Self::N).map(|i| horizon(field, pos, i as f32 / Self::N as f32 * std::f32::consts::TAU)).collect();
        Self { el }
    }
    fn at(&self, az: f32) -> f32 {
        let t = az.rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU * Self::N as f32;
        let i = t.floor() as usize % Self::N;
        let j = (i + 1) % Self::N;
        let f = t - t.floor();
        self.el[i] * (1.0 - f) + self.el[j] * f
    }
}

/// What a solve found, with the skylines for the overlay.
pub struct SolveResult {
    pub camera: Solved,
    pub photo_skyline: Skyline,
    pub model_skyline: Vec<Option<f32>>,
}

/// Find the camera that took `photo` (see the module docs). Deterministic: grid searches then
/// Nelder-Mead, no randomness.
pub fn solve(island: &Island, field: &Heightfield, p: &Photo, img: &Rgba) -> Result<SolveResult, String> {
    let ll = guess_lat_lon(p).ok_or_else(|| format!("{}: no guess.lat_lon and no GPS tag", p.id))?;
    let [gx, gz] = to_world(island, ll);
    let g = &p.guess;
    // Work at about 480 pixels wide: plenty for a skyline, quick to cast.
    let sw = 480u32.min(img.width);
    let sh = (img.height as f32 * sw as f32 / img.width as f32).round() as u32;
    let small = img.resize(sw, sh);
    let sky = skyline(&small);
    let pts = points(&sky, &p.ignore_columns, 160);
    if pts.pts.len() < 20 {
        return Err(format!("{}: only {} skyline columns found; is there sky in the photo?", p.id, pts.pts.len()));
    }
    let fov_from_focal =
        p.guess.fov_y_deg.or_else(|| p.source.as_ref().and_then(|s| s.focal_35mm)).map(|v| match p.guess.fov_y_deg {
            Some(f) => f,
            // 35 mm frame is 24 mm tall in landscape; the short side of the photo.
            None => {
                let short = if img.width >= img.height { 24.0 } else { 36.0 };
                2.0 * (short / (2.0 * v)).atan().to_degrees()
            }
        });
    let fovs: Vec<f32> = match fov_from_focal {
        Some(f) => vec![f],
        None => (0..11).map(|i| 25.0 + 5.0 * i as f32).collect(),
    };

    // 1. Positions on a grid around the guess; at each, rotation and fov by grid search.
    let mut cands: Vec<(f32, Solved)> = Vec::new();
    let steps = 3i32;
    let spacing = g.within_m / steps as f32;
    let heights: Vec<f32> = if g.above_ground_m > 20.0 {
        vec![g.above_ground_m * 0.5, g.above_ground_m, g.above_ground_m * 1.5]
    } else {
        vec![g.above_ground_m]
    };
    for iz in -steps..=steps {
        for ix in -steps..=steps {
            let (x, z) = (gx + ix as f32 * spacing, gz + iz as f32 * spacing);
            if (ix * ix + iz * iz) as f32 > (steps * steps) as f32 + 0.5 || !field.contains(x, z) {
                continue;
            }
            let ground = field.height(x, z).max(0.0);
            for &agl in &heights {
                let pos = [x, ground + agl, z];
                let table = HorizonTable::new(field, pos);
                let mut best: Option<(f32, Solved)> = None;
                let mut heading = g.heading_deg - g.heading_within_deg;
                while heading <= g.heading_deg + g.heading_within_deg {
                    for pi in -12..=12 {
                        for &fov in &fovs {
                            let c = Solved {
                                pos,
                                heading_deg: heading,
                                pitch_deg: pi as f32,
                                roll_deg: 0.0,
                                fov_y_deg: fov,
                                median_error_deg: 0.0,
                                inliers: 0.0,
                            };
                            let e = cost(&residuals(field, &pts, &c, Some(&table)));
                            if best.as_ref().is_none_or(|b| e < b.0) {
                                best = Some((e, c));
                            }
                        }
                    }
                    heading += 1.0;
                }
                if let Some(b) = best {
                    cands.push(b);
                }
            }
        }
    }
    cands.sort_by(|a, b| a.0.total_cmp(&b.0));
    cands.truncate(4);
    if cands.is_empty() {
        return Err(format!("{}: guess is outside the heightfield", p.id));
    }

    // 2. Refine the best few with Nelder-Mead over everything, keeping the camera near the guess
    //    and above the ground.
    let fov_free = fov_from_focal.is_none();
    let mut best: Option<(f32, Solved)> = None;
    for (_, start) in cands {
        let ground0 = field.height(start.pos[0], start.pos[2]);
        let agl0 = start.pos[1] - ground0;
        let x0 = [start.pos[0], start.pos[2], agl0, start.heading_deg, start.pitch_deg, 0.0, start.fov_y_deg];
        let make = |v: &[f32; 7]| -> Solved {
            let ground = field.height(v[0], v[1]).max(0.0);
            Solved {
                pos: [v[0], ground + v[2].max(1.0), v[1]],
                heading_deg: v[3],
                pitch_deg: v[4],
                roll_deg: v[5],
                fov_y_deg: if fov_free { v[6].clamp(10.0, 100.0) } else { start.fov_y_deg },
                median_error_deg: 0.0,
                inliers: 0.0,
            }
        };
        let objective = |v: &[f32; 7]| -> f32 {
            let c = make(v);
            let off = ((v[0] - gx).powi(2) + (v[1] - gz).powi(2)).sqrt();
            let penalty =
                (off - g.within_m).max(0.0) * 0.01 + (1.0 - v[2]).max(0.0) * 0.1 + (v[5].abs() - 8.0).max(0.0);
            cost(&residuals(field, &pts, &c, None)) + penalty
        };
        let scale = [spacing * 0.5, spacing * 0.5, agl0.max(2.0) * 0.5, 1.0, 1.0, 1.0, 3.0];
        let (v, e) = nelder_mead(objective, x0, scale, 500);
        if best.as_ref().is_none_or(|b| e < b.0) {
            best = Some((e, make(&v)));
        }
    }
    let (_, mut cam) = best.expect("at least one candidate");
    let res = residuals(field, &pts, &cam, None);
    let mut abs: Vec<f32> = res.iter().map(|e| e.abs().to_degrees()).collect();
    abs.sort_by(f32::total_cmp);
    cam.median_error_deg = round(abs[abs.len() / 2], 3);
    cam.inliers = round(abs.iter().filter(|&&e| e < 0.5).count() as f32 / abs.len() as f32, 3);
    cam.pos = cam.pos.map(|v| round(v, 1));
    cam.heading_deg = round(cam.heading_deg.rem_euclid(360.0), 2);
    cam.pitch_deg = round(cam.pitch_deg, 2);
    cam.roll_deg = round(cam.roll_deg, 2);
    cam.fov_y_deg = round(cam.fov_y_deg, 2);
    let model = model_skyline(field, &cam, sw, sh);
    Ok(SolveResult { camera: cam, photo_skyline: sky, model_skyline: model })
}

fn round(v: f32, digits: i32) -> f32 {
    let k = 10f32.powi(digits);
    (v * k).round() / k
}

/// Minimise `f` from `x0` with simplex steps `scale` (deterministic).
fn nelder_mead<const N: usize>(
    f: impl Fn(&[f32; N]) -> f32,
    x0: [f32; N],
    scale: [f32; N],
    iters: usize,
) -> ([f32; N], f32) {
    let mut s: Vec<([f32; N], f32)> = Vec::with_capacity(N + 1);
    s.push((x0, f(&x0)));
    for i in 0..N {
        let mut x = x0;
        x[i] += scale[i];
        s.push((x, f(&x)));
    }
    for _ in 0..iters {
        s.sort_by(|a, b| a.1.total_cmp(&b.1));
        let mut c = [0f32; N];
        for (x, _) in &s[..N] {
            for i in 0..N {
                c[i] += x[i] / N as f32;
            }
        }
        let worst = s[N];
        let at = |t: f32| -> [f32; N] { std::array::from_fn(|i| c[i] + t * (worst.0[i] - c[i])) };
        let xr = at(-1.0);
        let fr = f(&xr);
        if fr < s[0].1 {
            let xe = at(-2.0);
            let fe = f(&xe);
            s[N] = if fe < fr { (xe, fe) } else { (xr, fr) };
        } else if fr < s[N - 1].1 {
            s[N] = (xr, fr);
        } else {
            let xc = if fr < worst.1 { at(-0.5) } else { at(0.5) };
            let fc = f(&xc);
            if fc < worst.1.min(fr) {
                s[N] = (xc, fc);
            } else {
                let b = s[0].0;
                for k in 1..=N {
                    let x: [f32; N] = std::array::from_fn(|i| b[i] + 0.5 * (s[k].0[i] - b[i]));
                    s[k] = (x, f(&x));
                }
            }
        }
    }
    s.sort_by(|a, b| a.1.total_cmp(&b.1));
    s[0]
}

/// The photo with its skyline (red) and the solved camera's heightfield skyline (green).
pub fn overlay(img: &Rgba, r: &SolveResult) -> Rgba {
    let mut out = img.resize(r.photo_skyline.width, r.photo_skyline.height);
    for x in 0..out.width {
        if let Some(y) = r.photo_skyline.rows[x as usize] {
            out.fill_rect(x, (y as u32).saturating_sub(1), 1, 2, [255, 40, 40, 255]);
        }
        if let Some(y) = r.model_skyline[x as usize] {
            out.fill_rect(x, (y as u32).saturating_sub(1), 1, 2, [40, 255, 80, 255]);
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Render vs photo

/// The regions a photo is compared in, from the sensor's ray cast of the solved camera.
pub const REGIONS: [&str; 4] = ["sky", "sea", "land_near", "land_far"];

/// Land closer than this is "near", metres: past it fog and haze start to show.
pub const NEAR_M: f32 = 1500.0;

/// How a render compares with a photo from the same camera.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Match {
    pub id: String,
    /// The headline: mean of `colour_de`, `lightness_gap` and `palette_de`. Lower is closer.
    pub gap: f32,
    /// Coverage-weighted ΔE between the photo's and the render's mean colour per region.
    pub colour_de: f32,
    /// Coverage-weighted mean distance between the photo's and the render's L* (0..100)
    /// distributions per region (earth mover's distance): brightness and contrast together.
    pub lightness_gap: f32,
    /// ΔE between the two images' six-colour palettes, matched in lightness order.
    pub palette_de: f32,
    pub regions: Vec<RegionMatch>,
    /// Six-colour palettes (sRGB), darkest first.
    pub photo_palette: Vec<[u8; 3]>,
    pub render_palette: Vec<[u8; 3]>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RegionMatch {
    pub region: String,
    /// Share of the image.
    pub coverage: f32,
    pub photo_mean: [u8; 3],
    pub render_mean: [u8; 3],
    pub colour_de: f32,
    /// L* 10th, 50th and 90th percentiles.
    pub photo_lightness: [f32; 3],
    pub render_lightness: [f32; 3],
    pub lightness_gap: f32,
}

/// Region index per pixel of `cam` at `w` wide (see [`REGIONS`]), from the sensor ray cast.
pub fn regions(world: &World, cam: &CameraShot, w: u32) -> (u32, u32, Vec<u8>) {
    let buf = world.buffers(cam, w);
    let reg = (0..buf.class.len())
        .map(|i| match buf.class[i] {
            Class::Sky => 0,
            Class::Sea => 1,
            _ if buf.depth[i] < NEAR_M => 2,
            _ => 3,
        })
        .collect();
    (buf.width, buf.height, reg)
}

/// Compare `render` with `photo`, both resized to the region map's size.
pub fn compare(id: &str, photo: &Rgba, render: &Rgba, w: u32, h: u32, reg: &[u8]) -> Match {
    let (p, r) = (photo.resize(w, h), render.resize(w, h));
    let lab_of = |c: [u8; 4]| lab([to_linear(c[0]), to_linear(c[1]), to_linear(c[2])]);
    let pl: Vec<Vec3> = p.pixels.iter().map(|&c| lab_of(c)).collect();
    let rl: Vec<Vec3> = r.pixels.iter().map(|&c| lab_of(c)).collect();
    let n = reg.len() as f32;
    let mut regions = Vec::new();
    let (mut colour, mut light, mut wsum) = (0.0, 0.0, 0.0);
    for (k, name) in REGIONS.iter().enumerate() {
        let idx: Vec<usize> = (0..reg.len()).filter(|&i| reg[i] == k as u8).collect();
        let coverage = idx.len() as f32 / n;
        if coverage < 0.01 {
            continue;
        }
        let mean = |img: &Rgba| -> [u8; 3] {
            let mut s = [0f32; 3];
            for &i in &idx {
                for c in 0..3 {
                    s[c] += to_linear(img.pixels[i][c]);
                }
            }
            s.map(|v| crate::truth::to_srgb(v / idx.len() as f32))
        };
        let (pm, rm) = (mean(&p), mean(&r));
        let to_lab = |c: [u8; 3]| lab([to_linear(c[0]), to_linear(c[1]), to_linear(c[2])]);
        let de = dist(to_lab(pm), to_lab(rm));
        let mut pls: Vec<f32> = idx.iter().map(|&i| pl[i][0]).collect();
        let mut rls: Vec<f32> = idx.iter().map(|&i| rl[i][0]).collect();
        pls.sort_by(f32::total_cmp);
        rls.sort_by(f32::total_cmp);
        let emd = pls.iter().zip(&rls).map(|(a, b)| (a - b).abs()).sum::<f32>() / pls.len() as f32;
        let pct = |v: &[f32]| [0.1, 0.5, 0.9].map(|q| round(v[((v.len() - 1) as f32 * q) as usize], 1));
        colour += coverage * de;
        light += coverage * emd;
        wsum += coverage;
        regions.push(RegionMatch {
            region: (*name).into(),
            coverage: round(coverage, 3),
            photo_mean: pm,
            render_mean: rm,
            colour_de: round(de, 2),
            photo_lightness: pct(&pls),
            render_lightness: pct(&rls),
            lightness_gap: round(emd, 2),
        });
    }
    let wsum = f32::max(wsum, 1e-6);
    let (pp, rp) = (palette(&pl, 6), palette(&rl, 6));
    let palette_de = pp.iter().zip(&rp).map(|(a, b)| dist(*a, *b)).sum::<f32>() / pp.len() as f32;
    let (colour_de, lightness_gap) = (colour / wsum, light / wsum);
    let srgb = |l: &Vec3| -> [u8; 3] { from_lab(*l).map(crate::truth::to_srgb) };
    Match {
        id: id.into(),
        gap: round((colour_de + lightness_gap + palette_de) / 3.0, 2),
        colour_de: round(colour_de, 2),
        lightness_gap: round(lightness_gap, 2),
        palette_de: round(palette_de, 2),
        regions,
        photo_palette: pp.iter().map(srgb).collect(),
        render_palette: rp.iter().map(srgb).collect(),
    }
}

fn dist(a: Vec3, b: Vec3) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// `k` dominant colours in L*a*b* by k-means, seeded at lightness quantiles (deterministic),
/// darkest first.
pub fn palette(px: &[Vec3], k: usize) -> Vec<Vec3> {
    let mut by_l: Vec<Vec3> = px.to_vec();
    by_l.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut c: Vec<Vec3> = (0..k).map(|i| by_l[((i as f32 + 0.5) / k as f32 * by_l.len() as f32) as usize]).collect();
    for _ in 0..12 {
        let mut s = vec![[0f32; 3]; k];
        let mut n = vec![0f32; k];
        for p in px {
            let j = (0..k).min_by(|&a, &b| dist(*p, c[a]).total_cmp(&dist(*p, c[b]))).unwrap_or(0);
            for i in 0..3 {
                s[j][i] += p[i];
            }
            n[j] += 1.0;
        }
        for j in 0..k {
            if n[j] > 0.0 {
                c[j] = s[j].map(|v| v / n[j]);
            }
        }
    }
    c.sort_by(|a, b| a[0].total_cmp(&b[0]));
    c
}

/// Linear sRGB of a CIE L*a*b* colour (D65).
pub fn from_lab(l: Vec3) -> Vec3 {
    let fy = (l[0] + 16.0) / 116.0;
    let (fx, fz) = (fy + l[1] / 500.0, fy - l[2] / 200.0);
    let inv = |t: f32| if t > 0.206_893 { t * t * t } else { (t - 16.0 / 116.0) / 7.787 };
    let (x, y, z) = (inv(fx) * 0.950_47, inv(fy), inv(fz) * 1.088_83);
    [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.2040 * y + 1.0570 * z]
        .map(|v| v.clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn photo_light_gives_the_sun_and_the_saksun_photos_have_it() {
        let l = PhotoLight {
            taken_utc: "2019-05-20T16:54:07Z".into(),
            time_known: true,
            exposure_ev100: Some(13.0),
            cover: Some(1.0),
        };
        let (az, el) = l.sun([62.25, -7.18]).unwrap();
        // Late afternoon in May at 62 N: west and fairly high.
        assert!((240.0..280.0).contains(&az) && (20.0..35.0).contains(&el), "az {az} el {el}");
        let content = crate::content_dir();
        let refs = References::load(&content, "saksun").unwrap().expect("saksun has references");
        let lit: Vec<_> = refs.photos.iter().filter_map(|p| p.light.as_ref()).collect();
        assert_eq!(lit.len(), refs.photos.len(), "every reference photo has its light");
        assert!(lit.iter().all(|l| crate::sun::Utc::parse(&l.taken_utc).is_ok()));
    }

    #[test]
    fn basis_is_orthonormal_and_points_where_asked() {
        let (f, u, r) = basis(90.0, 10.0, 5.0);
        let dot = |a: Vec3, b: Vec3| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        for (a, b) in [(f, u), (f, r), (u, r)] {
            assert!(dot(a, b).abs() < 1e-5);
        }
        for v in [f, u, r] {
            assert!((dot(v, v) - 1.0).abs() < 1e-5);
        }
        // Heading 90 looks east (+X), pitched up.
        assert!(f[0] > 0.9 && f[1] > 0.1 && f[2].abs() < 1e-5);
        // Positive roll tips the right side down.
        assert!(r[1] < 0.0);
    }

    #[test]
    fn pixels_round_trip_through_directions() {
        let (f, u, r) = basis(200.0, -4.0, 2.0);
        for (px, py) in [(10.0, 20.0), (300.0, 100.0), (479.0, 319.0)] {
            let d = pixel_dir((f, u, r), 40.0, [480.0, 320.0], [px, py]);
            let (x, y) = project((f, u, r), 40.0, [480.0, 320.0], d).unwrap();
            assert!((x - px).abs() < 0.01 && (y - py).abs() < 0.01, "{x},{y}");
        }
    }

    fn ridge() -> Heightfield {
        // 101 x 101 at 30 m: flat at 5 m with a 300 m ridge along the north edge.
        let (w, d) = (101, 101);
        let heights = (0..w * d).map(|i| if i / w < 10 { 300.0 } else { 5.0 }).collect();
        Heightfield { width: w, depth: d, spacing: [30.0, 30.0], heights }
    }

    #[test]
    fn horizon_sees_the_ridge_and_the_sea() {
        let f = ridge();
        let pos = [0.0, 7.0, 0.0];
        // North: the ridge starts 1200 m away (row 10 is z = -1200), 293 m up.
        let north = horizon(&f, pos, 0.0).to_degrees();
        let expect = ((300.0f32 - 7.0) / 1200.0).atan().to_degrees();
        assert!((north - expect).abs() < 0.6, "{north} vs {expect}");
        // South there is only low land; the horizon stays near level.
        assert!(horizon(&f, pos, std::f32::consts::PI).to_degrees() < 0.2);
    }

    #[test]
    fn skyline_finds_a_painted_ridge() {
        // Sky light blue over a green ground whose edge is a diagonal.
        let (w, h) = (120u32, 80u32);
        let mut img = Rgba::new(w, h, [170, 200, 230, 255]);
        for x in 0..w {
            for y in (20 + x / 4)..h {
                img.set(x, y, [60, 110, 40, 255]);
            }
        }
        let s = skyline(&img);
        for x in [5usize, 60, 115] {
            let want = 20.0 + (x / 4) as f32;
            let got = s.rows[x].expect("a boundary");
            assert!((got - want).abs() <= 1.5, "column {x}: {got} vs {want}");
        }
    }

    #[test]
    fn solve_recovers_a_synthetic_camera() {
        // Render the heightfield's own skyline from a known camera as a two-colour image, then
        // solve from a guess that is off in heading and position.
        let island: Island = serde_json::from_str(
            r#"{"name":"t","heightmap":"h.png","size_px":[101,101],"metres_per_px":[30,30],"height_range_m":[0,300],
                "origin":{"north_lat":62.0,"west_lon":-7.0},"source":{"dataset":"","tile":"","attribution":""}}"#,
        )
        .unwrap();
        let mut heights = vec![5.0f32; 101 * 101];
        for r in 0..101 {
            for c in 0..101 {
                let (x, z) = (c as f32 - 50.0, r as f32 - 50.0);
                // A wavy ridge to the north so heading is pinned.
                if z < -25.0 + 6.0 * (x * 0.25).sin() {
                    heights[r * 101 + c] = 200.0 + 80.0 * (x * 0.13).cos();
                }
            }
        }
        let field = Heightfield { width: 101, depth: 101, spacing: [30.0, 30.0], heights };
        let truth = Solved {
            pos: [60.0, 6.7, 300.0],
            heading_deg: 8.0,
            pitch_deg: 6.0,
            roll_deg: 1.0,
            fov_y_deg: 40.0,
            median_error_deg: 0.0,
            inliers: 0.0,
        };
        let (w, h) = (240u32, 160u32);
        let line = model_skyline(&field, &truth, w, h);
        let mut img = Rgba::new(w, h, [170, 200, 230, 255]);
        for x in 0..w {
            if let Some(y) = line[x as usize] {
                for yy in (y.round() as u32)..h {
                    img.set(x, yy, [60, 110, 40, 255]);
                }
            }
        }
        let ll = |x: f32, z: f32| {
            let back = to_world(&island, [62.0, -7.0]);
            // Invert to_world numerically for the guess: offsets in metres to degrees.
            let metres_lat = 30.0 * 3600.0;
            let lat = 62.0 - f64::from(z - back[1]) / metres_lat;
            let mid = (62.0f64 - 101.0 * 30.0 / metres_lat / 2.0).to_radians().cos();
            let lon = -7.0 + f64::from(x - back[0]) / (111_320.0 * mid);
            [lat, lon]
        };
        let photo = Photo {
            id: "synthetic".into(),
            commons: String::new(),
            source: None,
            guess: Guess {
                lat_lon: Some(ll(100.0, 260.0)),
                within_m: 120.0,
                above_ground_m: 1.7,
                heading_deg: 20.0,
                heading_within_deg: 25.0,
                fov_y_deg: Some(40.0),
            },
            ignore_columns: vec![],
            camera: None,
            light: None,
        };
        let got = solve(&island, &field, &photo, &img).unwrap().camera;
        assert!((got.heading_deg - truth.heading_deg).abs() < 1.0, "{got:?}");
        assert!((got.pitch_deg - truth.pitch_deg).abs() < 0.5, "{got:?}");
        assert!(got.median_error_deg < 0.2, "{got:?}");
    }

    #[test]
    fn identical_images_have_no_gap_and_a_darker_render_has_one() {
        let mut img = Rgba::new(40, 30, [170, 200, 230, 255]);
        for y in 15..30 {
            for x in 0..40 {
                img.set(x, y, [60, 110, 40, 255]);
            }
        }
        let reg: Vec<u8> = (0..40 * 30).map(|i| if i / 40 < 15 { 0 } else { 2 }).collect();
        let same = compare("a", &img, &img, 40, 30, &reg);
        assert!(same.gap < 0.01, "{same:?}");
        let mut dark = img.clone();
        dark.pixels.iter_mut().for_each(|p| *p = [p[0] / 2, p[1] / 2, p[2] / 2, 255]);
        let worse = compare("a", &img, &dark, 40, 30, &reg);
        assert!(worse.gap > 5.0 && worse.lightness_gap > 5.0, "{worse:?}");
    }

    #[test]
    fn lab_round_trips() {
        for c in [[0.2f32, 0.5, 0.1], [0.8, 0.7, 0.6], [0.01, 0.02, 0.05]] {
            let back = from_lab(lab(c));
            for i in 0..3 {
                assert!((back[i] - c[i]).abs() < 2e-3, "{c:?} -> {back:?}");
            }
        }
    }
}
