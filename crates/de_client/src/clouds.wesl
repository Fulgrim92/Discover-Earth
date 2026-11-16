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
        mesh_view_bindings::{view, globals, lights, fog},
        pbr_functions,
        mesh_view_types::DIRECTIONAL_LIGHT_FLAGS_SHADOWS_ENABLED_BIT,
        shadows::{get_cascade_index, world_to_directional_light_local},
        shadow_sampling::sample_shadow_map_hardware,
        view_transformations::{depth_ndc_to_view_z, frag_coord_to_ndc, position_ndc_to_world},
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
    // valley mist: density per metre at sea level, height it thins over (metres), reach, steps
    mist: vec4<f32>,
    // daylight sky (de_world::sky): Perez A..D for luminance, x, y; E for each and brightness;
    // each channel's zenith scale and the sea's height (metres)
    sky_y: vec4<f32>,
    sky_x: vec4<f32>,
    sky_c: vec4<f32>,
    sky_e: vec4<f32>,
    sky_scale: vec4<f32>,
}

@group(constants::MATERIAL_BIND_GROUP) @binding(0) var<uniform> clouds: CloudParams;
@group(constants::MATERIAL_BIND_GROUP) @binding(1) var noise_tex: texture_3d<f32>;
@group(constants::MATERIAL_BIND_GROUP) @binding(2) var noise_smp: sampler;
// x: which samples of each pixel this draw writes (see `fragment`): 0 those like the first,
// 1 the rest.
@group(constants::MATERIAL_BIND_GROUP) @binding(3) var<uniform> cloud_pass: vec4<f32>;

struct CloudOut {
    @location(0) color: vec4<f32>,
    @builtin(sample_mask) mask: u32,
}

const PI: f32 = 3.14159265;
// The deck's mean density beyond the march's reach, as a share of cover times peak density.
const FAR_DENSITY: f32 = 0.15;

fn remap(x: f32, lo: f32, hi: f32) -> f32 {
    return (x - lo) / max(hi - lo, 1e-6);
}

fn noise(p: vec3<f32>) -> vec4<f32> {
    return textureSampleLevel(noise_tex, noise_smp, p, 0.0);
}

