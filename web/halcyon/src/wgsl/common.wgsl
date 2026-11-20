// common.wgsl: prepended to every shader (after the generated realm constants).
// Hashes, noise, the Frame/View uniform blocks, the realm table and its smooth Voronoi blend.

struct Frame {
  time: vec4f,   // t (s), dt, frame index, quality (0 low, 1 normal, 2 high)
  sun: vec4f,    // camera-realm sun direction xyz, sun drift (deg)
  misc: vec4f,   // levels, grid quads G, texels per quad, P3 output
  lv: array<vec4f, 12>, // per clip level: texel-0 world x, z, texel size, baked flag
  mc: array<vec4f, 12>, // per clip level: mesh centre x, z, vertex spacing, 0
  row: array<vec4f, ROW>, // realm row blended at the camera
}
struct View {
  vp: mat4x4f,   // projection * view rotation (camera-relative world)
  ivp: mat4x4f,
  cam: vec4f,    // camera world position, near
  size: vec4f,   // target w, h, 1/w, 1/h
  fwd: vec4f,    // forward, tan(fovY/2)
  ofs: vec4f,    // viewport x offset in canvas px, y, canvas w, canvas h
  right: vec4f,  // camera right, tan(fovX/2)
  up: vec4f,     // camera up
}

// world-space view ray through pixel position pp (target pixels)
fn viewRay(pp: vec2f) -> vec3f {
  let uv = pp * VW.size.zw;
  let x = (uv.x * 2.0 - 1.0) * VW.right.w;
  let y = (1.0 - uv.y * 2.0) * VW.fwd.w;
  return normalize(VW.fwd.xyz + VW.right.xyz * x + VW.up.xyz * y);
}

@group(0) @binding(0) var<uniform> FR: Frame;
@group(0) @binding(1) var<uniform> VW: View;
@group(0) @binding(2) var<storage, read> RT: array<vec4f>;

const PI: f32 = 3.14159265;

fn hu(x: i32, y: i32, s: u32) -> u32 {
  var h = (u32(x) * 0x8da6b343u) ^ (u32(y) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}
fn hf(x: i32, y: i32, s: u32) -> f32 { return f32(hu(x, y, s) >> 8u) * (1.0 / 16777216.0); }
fn hu3(x: i32, y: i32, z: i32) -> u32 { return hu(x, y, u32(z) * 0x9e3779b9u + 7u); }
fn hf3(x: i32, y: i32, z: i32) -> f32 { return f32(hu3(x, y, z) >> 8u) * (1.0 / 16777216.0); }

// smoothstep that also works with e0 > e1 (mirrored in world.js)
fn sstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// value noise in [-1,1] with analytic derivatives (x = value, yz = d/dp)
fn vnoised(p: vec2f, s: u32) -> vec3f {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let ix = i32(i.x); let iy = i32(i.y);
  let a = hf(ix, iy, s) * 2.0 - 1.0;
  let b = hf(ix + 1, iy, s) * 2.0 - 1.0;
  let c = hf(ix, iy + 1, s) * 2.0 - 1.0;
  let d = hf(ix + 1, iy + 1, s) * 2.0 - 1.0;
  let k1 = b - a; let k2 = c - a; let k3 = a - b - c + d;
  return vec3f(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du.x * (k1 + k3 * u.y), du.y * (k2 + k3 * u.x));
}
fn vn(p: vec2f, s: u32) -> f32 { return vnoised(p, s).x; }

fn rot2(q: vec2f) -> vec2f { return vec2f(0.8 * q.x - 0.6 * q.y, 0.6 * q.x + 0.8 * q.y) * 2.03; }

fn fbm(p: vec2f, oct: i32, seed: u32) -> f32 {
  var q = p; var a = 0.5; var s = 0.0;
  for (var o = 0; o < oct; o++) { s += a * vn(q, seed + u32(o)); a *= 0.5; q = rot2(q); }
  return s;
}

// 3D value noise (materials only; not mirrored on the CPU)
fn vn3(p: vec3f) -> f32 {
  let i = floor(p); let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let x = i32(i.x); let y = i32(i.y); let z = i32(i.z);
  let a = mix(mix(hf3(x, y, z), hf3(x + 1, y, z), u.x), mix(hf3(x, y + 1, z), hf3(x + 1, y + 1, z), u.x), u.y);
  let b = mix(mix(hf3(x, y, z + 1), hf3(x + 1, y, z + 1), u.x), mix(hf3(x, y + 1, z + 1), hf3(x + 1, y + 1, z + 1), u.x), u.y);
  return mix(a, b, u.z) * 2.0 - 1.0;
}

// ---- realm blend (mirror of realms.js realmWeights) ----
struct RWt { id: vec4i, w: vec4f, near: vec4f } // near: site x, z, realm, dmin

fn cellSite(i: i32, j: i32) -> vec3f {
  if (i >= -1 && i <= 1 && j >= -1 && j <= 1) {
    return RT[CUR_OFF + u32((i + 1) + (j + 1) * 3)].xyz;
  }
  let x = (f32(i) + (hf(i, j, 101u) - 0.5) * 2.0 * JIT) * CELL;
  let z = (f32(j) + (hf(i, j, 102u) - 0.5) * 2.0 * JIT) * CELL;
  return vec3f(x, z, f32(hu(i, j, 103u) % NREALM));
}

fn realmWeights(p0: vec2f) -> RWt {
  // warped lookup so borders are organic, not straight Voronoi edges (mirrored in realms.js)
  let wa = p0 * (1.0 / 2600.0);
  let wb = p0 * (1.0 / 800.0);
  let p = p0 + 650.0 * vec2f(vn(wa, 901u), vn(wa + vec2f(3.3, 8.1), 902u)) + 180.0 * vec2f(vn(wb, 903u), vn(wb + vec2f(1.9, 4.4), 904u));
  let bi = i32(floor(p.x / CELL + 0.5));
  let bj = i32(floor(p.y / CELL + 0.5));
  var sd: array<f32, 9>;
  var si: array<i32, 9>;
  var dmin = 1e30; var near = vec4f(0.0);
  var k = 0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let s = cellSite(bi + i, bj + j);
      let d = length(p - s.xy);
      sd[k] = d; si[k] = i32(s.z);
      if (d < dmin) { dmin = d; near = vec4f(s.xy, s.z, d); }
      k++;
    }
  }
  var r: RWt;
  r.id = vec4i(-1); r.w = vec4f(0.0); r.near = near;
  var sum = 0.0;
  for (var q = 0; q < 9; q++) {
    let e = (sd[q] - dmin) / BAND;
    if (e >= 1.0) { continue; }
    let a = 1.0 - e; let w = a * a * a;
    let id = si[q];
    var s = 0;
    while (s < 4 && r.id[s] != id && r.id[s] != -1) { s++; }
    if (s == 4) { continue; }
    r.id[s] = id; r.w[s] += w; sum += w;
  }
  r.w /= sum;
  return r;
}

fn bf(r: RWt, f: u32) -> vec4f {
  var o = vec4f(0.0);
  for (var s = 0; s < 4; s++) {
    if (r.id[s] >= 0) { o += r.w[s] * RT[u32(r.id[s]) * ROW + f]; }
  }
  return o;
}

fn sunDirFrom(s0: vec4f, drift: f32) -> vec3f {
  let el = radians(s0.x + drift * 0.5); let az = radians(s0.y + drift);
  return vec3f(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
}

fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// interleaved gradient noise for per-pixel jitter
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }
