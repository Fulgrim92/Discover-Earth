// Discover Earth water: streams, lakes and the mist at waterfalls, on Bevy's PBR.
//
// Streams carry their own frame: uv.x runs across the stream (-1 bank, +1 other bank), uv.y
// is metres along it, the tangent points downstream, and the vertex colour holds white-water
// amount (r), flow speed in m/s (g) and half the width in metres (b). Ripples and foam are
// noise scrolled downstream at the flow speed, so fast water reads fast. Lakes (speed 0) get
// slow wind ripples. The scene has no environment map, so the sky's reflection is added by
// hand with a Fresnel term, the same horizon-to-zenith colours the sky dome uses; that is what
// makes water read as water, in shadow too. Time is game time, so captures stay identical.

import bevy_pbr::render::{
    forward_io::{VertexOutput, FragmentOutput},
    pbr_fragment::pbr_input_from_standard_material,
    pbr_functions::{apply_pbr_lighting, main_pass_post_lighting_processing},
    mesh_view_bindings::{view, globals},
};

struct WaterParams {
    deep: vec4<f32>,
    foam: vec4<f32>,
    horizon: vec4<f32>,
    zenith: vec4<f32>,
    // x: 0 fresh water, 1 mist, 2 sea; y: sky reflection strength; z: ripple strength;
    // w: how see-through the sea is.
    flags: vec4<f32>,
    // The island's size in metres (x, z), then the wind (x, z) in m/s.
    sea: vec4<f32>,
    // Shallow-water colour near the shore; w: metres the shore texture's 1.0 stands for.
    shallow: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> water: WaterParams;
@group(constants::MATERIAL_BIND_GROUP) @binding(101) var shore_tex: texture_2d<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(102) var shore_smp: sampler;

const PI: f32 = 3.14159265;

// Signed metres to the shore line: positive at sea, negative inland; off the island, open sea.
fn shore_distance(p: vec3<f32>) -> f32 {
    let uv = (p.xz + water.sea.xy * 0.5) / water.sea.xy;
    if any(uv < vec2(0.0)) || any(uv > vec2(1.0)) {
        return water.shallow.w;
    }
    return textureSampleLevel(shore_tex, shore_smp, uv, 0.0).r * water.shallow.w;
}

// Slope (d height / dx, d height / dz) of the sea at p, time t. Wind waves: deep-water waves
// with angular speed sqrt(g k), directions fanned out around the wind, each faded out once it is
// shorter than a few pixels (`px`: metres per pixel) so it can't alias. Their directions stay
// fixed: turning them per pixel scrambles the phase kilometres from the origin. Near the shore
// (`shoal` 1 at the edge) they calm and a swell takes over whose crests follow the shore
// distance `d` (gradient `-to_land`) and run in to the land, like waves refracted over shallows;
// the surf in the fragment shader rides the same crests.
fn wave_slope(p: vec2<f32>, t: f32, wind: vec2<f32>, px: f32, d: f32, to_land: vec2<f32>, shoal: f32) -> vec2<f32> {
    // Lengths and turns are irregular so the sum never lines up into a visible pattern.
    let lengths = array<f32, 10>(61.0, 37.0, 23.0, 14.5, 8.9, 5.3, 3.4, 2.1, 1.31, 0.83);
    let turns = array<f32, 10>(0.0, 0.52, -0.38, 0.91, -0.77, 0.27, -1.1, 1.3, -0.55, 0.66);
    let steep = array<f32, 10>(0.04, 0.05, 0.055, 0.06, 0.065, 0.07, 0.075, 0.08, 0.08, 0.08);
    var g = vec2(0.0);
    for (var i = 0; i < 10; i++) {
        let a = turns[i];
        let dir = vec2(wind.x * cos(a) - wind.y * sin(a), wind.x * sin(a) + wind.y * cos(a));
        let k = 2.0 * PI / lengths[i];
        let w = sqrt(9.81 * k);
        let calm = 1.0 - shoal * select(0.4, 0.8, i < 3);
        let far = smoothstep(3.0 * px, 8.0 * px, lengths[i]);
        g += dir * (steep[i] * cos(k * dot(dir, p) - w * t + f32(i) * 2.3)) * far * calm;
    }
    // Swell: height cos(SWELL_K d + SWELL_W t), so slope = -SWELL_K sin(..) grad d.
    let phase = d * SWELL_K + t * SWELL_W;
    g += to_land * (0.12 * sin(phase)) * shoal * smoothstep(3.0 * px, 8.0 * px, 2.0 * PI / SWELL_K);
    return g;
}

// The swell near the shore: 30 m crests that run in to the land.
const SWELL_K: f32 = 0.21;
const SWELL_W: f32 = 1.6;

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

fn fbm(p: vec3<f32>, fade: f32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = p;
    for (var i = 0; i < 4; i++) {
        let w = select(1.0, fade, i >= 2);
        sum += amp * w * (noise3(q) - 0.5);
        q = q * 2.07 + vec3(17.1, 3.7, 9.2);
        amp *= 0.5;
    }
    return 0.5 + sum;
}

fn sky(dir: vec3<f32>) -> vec3<f32> {
    let t = pow(saturate(dir.y), 0.45);
    return mix(water.horizon.rgb, water.zenith.rgb, t);
}

// Ripple height at a point of the flow frame (metres across, metres along) at time t.
fn ripples(q: vec2<f32>, t: f32, speed: f32, fade: f32) -> f32 {
    // Streams: stretched along the flow and carried downstream; lakes: drifting wind ripples.
    let flow = vec2(q.x * 1.4, (q.y - speed * t) * 0.7);
    let wind = q + vec2(t * 0.35, t * 0.2);
    let p = select(wind, flow, speed > 0.05);
    return fbm(vec3(p * 0.9, t * (0.25 + 0.1 * speed)), fade);
}

@fragment
fn fragment(in: VertexOutput, @builtin(front_facing) is_front: bool) -> FragmentOutput {
    var pbr_input = pbr_input_from_standard_material(in, is_front);
    let p = in.world_position.xyz;
    let t = globals.time;
    let to_eye = view.world_position - p;
    let dist = length(to_eye);
    let V = to_eye / max(dist, 1e-3);
    var out: FragmentOutput;

    if water.flags.x > 0.5 && water.flags.x < 1.5 {
        // Mist: soft at the sides and top, rising and thinning, lit like the white water.
        let across = 1.0 - abs(in.uv.x * 2.0 - 1.0);
        let up = in.uv.y;
        let n = fbm(vec3(in.uv.x * 5.0, up * 3.0 - t * 0.5, t * 0.15), 1.0);
        let a = pow(across, 1.4) * pow(1.0 - up, 1.3) * smoothstep(0.25, 0.7, n) * 0.85;
        // Unlit: spray glows with the light around it rather than being shaded like a surface,
        // and an unlit sheet can't pick up the lighting's per-pixel noise.
        let c = mix(water.horizon.rgb, water.foam.rgb, 0.4) * 1.1;
        out.color = vec4(c, clamp(a, 0.0, 1.0));
        out.color = main_pass_post_lighting_processing(pbr_input, out.color);
        return out;
    }

    if water.flags.x > 1.5 {
        // The sea: wind waves, shallower and greener by the shore, foam where waves break.
        let d = shore_distance(p);
        // Which way is land: down the distance field, over a stretch wider than a texel so the
        // bilinear steps don't show.
        let e = 16.0;
        let to_land = -normalize(vec2(shore_distance(p + vec3(e, 0.0, 0.0)) - shore_distance(p - vec3(e, 0.0, 0.0)),
                                      shore_distance(p + vec3(0.0, 0.0, e)) - shore_distance(p - vec3(0.0, 0.0, e)))
                                 + vec2(1e-4, 0.0));
        let shoal = 1.0 - smoothstep(20.0, 160.0, d);
        let wind = normalize(water.sea.zw + vec2(1e-3, 0.0));
        // Metres one pixel covers here; on a plane seen edge-on this grows fast with distance.
        let px = max(length(dpdx(p.xz)), length(dpdy(p.xz)));
        // Waves only (no noise ripples): noise at world coordinates kilometres from the origin
        // runs out of float precision and its slope turns blocky.
        let slope = wave_slope(p.xz, t, wind, px, d, to_land, shoal);
        let N = normalize(vec3(-slope.x, 1.0, -slope.y));

        // Breaking waves: bands that run in to the shore, broken up by noise; plus a wash right
        // at the water's edge.
        let band = 0.5 + 0.5 * cos(d * SWELL_K + t * SWELL_W);
        let breakup = fbm(vec3(p.xz * 0.05, t * 0.12), 1.0);
        let surf = (1.0 - smoothstep(10.0, 70.0, d)) * smoothstep(0.6, 0.95, band) * smoothstep(0.4, 0.65, breakup);
        let wash = (1.0 - smoothstep(4.0, 22.0, d)) * (0.55 + 0.45 * smoothstep(0.3, 0.6, fbm(vec3(p.xz * 0.2, t * 0.5), 1.0)));
        let foam = saturate(surf + wash);

        let colour = mix(water.deep.rgb, water.shallow.rgb, (1.0 - smoothstep(10.0, 140.0, d)) * 0.8);
        pbr_input.N = N;
        pbr_input.material.base_color = vec4(mix(colour, water.foam.rgb, foam), 1.0);
        pbr_input.material.perceptual_roughness = mix(max(pbr_input.material.perceptual_roughness, 0.08), 0.7, foam);
        out.color = apply_pbr_lighting(pbr_input);
        let r = reflect(-V, N);
        let fresnel = 0.02 + 0.98 * pow(1.0 - saturate(dot(N, V)), 5.0);
        out.color = vec4(out.color.rgb + sky(r) * fresnel * (1.0 - foam) * water.flags.y,
                         mix(water.flags.w, 1.0, max(foam, fresnel)));
        out.color = main_pass_post_lighting_processing(pbr_input, out.color);
        return out;
    }

    let foam_amt = in.color.r;
    let speed = in.color.g;
    let half_w = max(in.color.b, 0.5);
    let fade = saturate(1.0 - dist / 800.0);
    let n0 = normalize(in.world_normal);
    let along_dir = normalize(in.world_tangent.xyz - n0 * dot(in.world_tangent.xyz, n0));
    let across_dir = normalize(cross(n0, along_dir));

    // Lakes have no flow frame: use world x, z.
    let q = select(p.xz, vec2(in.uv.x * half_w, in.uv.y), speed > 0.05);
    let e = 0.2;
    let h0 = ripples(q, t, speed, fade);
    let ga = (ripples(q + vec2(e, 0.0), t, speed, fade) - h0) / e;
    let gb = (ripples(q + vec2(0.0, e), t, speed, fade) - h0) / e;
    let x_dir = select(vec3(1.0, 0.0, 0.0), across_dir, speed > 0.05);
    let y_dir = select(vec3(0.0, 0.0, 1.0), along_dir, speed > 0.05);
    let strength = water.flags.z * (0.35 + 0.12 * min(speed, 5.0)) * (0.15 + 0.85 * fade);
    let N = normalize(n0 - (x_dir * ga + y_dir * gb) * strength);

    // Foam: white water where the stream falls, and a thin rim along fast banks.
    let churn = fbm(vec3(q.x * 1.6, (q.y - speed * t * 1.3) * 0.5, t * 0.9), 1.0);
    let rim = smoothstep(0.7, 1.0, abs(in.uv.x)) * saturate(speed / 3.0) * 0.6;
    let foam = saturate(foam_amt * (0.55 + smoothstep(0.3, 0.6, churn)) + rim * smoothstep(0.45, 0.7, churn));

    pbr_input.N = N;
    pbr_input.material.base_color = vec4(mix(water.deep.rgb, water.foam.rgb, foam), 1.0);
    pbr_input.material.perceptual_roughness = mix(0.06, 0.7, foam);
    out.color = apply_pbr_lighting(pbr_input);

    // The sky in the water: Schlick's Fresnel with water's 2% head-on reflectance.
    let r = reflect(-V, N);
    let fresnel = 0.02 + 0.98 * pow(1.0 - saturate(dot(N, V)), 5.0);
    out.color = vec4(out.color.rgb + sky(r) * fresnel * (1.0 - foam) * water.flags.y, 1.0);
    out.color = main_pass_post_lighting_processing(pbr_input, out.color);
    return out;
}
