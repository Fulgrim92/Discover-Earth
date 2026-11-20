// herd.wgsl: ground animals as populations (sheep, wild horses, standing flamingos, arctic foxes, seals, Lumen
// light-eaters and the slow giant on the horizon). A herd's home, species, size and its reaction to the drone
// (flee offset, alarm, gait distance) come from the CPU table in herd.js (HG, 3 vec4 per group); everything else is
// closed-form in time and index: each animal walks short arcs between grazing stops, so the gait phase is the
// distance walked and planted feet never slide. Every part is an ellipsoid (8 x 4 quads) placed on a rig whose
// body follows the terrain height and slope and whose feet stand on the ground (two-bone legs).
@group(2) @binding(0) var<uniform> HG: array<vec4f, 196>;

const HCO = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
const HP_SEG = 8u; const HP_RING = 4u;
const HP_VERTS = 192u;           // 8 x 4 quads x 6
const H_PARTS = 13u;             // body, neck, head, tail, 4 legs x 2 segments, snout/ear
const H_VERTS = 2496u;           // H_PARTS x HP_VERTS

// species: x body length, y body radius, z leg length, w neck length
fn spA(s: u32) -> vec4f {
  switch s {
    case 0u: { return vec4f(1.05, 0.34, 0.42, 0.28); }  // Faroese sheep
    case 1u: { return vec4f(1.75, 0.36, 0.95, 0.8); }   // wild horse
    case 2u: { return vec4f(0.5, 0.15, 0.95, 0.65); }   // flamingo (two legs)
    case 3u: { return vec4f(0.62, 0.13, 0.27, 0.16); }  // arctic fox
    case 4u: { return vec4f(1.6, 0.3, 0.0, 0.25); }     // seal (no legs)
    case 5u: { return vec4f(3.2, 0.8, 0.75, 1.3); }     // light-eater
    default: { return vec4f(3.2, 0.8, 0.75, 1.3); }     // giant (scaled)
  }
}
// x head length, y head radius, z spread of the herd (m), w walking speed (m/s)
fn spB(s: u32) -> vec4f {
  switch s {
    case 0u: { return vec4f(0.3, 0.11, 14.0, 0.5); }
    case 1u: { return vec4f(0.58, 0.12, 10.0, 1.1); }
    case 2u: { return vec4f(0.16, 0.035, 9.0, 0.35); }
    case 3u: { return vec4f(0.17, 0.06, 26.0, 0.9); }
    case 4u: { return vec4f(0.28, 0.13, 7.0, 0.0); }
    case 5u: { return vec4f(0.7, 0.28, 22.0, 0.35); }
    default: { return vec4f(0.7, 0.28, 0.0, 0.35); }
  }
}

struct Ani { ok: bool, p: vec3f, f: vec3f, u: vec3f, s: vec3f, sp: u32, sc: f32, gait: f32, graze: f32, alarm: f32, h: u32, walk: f32, look: vec3f }

fn hgnd(p: vec2f) -> f32 { return heightAny(p); }

