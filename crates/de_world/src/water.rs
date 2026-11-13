//! Water from the land's own data: streams, waterfalls and lakes found in the heightfield.
//!
//! Nobody draws a river here. The terrain is filled so every cell drains (priority-flood,
//! Barnes et al. 2014), each cell sends its water to its steepest downhill neighbour (D8,
//! O'Callaghan and Mark 1984), and the area draining through each cell is summed. Cells with
//! enough catchment are streams; where a stream drops steeply for long enough it is a
//! waterfall; flat or filled hollows big enough are lakes. The thresholds are rules in
//! `content/islands/<id>/rules.json` (`de schema rules`), with overrides to drop or add a
//! stream by hand when the data is wrong. Everything is deterministic and needs no GPU.

use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap},
    path::Path,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Heightfield, island::Vec3};

/// Heightmap cells at or below this are sea (the DEM stores the sea as 0 m).
const SEA_CELL_M: f32 = 0.5;

/// Rules for an island (`content/islands/<id>/rules.json`). Every field has a default.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Rules {
    pub water: WaterRules,
}

/// How water is found in the terrain.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct WaterRules {
    /// A cell is a stream when at least this much land drains through it, km².
    pub min_catchment_km2: f32,
    /// Stream width is `width_m[0] + width_per_sqrt_km2 * sqrt(catchment)`, capped at `width_m[1]`.
    pub width_m: [f32; 2],
    pub width_per_sqrt_km2: f32,
    /// How far streams are cut into the ground, metres.
    pub channel_depth_m: f32,
    /// A waterfall is a stretch at least this steep (metres down per metre along)...
    pub fall_min_gradient: f32,
    /// ...that drops at least this far in total, metres.
    pub fall_min_drop_m: f32,
    /// A lake is a hollow (or a flat the DEM levelled) of at least this area, m².
    pub lake_min_area_m2: f32,
    /// Ground whose neighbours are all within this many metres of it counts as flat (a DEM
    /// levels lake surfaces).
    pub lake_flat_m: f32,
    /// A hollow at least this deep below its spill point counts towards a lake, metres.
    pub lake_min_depth_m: f32,
    /// Hand corrections, applied in order after the streams are found.
    pub overrides: Vec<WaterOverride>,
}

impl Default for WaterRules {
    fn default() -> Self {
        Self {
            min_catchment_km2: 0.4,
            width_m: [1.2, 14.0],
            width_per_sqrt_km2: 2.5,
            channel_depth_m: 1.2,
            fall_min_gradient: 0.9,
            fall_min_drop_m: 15.0,
            lake_min_area_m2: 8000.0,
            lake_flat_m: 0.1,
            lake_min_depth_m: 0.5,
            overrides: Vec::new(),
        }
    }
}

/// One hand correction. World x, z in metres (x east, z south).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum WaterOverride {
    /// Drop every stream point within `radius_m` of `at`; streams split around the gap.
    RemoveStreams { at: [f32; 2], radius_m: f32 },
    /// Drop the lake that covers `at`.
    RemoveLake { at: [f32; 2] },
    /// Add a stream along `path` (downhill order), as wide as `catchment_km2` makes it.
    AddStream { path: Vec<[f32; 2]>, catchment_km2: f32 },
}

impl Rules {
    /// Reads `content/islands/<id>/rules.json`; the defaults when there is none.
    pub fn load(content: &Path, id: &str) -> Result<Self, String> {
        let path = content.join("islands").join(id).join("rules.json");
        if !path.is_file() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
    }
}

/// The water of an island.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct Water {
    pub streams: Vec<Stream>,
    pub falls: Vec<Fall>,
    pub lakes: Vec<Lake>,
    /// The above as sentences.
    pub text: String,
    /// Per heightmap cell: the lake surface height there, or NaN.
    #[serde(skip)]
    pub lake_level: Vec<f32>,
    /// Per heightmap cell: area draining through it, km².
    #[serde(skip)]
    pub catchment: Vec<f32>,
    #[serde(skip)]
    grid: Grid,
}

/// A stream from its source (or a lake's outlet) to where it joins another stream, a lake or
/// the sea. Points are smoothed, about 8 m apart, with the water surface as y.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Stream {
    pub id: usize,
    pub points: Vec<Vec3>,
    pub width_m: Vec<f32>,
    pub catchment_km2: Vec<f32>,
    /// "sea", "stream", "lake" or "edge" (runs off the map).
    pub ends_in: String,
    /// Metres from source to end and the height it loses.
    pub length_m: f32,
    pub drop_m: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Fall {
    pub id: usize,
    pub stream: usize,
    pub top: Vec3,
    pub bottom: Vec3,
    pub drop_m: f32,
    /// Mean steepness, metres down per metre along.
    pub gradient: f32,
    pub catchment_km2: f32,
    /// Whether it drops straight into the sea (a Faroese cliff fall).
    pub into_sea: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Lake {
    pub id: usize,
    pub level_m: f32,
    pub area_m2: f32,
    pub centre: Vec3,
    /// Heightmap cells (row * width + col).
    #[serde(skip)]
    pub cells: Vec<usize>,
}

/// Stream segments bucketed for "nearest stream" lookups.
#[derive(Clone, Debug, Default)]
struct Grid {
    cell: f32,
    origin: [f32; 2],
    cols: usize,
    rows: usize,
    /// (stream, segment start index) per bucket.
    buckets: Vec<Vec<(u32, u32)>>,
    /// Lake cells: size and spacing of the heightfield.
    field_w: usize,
    field_d: usize,
    spacing: [f32; 2],
    extent: [f32; 2],
}

const BUCKET_M: f32 = 48.0;
const POINT_STEP_M: f32 = 8.0;

/// What [`Water::channel`] finds under a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wet {
    /// Water surface height, metres.
    pub level: f32,
    /// Horizontal distance from the stream's centre line, metres (0 in a lake).
    pub dist: f32,
    /// Half the stream's width, metres (0 in a lake).
    pub half_width: f32,
}

