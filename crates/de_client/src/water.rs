//! Streams, waterfalls and lakes as meshes and a material, from [`de_world::water::Water`].
//!
//! Streams are ribbons laid on the ground mesh (which has their channels cut in). Each vertex
//! carries the stream's own frame for `water.wesl`: across and along in its UV, downstream as
//! its tangent, and white-water amount, flow speed and half width in its colour, so ripples
//! and foam move downstream at the water's speed. Lakes are flat sheets at their level over
//! their cells and two cells around them; the carved shore hides the edge. Every waterfall
//! gets a sheet of mist where it lands.

use bevy::{
    asset::{RenderAssetUsages, embedded_asset},
    mesh::{Indices, PrimitiveTopology},
    pbr::{ExtendedMaterial, MaterialExtension},
    prelude::*,
    render::render_resource::{AsBindGroup, ShaderType},
    shader::ShaderRef,
};
use de_world::{Heightfield, island::Look, water::Water};

use crate::scene::{SEA_LEVEL_M, Surface};

/// How far water sits above the ground mesh under it, metres.
const LIFT_M: f32 = 0.25;
/// Where a stream drops this much per metre it is fully white water; it starts at half that.
pub const WHITE_GRADIENT: f32 = 0.3;

pub type WaterMaterial = ExtendedMaterial<StandardMaterial, WaterExt>;

#[derive(Asset, AsBindGroup, TypePath, Clone, Debug)]
pub struct WaterExt {
    #[uniform(100)]
    pub params: WaterParams,
}

#[derive(ShaderType, Clone, Copy, Debug)]
pub struct WaterParams {
    pub deep: Vec4,
    pub foam: Vec4,
    pub horizon: Vec4,
    pub zenith: Vec4,
    /// x: 0 water, 1 mist; y: sky reflection strength; z: ripple strength.
    pub flags: Vec4,
}

impl MaterialExtension for WaterExt {
    fn fragment_shader() -> ShaderRef {
        "embedded://de_client/water.wesl".into()
    }
}

pub struct WaterPlugin;

impl Plugin for WaterPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "water.wesl");
        app.add_plugins(MaterialPlugin::<WaterMaterial>::default());
    }
}

/// The water material, or the mist material when `mist` is set.
pub fn material(look: &Look, zenith: [f32; 3], mist: bool) -> WaterMaterial {
    let v = |c: [f32; 3]| Vec4::new(c[0], c[1], c[2], 1.0);
    WaterMaterial {
        base: StandardMaterial {
            base_color: Color::WHITE,
            perceptual_roughness: 0.06,
            reflectance: 0.5,
            alpha_mode: if mist { AlphaMode::Blend } else { AlphaMode::Opaque },
            cull_mode: if mist { None } else { Some(bevy::render::render_resource::Face::Back) },
            double_sided: mist,
            ..default()
        },
        extension: WaterExt {
            params: WaterParams {
                deep: v(look.stream),
                foam: v(look.foam),
                horizon: v(look.horizon),
                zenith: v(zenith),
                flags: Vec4::new(if mist { 1.0 } else { 0.0 }, 1.0, 1.0, 0.0),
            },
        },
    }
}

/// Meshes for streams (with white water), lakes and the mist at waterfalls.
#[derive(Default)]
pub struct WaterMeshes {
    pub streams: Builder,
    pub lakes: Builder,
    pub mist: Builder,
}

/// What `water.wesl` needs per vertex besides position and normal.
#[derive(Clone, Copy)]
struct Lane {
    /// Downstream, horizontal.
    dir: Vec2,
    /// Metres along the stream at the quad's first and second edge.
    along: [f32; 2],
    /// White-water amount and flow speed at each edge.
    foam: [f32; 2],
    speed: [f32; 2],
    half_width: [f32; 2],
}

impl Lane {
    const LAKE: Lane = Lane { dir: Vec2::X, along: [0.0; 2], foam: [0.0; 2], speed: [0.0; 2], half_width: [0.0; 2] };
}

#[derive(Default)]
pub struct Builder {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub colors: Vec<[f32; 4]>,
    pub tangents: Vec<[f32; 4]>,
    pub indices: Vec<u32>,
}

