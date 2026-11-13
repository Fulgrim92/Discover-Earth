//! Streams, waterfalls and lakes as meshes, from [`de_world::water::Water`].
//!
//! Streams are ribbons laid on the ground mesh (which has their channels cut in), split into
//! calm water and white water where they fall steeply. Lakes are flat sheets at their level
//! over their cells and one ring around them; the carved shore hides the edge.

use bevy::{
    asset::RenderAssetUsages,
    mesh::{Indices, PrimitiveTopology},
    prelude::*,
};
use de_world::{Heightfield, water::Water};

use crate::scene::Surface;

/// How far water sits above the ground mesh under it, metres.
const LIFT_M: f32 = 0.25;
/// A stream is white water where it drops more than this per metre.
pub const WHITE_GRADIENT: f32 = 0.22;

/// Triangle lists for calm stream water, white water and lakes.
#[derive(Default)]
pub struct WaterMeshes {
    pub calm: Builder,
    pub white: Builder,
    pub lakes: Builder,
}

#[derive(Default)]
pub struct Builder {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
}

impl Builder {
    fn quad(&mut self, p: [[f32; 3]; 4]) {
        // p: a-left, a-right, b-left, b-right. Wound so the face points up (Bevy culls back
        // faces, and water is seen from above), with the quad's own slope as its normal.
        let e1 = Vec3::from(p[2]) - Vec3::from(p[0]);
        let e2 = Vec3::from(p[1]) - Vec3::from(p[0]);
        let mut n = e1.cross(e2).normalize_or(Vec3::Y);
        let flip = n.y < 0.0;
        if flip {
            n = -n;
        }
        let i = self.positions.len() as u32;
        self.positions.extend_from_slice(&p);
        self.normals.extend(std::iter::repeat_n(n.to_array(), 4));
        if flip {
            self.indices.extend_from_slice(&[i, i + 1, i + 2, i + 1, i + 3, i + 2]);
        } else {
            self.indices.extend_from_slice(&[i, i + 2, i + 1, i + 1, i + 2, i + 3]);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    pub fn mesh(self) -> Mesh {
        Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
            .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.positions)
            .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, self.normals)
            .with_inserted_indices(Indices::U32(self.indices))
    }
}