impl Water {
    /// Find the water of `field` under `rules`.
    pub fn find(field: &Heightfield, rules: &WaterRules) -> Self {
        let (w, d) = (field.width, field.depth);
        let n = w * d;
        let h = &field.heights;
        let sea: Vec<bool> = h.iter().map(|&v| v <= SEA_CELL_M).collect();
        let cell_km2 = field.spacing[0] * field.spacing[1] / 1e6;
        let nbrs = neighbours(w, d);
        let dist = |k: usize| {
            if k.is_multiple_of(2) {
                field.spacing[0].hypot(field.spacing[1])
            } else {
                [field.spacing[1], field.spacing[0]][(k / 2) % 2]
            }
        };

        // Fill without and with a tiny slope: the first gives lake depths, the second lets
        // water cross flats towards their outlet.
        let pure = fill(h, &sea, w, d, 0.0);
        let filled = fill(h, &sea, w, d, 1e-3);

        // Steepest descent on the sloped fill.
        let mut recv = vec![usize::MAX; n];
        for i in 0..n {
            if sea[i] {
                continue;
            }
            let mut best = (0.0f32, usize::MAX);
            for (k, j) in nbrs(i) {
                let s = (filled[i] - filled[j]) / dist(k);
                if s > best.0 {
                    best = (s, j);
                }
            }
            recv[i] = best.1;
        }

        // Catchment: pass area downhill, highest cells first.
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&a, &b| filled[b].total_cmp(&filled[a]).then(a.cmp(&b)));
        let mut acc = vec![cell_km2; n];
        for &i in &order {
            if recv[i] != usize::MAX {
                acc[recv[i]] += acc[i];
            }
        }

