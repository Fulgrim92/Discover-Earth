// particles.wgsl: motes around the camera in a hashed volume that wraps with camera movement (each particle is a
// fixed point of a world-space lattice moving with its own drift, folded into a box centred on the camera and faded
// out before the fold). Additive, soft, depth-tested against the resolved linear scene depth.
// Kinds: 0 pollen + seed fluff (sunlit, forward scattering), 1 salt glints, 2 snow / diamond dust, 3 spores,
// 4 fireflies.

@group(2) @binding(0) var sceneDist: texture_2d<f32>;

struct PV {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec3f,
  @location(2) d: f32,
}

@vertex fn vsPart(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PV {
  var o: PV;
  o.pos = LF_DEAD;
  let h = hu(i32(ii), 0x2b, 0x5eedu);
  let v1 = rowv(V1); let v3 = rowv(V3);
  // share of the 8192 motes per kind (density, not just weight)
  let w = vec4f(v3.x * 0.45, v3.y * 0.6, v3.z, v3.w * 0.3);
  let fire = v1.y * 0.1;
  let u = lfRand(h, 1u) * max(1.0, w.x + w.y + w.z + w.w + fire);
  var kind = 9u;
  var acc = w.x; if (u < acc) { kind = 0u; }
  else { acc += w.y; if (u < acc) { kind = 1u; } else { acc += w.z; if (u < acc) { kind = 2u; } else { acc += w.w; if (u < acc) { kind = 3u; } else { acc += fire; if (u < acc) { kind = 4u; } } } } }
  if (kind == 9u) { return o; }
  let t = FR.time.x;
  let cam = VW.cam.xyz;
  let r = vec3f(lfRand(h, 2u), lfRand(h, 3u), lfRand(h, 4u));
  let ph = lfRand(h, 5u) * 6.2832;
  // box (m) and drift (m/s) per kind; ground-hugging kinds keep a height above the terrain instead of a world y
  var B = vec3f(44.0, 16.0, 44.0);
  var vel = vec3f(0.0);
  var hug = true;
  var hmax = 7.0;
  var size = 0.006;
  if (kind == 0u) {
    let wv = lfWind(VW.anc.xz, t);
    vel = vec3f(LF_WD.x, 0.0, LF_WD.y) * (0.5 + 0.5 * r.y) * (0.6 + 1.5 * wv.z);
    size = select(0.004 + 0.004 * r.x, 0.018 + 0.01 * r.x, lfRand(h, 6u) < 0.15); // a few seed fluffs
    hmax = 9.0;
  } else if (kind == 1u) { vel = vec3f(0.15, 0.0, 0.1); size = 0.004; hmax = 2.5; }
  else if (kind == 2u) { hug = false; B = vec3f(40.0, 26.0, 40.0); vel = vec3f(0.25, -0.35 - 0.3 * r.x, 0.12); size = 0.006 + 0.006 * r.z; }
  else if (kind == 3u) { hug = false; B = vec3f(48.0, 26.0, 48.0); vel = vec3f(0.05, 0.25 + 0.3 * r.x, 0.03); size = 0.008 + 0.012 * r.z * r.z; }
  else { size = 0.012; hmax = 3.5; }
  // wobble: each mote wanders around its drift line
  let wob = vec3f(sin(t * (0.6 + r.x) + ph), sin(t * (0.5 + r.y) + ph * 1.7) * 0.6, cos(t * (0.7 + r.z) + ph * 0.3));
  var amp = 0.25;
  if (kind == 4u) { amp = 1.2; }
  if (kind == 2u) { amp = 0.4; }
  let pw = r * B + vel * t + wob * amp;
  // the box wraps around the head (VW.anc), not the eye, so both eyes see the same motes
  let anc = VW.anc.xyz;
  var rel = (fract((pw - anc) / B + 0.5) - 0.5) * B;
  var wp = anc + rel;
  if (hug) {
    let g = heightAny(wp.xz);
    let hy = (fract(r.y + vel.y * t / hmax) * hmax + wob.y * amp * 0.5);
    let base = max(g, select(-1e4, 0.02, kind == 1u));
    wp.y = base + 0.15 + hy * hy / hmax;
    rel = wp - anc;
  }
  var nd = rel / (B * 0.5);
  if (hug) { nd.y = rel.y / 12.0; }
  let fade = sstep(1.0, 0.65, length(nd));
  if (fade <= 0.0) { return o; }
  let da = length(rel);
  if (da < 0.6) { return o; }
  let d = length(wp - cam);
  let dir = (wp - cam) / d;
  // brightness by kind
  let L = FR.sun.xyz;
  let sc = sunCol();
  var col = vec3f(0.0);
  if (kind == 0u) {
    let sh = lfShadow(wp, da, r.z, 8);
    let fwd = hg(dot(dir, L), 0.8) * 6.0 + 0.05;
    col = vec3f(1.0, 0.92, 0.7) * sc * sh * fwd * 0.1 + lfAmb(1.0, vec3f(0.3)) * 0.02;
  } else if (kind == 1u) {
    let tw = pow(max(sin(t * (5.0 + 6.0 * r.x) + ph * 7.0), 0.0), 40.0);
    col = (sc * 0.6 + lfAmb(1.0, vec3f(1.0)) * 0.5) * (0.04 + tw * 4.0) * vec3f(1.0, 0.92, 0.95);
  } else if (kind == 2u) {
    let tw = pow(max(sin(t * (3.0 + 5.0 * r.x) + ph * 5.0), 0.0), 30.0);
    col = (lfAmb(1.0, vec3f(1.0)) * 0.9 + rowv(S7).rgb * rowv(S7).w * 3.0 + sc * 0.3) * (0.35 + tw * 3.0);
  } else if (kind == 3u) {
    let pl = 0.5 + 0.5 * sin(t * 1.3 + ph + dot(wp.xz, vec2f(0.05, 0.03)));
    var gc = vec3f(0.25, 1.0, 0.85);
    if (r.z > 0.6) { gc = vec3f(0.95, 0.35, 0.9); }
    if (r.z > 0.85) { gc = vec3f(1.0, 0.7, 0.25); }
    col = gc * (0.4 + 1.4 * pl * pl);
  } else {
    // fireflies: short flashes every few seconds
    let cyc = fract(t / (2.0 + 2.5 * r.x) + r.z);
    let blink = sstep(0.0, 0.05, cyc) * sstep(0.3, 0.12, cyc);
    col = vec3f(0.75, 1.0, 0.25) * blink * 14.0;
  }
  // keep a mote at least ~1.6 px wide; shrink its brightness by the area it gained (no sparkly aliasing)
  let pxs = size / (da * VW.fwd.w * 2.0) * VW.size.y;
  var s2 = size;
  if (pxs < 1.6) { s2 = size * 1.6 / pxs; col *= (pxs / 1.6) * (pxs / 1.6); }
  col *= fade * sstep(0.6, 2.5, da) * lfFogT(cam, dir, d);
  let c = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let q = wp + (VW.right.xyz * c.x + VW.up.xyz * c.y) * s2 * 2.0;
  o.pos = VW.vp * vec4f(q - cam, 1.0);
  o.uv = c;
  o.col = col;
  o.d = d;
  return o;
}

@fragment fn fsPart(in: PV) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  let sd = textureLoad(sceneDist, vec2i(in.pos.xy), 0).x;
  let vis = clamp((sd - in.d) / max(0.3, in.d * 0.02), 0.0, 1.0);
  let e = exp(-r2 * 4.0) * (1.0 - r2);
  return vec4f(in.col * e * vis * 2.4, 0.0);
}
