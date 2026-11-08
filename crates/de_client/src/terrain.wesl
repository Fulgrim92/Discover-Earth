// Discover Earth terrain: Bevy's PBR with ground layers blended per vertex (r grass,
// g rock, b shore, a moss), each from a scanned texture when the island has them and from
// seeded noise otherwise, plus fine detail normals so the ground reads at drone height.

import bevy_pbr::render::{
    forward_io::{VertexOutput, FragmentOutput},
    pbr_fragment::pbr_input_from_standard_material,
    pbr_functions::{apply_pbr_lighting, main_pass_post_lighting_processing},
    mesh_view_bindings::view,
};

struct TerrainParams {
    grass: vec4<f32>,
    rock: vec4<f32>,
    shore: vec4<f32>,
    moss: vec4<f32>,
    // Metres one texture tile covers, per layer (grass, rock, shore, moss).
    tile_m: vec4<f32>,
    // x: 1 when the scanned textures are bound, y: detail normal strength,
    // z: distance in metres at which fine detail has faded out, w: unused.
    flags: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> terrain: TerrainParams;
@group(constants::MATERIAL_BIND_GROUP) @binding(101) var albedo_tex: texture_2d_array<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(102) var albedo_smp: sampler;
@group(constants::MATERIAL_BIND_GROUP) @binding(103) var normal_tex: texture_2d_array<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(104) var normal_smp: sampler;

fn hash3(p: vec3<f32>) -> f32 {
    let q = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    let r = q * 17.0;
    return fract(r.x * r.y * r.z * (r.x + r.y + r.z));
}

fn noise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), u.x),
            mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
        mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), u.x),
            mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), u.x), u.y),
        u.z);
}

// Fractal noise in 0..1; octaves above what a pixel can show are faded out by `fade`.
fn fbm(p: vec3<f32>, fade: f32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = p;
    for (var i = 0; i < 5; i++) {
        let w = select(1.0, fade, i >= 2);
        sum += amp * w * (noise3(q) - 0.5);
        q = q * 2.03 + vec3(17.1, 3.7, 9.2);
        amp *= 0.5;
    }
    return 0.5 + sum;
}

// Triplanar sample of one layer of a texture array.
fn triplanar(tex: texture_2d_array<f32>, smp: sampler, layer: u32, p: vec3<f32>, n: vec3<f32>, tile: f32) -> vec4<f32> {
    var w = pow(abs(n), vec3(4.0));
    w = w / (w.x + w.y + w.z);
    let x = textureSample(tex, smp, p.zy / tile, layer);
    let y = textureSample(tex, smp, p.xz / tile, layer);
    let z = textureSample(tex, smp, p.xy / tile, layer);
    return x * w.x + y * w.y + z * w.z;
}

fn layer_colour(i: u32, base: vec3<f32>, p: vec3<f32>, n: vec3<f32>, fade: f32) -> vec3<f32> {
    if terrain.flags.x > 0.5 {
        let tile = terrain.tile_m[i];
        // Two scales of the same texture break up visible tiling.
        let near = triplanar(albedo_tex, albedo_smp, i, p, n, tile).rgb;
        let far = triplanar(albedo_tex, albedo_smp, i, p, n, tile * 7.3).rgb;
        let tex = mix(far, near, 0.5 + 0.5 * fade);
        // A light tint towards the island's look keeps layers in one palette.
        return tex * mix(vec3(1.0), base / max(dot(base, vec3(0.333)), 0.001), 0.25);
    }
    // No scanned textures: tint the layer colour with noise at metre and decametre scales.
    let fine = fbm(p * (1.3 + f32(i) * 0.37), fade);
    let broad = fbm(p * 0.045 + vec3(f32(i) * 11.0), 1.0);
    var c = base * (0.6 + 0.6 * fine) * (0.6 + 0.8 * broad);
    if i == 1u {
        // Basalt: the Faroes are stacked lava flows, so cliffs show horizontal bands.
        let band = sin(p.y * 0.55 + fbm(p * 0.02, 1.0) * 9.0);
        c *= 0.75 + 0.35 * smoothstep(-0.3, 0.6, band);
    }
    if i == 0u {
        // Grass browns where it is drier and higher.
        c = mix(c, c * vec3(1.35, 1.05, 0.7), smoothstep(0.45, 0.8, broad));
    }
    return c;
}

@fragment
fn fragment(in: VertexOutput, @builtin(front_facing) is_front: bool) -> FragmentOutput {
    var pbr_input = pbr_input_from_standard_material(in, is_front);
    let p = in.world_position.xyz;
    let dist = distance(view.world_position, p);
    let fade = saturate(1.0 - dist / terrain.flags.z);
    let n0 = normalize(in.world_normal);

    var w = max(in.color, vec4(0.0));
    // Let noise move the borders between layers so they read as patches, not bands.
    let edge = fbm(p * 0.09, 1.0) - 0.5;
    w = max(w + vec4(edge, -edge, edge * 0.5, -edge) * 0.6, vec4(0.0));
    w = w / max(w.r + w.g + w.b + w.a, 1e-4);

    let colour = layer_colour(0u, terrain.grass.rgb, p, n0, fade) * w.r
        + layer_colour(1u, terrain.rock.rgb, p, n0, fade) * w.g
        + layer_colour(2u, terrain.shore.rgb, p, n0, fade) * w.b
        + layer_colour(3u, terrain.moss.rgb, p, n0, fade) * w.a;
    pbr_input.material.base_color = vec4(colour, 1.0);
    pbr_input.material.perceptual_roughness = mix(0.92, 0.75, w.g);

    // Detail normals from the noise's gradient: bumps at the scale of a stride, fading out
    // with distance so far slopes do not shimmer.
    let s = terrain.flags.y * fade;
    if s > 0.001 {
        let e = 0.35;
        let q = p * 0.9;
        let h0 = fbm(q, fade);
        let gx = fbm(q + vec3(e, 0.0, 0.0), fade) - h0;
        let gz = fbm(q + vec3(0.0, 0.0, e), fade) - h0;
        let rough = mix(1.0, 2.2, w.g);
        pbr_input.N = normalize(n0 - vec3(gx, 0.0, gz) * s * rough / e);
    }

    var out: FragmentOutput;
    out.color = apply_pbr_lighting(pbr_input);
    out.color = main_pass_post_lighting_processing(pbr_input, out.color);
    return out;
}