        // Lakes: hollows and DEM-levelled flats, joined 4-way, big enough.
        let flat = |i: usize| nbrs(i).all(|(_, j)| (h[j] - h[i]).abs() <= rules.lake_flat_m);
        let wet: Vec<bool> =
            (0..n).map(|i| !sea[i] && (pure[i] - h[i] >= rules.lake_min_depth_m || (h[i] > 1.0 && flat(i)))).collect();
        let mut lake_id = vec![usize::MAX; n];
        let mut lakes = Vec::new();
        let mut lake_level = vec![f32::NAN; n];
        for s in 0..n {
            if !wet[s] || lake_id[s] != usize::MAX {
                continue;
            }
            let mut cells = vec![s];
            lake_id[s] = lakes.len();
            let mut k = 0;
            while k < cells.len() {
                let i = cells[k];
                k += 1;
                let (c, r) = (i % w, i / w);
                for (dc, dr) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
                    let (cc, rr) = (c as i32 + dc, r as i32 + dr);
                    if cc < 0 || rr < 0 || cc >= w as i32 || rr >= d as i32 {
                        continue;
                    }
                    let j = rr as usize * w + cc as usize;
                    if wet[j] && lake_id[j] == usize::MAX {
                        lake_id[j] = lakes.len();
                        cells.push(j);
                    }
                }
            }
            let area = cells.len() as f32 * cell_km2 * 1e6;
            let level = cells.iter().map(|&i| pure[i].max(h[i])).fold(f32::MIN, f32::max);
            let spread = level - cells.iter().map(|&i| h[i]).fold(f32::MAX, f32::min);
            if area < rules.lake_min_area_m2 || (spread < rules.lake_min_depth_m && cells.len() < 3) {
                for &i in &cells {
                    lake_id[i] = usize::MAX - 1;
                }
                continue;
            }
            let id = lakes.len();
            let (mut cx, mut cz) = (0.0, 0.0);
            for &i in &cells {
                let [x, z] = field.world_xz(i % w, i / w);
                cx += x;
                cz += z;
                lake_id[i] = id;
                lake_level[i] = level;
            }
            let m = cells.len() as f32;
            lakes.push(Lake { id, level_m: level, area_m2: area, centre: [cx / m, level, cz / m], cells });
        }
        for v in lake_id.iter_mut() {
            if *v >= lakes.len() {
                *v = usize::MAX;
            }
        }
        for o in &rules.overrides {
            if let WaterOverride::RemoveLake { at } = o
                && let Some(i) = cell_at(field, *at)
                && let Some(id) = lake_id.get(i).copied().filter(|&id| id != usize::MAX)
            {
                for &c in &lakes[id].cells {
                    lake_level[c] = f32::NAN;
                    lake_id[c] = usize::MAX;
                }
                lakes[id].cells.clear();
            }
        }
        lakes.retain(|l| !l.cells.is_empty());
        for (k, l) in lakes.iter_mut().enumerate() {
            l.id = k;
            for &c in &l.cells {
                lake_id[c] = k;
            }
        }
        let in_lake = |i: usize| lake_id[i] != usize::MAX;

        // Streams: walk down from every head until the water meets a stream, lake or the sea.
        let is_stream = |i: usize| !sea[i] && !in_lake(i) && acc[i] >= rules.min_catchment_km2;
        let mut fed = vec![false; n];
        for i in 0..n {
            if is_stream(i) && recv[i] != usize::MAX {
                fed[recv[i]] = true;
            }
        }
        let mut heads: Vec<usize> = (0..n).filter(|&i| is_stream(i) && !fed[i]).collect();
        heads.sort_by(|&a, &b| h[b].total_cmp(&h[a]).then(a.cmp(&b)));
        let mut seen = vec![false; n];
        let mut paths: Vec<(Vec<usize>, &'static str)> = Vec::new();
        for &s in &heads {
            let mut path = vec![s];
            seen[s] = true;
            let mut i = s;
            let end = loop {
                let j = recv[i];
                if j == usize::MAX {
                    break "edge";
                }
                path.push(j);
                if sea[j] {
                    break "sea";
                }
                if in_lake(j) {
                    break "lake";
                }
                if seen[j] {
                    break "stream";
                }
                seen[j] = true;
                i = j;
            };
            if path.len() >= 2 {
                paths.push((path, end));
            }
        }

        let mut water = Water { lake_level, catchment: acc.clone(), lakes, ..Default::default() };
        let pt = |i: usize| {
            let [x, z] = field.world_xz(i % w, i / w);
            [x, if sea[i] { crate::sense::SEA_LEVEL_M } else { h[i] }, z]
        };
        for (path, end) in &paths {
            let raw: Vec<Vec3> = path.iter().map(|&i| pt(i)).collect();
            let mut km2: Vec<f32> = path.iter().map(|&i| acc[i]).collect();
            // The last point belongs to whatever this stream runs into; keep its own size there.
            let n = km2.len();
            km2[n - 1] = km2[n - 2];
            let id = water.streams.len();
            // Waterfalls along the cell path.
            let mut k = 0;
            while k + 1 < raw.len() {
                let steep = |k: usize| {
                    let run = (raw[k + 1][0] - raw[k][0]).hypot(raw[k + 1][2] - raw[k][2]);
                    (raw[k][1] - raw[k + 1][1]) / run >= rules.fall_min_gradient
                };
                if !steep(k) {
                    k += 1;
                    continue;
                }
                let start = k;
                while k + 1 < raw.len() && steep(k) {
                    k += 1;
                }
                let (top, bottom) = (raw[start], raw[k]);
                let drop = top[1] - bottom[1];
                let run: f32 = (start..k).map(|i| (raw[i + 1][0] - raw[i][0]).hypot(raw[i + 1][2] - raw[i][2])).sum();
                if drop >= rules.fall_min_drop_m {
                    water.falls.push(Fall {
                        id: water.falls.len(),
                        stream: id,
                        top,
                        bottom,
                        drop_m: drop,
                        gradient: drop / run.max(1.0),
                        catchment_km2: km2[start],
                        into_sea: sea[path[k]],
                    });
                }
            }
            water.streams.push(make_stream(id, &raw, &km2, end, field, rules));
        }

        // Hand corrections.
        for o in &rules.overrides {
            match o {
                WaterOverride::RemoveStreams { at, radius_m } => {
                    let near = |p: &Vec3| (p[0] - at[0]).hypot(p[2] - at[1]) <= *radius_m;
                    let mut out = Vec::new();
                    for s in std::mem::take(&mut water.streams) {
                        let mut run: Vec<usize> = Vec::new();
                        let flush = |run: &mut Vec<usize>, out: &mut Vec<Stream>, last: bool| {
                            if run.len() >= 2 {
                                let mut t = s.clone();
                                t.points = run.iter().map(|&k| s.points[k]).collect();
                                t.width_m = run.iter().map(|&k| s.width_m[k]).collect();
                                t.catchment_km2 = run.iter().map(|&k| s.catchment_km2[k]).collect();
                                if !last {
                                    t.ends_in = "gap".into();
                                }
                                out.push(t);
                            }
                            run.clear();
                        };
                        for (k, p) in s.points.iter().enumerate() {
                            if near(p) {
                                flush(&mut run, &mut out, false);
                            } else {
                                run.push(k);
                            }
                        }
                        flush(&mut run, &mut out, true);
                    }
                    water.streams = out;
                    water.falls.retain(|f| !near(&f.top) && !near(&f.bottom));
                }
                WaterOverride::AddStream { path, catchment_km2 } => {
                    let raw: Vec<Vec3> = path.iter().map(|p| [p[0], field.height(p[0], p[1]), p[1]]).collect();
                    let km2 = vec![*catchment_km2; raw.len()];
                    if raw.len() >= 2 {
                        water.streams.push(make_stream(0, &raw, &km2, "added", field, rules));
                    }
                }
                WaterOverride::RemoveLake { .. } => {}
            }
        }
        for (k, s) in water.streams.iter_mut().enumerate() {
            s.id = k;
        }
        for (k, f) in water.falls.iter_mut().enumerate() {
            f.id = k;
        }
        water.falls.sort_by(|a, b| b.drop_m.total_cmp(&a.drop_m));
        for (k, f) in water.falls.iter_mut().enumerate() {
            f.id = k;
        }
        water.grid = Grid::build(field, &water.streams);
        water.text = water.describe();
        water
    }

    /// The water at world x, z, if any: a lake, or the nearest stream within its half width
    /// plus `margin` metres.
    pub fn channel(&self, x: f32, z: f32, margin: f32) -> Option<Wet> {
        let g = &self.grid;
        if g.field_w == 0 {
            return None;
        }
        let col = ((x + g.extent[0] / 2.0) / g.spacing[0]).round();
        let row = ((z + g.extent[1] / 2.0) / g.spacing[1]).round();
        if col >= 0.0 && row >= 0.0 && (col as usize) < g.field_w && (row as usize) < g.field_d {
            let l = self.lake_level[row as usize * g.field_w + col as usize];
            if !l.is_nan() {
                return Some(Wet { level: l, dist: 0.0, half_width: 0.0 });
            }
        }
        let bx = ((x - g.origin[0]) / g.cell).floor();
        let bz = ((z - g.origin[1]) / g.cell).floor();
        if bx < 0.0 || bz < 0.0 || bx as usize >= g.cols || bz as usize >= g.rows {
            return None;
        }
        let mut best: Option<(f32, Wet)> = None;
        for &(s, k) in &g.buckets[bz as usize * g.cols + bx as usize] {
            let st = &self.streams[s as usize];
            let (a, b) = (st.points[k as usize], st.points[k as usize + 1]);
            let (dx, dz) = (b[0] - a[0], b[2] - a[2]);
            let len2 = (dx * dx + dz * dz).max(1e-6);
            let t = (((x - a[0]) * dx + (z - a[2]) * dz) / len2).clamp(0.0, 1.0);
            let (px, pz) = (a[0] + dx * t, a[2] + dz * t);
            let dist = (x - px).hypot(z - pz);
            let half = 0.5 * (st.width_m[k as usize] * (1.0 - t) + st.width_m[k as usize + 1] * t);
            if dist > half + margin {
                continue;
            }
            let level = a[1] + (b[1] - a[1]) * t;
            // Prefer the stream whose bank this is most inside of.
            let score = dist - half;
            if best.as_ref().is_none_or(|(s, _)| score < *s) {
                best = Some((score, Wet { level, dist, half_width: half }));
            }
        }
        best.map(|b| b.1)
    }

    /// Ground height after cutting stream channels and lake beds into it: `ground` is the
    /// terrain's own height at x, z. Banks ease back up to the ground over `bank` metres beside
    /// a stream; make it at least the mesh's vertex spacing so the channel shows.
    pub fn carve(&self, x: f32, z: f32, ground: f32, depth: f32, bank: f32) -> f32 {
        match self.channel(x, z, bank) {
            None => ground,
            Some(w) if w.half_width == 0.0 => ground.min(w.level - depth * 1.5),
            Some(w) => {
                // Full depth inside the stream, easing back up to the ground across the bank.
                let bed = w.level - depth;
                let t = ((w.dist - w.half_width) / bank).clamp(0.0, 1.0);
                let t = t * t * (3.0 - 2.0 * t);
                ground.min(bed + t * (ground - bed).max(0.0))
            }
        }
    }

    fn describe(&self) -> String {
        let len: f32 = self.streams.iter().map(|s| s.length_m).sum();
        let mut s = vec![format!(
            "{} streams, {:.1} km in all; {} reach the sea. {} waterfalls, {} lakes.",
            self.streams.len(),
            len / 1000.0,
            self.streams.iter().filter(|s| s.ends_in == "sea").count(),
            self.falls.len(),
            self.lakes.len()
        )];
        if let Some(big) = self.streams.iter().max_by(|a, b| {
            let (ca, cb) = (a.catchment_km2.last().unwrap_or(&0.0), b.catchment_km2.last().unwrap_or(&0.0));
            ca.total_cmp(cb)
        }) {
            let e = big.points.last().copied().unwrap_or_default();
            s.push(format!(
                "The largest drains {:.1} km² and ends in the {} at ({:.0}, {:.0}).",
                big.catchment_km2.last().unwrap_or(&0.0),
                big.ends_in,
                e[0],
                e[2]
            ));
        }
        for f in self.falls.iter().take(5) {
            s.push(format!(
                "Fall {}: {:.0} m drop at ({:.0}, {:.0}), {:.1} km² above it{}.",
                f.id,
                f.drop_m,
                f.top[0],
                f.top[2],
                f.catchment_km2,
                if f.into_sea { ", into the sea" } else { "" }
            ));
        }
        for l in &self.lakes {
            s.push(format!(
                "Lake {}: {:.0} m² at {:.1} m, centre ({:.0}, {:.0}).",
                l.id, l.area_m2, l.level_m, l.centre[0], l.centre[2]
            ));
        }
        s.join(" ")
    }

    /// Stats for `de water`: counts per what streams end in.
    pub fn ends(&self) -> BTreeMap<String, usize> {
        let mut m = BTreeMap::new();
        for s in &self.streams {
            *m.entry(s.ends_in.clone()).or_default() += 1;
        }
        m
    }
}

