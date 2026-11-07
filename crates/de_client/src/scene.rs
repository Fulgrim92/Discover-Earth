//! The island scene: terrain mesh, sea, sky dome, sun, fog and the camera.

use std::path::PathBuf;

use bevy::{
    asset::RenderAssetUsages,
    camera::{Exposure, RenderTarget},
    light::{
        CascadeShadowConfigBuilder, DirectionalLightShadowMap, GlobalAmbientLight, NotShadowCaster, NotShadowReceiver,
    },
    mesh::{Indices, PrimitiveTopology},
    pbr::{DistanceFog, FogFalloff},
    prelude::*,
};
use de_world::{Heightfield, Island, island::Look};
use forge_core::Rng;

/// Which island to load, and from which `content/` folder.
#[derive(Resource, Clone, Debug)]
pub struct IslandSource {
    pub content: PathBuf,
    pub id: String,
}

/// Where the camera draws: the window, or an offscreen image (captures).
#[derive(Resource, Clone, Debug, Default)]
pub struct CameraTarget(pub Option<Handle<Image>>);

/// The loaded island and its ground, for systems that need heights (camera, captures).
#[derive(Resource, Clone, Debug)]
pub struct Ground {
    pub island: Island,
    pub field: Heightfield,
}

/// Marks the one camera the player or a step list moves. Reflected, so an agent can find it
/// over the Bevy Remote Protocol (`"filter": {"with": ["de_client::scene::CameraRig"]}`).
#[derive(Component, Default, Reflect)]
#[reflect(Component, Default)]
pub struct CameraRig;

pub struct ScenePlugin;

impl Plugin for ScenePlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<CameraRig>().init_resource::<CameraTarget>().add_systems(Startup, spawn_scene);
    }
}

/// Ground below sea level is pushed down this far, so the coast drops away under the water
/// instead of z-fighting with it (the DEM stores the sea as 0 m).
const SEABED_M: f32 = -25.0;
/// Height of the sea surface in metres.
pub const SEA_LEVEL_M: f32 = 0.6;

fn spawn_scene(
    mut commands: Commands,
    source: Res<IslandSource>,
    target: Res<CameraTarget>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let island = Island::load(&source.content, &source.id).unwrap_or_else(|e| panic!("{e}"));
    let field = island.heightfield(&source.content, &source.id).unwrap_or_else(|e| panic!("{e}"));
    let look = island.look.clone();
    let [w, d] = field.extent();
    // The sea runs on to the horizon; fog hides where it ends.
    let sea_reach = 400_000.0;

    // Terrain.
    commands.spawn((
        Name::new("terrain"),
        Mesh3d(meshes.add(terrain_mesh(&field, &look, &source.id))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::WHITE,
            perceptual_roughness: 0.93,
            reflectance: 0.3,
            ..default()
        })),
    ));

    // Sea: one large plane, slightly see-through so the seabed darkens it near the shore.
    let sea = Color::linear_rgba(look.sea[0], look.sea[1], look.sea[2], look.sea_alpha);
    commands.spawn((
        Name::new("sea"),
        NotShadowCaster,
        Mesh3d(meshes.add(Plane3d::default().mesh().size(sea_reach, sea_reach))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: sea,
            perceptual_roughness: 0.12,
            reflectance: 0.6,
            alpha_mode: AlphaMode::Blend,
            ..default()
        })),
        Transform::from_xyz(0.0, SEA_LEVEL_M, 0.0),
    ));

    // Sky: an unlit dome, horizon colour at the bottom fading to a deeper blue overhead.
    commands.spawn((
        Name::new("sky"),
        // The dome surrounds the sun's shadow camera; casting would put the world in shade.
        NotShadowCaster,
        NotShadowReceiver,
        Mesh3d(meshes.add(sky_mesh(sea_reach * 0.45, &look))),
        MeshMaterial3d(materials.add(StandardMaterial {
            base_color: Color::WHITE,
            unlit: true,
            fog_enabled: false,
            cull_mode: None,
            ..default()
        })),
    ));

    // Sun.
    let (el, az) = (look.sun_elevation_deg.to_radians(), look.sun_azimuth_deg.to_radians());
    // Direction *to* the sun: azimuth from north (−Z) clockwise towards east (+X).
    let to_sun = Vec3::new(az.sin() * el.cos(), el.sin(), -az.cos() * el.cos());
    commands.spawn((
        Name::new("sun"),
        DirectionalLight {
            illuminance: look.sun_lux,
            color: Color::srgb(1.0, 0.95, 0.86),
            shadow_maps_enabled: true,
            // Metres-scale terrain seen from hundreds of metres away: a larger normal bias
            // keeps broad slopes from shading themselves in blotches.
            shadow_normal_bias: 4.0,
            ..default()
        },
        Transform::from_translation(to_sun).looking_at(Vec3::ZERO, Vec3::Y),
        CascadeShadowConfigBuilder {
            num_cascades: 4,
            first_cascade_far_bound: 600.0,
            maximum_distance: w.max(d),
            ..default()
        }
        .build(),
    ));
    commands.insert_resource(DirectionalLightShadowMap { size: 4096 });
    commands.insert_resource(GlobalAmbientLight {
        color: Color::linear_rgb(look.horizon[0], look.horizon[1], look.horizon[2]),
        brightness: 500.0,
        ..default()
    });

    // Camera at the first view.
    let start = island
        .views
        .first()
        .map(|v| crate::look(v.pos, v.look_at))
        .unwrap_or_else(|| crate::look([0.0, field.max_height() + 400.0, d * 0.6], [0.0, 0.0, 0.0]));
    let horizon = Color::linear_rgb(look.horizon[0], look.horizon[1], look.horizon[2]);
    let mut camera = commands.spawn((
        Name::new("camera"),
        CameraRig,
        Camera3d::default(),
        Camera { clear_color: ClearColorConfig::Custom(horizon), ..default() },
        Projection::Perspective(PerspectiveProjection {
            fov: 55f32.to_radians(),
            near: 0.5,
            far: sea_reach,
            ..default()
        }),
        Exposure { ev100: 12.0 },
        DistanceFog {
            color: horizon,
            directional_light_color: Color::srgba(1.0, 0.92, 0.75, 0.35),
            directional_light_exponent: 24.0,
            falloff: FogFalloff::Exponential { density: std::f32::consts::LN_2 / look.fog_half_m },
        },
        start,
    ));
    if let Some(image) = &target.0 {
        camera.insert(RenderTarget::Image(image.clone().into()));
    }

    commands.insert_resource(Ground { island, field });
}