fn animal(ii: u32) -> Ani {
  var A: Ani; A.ok = false;
  let g = ii / 16u; let k = ii % 16u;
  let G0 = HG[g * 3u]; let G1 = HG[g * 3u + 1u]; let G2 = HG[g * 3u + 2u];
  if (f32(k) >= G0.w) { return A; }
  let sp = u32(G0.z); A.sp = sp;
  let sa = spA(sp); let sb = spB(sp);
  let t = FR.time.x;
  let h = hu(i32(G2.w), i32(k), 0x4E1u); A.h = h;
  let r1 = lfRand(h, 1u); let r2 = lfRand(h, 2u); let r3 = lfRand(h, 3u); let r4 = lfRand(h, 4u);
  A.sc = G2.z * (0.85 + 0.3 * r4);
  // herd centre wanders slowly; the flee offset is the CPU's integrated reaction to the drone
  let ph = G2.w * 0.001;
  let hc = G0.xy + vec2f(sin(t * 0.0021 + ph), cos(t * 0.0017 + ph * 1.3)) * sb.z * 0.8 + G1.xy;
  let ofs = vec2f(cos(r1 * 6.2832), sin(r1 * 6.2832)) * sb.z * sqrt(r2);
  // own walk: arcs of radius Rw walked for Tw seconds out of every T, standing (grazing) in between
  let T = 9.0 + 9.0 * r3; let Tw = T * (0.25 + 0.2 * r4);
  let tt = t / T + r2;
  let kk = floor(tt); let fw = clamp(fract(tt) * T, 0.0, Tw);
  let Rw = (2.5 + 3.0 * r1) * A.sc;
  let om = sb.w / Rw * select(1.0, -1.0, r3 > 0.5);
  let th = om * (kk * Tw + fw) + r4 * 6.2832;
  let walking = fract(tt) * T < Tw;
  var pos = hc + ofs + vec2f(cos(th), sin(th)) * Rw;
  var dir = normalize(vec2f(-sin(th), cos(th)) * sign(om));
  A.walk = select(0.0, 1.0, walking && sb.w > 0.0);
  A.gait = abs(om) * Rw * (kk * Tw + fw) + G1.w;
  A.graze = select(1.0, 0.25, walking);
  A.alarm = G1.z;
  // fleeing: run along the flee direction; heads up
  let fd = G2.xy;
  if (length(fd) > 0.01) { dir = normalize(mix(dir, normalize(fd), sstep(0.15, 0.5, G1.z))); }
  if (G1.z > 0.15) { A.graze = 0.0; A.walk = max(A.walk, sstep(0.15, 0.5, G1.z)); }
  if (sp == 4u) { A.walk = 0.0; A.graze = 0.0; dir = normalize(vec2f(cos(r3 * 6.2832), sin(r3 * 6.2832))); }
  // body on the terrain: pitch from the ground under the shoulders and hips
  let L = sa.x * A.sc;
  let gf = hgnd(pos + dir * L * 0.42); let gb = hgnd(pos - dir * L * 0.42);
  let g0 = 0.5 * (gf + gb);
  if (sp == 2u) { if (g0 > 0.05 || g0 < -0.6) { return A; } }        // flamingos stand in the shallows
  else if (sp == 4u) { if (g0 < 0.05) { return A; } }
  else if (g0 < 0.2) { return A; }                                     // land animals keep out of the water
  let fwd = normalize(vec3f(dir.x * L * 0.84, gf - gb, dir.y * L * 0.84));
  let side = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(side, fwd);
  A.f = fwd; A.u = up; A.s = side;
  let gy = select(g0, max(g0, 0.0) - 0.02, sp == 2u);
  A.p = vec3f(pos.x, gy, pos.y);
  // look toward the drone when alarmed
  let D = HG[192].xyz;
  A.look = normalize(D - A.p);
  let d = length(A.p - VW.cam.xyz);
  if (d > select(900.0, 6000.0, sp == 6u)) { return A; }
  if (!lfVisible(A.p - VW.cam.xyz + up * L * 0.4, L * 1.2)) { return A; }
  A.ok = true;
  return A;
}

struct HV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) loc: vec2f,                    // part-local: along (-1..1), around
  @location(3) @interpolate(flat) part: u32,
  @location(4) @interpolate(flat) sp: u32,
  @location(5) @interpolate(flat) tint: vec4f, // per-animal coat variation, glow
}

// two-bone leg: hip, foot, bone lengths l (each), knee bends along kd
fn knee(hip: vec3f, foot: vec3f, l: f32, kd: vec3f) -> vec3f {
  let m = 0.5 * (hip + foot);
  let hd = 0.5 * length(foot - hip);
  return m + kd * sqrt(max(l * l - hd * hd, 0.0));
}

