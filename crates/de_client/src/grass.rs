//! Grass, heather and moss: the tufts `de_world::grass` scatters, drawn as blades that bend in
//! the wind (grass most, heather a little, moss not at all).
//!
//! Each chunk around the camera is one mesh of blades, built once per level of detail (see
//! `GrassRules::chunks_near`). `grass.wesl` bends the blades with the wind in the vertex shader
//! and shrinks each tuft into the ground as the camera's distance passes its `keep`, so tufts
//! fade out smoothly and a chunk rebuilt at another level of detail never pops. Blades take the
//! ground's normal for lighting, so a meadow shades like the slope under it.

use std::collections::HashMap;

use bevy::{
    asset::{RenderAssetUsages, embedded_asset},
    light::NotShadowCaster,
    mesh::{Indices, PrimitiveTopology},
    pbr::{ExtendedMaterial, MaterialExtension},
    prelude::*,
    render::render_resource::{AsBindGroup, ShaderType},
    shader::ShaderRef,
};
use de_world::{
    Heightfield, Rng,
    grass::{GrassRules, Plant},
    island::Look,
    truth::Truth,
};

use crate::scene::Surface;

pub type GrassMaterial = ExtendedMaterial<StandardMaterial, GrassExt>;

#[derive(Asset, AsBindGroup, TypePath, Clone, Debug)]
pub struct GrassExt {
    #[uniform(100)]
    pub params: GrassParams,
}

#[derive(ShaderType, Clone, Copy, Debug)]
pub struct GrassParams {
    /// Wind direction (x, z), speed in m/s, sway (metres per metre of grass at 10 m/s).
    pub wind: Vec4,
    /// near_m, far_m of the level of detail.
    pub lod: Vec4,
}

impl MaterialExtension for GrassExt {
    fn vertex_shader() -> ShaderRef {
        "embedded://de_client/grass.wesl".into()
    }
    // The depth prepass needs the same wind, or clouds and mist that read its depth would
    // draw over the blades.
    fn prepass_vertex_shader() -> ShaderRef {
        "embedded://de_client/grass_prepass.wesl".into()
    }
    // Blades are too small to matter in the sun's shadow map.
    fn enable_shadows() -> bool {
        false
    }
}

pub struct GrassPlugin;

impl Plugin for GrassPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "grass.wesl");
        embedded_asset!(app, "grass_prepass.wesl");
        app.add_plugins(MaterialPlugin::<GrassMaterial>::default()).add_systems(Update, follow_camera);
    }
}

/// Everything needed to grow grass around the camera, and the chunks grown so far.
#[derive(Resource)]
pub struct Meadow {
    pub rules: GrassRules,
    pub field: Heightfield,
    pub truth: Option<Truth>,
    pub surface: Surface,
    pub sea_level: f32,
    /// The ground's average grass colour (see `ground::grass_ground_colour`).
    pub lush: [f32; 3],
    pub material: Handle<GrassMaterial>,
    chunks: HashMap<[i32; 2], (Entity, u8)>,
}

/// Most blades per tuft (heather), for sizing buffers.
const BLADES: usize = 7;

/// How each plant is built from blades: count, spread from the tuft's centre, half width and
/// lean (both per metre of height), how the lean curls (2: arcs over at the top, 1: straight
/// out), and how much the wind moves it (vertex colour alpha, read by `grass.wesl`).
struct Kind {
    blades: usize,
    radius: [f32; 2],
    width: [f32; 2],
    lean: [f32; 2],
    curl: f32,
    sway: f32,
}

impl Kind {
    fn of(plant: Plant) -> Self {
        match plant {
            Plant::Grass => {
                Self { blades: 4, radius: [0.03, 0.1], width: [0.006, 0.012], lean: [0.2, 0.65], curl: 2.0, sway: 1.0 }
            }
            // Stiff woody twigs in a rounded clump.
            Plant::Heather => Self {
                blades: 7,
                radius: [0.02, 0.12],
                width: [0.01, 0.016],
                lean: [0.15, 0.45],
                curl: 1.5,
                sway: 0.25,
            },
            // A low cushion: short wide fronds lying out flat.
            Plant::Moss => {
                Self { blades: 7, radius: [0.02, 0.16], width: [0.03, 0.05], lean: [1.5, 2.5], curl: 1.0, sway: 0.0 }
            }
        }
    }
}

