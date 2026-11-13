// Discover Earth clouds: one layer of volumetric cloud, ray-marched per pixel.
//
// Density is `de_world::clouds::Clouds::density_at` (keep the two in step): seeded Perlin-Worley
// shapes cut to the cover, worn at the edges by finer Worley, drifting with the wind. Light is
// single scattering of the sun with a cheap march towards it (Beer's law, plus a softer second
// term standing in for multiple scattering, after Hillaire 2016), a two-lobe phase function
// for the silver lining, and sky light from above and below. Rays stop at the land.

import bevy_pbr::{
    render::{
        forward_io::VertexOutput,
        mesh_view_bindings::{view, globals},
        view_transformations::depth_ndc_to_view_z,
    },
    prepass::utils::prepass_depth,
};

struct CloudParams {
    // base_m, top_m, scale_m, density per metre
    layer: vec4<f32>,
    // cover, detail, wind east, wind south
    shape: vec4<f32>,
    // direction to the sun, march steps
    sun_dir: vec4<f32>,
    // sunlight in lux per channel, light multiplier
    sun: vec4<f32>,
    // sky radiance on the tops, fade distance in metres
    sky_top: vec4<f32>,
    // light on the bellies, shadow strength on the ground
    sky_bottom: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(0) var<uniform> clouds: CloudParams;
@group(constants::MATERIAL_BIND_GROUP) @binding(1) var noise_tex: texture_3d<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(2) var noise_smp: sampler;

const PI: f32 = 3.14159265;

fn remap(x: f32, lo: f32, hi: f32) -> f32 {
    return (x - lo) / max(hi - lo, 1e-6);
}

fn noise(p: vec3<f32>) -> vec4<f32> {
    return textureSampleLevel(noise_tex, noise_smp, p, 0.0);
}

// Density per metre at `p`; `fine` adds the edge erosion (skipped on the light march).
fn density(p: vec3<f32>, t: f32, fine: bool) -> f32 {
    let base = clouds.layer.x;
    let top = clouds.layer.y;
    let h = (p.y - base) / (top - base);
    if h < 0.0 || h > 1.0 {
        return 0.0;
    }
    let scale = clouds.layer.z;
    let q = vec3(p.x - clouds.shape.z * t, p.y, p.z - clouds.shape.w * t) / scale;
    let weather = noise(vec3(q.x * 0.25, 0.5, q.z * 0.25)).b;
    let cover = clamp(clouds.shape.x * (0.55 + 0.9 * weather), 0.0, 1.0);
    let profile = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.35 + 0.6 * cover, 1.0, h));
    let d = remap(noise(q).r * profile, 1.0 - cover, 1.0);
    if d <= 0.0 {
        return 0.0;
    }
    if !fine {
        return d * clouds.layer.w;
    }
    let e = noise(q * 5.0).g;
    let amount = clouds.shape.y * (0.6 - 0.3 * h);
    return max(remap(d, e * amount, 1.0), 0.0) * clouds.layer.w;
}

// Henyey-Greenstein phase function, per steradian.
fn hg(mu: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

// Interleaved gradient noise (Jimenez 2014): a fixed per-pixel offset for the march start,
// so banding turns into fine grain. Not random: the same pixel always gets the same offset.
fn ign(px: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let ro = view.world_position;
    let rd = normalize(in.world_position.xyz - ro);
    let base = clouds.layer.x;
    let top = clouds.layer.y;
    let reach = clouds.sky_top.w;

    // Where the land is along this ray (none: the sky).
    var t_land = reach;
    @if(DEPTH_PREPASS) {
        let depth = prepass_depth(in.position, 0u);
        if depth > 0.0 {
            let fwd = normalize(-view.world_from_view[2].xyz);
            t_land = min(t_land, -depth_ndc_to_view_z(depth) / max(dot(rd, fwd), 1e-4));
        }
    }

    // The stretch of the ray inside the layer.
    var t0 = 0.0;
    var t1 = t_land;
    if abs(rd.y) > 1e-5 {
        let ta = (base - ro.y) / rd.y;
        let tb = (top - ro.y) / rd.y;
        t0 = max(min(ta, tb), 0.0);
        t1 = min(max(ta, tb), t_land);
    } else if ro.y < base || ro.y > top {
        discard;
    }
    if t1 <= t0 {
        discard;
    }

    let t = globals.time;
    let to_sun = clouds.sun_dir.xyz;
    let steps = max(i32(clouds.sun_dir.w), 1);
    // Steps grow with distance: fine where clouds are close and big on screen, coarse far
    // off where the fade hides them. `steps` is the budget for an average ray.
    let thick = top - base;
    let min_ds = thick / f32(steps);
    let mu = dot(rd, to_sun);
    let phase = mix(hg(mu, 0.65), hg(mu, -0.2), 0.35);
    let sun = clouds.sun.rgb * clouds.sun.w;
    let jitter = ign(in.position.xy);

    var trans = 1.0;
    var light = vec3(0.0);
    var t_seen = -1.0;
    var s = t0;
    for (var i = 0; i < 3 * steps; i++) {
        if s >= t1 {
            break;
        }
        let ds = min(max(min_ds, 0.04 * s), t1 - s);
        let p = ro + rd * (s + jitter * ds);
        s += ds;
        let d = density(p, t, true);
        if d <= 0.0 {
            continue;
        }
        if t_seen < 0.0 {
            t_seen = s - ds;
        }
        // Optical depth towards the sun, in four growing steps up to the layer top.
        let reach_up = clamp((top - p.y) / max(to_sun.y, 0.05), 50.0, 2500.0);
        var od = 0.0;
        var walked = 0.0;
        for (var j = 0; j < 4; j++) {
            let len = reach_up * (f32(j) + 1.0) / 10.0;
            od += density(p + to_sun * (walked + 0.5 * len), t, false) * len;
            walked += len;
        }
        // Sunlight scattered once, plus three fainter, wider octaves standing in for light
        // that scattered many times inside the cloud (Wrenninge et al. 2013, as in Hillaire
        // 2016): each octave sees less of the optical depth and a rounder phase function.
        var sunlit = 0.0;
        var a = 1.0;
        var b = 1.0;
        var c = 1.0;
        for (var k = 0; k < 4; k++) {
            let ph = mix(1.0 / (4.0 * PI), phase, c);
            sunlit += a * exp(-od * b) * ph;
            a *= 0.5;
            b *= 0.4;
            c *= 0.5;
        }
        let h = clamp((p.y - base) / (top - base), 0.0, 1.0);
        let ambient = mix(clouds.sky_bottom.rgb, clouds.sky_top.rgb, h) * clouds.sun.w;
        let scatter = sun * sunlit + ambient;
        // Integrate across the step analytically (Hillaire 2015), so thick steps stay stable.
        let step_trans = exp(-d * ds);
        light += trans * scatter * (1.0 - step_trans);
        trans *= step_trans;
        if trans < 0.01 {
            break;
        }
    }
    if t_seen < 0.0 {
        discard;
    }
    // Far clouds fade into haze: their own light gives way to a flat sky-lit grey, but they
    // stay as opaque as they are, so an overcast still hides the low sun.
    let fade = exp(-3.0 * t_seen / reach);
    let alpha = 1.0 - trans;
    let haze = 0.5 * (clouds.sky_top.rgb + clouds.sky_bottom.rgb) * clouds.sun.w;
    return vec4(mix(haze * alpha, light, fade) * view.exposure, alpha);
}