@vertex fn vsHerd(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> HV {
  var o: HV; o.pos = LF_DEAD;
  let A = animal(ii);
  if (!A.ok) { return o; }
  let part = vi / HP_VERTS; let pv = vi % HP_VERTS;
  let sa = spA(A.sp) * A.sc; let sb = spB(A.sp) * A.sc;
  let L = sa.x; let R = sa.y; let LL = sa.z;
  let F = A.f; let U = A.u; let S = A.s;
  let t = FR.time.x;
  let bodyY = select(LL * 0.92 + R * 0.35, R * 0.75, A.sp == 4u);
  let breathe = 1.0 + 0.015 * sin(t * 1.7 + f32(A.h & 255u));
  let bob = 0.04 * LL * A.walk * abs(sin(A.gait / max(LL * 1.6, 0.1) * 6.2832));
  let C = A.p + U * (bodyY + bob);
  var c = C; var ax = F; var hl = L * 0.5; var rr = R * breathe;
  var flat0 = 1.0; // squash of the body cross-section (seal lies flat)
  let biped = A.sp == 2u;
  // neck and head
  let shoulder = C + F * L * select(0.38, 0.1, biped) + U * R * 0.4;
  let lookUp = sstep(0.15, 0.5, A.alarm);
  let lk = normalize(mix(F, A.look, 0.6 * lookUp));
  var nd = normalize(F * 0.55 + U * mix(mix(0.85, -1.1, A.graze), 1.4, lookUp));
  if (biped) { nd = normalize(F * 0.35 + U * mix(0.9, -1.3, A.graze)); }
  if (A.sp == 4u) { nd = normalize(F + U * (0.3 + 0.4 * sstep(0.6, 1.0, sin(t * 0.13 + f32(A.h & 63u))))); }
  let neckEnd = shoulder + nd * sa.w;
  let hdir = normalize(mix(nd, lk, 0.5) + U * select(-0.5, -0.9, biped) + F * 0.3);
  if (part == 0u) {
    if (biped) { hl = L * 0.5; rr = R; }
    if (A.sp == 4u) { flat0 = 0.7; ax = normalize(F + U * 0.05); }
  } else if (part == 1u) {
    c = 0.5 * (shoulder + neckEnd); ax = nd; hl = sa.w * 0.55; rr = R * select(0.42, 0.18, biped);
    if (A.sp == 0u) { rr = R * 0.55; }
  } else if (part == 2u) {
    c = neckEnd + hdir * sb.x * 0.45; ax = hdir; hl = sb.x * 0.5; rr = sb.y;
  } else if (part == 3u) {
    // tail
    let tl = select(0.25, 0.55, A.sp == 1u || A.sp == 3u) * L;
    let td = normalize(-F + U * select(-0.9, 0.15, A.sp == 3u) + S * 0.15 * sin(t * 2.0 + f32(A.h & 31u)));
    c = C - F * L * 0.48 + td * tl * 0.5; ax = td; hl = tl * 0.5; rr = R * select(0.12, 0.28, A.sp == 3u);
    if (A.sp == 2u || A.sp == 4u) { c = C - F * L * 0.5; hl = L * 0.15; rr = R * 0.3; ax = F; }
  } else if (part == 12u) {
    // ears / snout / bill: a small piece at the head tip
    c = neckEnd + hdir * sb.x * 0.95; ax = normalize(hdir + U * select(0.0, -0.8, biped)); hl = sb.x * 0.22; rr = sb.y * 0.55;
  } else {
    // legs: parts 4..11 = 4 legs x (upper, lower)
    let li = (part - 4u) / 2u; let seg = (part - 4u) % 2u;
    if (A.sp == 4u || (biped && li >= 2u)) { return o; }
    let front = li < 2u; let left = (li & 1u) == 0u;
    var hip = C + F * select(-L * 0.36, L * 0.36, front) + S * select(-R * 0.55, R * 0.55, left) - U * R * 0.3;
    if (biped) { hip = C + S * select(-R * 0.4, R * 0.4, left) - U * R * 0.5; }
    // gait: stance 60% (the foot planted while the body passes), swing 40%
    let stride = LL * select(0.75, 0.45, biped);
    let cyc = stride / 0.6;
    let off = select(select(0.25, 0.75, left), select(0.5, 0.0, left), front);
    let phs = fract(A.gait / cyc + select(off, select(0.0, 0.5, left), biped));
    var fx = 0.0; var lift = 0.0;
    if (phs < 0.6) { fx = stride * (0.5 - phs / 0.6); }
    else { let q = (phs - 0.6) / 0.4; fx = stride * (-0.5 + q); lift = sin(3.1416 * q) * 0.22 * LL; }
    fx *= A.walk; lift *= A.walk;
    let fxz = hip.xz + F.xz * fx;
    let fy = hgnd(fxz) + lift + 0.02 * LL;
    var foot = vec3f(fxz.x, fy, fxz.y);
    let hl0 = length(foot - hip);
    if (hl0 > LL) { foot = hip + (foot - hip) * (LL / hl0); }
    let kn = knee(hip, foot, LL * 0.5, select(-F, F, front) * select(1.0, -1.0, biped));
    var a0 = hip; var a1 = kn;
    if (seg == 1u) { a0 = kn; a1 = foot; }
    c = 0.5 * (a0 + a1); ax = normalize(a1 - a0 + vec3f(0.0, 1e-4, 0.0)); hl = 0.5 * length(a1 - a0) + rr * 0.0;
    rr = R * select(select(0.2, 0.14, seg == 1u), 0.08, biped) * select(1.0, 0.75, A.sp == 1u);
    if (A.sp == 5u || A.sp == 6u) { rr = R * select(0.22, 0.16, seg == 1u); }
  }
  // ellipsoid vertex
  let q = pv / 6u; let co = HCO[pv % 6u];
  let sgi = q % HP_SEG + co.x; let rg = q / HP_SEG + co.y;
  let thv = f32(rg) / f32(HP_RING) * 3.1416;
  let ph = f32(sgi) / f32(HP_SEG) * 6.2832;
  let b1 = normalize(cross(ax, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(ax.y) > 0.9)));
  let b2 = cross(ax, b1);
  let ring = (b1 * cos(ph) + b2 * sin(ph) * flat0) * sin(thv);
  // body: a slightly egg-shaped barrel, fuller at the chest
  var rk = rr;
  if (part == 0u) { rk *= 1.0 + 0.12 * cos(thv); }
  let wp = c + ax * (-cos(thv)) * hl + ring * rk;
  o.n = normalize(ax * (-cos(thv)) / max(hl, 1e-3) + ring / max(rk, 1e-3));
  o.wp = wp;
  o.loc = vec2f(-cos(thv), ph);
  o.part = part; o.sp = A.sp;
  o.tint = vec4f(lfRand(A.h, 5u), lfRand(A.h, 6u), A.alarm, f32(A.h & 1023u));
  o.pos = VW.vp * vec4f(wp - VW.cam.xyz, 1.0);
  return o;
}

