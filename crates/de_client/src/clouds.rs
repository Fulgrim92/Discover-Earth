//! Volumetric clouds: a layer between `look.clouds.base_m` and `top_m`, ray-marched per pixel
//! (`clouds.wesl`) through the seeded noise volume from `de_world::clouds`, and their shadows
//! on the ground (`terrain.wesl` samples the same volume along the sun).
//!
//! The clouds draw on a box that follows the camera, after the land and the sea. It ignores the
//! depth test and stops each ray at the land itself (from the depth prepass), so clouds sit on
//! the ridges and wrap around them instead of being cut off by a sky dome.

use bevy::{
    asset::{RenderAssetUsages, embedded_asset},
    image::{ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor},
    light::{NotShadowCaster, NotShadowReceiver},
    mesh::MeshVertexBufferLayoutRef,
    pbr::{MaterialPipeline, MaterialPipelineKey},
    prelude::*,
    render::render_resource::{
        AsBindGroup, CompareFunction, Extent3d, RenderPipelineDescriptor, ShaderType, SpecializedMeshPipelineError,
        TextureDimension, TextureFormat,
    },
    shader::ShaderRef,
};
use de_world::{clouds::Noise, island::Look};

use crate::CameraRig;

/// What both cloud shaders need, packed in vec4s (see `clouds.wesl` for the layout).
#[derive(ShaderType, Clone, Copy, Debug, Default)]
pub struct CloudParams {
    /// base_m, top_m, scale_m, density (per metre).
    pub layer: Vec4,
    /// cover, detail, wind east, wind south (m/s).
    pub shape: Vec4,
    /// Direction to the sun, and the number of march steps.
    pub sun_dir: Vec4,
    /// Sunlight reaching the clouds, lux per channel, and the `light` multiplier.
    pub sun: Vec4,
    /// Sky light on the cloud tops (radiance per channel), and the fade distance in metres.
    pub sky_top: Vec4,
    /// Light on the cloud bellies (radiance per channel), and the shadow strength on the ground.
    pub sky_bottom: Vec4,
}

impl CloudParams {
    /// The layer, the light and the sky for an island's look. `cover` 0 turns both shaders off.
    pub fn new(look: &Look) -> Self {
        let c = &look.clouds;
        let to_sun = to_sun(look);
        let cine = &look.cinema;
        // Sunlight the clouds see: with the physical atmosphere the sun is given above it, so
        // dim and redden it along its path (Rayleigh plus a little haze, about 8 km of air).
        let base = Vec3::new(1.0, 0.95, 0.86);
        let sun = if cine.atmosphere {
            let air = 1.0 / to_sun.y.max(0.03);
            let tau = Vec3::new(0.046, 0.108, 0.265) + Vec3::splat(0.03);
            base * cine.sun_lux * Vec3::new((-tau.x * air).exp(), (-tau.y * air).exp(), (-tau.z * air).exp())
        } else {
            base * look.sun_lux
        };
        let zenith = Vec3::from(look.zenith);
        let horizon = Vec3::from(look.horizon);
        // Cloud tops see the open sky; bellies see the sky's horizon and the dark land below.
        let sky = look.sky_light;
        // Plus sunlight that has scattered many times inside the deck and comes out everywhere:
        // it follows the sun's height, which is why a noon overcast glows and an evening one
        // goes grey. It comes out nearly white (a grey of the sunlight's brightness, tinted by
        // the sky), and bellies get less of everything than tops, which gives clouds their
        // shape. Calibrated against the reference photos with `de photo match`.
        let lum = sun.dot(Vec3::new(0.2126, 0.7152, 0.0722));
        let tint = (zenith / zenith.max_element().max(1e-3)).lerp(Vec3::ONE, 0.6);
        let diffuse = Vec3::splat(lum * to_sun.y.max(0.0) * 0.5) * tint;
        let top = (zenith * 0.6 + horizon * 0.4) * sky + diffuse;
        let bottom = horizon * sky * 0.35 + diffuse * 0.6;
        Self {
            layer: Vec4::new(c.base_m, c.top_m, c.scale_m, c.density),
            shape: Vec4::new(c.cover, c.detail, c.wind[0], c.wind[1]),
            sun_dir: to_sun.extend(c.steps as f32),
            // The single-plus-octaves scattering in `clouds.wesl` leaves thick cloud about half
            // as bright as in the reference photos; this calibrates it, so `light` 1 matches them.
            sun: sun.extend(c.light * 2.0),
            sky_top: top.extend(c.reach_m),
            sky_bottom: bottom.extend(c.shadows),
        }
    }
}