/// How our water compares with ESA WorldCover's "permanent water bodies" inland (the sea left
/// out): the share of WorldCover's inland water that we draw as lake or stream, and the share
/// of our lake area that WorldCover also sees as water.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CoverCheck {
    /// Inland water in WorldCover, m².
    pub cover_water_m2: f32,
    /// Share of it within one of our lakes or streams (plus 10 m, WorldCover's pixel).
    pub ours_found: f32,
    /// Share of our lake area that WorldCover calls water.
    pub lakes_confirmed: f32,
    /// WorldCover water blobs over 2000 m² that we miss, centre and area: places to look.
    pub missed: Vec<([f32; 2], f32)>,
}

impl Water {
    /// Compare with the land cover in `truth` (see [`CoverCheck`]).
    pub fn cover_check(&self, field: &Heightfield, truth: &crate::truth::Truth) -> CoverCheck {
        let (tw, th) = (truth.width as usize, truth.height as usize);
        let px_m = [field.spacing[0] / truth.per_px, field.spacing[1] / truth.per_px];
        let [ew, ed] = field.extent();
        let at = |c: usize, r: usize| {
            [
                (c as f32 + 0.5) / truth.per_px * field.spacing[0] - field.spacing[0] / 2.0 - ew / 2.0,
                (r as f32 + 0.5) / truth.per_px * field.spacing[1] - field.spacing[1] / 2.0 - ed / 2.0,
            ]
        };
        // Inland: water pixels whose ground is above the sea.
        let inland: Vec<bool> = (0..tw * th)
            .map(|k| {
                let [x, z] = at(k % tw, k / tw);
                truth.cover[k] == 80 && field.contains(x, z) && field.height(x, z) > 1.5
            })
            .collect();
        let px_area = px_m[0] * px_m[1];
        let (mut total, mut found, mut lake_px, mut lake_ok) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for (k, &water_here) in inland.iter().enumerate() {
            let [x, z] = at(k % tw, k / tw);
            let wet = self.channel(x, z, 10.0);
            if water_here {
                total += 1.0;
                if wet.is_some() {
                    found += 1.0;
                }
            }
            if wet.is_some_and(|w| w.half_width == 0.0) {
                lake_px += 1.0;
                if truth.cover[k] == 80 {
                    lake_ok += 1.0;
                }
            }
        }
        // Missed blobs: 8-connected inland water we don't cover.
        let mut seen = vec![false; tw * th];
        let mut missed = Vec::new();
        for s in 0..tw * th {
            if !inland[s] || seen[s] {
                continue;
            }
            let mut stack = vec![s];
            seen[s] = true;
            let (mut n, mut miss, mut cx, mut cz) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            while let Some(k) = stack.pop() {
                let [x, z] = at(k % tw, k / tw);
                n += 1.0;
                cx += x;
                cz += z;
                if self.channel(x, z, 10.0).is_none() {
                    miss += 1.0;
                }
                let (c, r) = ((k % tw) as i32, (k / tw) as i32);
                for dr in -1..=1 {
                    for dc in -1..=1 {
                        let (cc, rr) = (c + dc, r + dr);
                        if cc >= 0 && rr >= 0 && (cc as usize) < tw && (rr as usize) < th {
                            let j = rr as usize * tw + cc as usize;
                            if inland[j] && !seen[j] {
                                seen[j] = true;
                                stack.push(j);
                            }
                        }
                    }
                }
            }
            if miss * px_area >= 2000.0 && miss / n > 0.5 {
                missed.push(([cx / n, cz / n], n * px_area));
            }
        }
        missed.sort_by(|a, b| b.1.total_cmp(&a.1));
        CoverCheck {
            cover_water_m2: total * px_area,
            ours_found: found / total.max(1.0),
            lakes_confirmed: lake_ok / lake_px.max(1.0),
            missed,
        }
    }

