// cloudnoise.wgsl: tileable 3D cloud noise, baked once at start (compute). The weather bake is cloudwx.wgsl.
// Base (128^3, 4 mips): r = Perlin-Worley, g/b/a = Worley fbm at rising frequency. Detail (32^3): Worley fbm x3.

@group(1) @binding(0) var outBase: texture_storage_3d<rgba8unorm, write>;
@group(1) @binding(1) var outDet: texture_storage_3d<rgba8unorm, write>;
@group(1) @binding(2) var mipSrc: texture_3d<f32>;
@group(1) @binding(3) var mipDst: texture_storage_3d<rgba8unorm, write>;

fn wrap3(c: vec3i, per: i32) -> vec3i { return ((c % vec3i(per)) + vec3i(per)) % vec3i(per); }

fn grad3(c: vec3i, per: i32, seed: i32) -> vec3f {
  let w = wrap3(c, per);
  let h = hu3(w.x, w.y, w.z + seed * 7919);
  // 16 gradients on the cube edges (12 + 4 repeats), the classic improved-Perlin set
  switch (h & 15u) {
    case 0u, 12u: { return vec3f(1.0, 1.0, 0.0); }
    case 1u, 13u: { return vec3f(-1.0, 1.0, 0.0); }
    case 2u: { return vec3f(1.0, -1.0, 0.0); }
    case 3u: { return vec3f(-1.0, -1.0, 0.0); }
    case 4u: { return vec3f(1.0, 0.0, 1.0); }
    case 5u: { return vec3f(-1.0, 0.0, 1.0); }
    case 6u: { return vec3f(1.0, 0.0, -1.0); }
    case 7u: { return vec3f(-1.0, 0.0, -1.0); }
    case 8u: { return vec3f(0.0, 1.0, 1.0); }
    case 9u, 14u: { return vec3f(0.0, -1.0, 1.0); }
    case 10u: { return vec3f(0.0, 1.0, -1.0); }
    default: { return vec3f(0.0, -1.0, -1.0); }
  }
}

// periodic gradient noise, p in lattice units, period `per`; about [-1, 1]
fn perlinP(p: vec3f, per: i32, seed: i32) -> f32 {
  let i = vec3i(floor(p)); let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var r = array<f32, 8>();
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    r[k] = dot(grad3(i + o, per, seed), f - vec3f(o));
  }
  let x0 = mix(r[0], r[1], u.x); let x1 = mix(r[2], r[3], u.x);
  let x2 = mix(r[4], r[5], u.x); let x3 = mix(r[6], r[7], u.x);
  return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}

// periodic Worley, p in cell units; returns 1 - distance to the nearest feature (cells are 1 apart)
fn worleyP(p: vec3f, per: i32, seed: i32) -> f32 {
  let c = vec3i(floor(p));
  var md = 9.0;
  for (var k = 0; k < 27; k++) {
    let o = vec3i(k % 3 - 1, (k / 3) % 3 - 1, k / 9 - 1);
    let n = c + o;
    let w = wrap3(n, per);
    let h = hu3(w.x, w.y, w.z + seed * 104729);
    let fp = vec3f(n) + vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) * (1.0 / 1023.0);
    let d = fp - p;
    md = min(md, dot(d, d));
  }
  return clamp(1.0 - sqrt(md), 0.0, 1.0);
}

fn remapc(x: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (x - a) / (b - a) * (d - c); }

@compute @workgroup_size(4, 4, 4) fn csBase(@builtin(global_invocation_id) id: vec3u) {
  let N = textureDimensions(outBase).x;
  if (any(id >= vec3u(N))) { return; }
  let uvw = (vec3f(id) + 0.5) / f32(N);
  // Perlin fbm, 4 octaves, periods 4..32
  var pn = 0.0; var a = 1.0; var fq = 4; var norm = 0.0;
  for (var o = 0; o < 4; o++) {
    pn += a * perlinP(uvw * f32(fq), fq, o);
    norm += a; a *= 0.5; fq *= 2;
  }
  pn = clamp(pn / norm * 0.85 + 0.5, 0.0, 1.0);
  let w4 = worleyP(uvw * 4.0, 4, 11);
  let w8 = worleyP(uvw * 8.0, 8, 12);
  let w16 = worleyP(uvw * 16.0, 16, 13);
  let w32 = worleyP(uvw * 32.0, 32, 14);
  let wf0 = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
  let pw = clamp(remapc(pn, 0.0, 1.0, wf0, 1.0), 0.0, 1.0);
  let g = w8 * 0.625 + w16 * 0.25 + w32 * 0.125;
  let b = w16 * 0.75 + w32 * 0.25;
  textureStore(outBase, id, vec4f(pw, g, b, w32));
}

@compute @workgroup_size(4, 4, 4) fn csDetail(@builtin(global_invocation_id) id: vec3u) {
  let N = textureDimensions(outDet).x;
  if (any(id >= vec3u(N))) { return; }
  let uvw = (vec3f(id) + 0.5) / f32(N);
  let w2 = worleyP(uvw * 2.0, 2, 21);
  let w4 = worleyP(uvw * 4.0, 4, 22);
  let w8 = worleyP(uvw * 8.0, 8, 23);
  textureStore(outDet, id, vec4f(w2 * 0.625 + w4 * 0.25 + w8 * 0.125, w4 * 0.75 + w8 * 0.25, w8, 1.0));
}

// 2x2x2 box down-sample into the next mip
@compute @workgroup_size(4, 4, 4) fn csMip(@builtin(global_invocation_id) id: vec3u) {
  let N = textureDimensions(mipDst).x;
  if (any(id >= vec3u(N))) { return; }
  var s = vec4f(0.0);
  for (var k = 0u; k < 8u; k++) {
    s += textureLoad(mipSrc, vec3i(id * 2u + vec3u(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u)), 0);
  }
  textureStore(mipDst, id, s * 0.125);
}