fn coat(sp: u32, part: u32, tint: vec4f, loc: vec2f, wp: vec3f) -> vec3f {
  let v = tint.x; let v2 = tint.y;
  switch sp {
    case 0u: {
      // Faroese sheep: mostly cream-white, some moorit brown and black; dark faces and legs on many
      var w = mix(vec3f(0.55, 0.52, 0.45), vec3f(0.62, 0.6, 0.53), v2);
      if (v > 0.72) { w = vec3f(0.2, 0.13, 0.08); }
      if (v > 0.9) { w = vec3f(0.045, 0.04, 0.035); }
      if (part >= 2u && part != 3u && v2 > 0.5) { w *= 0.35; }
      return w * (0.85 + 0.25 * vn(wp.xz * 9.0 + wp.y * 7.0, 961u));
    }
    case 1u: {
      var w = mix(vec3f(0.22, 0.12, 0.06), vec3f(0.42, 0.32, 0.18), v);   // bay to dun
      if (part >= 4u && part <= 11u) { w = mix(w, vec3f(0.03, 0.025, 0.02), sstep(0.0, 0.8, loc.x)); }
      if (part == 3u) { w = vec3f(0.03, 0.025, 0.02); }
      return w;
    }
    case 2u: {
      if (part >= 4u && part <= 11u) { return vec3f(0.62, 0.3, 0.3); }
      if (part == 12u) { return mix(vec3f(0.82, 0.62, 0.55), vec3f(0.02), sstep(0.0, 0.6, loc.x)); }
      return mix(vec3f(0.85, 0.42, 0.42), vec3f(0.9, 0.55, 0.5), v);
    }
    case 3u: { return mix(vec3f(0.78, 0.8, 0.82), vec3f(0.62, 0.6, 0.56), v * 0.5); }
    case 4u: {
      let m = sstep(0.1, 0.5, vn(wp.xz * 6.0 + wp.y * 4.0, 962u));
      return mix(vec3f(0.16, 0.16, 0.15), vec3f(0.3, 0.29, 0.27), m) * mix(1.0, 1.4, sstep(-0.2, -0.6, loc.y));
    }
    default: { return vec3f(0.06, 0.05, 0.08); }
  }
}

struct HOut { @location(0) c: vec4f, @location(1) d: vec4f }

@fragment fn fsHerd(in: HV) -> HOut {
  let cam = VW.cam.xyz;
  let toC = cam - in.wp; let dist = length(toC); let V = toC / dist;
  var n = normalize(in.n);
  let L = FR.sun.xyz; let sc = sunCol();
  let alb = coat(in.sp, in.part, in.tint, in.loc, in.wp);
  let ndl = dot(n, L);
  let sh = select(0.0, lfCloudShadow(in.wp), L.y > -0.03);
  // wool and fur scatter: wrapped diffuse; short-haired horse and wet seal: a little gloss
  let wrapK = select(0.15, 0.4, in.sp == 0u || in.sp == 3u);
  var col = alb * (sc * sh * max((ndl + wrapK) / (1.0 + wrapK), 0.0) + lfAmb(n.y, alb));
  let hv = normalize(L + V);
  let gl = select(0.0, select(0.08, 0.25, in.sp == 4u), in.sp == 1u || in.sp == 4u);
  col += sc * sh * pow(max(dot(n, hv), 0.0), 50.0) * gl;
  if (in.sp >= 5u) {
    // light-eaters: dark translucent hide; the light they graze glows inside in slow soft patches
    let gc = glowCol(in.wp.xz, in.tint.x);
    let pat = sstep(0.2, 0.7, vn(vec2f(in.loc.y * 1.3, in.loc.x * 3.0 + FR.time.x * 0.15) + in.tint.w, 963u));
    let fres = pow(1.0 - abs(dot(n, V)), 2.0);
    col += gc * (0.04 + 0.5 * pat * select(0.2, 1.0, in.part == 0u) + 0.25 * fres);
  }
  var o: HOut;
  o.c = vec4f(col, 1.0);
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