    /// A top-down map: hillshaded ground, WorldCover's water in pale blue when `truth` is given,
    /// our streams and lakes in deep blue, and every waterfall as a numbered red mark.
    pub fn map(&self, field: &Heightfield, truth: Option<&crate::truth::Truth>, scale: u32) -> crate::image::Rgba {
        use crate::image::Rgba;
        let (w, d) = (field.width as u32 * scale, field.depth as u32 * scale);
        let mut img = Rgba::new(w, d, [0, 0, 0, 255]);
        let [ew, ed] = field.extent();
        let xz = |px: u32, py: u32| {
            [
                (px as f32 + 0.5) / scale as f32 * field.spacing[0] - ew / 2.0 - field.spacing[0] / 2.0,
                (py as f32 + 0.5) / scale as f32 * field.spacing[1] - ed / 2.0 - field.spacing[1] / 2.0,
            ]
        };
        let sun = [-0.5f32, 0.7, -0.5];
        for py in 0..d {
            for px in 0..w {
                let [x, z] = xz(px, py);
                let c = (px / scale) as usize;
                let r = (py / scale) as usize;
                let g = field.at(c, r);
                let col = if g <= SEA_CELL_M {
                    [40, 60, 90, 255]
                } else {
                    let n = field.normal(c, r);
                    let lit = (n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]).max(0.0) / 1.0;
                    let v = (60.0 + 170.0 * lit) as u8;
                    let mut p = [v, v, (v as f32 * 0.95) as u8, 255];
                    if truth.and_then(|t| t.cover_at(field, x, z)) == Some(80) {
                        p = [150, 200, 240, 255];
                    }
                    if let Some(wet) = self.channel(x, z, 0.0) {
                        p = if wet.half_width == 0.0 { [20, 70, 180, 255] } else { [10, 40, 200, 255] };
                    }
                    p
                };
                img.set(px, py, col);
            }
        }
        // Streams are often narrower than a pixel: draw every one at least a pixel wide.
        let to_px = |p: Vec3| {
            (
                ((p[0] + ew / 2.0) / field.spacing[0] + 0.5) * scale as f32,
                ((p[2] + ed / 2.0) / field.spacing[1] + 0.5) * scale as f32,
            )
        };
        for s in &self.streams {
            for p in &s.points {
                let (x, y) = to_px(*p);
                img.set(x as u32, y as u32, [10, 40, 200, 255]);
            }
        }
        for f in &self.falls {
            let (x, y) = to_px(f.top);
            for a in 0..32 {
                let t = a as f32 / 32.0 * std::f32::consts::TAU;
                for r in [4.0f32, 5.0] {
                    img.set((x + r * t.cos()) as u32, (y + r * t.sin()) as u32, [230, 30, 30, 255]);
                }
            }
            img.text(x as u32 + 7, (y as u32).saturating_sub(3), &f.id.to_string(), 1, [255, 255, 255, 255]);
        }
        img
    }

    /// A camera for each waterfall, downstream of it and looking back up at its face.
    pub fn fall_views(&self, field: &Heightfield) -> Vec<crate::View> {
        self.falls
            .iter()
            .map(|f| {
                let (dx, dz) = (f.bottom[0] - f.top[0], f.bottom[2] - f.top[2]);
                let len = dx.hypot(dz).max(1.0);
                let dist = (f.drop_m * 3.0).clamp(150.0, 700.0);
                let mid =
                    [(f.top[0] + f.bottom[0]) / 2.0, (f.top[1] + f.bottom[1]) / 2.0, (f.top[2] + f.bottom[2]) / 2.0];
                let (x, z) = (f.bottom[0] + dx / len * dist, f.bottom[2] + dz / len * dist);
                let ground = if field.contains(x, z) { field.height(x, z).max(0.6) } else { 0.6 };
                let y = (mid[1] + 0.25 * dist).max(ground + 30.0);
                crate::View { name: format!("fall{}", f.id), pos: [x, y, z], look_at: mid }
            })
            .collect()
    }
}