/// The heightfield as one mesh: a vertex per pixel, coloured by height and slope, with a
/// little seeded variation so slopes do not read as flat paint.
pub fn terrain_mesh(h: &Heightfield, look: &Look, seed_name: &str) -> Mesh {
    let (w, d) = (h.width, h.depth);
    let mut rng = Rng::new(seed_name.bytes().fold(2166136261u32, |a, b| (a ^ u32::from(b)).wrapping_mul(16777619)));
    let mut positions = Vec::with_capacity(w * d);
    let mut normals = Vec::with_capacity(w * d);
    let mut colors = Vec::with_capacity(w * d);
    let mix = |a: [f32; 3], b: [f32; 3], t: f32| -> [f32; 3] {
        let t = t.clamp(0.0, 1.0);
        [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
    };
    let top = h.max_height().max(1.0);
    for row in 0..d {
        for col in 0..w {
            let [x, z] = h.world_xz(col, row);
            let y0 = h.at(col, row);
            let y = if y0 <= 0.5 { SEABED_M } else { y0 };
            let n = h.normal(col, row);
            positions.push([x, y, z]);
            normals.push(n);
            let slope = 1.0 - n[1]; // 0 flat .. 1 vertical
            let rockiness = ((slope - look.rock_slope * 0.35) / (look.rock_slope * 0.65)).clamp(0.0, 1.0);
            // Higher ground is browner and thinner.
            let grass = mix(look.grass, [look.grass[0] * 1.5, look.grass[1] * 1.05, look.grass[2] * 1.2], y0 / top);
            let mut c = mix(grass, look.rock, rockiness.powf(0.8));
            if y0 < 6.0 {
                c = mix(look.shore, c, y0 / 6.0);
            }
            let v = 0.88 + rng.next_f64() as f32 * 0.24;
            colors.push([c[0] * v, c[1] * v, c[2] * v, 1.0]);
        }
    }
    let mut indices = Vec::with_capacity((w - 1) * (d - 1) * 6);
    for row in 0..d as u32 - 1 {
        for col in 0..w as u32 - 1 {
            let i = row * w as u32 + col;
            let (r, b, br) = (i + 1, i + w as u32, i + w as u32 + 1);
            indices.extend_from_slice(&[i, b, r, r, b, br]);
        }
    }
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::RENDER_WORLD)
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, positions)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, normals)
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, colors)
        .with_inserted_indices(Indices::U32(indices))
}

/// A hemisphere-and-a-bit, seen from inside, coloured from the horizon up to the zenith.
fn sky_mesh(radius: f32, look: &Look) -> Mesh {
    let mut mesh = Sphere::new(radius).mesh().uv(48, 24);
    let zenith = [0.10, 0.24, 0.52];
    let positions: Vec<[f32; 3]> = match mesh.attribute(Mesh::ATTRIBUTE_POSITION) {
        Some(bevy::mesh::VertexAttributeValues::Float32x3(p)) => p.clone(),
        _ => unreachable!("sphere meshes have Float32x3 positions"),
    };
    let colors: Vec<[f32; 4]> = positions
        .iter()
        .map(|p| {
            let t = (p[1] / radius).max(0.0).powf(0.45);
            let c = |i: usize| look.horizon[i] + (zenith[i] - look.horizon[i]) * t;
            [c(0), c(1), c(2), 1.0]
        })
        .collect();
    mesh.insert_attribute(Mesh::ATTRIBUTE_COLOR, colors);
    mesh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terrain_mesh_has_a_vertex_per_pixel_and_drops_the_seabed() {
        let heights = vec![0.0, 10.0, 20.0, 0.0, 30.0, 40.0, 0.0, 50.0, 60.0];
        let h = Heightfield { width: 3, depth: 3, spacing: [10.0, 10.0], heights };
        let mesh = terrain_mesh(&h, &Look::default(), "t");
        assert_eq!(mesh.count_vertices(), 9);
        assert_eq!(mesh.indices().map(|i| i.len()), Some(2 * 2 * 6));
        let Some(bevy::mesh::VertexAttributeValues::Float32x3(p)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
            panic!("positions")
        };
        assert_eq!(p[0][1], SEABED_M, "sea pixels sink below the water");
        assert_eq!(p[1][1], 10.0);
    }

    #[test]
    fn terrain_colours_are_seeded() {
        let h = Heightfield { width: 2, depth: 2, spacing: [1.0, 1.0], heights: vec![5.0; 4] };
        let colors = |seed| match terrain_mesh(&h, &Look::default(), seed).attribute(Mesh::ATTRIBUTE_COLOR) {
            Some(bevy::mesh::VertexAttributeValues::Float32x4(c)) => c.clone(),
            _ => panic!("colours"),
        };
        assert_eq!(colors("a"), colors("a"));
        assert_ne!(colors("a"), colors("b"));
    }
}
