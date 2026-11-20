// clip.wgsl: clipmap sampling, level choice and the height-marched sun shadow. Bound as group 1.
@group(1) @binding(0) var clipT: texture_2d_array<f32>;
@group(1) @binding(1) var clipA: texture_2d_array<f32>;
@group(1) @binding(2) var clipB: texture_2d_array<f32>;
@group(1) @binding(3) var clipSm: sampler;
@group(1) @binding(4) var clipSh: texture_2d_array<f32>; // shade: sun shadow, sky visibility, nL, nM (bake.wgsl)
// Heights: r32float, unfilterable on adapters without float32-filterable, so never put through the linear sampler.
// clipH gathers the 2x2 texels once and blends them in f32 (exact bilinear, same result with or without the feature).
@group(1) @binding(5) var clipHt: texture_2d_array<f32>;
@group(1) @binding(6) var clipPt: sampler; // non-filtering, clamp-to-edge
fn clipSH(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipSh, clipSm, clipUV(i, p), i, 0.0); }

fn nLevels() -> u32 { return u32(FR.misc.x); }

// finest level whose baked square covers p with `margin` texels to spare
fn clipLevel(p: vec2f, start: u32, margin: f32) -> u32 {
  let n = nLevels();
  for (var i = start; i < n; i++) {
    let lv = FR.lv[i];
    let c = lv.xy + 256.0 * lv.z;
    let d = max(abs(p.x - c.x), abs(p.y - c.y));
    if (d < (256.0 - margin) * lv.z) { return i; }
  }
  return n - 1u;
}
// 0 inside, 1 at the coverage edge of level i (for cross-fading to i+1)
fn clipEdge(i: u32, p: vec2f) -> f32 {
  let lv = FR.lv[i];
  let c = lv.xy + 256.0 * lv.z;
  let d = max(abs(p.x - c.x), abs(p.y - c.y)) / lv.z;
  return sstep(200.0, 246.0, d);
}
fn clipUV(i: u32, p: vec2f) -> vec2f {
  let lv = FR.lv[i];
  return ((p - lv.xy) / lv.z + 0.5) * (1.0 / 512.0);
}
fn clipH(i: u32, p: vec2f) -> f32 {
  let t = clipUV(i, p) * 512.0 - 0.5;
  let b = floor(t);
  let f = t - b;
  // footprint centred on the shared corner of texels b and b+1: w = (b.x, b.y), z = (b.x+1, b.y), x = (b.x, b.y+1), y = (b.x+1, b.y+1)
  let g = textureGather(0, clipHt, clipPt, (b + 1.0) * (1.0 / 512.0), i);
  return mix(mix(g.w, g.z, f.x), mix(g.x, g.y, f.x), f.y);
}
// (h, dh/dx, dh/dz, concavity): exact height from clipH, the rest hardware-filtered from rgba16float
fn clipS(i: u32, p: vec2f) -> vec4f {
  var s = textureSampleLevel(clipT, clipSm, clipUV(i, p), i, 0.0);
  s.x = clipH(i, p);
  return s;
}
fn clipMA(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipA, clipSm, clipUV(i, p), i, 0.0); }
fn clipMB(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipB, clipSm, clipUV(i, p), i, 0.0); }

// best height anywhere (cross-faded at level edges)
fn heightAny(p: vec2f) -> f32 {
  let l = clipLevel(p, 0u, 8.0);
  let e = clipEdge(l, p);
  var h = clipH(l, p);
  if (e > 0.0 && l + 1u < nLevels()) { h = mix(h, clipH(l + 1u, p), e); }
  return h;
}

// soft sun shadow by marching the height clipmaps toward the sun
fn sunShadow(p: vec3f, L: vec3f, dist: f32, soft: f32, jit: f32, steps: i32) -> f32 {
  if (L.y < -0.05) { return 0.0; }
  var t = max(0.6, dist * 0.004) * (1.0 + jit * 0.5);
  var res = 1.0;
  var lv = clipLevel(p.xz, 0u, 8.0);
  for (var i = 0; i < steps; i++) {
    let q = p + L * t;
    lv = clipLevel(q.xz, lv, 8.0);
    let lt = FR.lv[lv].z;
    let h = clipH(lv, q.xz);
    let d = q.y - h;
    res = min(res, d / (soft * t + 0.25 * lt));
    if (res < -0.1 || q.y > 2600.0) { break; }
    t = t * 1.26 + 0.8;
  }
  return sstep(-0.1, 1.0, res);
}