/// Signed metres from each heightmap cell to the shore line: positive out at sea (where the
/// water is shallow and waves break near zero), negative inland. The shore is taken half a cell
/// from the last land cell, so the field crosses zero between land and sea and a texture of it,
/// sampled bilinearly, finds the water's edge between cells. Two-pass chamfer distance
/// (Borgefors 1986), exact to a few percent. Cells of `h` at or below [`SEA_CELL_M`] plus
/// `tide_m` are sea.
pub fn shore_distance(field: &Heightfield, tide_m: f32) -> Vec<f32> {
    let land: Vec<bool> = field.heights.iter().map(|&h| h > SEA_CELL_M + tide_m).collect();
    let to_land = chamfer(field, |i| land[i]);
    let to_sea = chamfer(field, |i| !land[i]);
    let half = 0.5 * field.spacing[0].min(field.spacing[1]);
    land.iter()
        .enumerate()
        .map(|(i, &l)| if l { -(to_sea[i] - half).max(0.0) } else { (to_land[i] - half).max(0.0) })
        .collect()
}

/// Metres from each cell to the nearest cell where `seed` holds (0 there; infinite with no seed).
fn chamfer(field: &Heightfield, seed: impl Fn(usize) -> bool) -> Vec<f32> {
    let (w, d) = (field.width, field.depth);
    let (sx, sz) = (field.spacing[0], field.spacing[1]);
    let diag = sx.hypot(sz);
    let mut dist: Vec<f32> = (0..w * d).map(|i| if seed(i) { 0.0 } else { f32::INFINITY }).collect();
    let pass = |dist: &mut Vec<f32>, c: usize, r: usize, nb: &[(i32, i32, f32)]| {
        let i = r * w + c;
        for &(dc, dr, cost) in nb {
            let (cc, rr) = (c as i32 + dc, r as i32 + dr);
            if cc >= 0 && rr >= 0 && cc < w as i32 && rr < d as i32 {
                let v = dist[rr as usize * w + cc as usize] + cost;
                if v < dist[i] {
                    dist[i] = v;
                }
            }
        }
    };
    let fwd = [(-1, 0, sx), (0, -1, sz), (-1, -1, diag), (1, -1, diag)];
    let bwd = [(1, 0, sx), (0, 1, sz), (1, 1, diag), (-1, 1, diag)];
    for r in 0..d {
        for c in 0..w {
            pass(&mut dist, c, r, &fwd);
        }
    }
    for r in (0..d).rev() {
        for c in (0..w).rev() {
            pass(&mut dist, c, r, &bwd);
        }
    }
    dist
}