impl Builder {
    /// p: a-left, a-right, b-left, b-right. Wound so the face points up (Bevy culls back
    /// faces, and water is seen from above), with the quad's own slope as its normal.
    fn quad(&mut self, p: [[f32; 3]; 4], lane: Lane) {
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
        // UV x: -1 on the left bank, +1 on the right; y: metres along.
        for (k, side) in [(0, -1.0), (0, 1.0), (1, -1.0), (1, 1.0)] {
            self.uvs.push([side, lane.along[k]]);
            self.colors.push([lane.foam[k], lane.speed[k], lane.half_width[k], 1.0]);
        }
        let t = [lane.dir.x, 0.0, lane.dir.y, 1.0];
        self.tangents.extend(std::iter::repeat_n(t, 4));
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
            .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uvs)
            .with_inserted_attribute(Mesh::ATTRIBUTE_TANGENT, self.tangents)
            .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, self.colors)
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
        // Height under each point: on the ground, up to the water level where the channel is
        // cut, and never below the sea where a stream runs into it.
        let y: Vec<f32> = p
            .iter()
            .map(|q| {
                let g = surface.height(q[0], q[2]);
                g.max(q[1].min(g + 3.0)).max(SEA_LEVEL_M) + LIFT_M
            })
            .collect();
        let dir = |k: usize| {
            let (a, b) = (p[k.saturating_sub(1)], p[(k + 1).min(p.len() - 1)]);
            Vec2::new(b[0] - a[0], b[2] - a[2]).normalize_or(Vec2::X)
        };
        let grad = |k: usize| {
            let (a, b) = (k.saturating_sub(1), (k + 1).min(p.len() - 1));
            let run = (p[b][0] - p[a][0]).hypot(p[b][2] - p[a][2]).max(0.1);
            ((y[a] - y[b]) / run).max(0.0)
        };
        // Flow speed grows with the slope, like water over a rough bed (roughly Manning's sqrt).
        let speed = |k: usize| (0.4 + 4.0 * grad(k).sqrt()).min(8.0);
        let foam = |k: usize| ((grad(k) / WHITE_GRADIENT - 0.5) * 2.0).clamp(0.0, 1.0);
        let mut along = 0.0;
        for k in 0..p.len() - 1 {
            let step = (p[k + 1][0] - p[k][0]).hypot(p[k + 1][2] - p[k][2]);
            let edge = |k: usize| {
                let d = dir(k);
                let n = Vec2::new(-d.y, d.x) * s.width_m[k] * 0.5;
                let (x, z) = (p[k][0], p[k][2]);
                [[x - n.x, y[k], z - n.y], [x + n.x, y[k], z + n.y]]
            };
            let (a, b) = (edge(k), edge(k + 1));
            let lane = Lane {
                dir: (dir(k) + dir(k + 1)).normalize_or(Vec2::X),
                along: [along, along + step],
                foam: [foam(k), foam(k + 1)],
                speed: [speed(k), speed(k + 1)],
                half_width: [s.width_m[k] * 0.5, s.width_m[k + 1] * 0.5],
            };
            out.streams.quad([a[0], a[1], b[0], b[1]], lane);
            along += step;
        }
    }
    // Mist where each waterfall lands: three crossed upright sheets, sized by the drop.
    for f in &water.falls {
        let size = (f.drop_m * 0.5).clamp(12.0, 70.0);
        let base = Vec3::new(f.bottom[0], f.bottom[1].max(SEA_LEVEL_M), f.bottom[2]);
        for k in 0..3 {
            let a = k as f32 * std::f32::consts::PI / 3.0;
            let d = Vec3::new(a.cos(), 0.0, a.sin()) * size * 0.5;
            let up = Vec3::Y * size * 0.9;
            let i = out.mist.positions.len() as u32;
            for (pos, uv) in [
                (base - d, [0.0, 0.0]),
                (base + d, [1.0, 0.0]),
                (base - d + up, [0.0, 1.0]),
                (base + d + up, [1.0, 1.0]),
            ] {
                out.mist.positions.push((pos - Vec3::Y * 2.0).to_array());
                out.mist.normals.push([0.0, 1.0, 0.0]);
                out.mist.uvs.push(uv);
                out.mist.colors.push([1.0; 4]);
                out.mist.tangents.push([1.0, 0.0, 0.0, 1.0]);
            }
            out.mist.indices.extend_from_slice(&[i, i + 2, i + 1, i + 1, i + 2, i + 3]);
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
                out.lakes.quad(corners.map(at), Lane::LAKE);
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
        assert!(!m.streams.is_empty() && !m.mist.is_empty());
        let n = m.streams.positions.len();
        assert_eq!((m.streams.uvs.len(), m.streams.colors.len(), m.streams.tangents.len()), (n, n, n));
        assert!(m.streams.colors.iter().any(|c| c[0] > 0.5), "the cliff step is white water");
        assert!(m.streams.colors.iter().any(|c| c[0] == 0.0), "the gentle floor is calm");
        for p in &m.streams.positions {
            let g = surface.height(p[0], p[2]);
            assert!(p[1] >= g + LIFT_M - 0.01, "water above the ground: {p:?} ground {g}");
        }
        // Every triangle faces up (counter-clockwise seen from above), or it would be culled.
        for b in [&m.streams, &m.lakes] {
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
