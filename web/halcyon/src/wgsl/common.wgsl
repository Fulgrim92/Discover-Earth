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

// ---- clouds, shared (sky/atmosphere). The volumetric clouds' coverage field and its cheap ground shadow.
// The cloud pass bakes this field into a camera-centred weather texture every frame; terrain and water call
// cloudShadow() directly, so the shadows on the ground come from the same field as the clouds in the sky.
const CLOUD_WIND: vec2f = vec2f(4.2, 1.7); // m/s, one wind for the planet so the field never jumps at borders

// cellular domes (1 at a cell centre, falling off as a paraboloid, smooth-min blended so outlines stay round),
// cells of varying size: one cumulus per cell
fn cell2(p: vec2f, sd: u32) -> f32 {
  let i = floor(p);
  var acc = 0.0;
  for (var k = 0; k < 9; k++) {
    let c = i + vec2f(f32(k % 3 - 1), f32(k / 3 - 1));
    let ci = vec2i(c);
    let h = hu(ci.x, ci.y, sd);
    let r = vec2f(f32(h & 1023u), f32((h >> 10u) & 1023u)) * (1.0 / 1023.0);
    let sz = 0.5 + 0.6 * f32((h >> 20u) & 1023u) * (1.0 / 1023.0);
    let d = c + 0.15 + 0.7 * r - p;
    acc += exp(-10.0 * dot(d, d) / (sz * sz));
  }
  return 1.0 + log(max(acc, 1e-6)) * 0.1;
}

// 2D cloud field in [0,1]: regional swell + mid-scale masses, mixed toward separate cumulus cells by c3.x
fn cloudField(xz: vec2f, small: f32) -> f32 {
  let q = xz - CLOUD_WIND * FR.time.x;
  let wl = fbm(q * (1.0 / 6100.0), 3, 600u);
  let wm = fbm(rot2(q * (1.0 / 1900.0)) * 0.5 + vec2f(31.7, -12.3), 4, 610u);
  var ws = 0.0;
  if (small > 0.01) {
    let wp = q + 160.0 * vec2f(vn(q * (1.0 / 700.0), 621u), vn(q * (1.0 / 700.0) + 5.3, 622u));
    ws = cell2(wp * (1.0 / 950.0), 640u) * 1.15 - 0.62 + fbm(q * (1.0 / 260.0), 2, 650u) * 0.22;
  }
  return 0.5 + wl * (0.55 - 0.3 * small) + mix(wm * 0.75, ws + wm * 0.25, small);
}
// coverage of the main layer from the field and the realm's cover c0.x (0 = none, 1 = overcast)
fn cloudCov(f: f32, cover: f32) -> f32 {
  return sstep(1.0 - cover - 0.12, 1.0 - cover + 0.36, f);
}
// cloud-sea coverage: nearly closed with slow drifting holes
fn seaCov(xz: vec2f) -> f32 {
  let q = xz - CLOUD_WIND * 0.6 * FR.time.x;
  return sstep(-0.32, -0.08, fbm(q * (1.0 / 520.0), 3, 630u));
}

struct CloudU {
  win: vec4f,  // weather window texel-0 x, z, texel size (m), texels
  slab: vec4f, // main layer min base, max top, sea min base, sea max top (planet-wide bounds)
  q: vec4f,    // primary steps, light steps, max distance (m), reflection steps
  misc: vec4f, // half-res w, h, 1/w, 1/h
  camId: vec4f, // realm ids blended at the camera (-1 = none)
  camW: vec4f,  // their weights
}

// Sun transmittance through the clouds at world point p (cheap: one coverage lookup per layer).
fn cloudShadow(p: vec3f, L: vec3f, rw: RWt) -> f32 {
  if (L.y < 0.005) { return 1.0; }
  return cloudShadowF(p, L, bf(rw, C0), bf(rw, C1), bf(rw, C2), bf(rw, C3));
}
// the same with the cloud fields given (life.wgsl passes the camera row: flora, fauna, particles, drone)
// cost ablation: false drops cloud shadows everywhere (terrain, water glitter, life)
const CLOUD_SHADOW_ON: bool = true;
fn cloudShadowF(p: vec3f, L: vec3f, c0: vec4f, c1: vec4f, c2: vec4f, c3: vec4f) -> f32 {
  if (!CLOUD_SHADOW_ON || L.y < 0.005) { return 1.0; }
  var tr = 1.0;
  let ly = max(L.y, 0.1);
  if (c0.x > 0.005) {
    let mid = mix(c0.y, c0.z, 0.2);
    if (p.y < mid) {
      let xz = p.xz + L.xz * ((mid - p.y) / ly);
      let cv = cloudCov(cloudField(xz, c3.x), c0.x);
      tr = 1.0 - sstep(0.05, 0.6, cv) * clamp(c0.w * 0.85, 0.0, 0.88);
    }
  }
  if (c1.w > 0.005 && p.y < c2.y) {
    // through the cloud sea: thickness above p along the sun
    let th = (c2.y - max(p.y, c2.x)) / ly;
    let xz = p.xz + L.xz * ((c2.y - p.y) / ly);
    let od = th * c2.z * 0.03 * seaCov(xz);
    tr *= mix(1.0, max(exp(-od), 0.06), c1.w);
  }
  return tr;
}

// ---- sky light (sky/atmosphere programmer) ----
// The sky-view LUT of the physical atmosphere for this frame's camera (fx/atmo.js, wgsl/atmo.wgsl): rows 0..127
// are display radiance over the sphere (u = azimuth, v = elevation, denser near the horizon), a = mean
// transmittance along the view; row 128 holds per-frame values (atmoInfo).
@group(0) @binding(3) var atmoT: texture_2d<f32>;
@group(0) @binding(4) var atmoS: sampler;

// The key light is the sun or the moon, whichever is brighter where the realms blend: each body blends its own
// elevation across the Drift, so the sun sets and the moon rises (no disc slides across the sky); the light
// direction is their brightness-weighted mean, which only swings while both are at the horizon and dim.
const MOON_COL: vec3f = vec3f(0.94, 0.95, 1.0);
fn moonDirFrom(s8: vec4f, drift: f32) -> vec3f {
  let el = radians(s8.x + drift * 0.25); let az = radians(s8.y + drift * 0.5);
  return vec3f(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
}
// relative air mass (Kasten-Young) for a body at height y = sin(elevation)
fn airMass(y: f32) -> f32 {
  let e = degrees(asin(clamp(y, -1.0, 1.0)));
  return 1.0 / (max(y, 0.0) + 0.50572 * pow(max(e + 6.07995, 0.3), -1.6364));
}
struct KL { dir: vec3f, col: vec3f }
fn keyLight(s0: vec4f, s1: vec4f, s8: vec4f, drift: f32) -> KL {
  let sd = sunDirFrom(s0, drift);
  let sc = s1.rgb * s0.z * sstep(-0.035, 0.06, sd.y);
  let md = moonDirFrom(s8, drift);
  let mc = MOON_COL * s8.z * sstep(-0.035, 0.06, md.y) * exp(-0.22 * airMass(md.y));
  let ws = luma(sc) + 1e-5; let wm = luma(mc);
  var o: KL;
  o.dir = normalize(sd * ws + md * wm);
  o.col = sc + mc;
  return o;
}