impl Meadow {
    /// `ground`: the heightfield, its land cover (if any) and the drawn surface.
    pub fn new(
        rules: GrassRules,
        (field, truth, surface): (Heightfield, Option<Truth>, Surface),
        look: &Look,
        ground_colour: [f32; 3],
        sea_level: f32,
        materials: &mut Assets<GrassMaterial>,
    ) -> Self {
        let wind = Vec2::from(look.clouds.wind);
        // Wind near the ground is about half the wind aloft (log profile over grassland).
        let speed = wind.length() * 0.5;
        let dir = wind.normalize_or(Vec2::X);
        let material = materials.add(GrassMaterial {
            base: StandardMaterial {
                base_color: Color::WHITE,
                perceptual_roughness: 0.95,
                reflectance: 0.1,
                cull_mode: None,
                ..default()
            },
            extension: GrassExt {
                params: GrassParams {
                    wind: Vec4::new(dir.x, dir.y, speed, rules.sway),
                    lod: Vec4::new(rules.near_m, rules.far_m, 0.0, 0.0),
                },
            },
        });
        Self { rules, field, truth, surface, sea_level, lush: ground_colour, material, chunks: HashMap::new() }
    }

    /// The mesh of one chunk at a level of detail (tufts with `keep` under it).
    pub fn chunk_mesh(&self, chunk: [i32; 2], level: f32) -> Option<Mesh> {
        let tufts = self.rules.scatter(&self.field, self.truth.as_ref(), self.sea_level, chunk);
        let tufts: Vec<_> = tufts.into_iter().filter(|t| t.keep < level).collect();
        if tufts.is_empty() {
            return None;
        }
        let n = tufts.len() * BLADES;
        let mut pos = Vec::with_capacity(n * 5);
        let mut nor = Vec::with_capacity(n * 5);
        let mut uv = Vec::with_capacity(n * 5);
        let mut uv_b = Vec::with_capacity(n * 5);
        let mut col = Vec::with_capacity(n * 5);
        let mut idx: Vec<u32> = Vec::with_capacity(n * 9);
        // Colours start from what the ground's grass layer averages to, so plants match the
        // ground under and beyond them. Live grass: a little greener (soil and litter make the
        // ground browner than the blades); dry grass: straw, about as bright. Heather: dark
        // woody stems with purple-brown tips. Moss: yellow-green, greying on high dry ground
        // (woolly fringe-moss).
        let g = self.lush;
        let green = [g[0] * 0.95, g[1] * 1.1, g[2] * 0.85];
        let straw = [g[0] * 1.3, g[1] * 1.15, g[2] * 0.75];
        let mix3 = |a: [f32; 3], b: [f32; 3], t: f32| -> [f32; 3] { std::array::from_fn(|i| a[i] + (b[i] - a[i]) * t) };
        let grey = [(g[0] + g[1] + g[2]) / 3.0 * 1.1; 3];
        let s = &self.surface;
        for t in &tufts {
            let e = 0.75;
            let ground = |x: f32, z: f32| s.height(x, z);
            let n = Vec3::new(
                ground(t.x - e, t.z) - ground(t.x + e, t.z),
                2.0 * e,
                ground(t.x, t.z - e) - ground(t.x, t.z + e),
            )
            .normalize();
            let mut rng = Rng::new((t.x.to_bits() as u64) << 32 | t.z.to_bits() as u64);
            let mut f = || rng.next_f64() as f32;
            let p = Kind::of(t.plant);
            let (root, tip) = match t.plant {
                Plant::Grass => {
                    let c = mix3(green, straw, t.dry * 0.7);
                    (c, c)
                }
                Plant::Heather => ([g[0] * 0.75, g[1] * 0.55, g[2] * 0.65], [g[0] * 1.2, g[1] * 0.62, g[2] * 1.25]),
                Plant::Moss => {
                    let c = mix3([g[0] * 0.65, g[1] * 0.8, g[2] * 0.35], grey, t.dry * 0.2);
                    (c, c)
                }
            };
            for b in 0..p.blades {
                let a = t.turn + b as f32 * 2.399 + (f() - 0.5) * 0.6;
                let (dx, dz) = (a.cos(), a.sin());
                let r = p.radius[0] + f() * (p.radius[1] - p.radius[0]);
                let (bx, bz) = (t.x + dx * r, t.z + dz * r);
                let y = ground(bx, bz) - 0.02;
                let h = t.height * (0.65 + f() * 0.5);
                let w = p.width[0] + f() * (p.width[1] - p.width[0]);
                // Blades face across their lean; they lean out from the tuft's centre.
                let (sx, sz) = (-dz * w, dx * w);
                let lean = (p.lean[0] + f() * (p.lean[1] - p.lean[0])) * h;
                let shade = 0.85 + f() * 0.3;
                let base = pos.len() as u32;
                for (k, &(up, half)) in
                    [(0.0, 1.0), (0.0, -1.0), (0.55, 0.75), (0.55, -0.75), (1.0, 0.0)].iter().enumerate()
                {
                    let bend = lean * f32::powf(up, p.curl);
                    pos.push([bx + sx * half + dx * bend, y + h * up, bz + sz * half + dz * bend]);
                    nor.push(n.to_array());
                    uv.push([if k == 4 { 0.0 } else { half }, up]);
                    uv_b.push([h, t.keep]);
                    let c = mix3(root, tip, up);
                    col.push([c[0] * shade, c[1] * shade, c[2] * shade, p.sway]);
                }
                idx.extend_from_slice(&[
                    base,
                    base + 1,
                    base + 2,
                    base + 2,
                    base + 1,
                    base + 3,
                    base + 2,
                    base + 3,
                    base + 4,
                ]);
            }
        }
        let mut m = Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD);
        m.insert_attribute(Mesh::ATTRIBUTE_POSITION, pos);
        m.insert_attribute(Mesh::ATTRIBUTE_NORMAL, nor);
        m.insert_attribute(Mesh::ATTRIBUTE_UV_0, uv);
        m.insert_attribute(Mesh::ATTRIBUTE_UV_1, uv_b);
        m.insert_attribute(Mesh::ATTRIBUTE_COLOR, col);
        m.insert_indices(Indices::U32(idx));
        Some(m)
    }
}

