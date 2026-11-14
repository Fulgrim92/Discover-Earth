//! Grass: the tufts `de_world::grass` scatters, drawn as blades that bend in the wind.
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
use de_world::{Heightfield, Rng, grass::GrassRules, island::Look, truth::Truth};

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

/// Blades per tuft.
const BLADES: usize = 4;

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
                perceptual_roughness: 0.85,
                reflectance: 0.3,
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
        // Live blades: the colour the ground's grass layer averages to (so the meadow matches
        // the ground under and beyond it), a little greener, since soil and litter make the
        // ground browner than the blades. Dry blades: straw, about as bright.
        let g = self.lush;
        let green = [g[0] * 0.95, g[1] * 1.1, g[2] * 0.85];
        let straw = [g[0] * 1.3, g[1] * 1.15, g[2] * 0.75];
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
            let c: [f32; 3] = std::array::from_fn(|i| green[i] + (straw[i] - green[i]) * t.dry * 0.7);
            for b in 0..BLADES {
                let a = t.turn + b as f32 * 2.399 + (f() - 0.5) * 0.6;
                let (dx, dz) = (a.cos(), a.sin());
                let r = 0.03 + f() * 0.07;
                let (bx, bz) = (t.x + dx * r, t.z + dz * r);
                let y = ground(bx, bz) - 0.02;
                let h = t.height * (0.65 + f() * 0.5);
                let w = 0.006 + f() * 0.006;
                // Blades face across their lean; they lean out from the tuft's centre.
                let (sx, sz) = (-dz * w, dx * w);
                let lean = (0.2 + f() * 0.45) * h;
                let shade = 0.85 + f() * 0.3;
                let base = pos.len() as u32;
                for (k, &(up, half)) in
                    [(0.0, 1.0), (0.0, -1.0), (0.55, 0.75), (0.55, -0.75), (1.0, 0.0)].iter().enumerate()
                {
                    let bend = lean * up * up;
                    pos.push([bx + sx * half + dx * bend, y + h * up, bz + sz * half + dz * bend]);
                    nor.push(n.to_array());
                    uv.push([if k == 4 { 0.0 } else { half }, up]);
                    uv_b.push([h, t.keep]);
                    col.push([c[0] * shade, c[1] * shade, c[2] * shade, 1.0]);
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