/// Unit vector towards the sun: azimuth from north (−Z) clockwise towards east (+X).
pub fn to_sun(look: &Look) -> Vec3 {
    let (el, az) = (look.sun_elevation_deg.to_radians(), look.sun_azimuth_deg.to_radians());
    Vec3::new(az.sin() * el.cos(), el.sin(), -az.cos() * el.cos())
}

/// The noise volume as a repeating, filtered 3D texture.
pub fn noise_image(noise: &Noise) -> Image {
    let n = noise.size as u32;
    let mut img = Image::new(
        Extent3d { width: n, height: n, depth_or_array_layers: n },
        TextureDimension::D3,
        noise.rgba.clone(),
        TextureFormat::Rgba8Unorm,
        RenderAssetUsages::RENDER_WORLD,
    );
    img.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor {
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::Repeat,
        address_mode_w: ImageAddressMode::Repeat,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        ..default()
    });
    img
}

/// A 1x1x1 stand-in when the sky is clear, so the terrain material always has a volume bound.
pub fn empty_noise_image() -> Image {
    noise_image(&Noise { size: 1, rgba: vec![0, 0, 0, 255] })
}

#[derive(Asset, AsBindGroup, TypePath, Clone, Debug)]
pub struct CloudMaterial {
    #[uniform(0)]
    pub params: CloudParams,
    #[texture(1, dimension = "3d")]
    #[sampler(2)]
    pub noise: Handle<Image>,
}

impl Material for CloudMaterial {
    fn fragment_shader() -> ShaderRef {
        "embedded://de_client/clouds.wesl".into()
    }

    fn alpha_mode(&self) -> AlphaMode {
        AlphaMode::Premultiplied
    }

    fn enable_prepass() -> bool {
        false
    }

    fn enable_shadows() -> bool {
        false
    }

    fn specialize(
        _pipeline: &MaterialPipeline,
        descriptor: &mut RenderPipelineDescriptor,
        _layout: &MeshVertexBufferLayoutRef,
        _key: MaterialPipelineKey<Self>,
    ) -> Result<(), SpecializedMeshPipelineError> {
        // Every pixel marches; the shader stops at the land from the depth prepass.
        if let Some(depth) = descriptor.depth_stencil.as_mut() {
            depth.depth_compare = Some(CompareFunction::Always);
            depth.depth_write_enabled = Some(false);
        }
        descriptor.primitive.cull_mode = None;
        Ok(())
    }
}

/// The box the clouds draw on; it follows the camera.
#[derive(Component)]
pub struct CloudBox;

pub struct CloudsPlugin;

impl Plugin for CloudsPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "clouds.wesl");
        app.add_plugins(MaterialPlugin::<CloudMaterial>::default())
            .add_systems(PostUpdate, follow_camera.before(TransformSystems::Propagate));
    }
}

/// Spawns the cloud box for a look with clouds.
pub fn spawn(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<CloudMaterial>,
    params: CloudParams,
    noise: Handle<Image>,
) {
    commands.spawn((
        Name::new("clouds"),
        CloudBox,
        NotShadowCaster,
        NotShadowReceiver,
        bevy::camera::visibility::NoFrustumCulling,
        Mesh3d(meshes.add(Cuboid::from_length(2000.0))),
        MeshMaterial3d(materials.add(CloudMaterial { params, noise })),
    ));
}

fn follow_camera(
    cam: Query<&Transform, (With<CameraRig>, Without<CloudBox>)>,
    mut boxes: Query<&mut Transform, With<CloudBox>>,
) {
    let Ok(cam) = cam.single() else { return };
    for mut t in &mut boxes {
        t.translation = cam.translation;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_follow_the_look() {
        let mut look = Look::default();
        let off = CloudParams::new(&look);
        assert_eq!(off.shape.x, 0.0, "no cover by default: both shaders skip clouds");
        look.clouds.cover = 0.6;
        look.sun_elevation_deg = 30.0;
        let p = CloudParams::new(&look);
        assert_eq!(p.shape.x, 0.6);
        assert!((p.sun_dir.truncate().length() - 1.0).abs() < 1e-5);
        assert!((p.sun_dir.y - 30f32.to_radians().sin()).abs() < 1e-5);
        assert!(p.layer.y > p.layer.x);
        // Tops are lit more than bellies, and a higher sun lights the deck more.
        assert!(p.sky_top.truncate().length() > p.sky_bottom.truncate().length());
        look.sun_elevation_deg = 60.0;
        assert!(CloudParams::new(&look).sky_top.truncate().length() > p.sky_top.truncate().length());
    }

    #[test]
    fn noise_image_is_a_repeating_volume() {
        let img = empty_noise_image();
        assert_eq!(img.texture_descriptor.dimension, TextureDimension::D3);
        let ImageSampler::Descriptor(s) = &img.sampler else { panic!("no sampler") };
        assert_eq!(s.address_mode_w, ImageAddressMode::Repeat);
    }
}