// The shapes' coordinates (in tiles) pushed about by a slow field turned and scaled against the
// tile, so the tile never repeats in a grid. `de_world::clouds::warp`.
fn warp(xz: vec2<f32>) -> vec2<f32> {
    let c = 0.825336;
    let s = 0.564642;
    let u = (c * xz.x - s * xz.y) * 0.17 + 0.37;
    let v = (s * xz.x + c * xz.y) * 0.17 + 0.71;
    let wx = noise(vec3(u, 0.2, v)).b - 0.5;
    let wz = noise(vec3(u, 0.8, v)).b - 0.5;
    return xz + 2.0 * 0.5 * vec2(wx, wz);
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
    let w = warp(q.xz);
    let qs = vec3(w.x, q.y, w.y);
    let d = remap(noise(qs).r * profile, 1.0 - cover, 1.0);
    if d <= 0.0 {
        return 0.0;
    }
    if !fine {
        return d * clouds.layer.w;
    }
    let e = noise(qs * 5.0).g;
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

// Sunlight left after the cloud layer, from `p` towards the sun (1 clear .. 0 shaded).
fn cloud_transmittance(p: vec3<f32>, t: f32) -> f32 {
    let l = clouds.sun_dir.xyz;
    if clouds.shape.x <= 0.0 || l.y <= 0.01 {
        return 1.0;
    }
    let ta = max((clouds.layer.x - p.y) / l.y, 0.0);
    let tb = (clouds.layer.y - p.y) / l.y;
    if tb <= ta {
        return 1.0;
    }
    let ds = min(tb - ta, 4000.0) / 4.0;
    var od = 0.0;
    for (var i = 0; i < 4; i++) {
        od += density(p + l * (ta + (f32(i) + 0.5) * ds), t, false) * ds;
    }
    return exp(-od);
}

// Whether the sun reaches `p`, from the sun's shadow map (ridges shade the valleys).
fn sun_visible(p: vec3<f32>, view_z: f32) -> f32 {
    if lights.n_directional_lights == 0u {
        return 1.0;
    }
    let light = &lights.directional_lights[0];
    if ((*light).flags & DIRECTIONAL_LIGHT_FLAGS_SHADOWS_ENABLED_BIT) == 0u {
        return 1.0;
    }
    let cascade = get_cascade_index(0u, view_z);
    if cascade >= (*light).num_cascades {
        return 1.0;
    }
    let local = world_to_directional_light_local(0u, cascade, vec4(p, 1.0));
    if local.w == 0.0 {
        return 1.0;
    }
    return sample_shadow_map_hardware(local.xy, local.z, i32((*light).depth_texture_base_index + cascade));
}

// The clouds along a ray up to `t_land`: premultiplied light (before exposure) and alpha.
fn march_clouds(ro: vec3<f32>, rd: vec3<f32>, t_land: f32, jitter: f32) -> vec4<f32> {
    let base = clouds.layer.x;
    let top = clouds.layer.y;
    let reach = clouds.sky_top.w;
    if clouds.shape.x <= 0.0 {
        return vec4(0.0);
    }

    // The stretch of the ray inside the layer: marched up to `reach`, and past it (on to the
    // land, the sea or the horizon) taken as an even haze of the deck's mean density.
    let t_cap = min(t_land, reach);
    var t0 = 0.0;
    var t_out = t_land;
    if abs(rd.y) > 1e-5 {
        let ta = (base - ro.y) / rd.y;
        let tb = (top - ro.y) / rd.y;
        t0 = max(min(ta, tb), 0.0);
        t_out = min(max(ta, tb), t_land);
    } else if ro.y > top {
        return vec4(0.0);
    } else if ro.y < base {
        t0 = t_land;
    }
    let t1 = min(t_out, t_cap);
    // Past the reach the earth's curve matters: a ray level with the horizon still climbs into
    // the deck some tens of kilometres off, so the overcast closes down on to the horizon.
    var f0 = t0;
    var f1 = t_out;
    if ro.y < top {
        f1 = min(curved_rise(top - ro.y, rd.y), t_land);
        if ro.y < base {
            f0 = curved_rise(base - ro.y, rd.y);
        }
    } else {
        // From above, the deck's top curves away: a ray just under level still meets it out to
        // the deck's own horizon, so it covers the sea right up to there.
        let r = 6.371e6;
        let disc_top = rd.y * rd.y - 2.0 * (ro.y - top) / r;
        if rd.y < 0.0 && disc_top >= 0.0 {
            f0 = r * (-rd.y - sqrt(disc_top));
            let disc_base = rd.y * rd.y - 2.0 * (ro.y - base) / r;
            f1 = min(select(r * (-rd.y + sqrt(disc_top)), r * (-rd.y - sqrt(disc_base)), disc_base >= 0.0), t_land);
        } else {
            f1 = f0;
        }
    }
    let far = max(f1 - max(f0, t_cap), 0.0);
    if t1 <= t0 && far <= 0.0 {
        return vec4(0.0);
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

    var trans = 1.0;
    var light = vec3(0.0);
    var t_seen = -1.0;
    var s = t0;
    // Steps left at a quarter length after the ray first meets cloud: a coarse step that
    // lands inside a cloud is taken back and walked finely, so the edge falls where the cloud
    // is, not where the per-pixel jitter put the sample (which drew edges as a stipple).
    var fine = 0;
    for (var i = 0; i < 4 * steps; i++) {
        if s >= t1 {
            break;
        }
        var ds = min(max(min_ds, 0.04 * s), t1 - s);
        if fine > 0 {
            ds *= 0.25;
            fine -= 1;
        }
        let p = ro + rd * (s + jitter * ds);
        s += ds;
        let d = density(p, t, true);
        if d <= 0.0 {
            continue;
        }
        if t_seen < 0.0 && fine == 0 && ds > 2.0 * min_ds {
            s -= ds;
            fine = 8;
            t_seen = s;
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
        if trans < 0.03 {
            break;
        }
    }
    // Beyond the reach: without this the sky opened in a bright strip under the deck's far
    // edge, just above the horizon, where a real overcast runs on and closes up.
    if far > 0.0 && trans >= 0.03 {
        let t_far = max(f0, t_cap);
        if t_seen < 0.0 {
            t_seen = t_far;
        }
        trans *= exp(-FAR_DENSITY * clouds.shape.x * clouds.layer.w * far);
    }
    if t_seen < 0.0 {
        return vec4(0.0);
    }
    // Far clouds fade into haze: their own light gives way to a flat sky-lit grey, but they
    // stay as opaque as they are, so an overcast still hides the low sun.
    let fade = exp(-3.0 * t_seen / reach);
    // The sun disc behind is some 100000 times brighter than the sky, so even the 1% a thick
    // cloud lets through would show it. Treat the last few percent as fully opaque.
    let alpha = 1.0 - max(trans - 0.03, 0.0) / 0.97;
    let haze = 0.5 * (clouds.sky_top.rgb + clouds.sky_bottom.rgb) * clouds.sun.w;
    return vec4(mix(haze * alpha, light, fade), alpha);
}

// The Perez formula (Preetham 1999), as `de_world::sky::perez`.
fn perez(abcd: vec4<f32>, e: f32, cos_t: f32, gamma: f32) -> f32 {
    let cg = cos(gamma);
    return (1.0 + abcd.x * exp(abcd.y / cos_t)) * (1.0 + abcd.z * exp(abcd.w * gamma) + e * cg * cg);
}

// The clear daylight sky in a direction, with the sun's disc: linear RGB luminance (cd/m²),
// as `de_world::sky::Sky::rgb`.
fn sky_radiance(rd: vec3<f32>) -> vec3<f32> {
    let to_sun = clouds.sun_dir.xyz;
    let cos_t = max(rd.y, 0.01);
    let mu = clamp(dot(rd, to_sun), -1.0, 1.0);
    let gamma = acos(mu);
    let lum = clouds.sky_scale.x * perez(clouds.sky_y, clouds.sky_e.x, cos_t, gamma);
    let x = clouds.sky_scale.y * perez(clouds.sky_x, clouds.sky_e.y, cos_t, gamma);
    let y = max(clouds.sky_scale.z * perez(clouds.sky_c, clouds.sky_e.z, cos_t, gamma), 1e-4);
    let xyz = vec3(x / y * lum, lum, (1.0 - x - y) / y * lum);
    let rgb = max(vec3(
        3.2406 * xyz.x - 1.5372 * xyz.y - 0.4986 * xyz.z,
        -0.9689 * xyz.x + 1.8758 * xyz.y + 0.0415 * xyz.z,
        0.0557 * xyz.x - 0.2040 * xyz.y + 1.0570 * xyz.z,
    ), vec3(0.0));
    // The sun: its illuminance spread over its disc (0.53° across, 6.8e-5 sr), edge softened
    // over a pixel or so.
    let r = 0.0046;
    let disc = 1.0 - smoothstep(r * 0.8, r * 1.2, gamma);
    let sun = clouds.sun.rgb / 6.8e-5 * disc * f32(rd.y > 0.0);
    return rgb * clouds.sky_e.w + sun;
}

// Mist along a ray up to `t_land`: in-scattered light (before exposure) and transmittance.
// Thick near the sea and thinning with height, lit by the sun where the ridges and clouds let
// it through, which draws the shafts, and by the sky everywhere.
fn march_mist(ro: vec3<f32>, rd: vec3<f32>, t_land: f32, jitter: f32) -> vec4<f32> {
    let d0 = clouds.mist.x;
    let hscale = clouds.mist.y;
    if d0 <= 0.0 {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }
    // Stop where the mist has thinned out (five scale heights up) or at the land.
    var t_end = min(t_land, clouds.mist.z);
    let ceiling = 5.0 * hscale;
    if rd.y > 1e-4 {
        t_end = min(t_end, max(ceiling - ro.y, 0.0) / rd.y);
    } else if ro.y > ceiling {
        if rd.y >= -1e-4 {
            return vec4(0.0, 0.0, 0.0, 1.0);
        }
    }
    if t_end <= 0.0 {
        return vec4(0.0, 0.0, 0.0, 1.0);
    }
    let to_sun = clouds.sun_dir.xyz;
    let mu = dot(rd, to_sun);
    // Strong forward scattering: shafts glow looking towards the sun.
    let phase = mix(hg(mu, 0.75), 1.0 / (4.0 * PI), 0.4);
    let sun = clouds.sun.rgb;
    let ambient = 0.5 * (clouds.sky_top.rgb + clouds.sky_bottom.rgb);
    let fwd = normalize(-view.world_from_view[2].xyz);
    let n = max(i32(clouds.mist.w), 1);
    let t = globals.time;

    var trans = 1.0;
    var light = vec3(0.0);
    var prev = 0.0;
    // Samples bunch up near the camera (quadratic spacing), where shafts are sharpest.
    for (var i = 0; i < n; i++) {
        let u = (f32(i) + 1.0) / f32(n);
        let s1 = t_end * u * u;
        let ds = s1 - prev;
        let p = ro + rd * (prev + jitter * ds);
        prev = s1;
        let d = d0 * exp(-max(p.y, 0.0) / hscale);
        if d * ds < 1e-6 {
            continue;
        }
        let view_z = -dot(p - ro, fwd);
        let lit = sun_visible(p, view_z) * cloud_transmittance(p, t);
        let scatter = sun * phase * lit + ambient;
        let step_trans = exp(-d * ds);
        light += trans * scatter * (1.0 - step_trans);
        trans *= step_trans;
    }
    return vec4(light, trans);
}

// How far along a ray (rising `dy` per metre) until it is `h` metres higher above the ground,
// over the earth's curve: t²/2R + dy t = h.
fn curved_rise(h: f32, dy: f32) -> f32 {
    let r = 6.371e6;
    let q = sqrt(dy * dy + 2.0 * h / r);
    if dy >= 0.0 {
        return 2.0 * h / (dy + q);
    }
    return r * (q - dy);
}

// Distance along the ray to the cloud layer: 0 inside it; from below, where the ray climbs
// into its base over the earth's curve (as `march_clouds` takes it past the reach); from
// above, its top, or 0 looking up and away from it.
fn layer_entry(ro: vec3<f32>, rd: vec3<f32>) -> f32 {
    if ro.y < clouds.layer.x {
        return curved_rise(clouds.layer.x - ro.y, rd.y);
    }
    if ro.y > clouds.layer.y && rd.y < 0.0 {
        return (clouds.layer.y - ro.y) / rd.y;
    }
    return 0.0;
}

// The mean over this pixel's 2x2 quad of the pixels that see about as far as this one (`t`,
// to the land or the sky), from the fine derivatives. The per-pixel jitter leaves soft edges
// as a checker of hits and misses (there is no temporal filter to average it), and the
// neighbouring offsets averaged read as the soft edge they sample. Pixels across a skyline
// are left out of each other's mean: mixing them drew the ridge's light into the sky, and
// not averaging there at all left the sky's own noise as a row of dots along every ridge.
fn quad_mean(v: vec4<f32>, t: f32, px: vec2<f32>) -> vec4<f32> {
    let sx = select(-1.0, 1.0, (u32(px.x) & 1u) == 0u);
    let sy = select(-1.0, 1.0, (u32(px.y) & 1u) == 0u);
    // The other three pixels' values: across, above or below, and diagonal.
    let vh = v + sx * dpdxFine(v);
    let vv = v + sy * dpdyFine(v);
    let vd = vv + sx * dpdxFine(vv);
    let th = t + sx * dpdxFine(t);
    let tv = t + sy * dpdyFine(t);
    let td = tv + sx * dpdxFine(tv);
    let near = 0.05 * t;
    let wh = select(0.0, 1.0, abs(th - t) <= near);
    let wv = select(0.0, 1.0, abs(tv - t) <= near);
    let wd = select(0.0, 1.0, abs(td - t) <= near);
    return (v + wh * vh + wv * vv + wd * vd) / (1.0 + wh + wv + wd);
}

// One triangle that covers the screen (and more), so no triangle edge crosses the picture,
// where helper pixels would upset `quad_mean`. The fragment finds its own ray from the pixel.
@vertex
fn vertex(@builtin(vertex_index) i: u32) -> VertexOutput {
    let uv = vec2(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VertexOutput;
    out.position = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
    out.world_position = vec4(position_ndc_to_world(vec3(out.position.xy, 0.5)), 1.0);
    out.world_normal = vec3(0.0, 1.0, 0.0);
    return out;
}

// With multisampling a pixel on a skyline holds land in some samples and sky in others, and
// one colour for all of them is wrong for one kind: the sky's samples took the land's
// see-through mist over the sky drawn underneath, a bright dot on every ridge. So the clouds
// are drawn twice: the first draw writes the samples that see what the pixel's first sample
// sees, the second the others (and discards everywhere but on edges).
@fragment
fn fragment(in: VertexOutput) -> CloudOut {
    let ro = view.world_position;
    let ndc = frag_coord_to_ndc(in.position);
    let rd = normalize(position_ndc_to_world(vec3(ndc.xy, 0.5)) - ro);
    let second = cloud_pass.x > 0.5;

    // Where the land is along this ray (none: the sky).
    // Open sky: as far as a deck at cloud height stays above the horizon on the curved earth.
    var t_land = 300000.0;
    var open_sky = true;
    var mask = 0xffffffffu;
    @if(DEPTH_PREPASS) {
        let first = prepass_depth(in.position, 0u);
        var depth = first;
        var n = 1u;
        @if(MULTISAMPLED) {
            n = textureNumSamples(bevy_pbr::render::mesh_view_bindings::depth_prepass_texture);
        }
        var same = 0u;
        var other = 0.0;
        for (var i = 0u; i < n; i++) {
            let d = prepass_depth(in.position, i);
            if (d > 0.0) == (first > 0.0) {
                same |= 1u << i;
            } else {
                other = d;
            }
        }
        if second {
            mask = ~same & ((1u << n) - 1u);
            depth = other;
        } else {
            mask = same;
        }
        if depth > 0.0 {
            open_sky = false;
            let fwd = normalize(-view.world_from_view[2].xyz);
            t_land = min(t_land, -depth_ndc_to_view_z(depth) / max(dot(rd, fwd), 1e-4));
        }
    }
    if second && mask == 0u {
        discard;
    }
    // The sea is see-through, so it leaves no depth: past the land's edge a ray down would
    // count as open sky, and the sky was drawn over the far sea as a bright band. Meet it here.
    // A ray that would pass over the true horizon on the curved earth sees sky, not the flat
    // sea plane (from high up that plane showed as a strip between the deck and the sky).
    let over_horizon = rd.y * rd.y < 2.0 * (ro.y - clouds.sky_scale.w) / 6.371e6;
    if rd.y < -1e-6 && !(open_sky && over_horizon) {
        let t_sea = (clouds.sky_scale.w - ro.y) / rd.y;
        if t_sea > 0.0 {
            open_sky = false;
            t_land = min(t_land, t_sea);
        }
    }
    let jitter = ign(in.position.xy);
    // The second draw covers single samples on skylines; its neighbours are not drawn.
    let cloud_px = march_clouds(ro, rd, t_land, jitter);
    var cloud = select(quad_mean(cloud_px, t_land, in.position.xy), cloud_px, second);
    // The scene's distance fog, as the ground and sea get it, from where the ray enters the
    // layer: without it far cloud kept its own grey while the sea under it faded to the fog's
    // colour, and the two met in a hard line at the horizon.
    @if(DISTANCE_FOG) {
        if cloud.a > 1e-4 {
            // At least a metre off: the fog's sun glow normalises the offset to the camera.
            let at = ro + rd * clamp(layer_entry(ro, rd), 1.0, clouds.sky_top.w * 2.5);
            // Fog is linear in the colour (kept * c + added), so it is applied to premultiplied
            // light from two calls without dividing by a small alpha.
            let added = pbr_functions::apply_fog(fog, vec4(0.0, 0.0, 0.0, 1.0), at, ro, in.position.xy).rgb;
            let kept = pbr_functions::apply_fog(fog, vec4(1.0, 1.0, 1.0, 1.0), at, ro, in.position.xy).rgb - added;
            cloud = vec4(cloud.rgb * kept + cloud.a * added / view.exposure, cloud.a);
        }
    }
    let mist_px = march_mist(ro, rd, t_land, jitter);
    let mist = select(quad_mean(mist_px, t_land, in.position.xy), mist_px, second);
    // Where nothing is in the way, draw our own daylight sky (and the sun) behind the clouds.
    if open_sky && clouds.sky_e.w > 0.0 {
        let behind = sky_radiance(rd);
        let seen = cloud.rgb + (1.0 - cloud.a) * behind;
        return CloudOut(vec4((mist.rgb + mist.a * seen) * view.exposure, 1.0), mask);
    }
    // Mist lies in front of the clouds: its light, then the clouds seen through it.
    let rgb = mist.rgb + mist.a * cloud.rgb;
    let alpha = 1.0 - mist.a * (1.0 - cloud.a);
    if alpha <= 0.0 {
        discard;
    }
    return CloudOut(vec4(rgb * view.exposure, alpha), mask);
}