/// Smooth a cell path into a stream: Chaikin corners, points every [`POINT_STEP_M`], water
/// never running uphill.
fn make_stream(id: usize, raw: &[Vec3], km2: &[f32], end: &str, field: &Heightfield, rules: &WaterRules) -> Stream {
    let mut p: Vec<[f32; 3]> = raw.iter().zip(km2).map(|(p, a)| [p[0], p[2], *a]).collect();
    for _ in 0..3 {
        if p.len() < 3 {
            break;
        }
        let mut q = vec![p[0]];
        for k in 0..p.len() - 1 {
            let (a, b) = (p[k], p[k + 1]);
            let mix = |t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
            q.push(mix(0.25));
            q.push(mix(0.75));
        }
        q.push(p[p.len() - 1]);
        p = q;
    }
    // Resample by distance.
    let mut out: Vec<[f32; 3]> = vec![p[0]];
    let mut carry = 0.0;
    for k in 0..p.len() - 1 {
        let (a, b) = (p[k], p[k + 1]);
        let seg = (b[0] - a[0]).hypot(b[1] - a[1]);
        let mut t = POINT_STEP_M - carry;
        while t < seg {
            let f = t / seg;
            out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
            t += POINT_STEP_M;
        }
        carry = seg - (t - POINT_STEP_M);
    }
    if out.last() != p.last() {
        out.push(p[p.len() - 1]);
    }
    let end_y = raw.last().map(|p| p[1]).unwrap_or(0.0);
    let mut level = f32::MAX;
    let mut points = Vec::with_capacity(out.len());
    let mut length = 0.0;
    for (k, q) in out.iter().enumerate() {
        let g = if k + 1 == out.len() { end_y } else { field.height(q[0], q[1]) };
        level = level.min(g);
        points.push([q[0], level, q[1]]);
        if k > 0 {
            length += (q[0] - out[k - 1][0]).hypot(q[1] - out[k - 1][1]);
        }
    }
    let width = out
        .iter()
        .map(|q| (rules.width_m[0] + rules.width_per_sqrt_km2 * q[2].max(0.0).sqrt()).min(rules.width_m[1]))
        .collect();
    let drop = points[0][1] - points[points.len() - 1][1];
    Stream {
        id,
        points,
        width_m: width,
        catchment_km2: out.iter().map(|q| q[2]).collect(),
        ends_in: end.into(),
        length_m: length,
        drop_m: drop,
    }
}

impl Grid {
    fn build(field: &Heightfield, streams: &[Stream]) -> Self {
        let extent = field.extent();
        let pad = 40.0;
        let origin = [-extent[0] / 2.0 - pad, -extent[1] / 2.0 - pad];
        let cols = ((extent[0] + 2.0 * pad) / BUCKET_M).ceil() as usize + 1;
        let rows = ((extent[1] + 2.0 * pad) / BUCKET_M).ceil() as usize + 1;
        let mut buckets = vec![Vec::new(); cols * rows];
        let reach = 40.0; // widest stream plus bank, metres
        for (s, st) in streams.iter().enumerate() {
            for k in 0..st.points.len().saturating_sub(1) {
                let (a, b) = (st.points[k], st.points[k + 1]);
                let lo = [a[0].min(b[0]) - reach, a[2].min(b[2]) - reach];
                let hi = [a[0].max(b[0]) + reach, a[2].max(b[2]) + reach];
                let c0 = ((lo[0] - origin[0]) / BUCKET_M).floor().max(0.0) as usize;
                let c1 = (((hi[0] - origin[0]) / BUCKET_M).floor() as usize).min(cols - 1);
                let r0 = ((lo[1] - origin[1]) / BUCKET_M).floor().max(0.0) as usize;
                let r1 = (((hi[1] - origin[1]) / BUCKET_M).floor() as usize).min(rows - 1);
                for r in r0..=r1 {
                    for c in c0..=c1 {
                        buckets[r * cols + c].push((s as u32, k as u32));
                    }
                }
            }
        }
        Self {
            cell: BUCKET_M,
            origin,
            cols,
            rows,
            buckets,
            field_w: field.width,
            field_d: field.depth,
            spacing: field.spacing,
            extent,
        }
    }
}

fn cell_at(field: &Heightfield, at: [f32; 2]) -> Option<usize> {
    let [ew, ed] = field.extent();
    let c = ((at[0] + ew / 2.0) / field.spacing[0]).round();
    let r = ((at[1] + ed / 2.0) / field.spacing[1]).round();
    (c >= 0.0 && r >= 0.0 && (c as usize) < field.width && (r as usize) < field.depth)
        .then(|| r as usize * field.width + c as usize)
}

/// The 8 neighbours of a cell as (direction, index); even directions are diagonal.
fn neighbours(w: usize, d: usize) -> impl Fn(usize) -> std::vec::IntoIter<(usize, usize)> {
    move |i: usize| {
        let (c, r) = ((i % w) as i32, (i / w) as i32);
        let dirs = [(-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0)];
        let mut v = Vec::with_capacity(8);
        for (k, (dc, dr)) in dirs.into_iter().enumerate() {
            let (cc, rr) = (c + dc, r + dr);
            if cc >= 0 && rr >= 0 && cc < w as i32 && rr < d as i32 {
                v.push((k, rr as usize * w + cc as usize));
            }
        }
        v.into_iter()
    }
}

