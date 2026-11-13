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
    // x: 0 water, 1 mist; y: sky reflection strength; z: ripple strength; w: unused.
    flags: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(100) var<uniform> water: WaterParams;

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

    if water.flags.x > 0.5 {
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
