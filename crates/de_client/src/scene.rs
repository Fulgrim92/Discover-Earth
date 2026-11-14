//! The island scene: terrain mesh, sea, sky dome, sun, fog and the camera.

use std::path::PathBuf;

use bevy::{
    asset::RenderAssetUsages,
    camera::{Exposure, RenderTarget},
    core_pipeline::tonemapping::Tonemapping,
    light::{Atmosphere, AtmosphereEnvironmentMapLight, atmosphere::ScatteringMedium},
    light::{
        CascadeShadowConfigBuilder, DirectionalLightShadowMap, GlobalAmbientLight, NotShadowCaster, NotShadowReceiver,
    },
    mesh::{Indices, PrimitiveTopology},
    pbr::{AtmosphereSettings, DistanceFog, FogFalloff},
    post_process::bloom::Bloom,
    prelude::*,
    render::view::{ColorGrading, ColorGradingGlobal, ColorGradingSection},
};
pub use de_world::Surface;
pub use de_world::island::layer_weights;
use de_world::{Heightfield, Island, island::Look, water::Water};

use crate::clouds::{CloudMaterial, CloudParams, CloudsPlugin};
use crate::ground::{GroundPlugin, TerrainMaterial, terrain_material};

/// Which island to load, and from which `content/` folder.
#[derive(Resource, Clone, Debug)]
pub struct IslandSource {
    pub content: PathBuf,
    pub id: String,
}

/// Where the camera draws: the window, or an offscreen image (captures).
#[derive(Resource, Clone, Debug, Default)]
pub struct CameraTarget(pub Option<Handle<Image>>);

/// Present for `sketch` captures: no shadows, for quick layout checks.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct Sketch;

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
        app.add_plugins((GroundPlugin, CloudsPlugin, crate::water::WaterPlugin, crate::grass::GrassPlugin))
            .register_type::<CameraRig>()
            .init_resource::<CameraTarget>()
            .add_systems(Startup, spawn_scene);
    }
}

/// Ground below sea level is pushed down this far, so the coast drops away under the water
/// instead of z-fighting with it (the DEM stores the sea as 0 m).
const SEABED_M: f32 = -25.0;
/// Vertical field of view of the camera, degrees.
pub const FOV_Y_DEG: f32 = 55.0;

/// Height of the sea surface in metres.
pub const SEA_LEVEL_M: f32 = de_world::sense::SEA_LEVEL_M;

/// The scene's material stores, grouped to keep `spawn_scene` within Bevy's parameter limit.
type Materials<'w> = (
    ResMut<'w, Assets<StandardMaterial>>,
    ResMut<'w, Assets<TerrainMaterial>>,
    ResMut<'w, Assets<CloudMaterial>>,
    ResMut<'w, Assets<crate::water::WaterMaterial>>,
    ResMut<'w, Assets<crate::grass::GrassMaterial>>,
);