/// Priority-flood fill: raise every hollow to its spill point, plus `eps` per cell so water can
/// cross flats. Sea cells and the map's edge drain.
fn fill(h: &[f32], sea: &[bool], w: usize, d: usize, eps: f32) -> Vec<f32> {
    let n = w * d;
    let mut out = h.to_vec();
    let mut done = vec![false; n];
    // Heights are >= 0, so their bit patterns sort like the numbers; the index breaks ties.
    let key = |v: f32, i: usize| Reverse(((v.max(0.0).to_bits() as u64) << 32) | i as u64);
    let mut heap = BinaryHeap::new();
    for i in 0..n {
        let (c, r) = (i % w, i / w);
        if sea[i] || c == 0 || r == 0 || c == w - 1 || r == d - 1 {
            done[i] = true;
            heap.push(key(out[i], i));
        }
    }
    let nb = neighbours(w, d);
    while let Some(Reverse(k)) = heap.pop() {
        let i = (k & 0xffff_ffff) as usize;
        for (_, j) in nb(i) {
            if done[j] {
                continue;
            }
            done[j] = true;
            out[j] = out[j].max(out[i] + eps);
            heap.push(key(out[j], j));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A valley running south to the sea: walls rise east and west, the floor drops southwards,
    /// with a 40 m step two thirds of the way down and a hollow near the top.
    fn valley() -> Heightfield {
        let (w, d) = (41, 61);
        let mut heights = vec![0.0; w * d];
        for r in 0..d {
            for c in 0..w {
                let across = (c as f32 - 20.0).abs() * 6.0;
                let floor = if r >= 55 { 0.0 } else { (55 - r) as f32 * 3.0 + if r < 40 { 40.0 } else { 0.0 } };
                heights[r * w + c] = floor + across;
            }
        }
        // A hollow on the valley floor: 3x3 cells sunk 15 m.
        for r in 10..13 {
            for c in 19..22 {
                heights[r * w + c] -= 15.0;
            }
        }
        Heightfield { width: w, depth: d, spacing: [30.0, 30.0], heights }
    }

    #[test]
    fn the_valley_drains_to_the_sea_with_a_fall_and_a_lake() {
        let f = valley();
        let rules = WaterRules { min_catchment_km2: 0.05, lake_min_area_m2: 5000.0, ..Default::default() };
        let w = Water::find(&f, &rules);
        let main = w.streams.iter().max_by(|a, b| a.length_m.total_cmp(&b.length_m)).unwrap();
        assert_eq!(main.ends_in, "sea", "{}", w.text);
        assert!(main.points.windows(2).all(|p| p[1][1] <= p[0][1]), "water never runs uphill");
        assert!(main.points.iter().all(|p| p[0].abs() < 40.0), "follows the valley floor");
        assert_eq!(w.lakes.len(), 1, "{}", w.text);
        assert!(w.lakes[0].cells.len() >= 7, "{:?}", w.lakes[0]);
        let fall = w.falls.iter().find(|f| f.drop_m >= 40.0).expect("the step is a fall");
        assert!((fall.top[2] - f.world_xz(20, 39)[1]).abs() < 31.0, "{fall:?}");
        assert!(w.text.contains("waterfall"), "{}", w.text);
    }

    #[test]
    fn channel_and_carve() {
        let f = valley();
        let rules = WaterRules { min_catchment_km2: 0.05, lake_min_area_m2: 5000.0, ..Default::default() };
        let w = Water::find(&f, &rules);
        let [x, z] = f.world_xz(20, 50);
        let wet = w.channel(x, z, 0.0).expect("the valley floor is wet");
        assert!(wet.dist < 2.0, "{wet:?}");
        let g = f.height(x, z);
        assert!(w.carve(x, z, g, 1.2, 5.0) < wet.level - 1.0);
        let far = f.world_xz(5, 50);
        assert_eq!(w.carve(far[0], far[1], 99.0, 1.2, 5.0), 99.0, "dry ground stays");
        // In the lake.
        let [lx, lz] = f.world_xz(20, 11);
        assert!(w.channel(lx, lz, 0.0).is_some_and(|c| c.half_width == 0.0));
    }

    #[test]
    fn overrides_remove_and_add() {
        let f = valley();
        let at = f.world_xz(20, 48);
        let rules = WaterRules {
            min_catchment_km2: 0.05,
            overrides: vec![
                WaterOverride::RemoveStreams { at, radius_m: 50.0 },
                WaterOverride::AddStream { path: vec![f.world_xz(5, 30), f.world_xz(5, 50)], catchment_km2: 1.0 },
            ],
            ..Default::default()
        };
        let w = Water::find(&f, &rules);
        assert!(w.channel(at[0], at[1], 0.0).is_none());
        assert!(w.streams.iter().any(|s| s.ends_in == "gap"));
        assert!(w.streams.iter().any(|s| s.ends_in == "added"));
    }

    #[test]
    fn shore_distance_grows_out_to_sea() {
        let f = valley();
        let dist = shore_distance(&f, 0.0);
        // Row 58 of the sea strip (column 20) lies between walls one cell away.
        assert!(dist[30 * f.width + 5] < 0.0, "land is inland of the shore: {}", dist[30 * f.width + 5]);
        // The shore line lies half a cell out from the last land cell.
        let sea = 58 * f.width + 20;
        let half = 0.5 * f.spacing[0].min(f.spacing[1]);
        assert!((dist[sea] - (30.0 - half)).abs() < 1.0, "{}", dist[sea]);
        assert!(dist[sea] > 0.0 && dist[sea + 1] < 0.0, "zero between sea and land");
        // A high tide floods the lowest land, so the sea reaches further.
        let high = shore_distance(&f, 7.0);
        assert!(high[57 * f.width + 21] > 0.0);
    }

    #[test]
    fn deterministic() {
        let f = valley();
        let a = serde_json::to_string(&Water::find(&f, &WaterRules::default())).unwrap();
        let b = serde_json::to_string(&Water::find(&f, &WaterRules::default())).unwrap();
        assert_eq!(a, b);
    }
}
