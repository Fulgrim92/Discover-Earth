//! The terrain's material: Bevy's PBR extended with blended ground layers (`terrain.wesl`).
//!
//! Layers are grass, rock, shore and moss, weighted per vertex by `scene::terrain_mesh`. Each
//! layer takes its scanned texture from `content/materials/<layer>/albedo.jpg` when present
//! (`scripts/materials/fetch.py` downloads CC0 sets), and seeded noise in the island's colours
//! when not, so the game is complete without textures and richer with them.

use std::path::Path;

use bevy::{
    asset::{RenderAssetUsages, embedded_asset},
    image::{ImageAddressMode, ImageFilterMode, ImageSampler, ImageSamplerDescriptor, ImageType},
    pbr::{ExtendedMaterial, MaterialExtension},
    prelude::*,
    render::render_resource::{
        AsBindGroup, Extent3d, ShaderType, TextureDimension, TextureFormat, TextureViewDescriptor, TextureViewDimension,
    },
    shader::ShaderRef,
};
use de_world::island::Look;

use crate::clouds::CloudParams;

/// Ground layer names, in the order of the vertex weights (r, g, b, a) and the texture array.
pub const LAYERS: [&str; 4] = ["grass", "rock", "shore", "moss"];

pub type TerrainMaterial = ExtendedMaterial<StandardMaterial, TerrainExt>;

#[derive(Asset, AsBindGroup, TypePath, Clone, Debug)]
pub struct TerrainExt {
    #[uniform(100)]
    pub params: TerrainParams,
    #[texture(101, dimension = "2d_array")]
    #[sampler(102)]
    pub albedo: Handle<Image>,
    #[texture(103, dimension = "2d_array")]
    #[sampler(104)]
    pub normal: Handle<Image>,
    /// The cloud layer, for cloud shadows (cover 0: none).
    #[uniform(105)]
    pub clouds: CloudParams,
    #[texture(106, dimension = "3d")]
    #[sampler(107)]
    pub cloud_noise: Handle<Image>,
}

#[derive(ShaderType, Clone, Copy, Debug)]
pub struct TerrainParams {
    pub grass: Vec4,
    pub rock: Vec4,
    pub shore: Vec4,
    pub moss: Vec4,
    pub tile_m: Vec4,
    pub flags: Vec4,
}

impl MaterialExtension for TerrainExt {
    fn fragment_shader() -> ShaderRef {
        "embedded://de_client/terrain.wesl".into()
    }
}

pub struct GroundPlugin;

impl Plugin for GroundPlugin {
    fn build(&self, app: &mut App) {
        embedded_asset!(app, "terrain.wesl");
        app.add_plugins(MaterialPlugin::<TerrainMaterial>::default());
    }
}

/// The terrain material for an island's look, with scanned textures if `content/materials`
/// has all four layers.
pub fn terrain_material(
    look: &Look,
    content: &Path,
    images: &mut Assets<Image>,
    clouds: CloudParams,
    cloud_noise: Handle<Image>,
) -> TerrainMaterial {
    let v = |c: [f32; 3]| Vec4::new(c[0], c[1], c[2], 1.0);
    let scanned = load_layers(content, "albedo.jpg", true).zip(load_layers(content, "normal.jpg", false));
    let has = scanned.is_some();
    let (albedo, normal) = match scanned {
        Some((a, n)) => (images.add(a), images.add(n)),
        None => (images.add(flat_array([128, 128, 128, 255])), images.add(flat_array([128, 128, 255, 255]))),
    };
    TerrainMaterial {
        base: StandardMaterial { base_color: Color::WHITE, perceptual_roughness: 0.92, reflectance: 0.3, ..default() },
        extension: TerrainExt {
            params: TerrainParams {
                grass: v(look.grass),
                rock: v(look.rock),
                shore: v(look.shore),
                moss: v(look.moss),
                tile_m: Vec4::new(3.0, 6.0, 4.0, 3.0),
                flags: Vec4::new(if has { 1.0 } else { 0.0 }, look.detail_normals, look.detail_fade_m, 0.0),
            },
            albedo,
            normal,
            clouds,
            cloud_noise,
        },
    }
}

/// A 1x1 texture array of four layers, bound when there are no scanned textures.
fn flat_array(px: [u8; 4]) -> Image {
    let mut img = Image::new(
        Extent3d { width: 1, height: 1, depth_or_array_layers: LAYERS.len() as u32 },
        TextureDimension::D2,
        px.repeat(LAYERS.len()),
        TextureFormat::Rgba8Unorm,
        RenderAssetUsages::RENDER_WORLD,
    );
    img.texture_view_descriptor =
        Some(TextureViewDescriptor { dimension: Some(TextureViewDimension::D2Array), ..default() });
    img
}