fn spawn_scene(
    mut commands: Commands,
    source: Res<IslandSource>,
    (target, sketch): (Res<CameraTarget>, Option<Res<Sketch>>),
    mut meshes: ResMut<Assets<Mesh>>,
    (mut materials, mut terrain_materials, mut cloud_materials, mut water_materials, mut grass_materials): Materials,
    (mut images, mut media): (ResMut<Assets<Image>>, ResMut<Assets<ScatteringMedium>>),
) {
    let island = Island::load(&source.content, &source.id).unwrap_or_else(|e| panic!("{e}"));
    let field = island.heightfield(&source.content, &source.id).unwrap_or_else(|e| panic!("{e}"));
    let look = island.look.clone();
    let [w, d] = field.extent();
    // The sea runs on to the horizon; fog hides where it ends.
    let sea_reach = 400_000.0;

    // Clouds: the seeded noise volume, shared by the cloud layer and the terrain's shadows.
    let clouds = CloudParams::new(&look);
    let noise = images.add(if look.clouds.on() {
        crate::clouds::noise_image(&de_world::clouds::Noise::new(de_world::clouds::seed(&source.id)))
    } else {
        crate::clouds::empty_noise_image()
    });
    if clouds.any() {
        crate::clouds::spawn(&mut commands, &mut meshes, &mut cloud_materials, clouds, noise.clone());
    }

    // Streams, waterfalls and lakes, found in the terrain under the island's rules.
    let rules = de_world::water::Rules::load(&source.content, &source.id).unwrap_or_else(|e| panic!("{e}"));
    let water = Water::find(&field, &rules.water);
    let surface = Surface::new(&field, &look, &source.id, Some((&water, rules.water.channel_depth_m)));

    // Terrain.
    commands.spawn((
        Name::new("terrain"),
        Mesh3d(meshes.add(surface_mesh(&field, &look, &surface))),
        MeshMaterial3d(terrain_materials.add(terrain_material(&look, &source.content, &mut images, clouds, noise))),
    ));

    let sea_level = SEA_LEVEL_M + look.tide_m;
    let shore = images.add(crate::water::shore_image(&field, look.tide_m));
    let wm = crate::water::meshes(&water, &field, &surface, sea_level);
    let water_mat =
        water_materials.add(crate::water::material(&look, crate::water::Kind::Fresh, shore.clone(), [w, d]));
    let mist_mat = water_materials.add(crate::water::material(&look, crate::water::Kind::Mist, shore.clone(), [w, d]));
    for (name, b, mat) in
        [("streams", wm.streams, water_mat.clone()), ("lakes", wm.lakes, water_mat), ("mist", wm.mist, mist_mat)]
    {
        if !b.is_empty() {
            commands.spawn((Name::new(name), NotShadowCaster, Mesh3d(meshes.add(b.mesh())), MeshMaterial3d(mat)));
        }
    }

    // Grass where the land cover and the terrain say, grown around the camera as it moves.
    let truth = de_world::truth::Truth::load(&source.content, &source.id, &island).unwrap_or_else(|e| panic!("{e}"));
    commands.insert_resource(crate::grass::Meadow::new(
        rules.grass.clone(),
        (field.clone(), truth, surface.clone()),
        &look,
        crate::ground::grass_ground_colour(&source.content, &look),
        sea_level,
        &mut grass_materials,
    ));

    // Sea: one large plane at the tide's level, with wind waves and foam along the shore.
    commands.spawn((
        Name::new("sea"),
        NotShadowCaster,
        Mesh3d(meshes.add(crate::water::sea_mesh(sea_reach))),
        MeshMaterial3d(water_materials.add(crate::water::material(
            &look,
            crate::water::Kind::Sea,
            shore.clone(),
            [w, d],
        ))),
        Transform::from_xyz(0.0, sea_level, 0.0),
    ));

    // Sky: an unlit dome, horizon colour at the bottom fading to a deeper blue overhead; or, with
    // `cinema.atmosphere`, a physically based atmosphere (the dome would read as far terrain).
    let cine = &look.cinema;
    if cine.atmosphere {
        commands.spawn((Name::new("atmosphere"), Atmosphere::earth(media.add(ScatteringMedium::default()))));
    } else {
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
    }

    // Sun.
    let (el, az) = (look.sun_elevation_deg.to_radians(), look.sun_azimuth_deg.to_radians());
    // Direction *to* the sun: azimuth from north (−Z) clockwise towards east (+X).
    let to_sun = Vec3::new(az.sin() * el.cos(), el.sin(), -az.cos() * el.cos());
    commands.spawn((
        Name::new("sun"),
        DirectionalLight {
            illuminance: if cine.atmosphere { cine.sun_lux } else { look.sun_lux },
            color: Color::srgb(1.0, 0.95, 0.86),
            shadow_maps_enabled: sketch.is_none(),
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
        brightness: look.sky_light,
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
            fov: FOV_Y_DEG.to_radians(),
            near: 0.5,
            far: sea_reach,
            ..default()
        }),
        Exposure { ev100: cine.exposure_ev100 },
        tonemapper(&cine.tonemapper),
        ColorGrading::with_identical_sections(
            ColorGradingGlobal { temperature: cine.temperature, ..default() },
            ColorGradingSection { saturation: cine.saturation, contrast: cine.contrast, ..default() },
        ),
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
    if cine.atmosphere {
        camera.insert((
            AtmosphereSettings { aerial_view_lut_max_distance: 60_000.0, ..default() },
            AtmosphereEnvironmentMapLight::default(),
        ));
    }
    if clouds.any() {
        // The clouds and mist stop their rays at the land, which they read from the depth prepass.
        camera.insert(bevy::core_pipeline::prepass::DepthPrepass);
    }
    if cine.bloom > 0.0 {
        camera.insert(Bloom { intensity: cine.bloom, ..Bloom::NATURAL });
    }

    commands.insert_resource(Ground { island, field });
}

/// The tonemapper named in `look.cinema.tonemapper` (checked by `Island::check`).
fn tonemapper(name: &str) -> Tonemapping {
    match name {
        "agx" => Tonemapping::AgX,
        "aces" => Tonemapping::AcesFitted,
        "filmic" => Tonemapping::BlenderFilmic,
        "reinhard" => Tonemapping::ReinhardLuminance,
        "none" => Tonemapping::None,
        _ => Tonemapping::TonyMcMapface,
    }
}

/// The heightfield as one mesh, `look.subdivide` vertices per pixel along each side (see
/// [`Surface`]). Vertex colours carry the ground layer weights (r grass, g rock, b shore, a moss)
/// that the terrain shader blends.
pub fn terrain_mesh(h: &Heightfield, look: &Look, seed_name: &str) -> Mesh {
    surface_mesh(h, look, &Surface::new(h, look, seed_name, None))
}

pub fn surface_mesh(h: &Heightfield, look: &Look, s: &Surface) -> Mesh {
    let (w, d, step) = (s.w, s.d, s.step);
    let [ew, ed] = s.extent;
    let at = |c: usize, r: usize| s.at(c, r);
    let top = h.max_height().max(1.0);
    let mut positions = Vec::with_capacity(w * d);
    let mut normals = Vec::with_capacity(w * d);
    let mut weights = Vec::with_capacity(w * d);
    for row in 0..d {
        for col in 0..w {
            let y0 = at(col, row);
            let (x, z) = (col as f32 * step[0] - ew / 2.0, row as f32 * step[1] - ed / 2.0);
            let n = {
                let (l, r) = (at(col.saturating_sub(1), row), at(col + 1, row));
                let (u, dn) = (at(col, row.saturating_sub(1)), at(col, row + 1));
                Vec3::new((l - r) / (2.0 * step[0]), 1.0, (u - dn) / (2.0 * step[1])).normalize()
            };
            positions.push([x, if y0 <= 0.5 { SEABED_M } else { y0 }, z]);
            normals.push(n.to_array());
            weights.push(layer_weights(y0, 1.0 - n.y, top, look));
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
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, weights)
        .with_inserted_indices(Indices::U32(indices))
}

/// A hemisphere-and-a-bit, seen from inside, coloured from the horizon up to the zenith.
fn sky_mesh(radius: f32, look: &Look) -> Mesh {
    let mut mesh = Sphere::new(radius).mesh().uv(48, 24);
    let zenith = look.zenith;
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

    fn flat_look(sub: u32) -> Look {
        Look { subdivide: sub, relief_m: 0.0, ..Look::default() }
    }

    #[test]
    fn mesh_has_subdivided_vertices_and_drops_the_seabed() {
        let heights = vec![0.0, 10.0, 20.0, 0.0, 30.0, 40.0, 0.0, 50.0, 60.0];
        let h = Heightfield { width: 3, depth: 3, spacing: [10.0, 10.0], heights };
        assert_eq!(terrain_mesh(&h, &flat_look(1), "t").count_vertices(), 9);
        let mesh = terrain_mesh(&h, &flat_look(2), "t");
        assert_eq!(mesh.count_vertices(), 25);
        let Some(bevy::mesh::VertexAttributeValues::Float32x3(p)) = mesh.attribute(Mesh::ATTRIBUTE_POSITION) else {
            panic!("positions")
        };
        assert_eq!(p[0][1], SEABED_M, "sea pixels sink below the water");
        assert!((p[2][1] - 10.0).abs() < 1e-4, "original pixels keep their height: {}", p[2][1]);
        assert!((p[2][0] - 0.0).abs() < 1e-4, "half-step spacing");
    }

    #[test]
    fn relief_is_seeded() {
        let h = Heightfield { width: 4, depth: 4, spacing: [10.0, 10.0], heights: vec![50.0; 16] };
        let look = Look { relief_m: 2.0, ..Look::default() };
        let pos = |seed| match terrain_mesh(&h, &look, seed).attribute(Mesh::ATTRIBUTE_POSITION) {
            Some(bevy::mesh::VertexAttributeValues::Float32x3(p)) => p.clone(),
            _ => panic!("positions"),
        };
        assert_eq!(pos("a"), pos("a"));
        assert_ne!(pos("a"), pos("b"));
        assert!(pos("a").iter().all(|p| (p[1] - 50.0).abs() <= 2.0 + 1e-4));
    }

    #[test]
    fn layer_weights_sum_to_one_and_follow_the_ground() {
        let look = Look::default();
        for (y, slope) in [(2.0, 0.0), (100.0, 0.0), (300.0, 0.6), (500.0, 0.2)] {
            let w = layer_weights(y, slope, 700.0, &look);
            assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-4, "{w:?}");
        }
        assert!(layer_weights(2.0, 0.0, 700.0, &look)[2] > 0.5, "low and flat is shore");
        assert!(layer_weights(300.0, 0.8, 700.0, &look)[1] > 0.9, "steep is rock");
        assert!(layer_weights(100.0, 0.0, 700.0, &look)[0] > 0.5, "low flat inland is grass");
    }
}