/// Levels of detail a chunk is built at: the smallest one at or over the chunk's own.
const LEVELS: [f32; 6] = [1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125];

fn level_of(lod: f32) -> u8 {
    (0..LEVELS.len()).rev().find(|&i| LEVELS[i] >= lod).unwrap_or(0) as u8
}

/// Grow the chunks the camera can see and drop the ones it left behind.
fn follow_camera(
    mut commands: Commands,
    meadow: Option<ResMut<Meadow>>,
    camera: Query<&GlobalTransform, With<crate::CameraRig>>,
    mut meshes: ResMut<Assets<Mesh>>,
) {
    let (Some(mut meadow), Ok(cam)) = (meadow, camera.single()) else {
        return;
    };
    let eye = cam.translation().to_array();
    let want: HashMap<[i32; 2], u8> = meadow
        .rules
        .chunks_near(eye, |x, z| meadow.surface.height(x, z))
        .into_iter()
        .map(|(c, lod)| (c, level_of(lod)))
        .collect();
    let gone: Vec<[i32; 2]> = meadow.chunks.keys().filter(|c| !want.contains_key(*c)).copied().collect();
    for c in gone {
        if let Some((e, _)) = meadow.chunks.remove(&c) {
            commands.entity(e).despawn();
        }
    }
    for (c, level) in want {
        if meadow.chunks.get(&c).is_some_and(|&(_, l)| l == level) {
            continue;
        }
        if let Some((e, _)) = meadow.chunks.remove(&c) {
            commands.entity(e).despawn();
        }
        let entity = match meadow.chunk_mesh(c, LEVELS[level as usize]) {
            Some(mesh) => commands
                .spawn((
                    Name::new(format!("grass {} {}", c[0], c[1])),
                    NotShadowCaster,
                    Mesh3d(meshes.add(mesh)),
                    MeshMaterial3d(meadow.material.clone()),
                ))
                .id(),
            None => commands.spawn(Name::new(format!("grass {} {} (bare)", c[0], c[1]))).id(),
        };
        meadow.chunks.insert(c, (entity, level));
    }
}