/// Every layer's `<file>` stacked into one mipmapped texture array, or None if any is missing.
fn load_layers(content: &Path, file: &str, srgb: bool) -> Option<Image> {
    let mut size = None;
    let mut layers = Vec::new();
    for layer in LAYERS {
        let path = content.join("materials").join(layer).join(file);
        let bytes = std::fs::read(&path).ok()?;
        let img = Image::from_buffer(
            &bytes,
            ImageType::Extension("jpg"),
            default(),
            srgb,
            ImageSampler::Default,
            RenderAssetUsages::RENDER_WORLD,
        )
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let want = if srgb { TextureFormat::Rgba8UnormSrgb } else { TextureFormat::Rgba8Unorm };
        let img = if img.texture_descriptor.format == want {
            img
        } else {
            img.convert(want).unwrap_or_else(|| panic!("{}: cannot convert to RGBA8", path.display()))
        };
        let s = (img.width(), img.height());
        if *size.get_or_insert(s) != s {
            panic!("{}: is {}x{}, other layers are {:?}; all layers need one size", path.display(), s.0, s.1, size);
        }
        layers.push(img.data.expect("decoded image has data"));
    }
    let (w, h) = size?;
    let mips = (w.min(h) as f32).log2().floor() as u32 + 1;
    // Layer-major order: every mip of layer 0, then every mip of layer 1, ...
    let mut data = Vec::new();
    for layer in layers {
        let (mut lw, mut lh, mut px) = (w, h, layer);
        for _ in 0..mips {
            data.extend_from_slice(&px);
            (px, lw, lh) = halve(&px, lw, lh, srgb);
        }
    }
    let format = if srgb { TextureFormat::Rgba8UnormSrgb } else { TextureFormat::Rgba8Unorm };
    let mut img = Image { data: Some(data), ..default() };
    img.texture_descriptor.size = Extent3d { width: w, height: h, depth_or_array_layers: LAYERS.len() as u32 };
    img.texture_descriptor.dimension = TextureDimension::D2;
    img.texture_descriptor.format = format;
    img.texture_descriptor.mip_level_count = mips;
    img.texture_view_descriptor =
        Some(TextureViewDescriptor { dimension: Some(TextureViewDimension::D2Array), ..default() });
    img.sampler = ImageSampler::Descriptor(ImageSamplerDescriptor {
        address_mode_u: ImageAddressMode::Repeat,
        address_mode_v: ImageAddressMode::Repeat,
        mag_filter: ImageFilterMode::Linear,
        min_filter: ImageFilterMode::Linear,
        mipmap_filter: ImageFilterMode::Linear,
        anisotropy_clamp: 8,
        ..default()
    });
    img.asset_usage = RenderAssetUsages::RENDER_WORLD;
    Some(img)
}

/// The next mip down: a 2x2 box filter (in linear light for colour textures).
fn halve(px: &[u8], w: u32, h: u32, srgb: bool) -> (Vec<u8>, u32, u32) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let to_lin = |v: u8| if srgb { (f32::from(v) / 255.0).powf(2.2) } else { f32::from(v) / 255.0 };
    let from_lin = |v: f32| ((if srgb { v.powf(1.0 / 2.2) } else { v }) * 255.0).round().clamp(0.0, 255.0) as u8;
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            for c in 0..4 {
                let mut sum = 0.0;
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let sx = (x * 2 + dx).min(w - 1);
                    let sy = (y * 2 + dy).min(h - 1);
                    let v = px[((sy * w + sx) * 4 + c) as usize];
                    sum += if c == 3 { f32::from(v) / 255.0 } else { to_lin(v) };
                }
                let avg = sum / 4.0;
                out[((y * nw + x) * 4 + c) as usize] = if c == 3 { (avg * 255.0).round() as u8 } else { from_lin(avg) };
            }
        }
    }
    (out, nw, nh)
}

/// The average colour (linear) the terrain shader draws for the grass layer: the scanned
/// texture's mean with the shader's tint towards `look.grass`, or the noise colour's mean when
/// there is no texture. Grass blades use it so a meadow and the ground under it match.
pub fn grass_ground_colour(content: &Path, look: &Look) -> [f32; 3] {
    let base = look.grass;
    let path = content.join("materials").join("grass").join("albedo.jpg");
    let mean = std::fs::read(&path).ok().and_then(|bytes| {
        let img = Image::from_buffer(
            &bytes,
            ImageType::Extension("jpg"),
            default(),
            true,
            ImageSampler::Default,
            RenderAssetUsages::RENDER_WORLD,
        )
        .ok()?
        .convert(TextureFormat::Rgba8UnormSrgb)?;
        let data = img.data?;
        let n = (data.len() / 4) as f32;
        let lin = |v: u8| {
            let c = f32::from(v) / 255.0;
            if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        };
        let mut sum = [0.0f32; 3];
        for px in data.chunks_exact(4) {
            for i in 0..3 {
                sum[i] += lin(px[i]);
            }
        }
        Some(sum.map(|s| s / n))
    });
    match mean {
        Some(tex) => {
            let avg = ((base[0] + base[1] + base[2]) / 3.0).max(0.001);
            std::array::from_fn(|i| tex[i] * (0.75 + 0.25 * base[i] / avg))
        }
        // Noise mean: (0.6 + 0.6 * 0.5) * (0.6 + 0.8 * 0.5).
        None => base.map(|c| c * 0.9),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halving_averages_and_shrinks() {
        let px = [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255];
        let (out, w, h) = halve(&px, 2, 2, false);
        assert_eq!((w, h), (1, 1));
        assert_eq!(out, vec![128, 128, 128, 255]);
    }

    #[test]
    fn no_textures_means_noise_layers() {
        let mut images = Assets::<Image>::default();
        let m = terrain_material(
            &Look::default(),
            Path::new("/nonexistent"),
            &mut images,
            CloudParams::default(),
            Handle::default(),
        );
        assert_eq!(m.extension.params.flags.x, 0.0);
    }
}