/// Build the water meshes. `surface` is the carved ground the terrain mesh is made from.
pub fn meshes(water: &Water, field: &Heightfield, surface: &Surface) -> WaterMeshes {
    let mut out = WaterMeshes::default();
    for s in &water.streams {
        let p = &s.points;
        if p.len() < 2 {
            continue;
        }
        // Surface height under each point: never below the water level, always on the ground.
        let y: Vec<f32> = p
            .iter()
            .map(|q| surface.height(q[0], q[2]).max(q[1].min(surface.height(q[0], q[2]) + 3.0)) + LIFT_M)
            .collect();
        let side = |k: usize| {
            let (a, b) = (p[k.saturating_sub(1)], p[(k + 1).min(p.len() - 1)]);
            let t = Vec2::new(b[0] - a[0], b[2] - a[2]).normalize_or(Vec2::X);
            Vec2::new(-t.y, t.x)
        };
        let grad = |k: usize| {
            let (a, b) = (k.saturating_sub(1), (k + 1).min(p.len() - 1));
            let run = (p[b][0] - p[a][0]).hypot(p[b][2] - p[a][2]).max(0.1);
            (y[a] - y[b]) / run
        };
        for k in 0..p.len() - 1 {
            let edge = |k: usize| {
                let n = side(k) * s.width_m[k] * 0.5;
                let (x, z) = (p[k][0], p[k][2]);
                [[x - n.x, y[k], z - n.y], [x + n.x, y[k], z + n.y]]
            };
            let (a, b) = (edge(k), edge(k + 1));
            let target = if grad(k).max(grad(k + 1)) > WHITE_GRADIENT { &mut out.white } else { &mut out.calm };
            target.quad([a[0], a[1], b[0], b[1]]);
        }
    }
    // Lakes: a sheet on the ground mesh's grid over the lake and two cells around it, left out
    // only where the ground drops well below the level (an outlet running off downhill). The
    // carved shore then hides the sheet's edge, so the shoreline follows the ground.
    let (w, d) = (field.width, field.depth);
    let sub = ((surface.w - 1) / (w - 1)).max(1);
    let mut taken = vec![false; surface.w * surface.d];
    for l in &water.lakes {
        let y = l.level_m + LIFT_M * 0.4;
        let mut near = vec![false; w * d];
        for &i in &l.cells {
            let (c, r) = ((i % w) as i32, (i / w) as i32);
            for rr in (r - 2).max(0)..=(r + 2).min(d as i32 - 1) {
                for cc in (c - 2).max(0)..=(c + 2).min(w as i32 - 1) {
                    near[rr as usize * w + cc as usize] = true;
                }
            }
        }
        for r in 0..surface.d - 1 {
            for c in 0..surface.w - 1 {
                // The heightmap cell nearest this quad's centre.
                let (fc, fr) = (((2 * c + 1) / (2 * sub)).min(w - 1), ((2 * r + 1) / (2 * sub)).min(d - 1));
                let k = r * surface.w + c;
                if !near[fr * w + fc] || taken[k] {
                    continue;
                }
                let corners = [(c, r), (c + 1, r), (c, r + 1), (c + 1, r + 1)];
                let low = corners.iter().map(|&(a, b)| surface.heights[b * surface.w + a]).fold(f32::MAX, f32::min);
                let own = water.lake_level[fr * w + fc] == l.level_m;
                if !own && low < l.level_m - 1.0 {
                    continue;
                }
                taken[k] = true;
                let at = |(a, b): (usize, usize)| {
                    [
                        a as f32 * surface.step[0] - surface.extent[0] / 2.0,
                        y,
                        b as f32 * surface.step[1] - surface.extent[1] / 2.0,
                    ]
                };
                out.lakes.quad(corners.map(at));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use de_world::{island::Look, water::WaterRules};

    #[test]
    fn a_valley_gets_stream_and_white_water_on_its_ground() {
        // A valley falling south with a cliff step, as in de_world's water tests.
        let (w, d) = (41, 61);
        let mut heights = vec![0.0; w * d];
        for r in 0..d {
            for c in 0..w {
                let across = (c as f32 - 20.0).abs() * 6.0;
                let floor = if r >= 55 { 0.0 } else { (55 - r) as f32 * 3.0 + if r < 40 { 40.0 } else { 0.0 } };
                heights[r * w + c] = floor + across;
            }
        }
        let field = Heightfield { width: w, depth: d, spacing: [30.0, 30.0], heights };
        let water = Water::find(&field, &WaterRules { min_catchment_km2: 0.05, ..Default::default() });
        let look = Look { relief_m: 0.0, ..Look::default() };
        let surface = Surface::new(&field, &look, "t", Some((&water, 1.2)));
        let m = meshes(&water, &field, &surface);
        assert!(!m.calm.is_empty() && !m.white.is_empty());
        for p in m.calm.positions.iter().chain(&m.white.positions) {
            let g = surface.height(p[0], p[2]);
            assert!(p[1] >= g + LIFT_M - 0.01, "water above the ground: {p:?} ground {g}");
        }
        // Every triangle faces up (counter-clockwise seen from above), or it would be culled.
        for b in [&m.calm, &m.white, &m.lakes] {
            for t in b.indices.chunks(3) {
                let [a, p, q] = [t[0], t[1], t[2]].map(|i| Vec3::from(b.positions[i as usize]));
                assert!((p - a).cross(q - a).y > 0.0, "triangle {t:?} faces down");
            }
        }
        // The channel is cut: the ground under the stream is below the uncut valley floor.
        let [x, z] = field.world_xz(20, 50);
        assert!(surface.height(x, z) < field.height(x, z) - 0.5);
    }
}
