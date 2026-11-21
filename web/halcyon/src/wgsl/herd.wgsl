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
const H_PARTS = 15u;             // body, neck, head, tail, 4 legs x 2 segments, snout, 2 ears
const H_VERTS = 2880u;           // H_PARTS x HP_VERTS

// species: x body length, y body radius, z leg length, w neck length
fn spA(s: u32) -> vec4f {
  switch s {
    case 0u: { return vec4f(1.05, 0.34, 0.42, 0.28); }  // Faroese sheep
    case 1u: { return vec4f(1.75, 0.36, 0.95, 0.8); }   // wild horse
    case 2u: { return vec4f(0.5, 0.15, 0.95, 0.65); }   // flamingo (two legs)
    case 3u: { return vec4f(0.62, 0.13, 0.27, 0.16); }  // arctic fox
    case 4u: { return vec4f(1.6, 0.3, 0.0, 0.25); }     // seal (no legs)
    case 5u: { return vec4f(3.2, 0.8, 0.75, 1.3); }     // light-eater
    case 7u: { return vec4f(7.0, 0.85, 0.0, 0.0); }     // orca
    case 8u: { return vec4f(14.0, 1.75, 0.0, 0.0); }    // humpback whale
    default: { return vec4f(3.0, 0.55, 2.0, 2.2); }     // giant: a long-legged, long-necked strider (scaled)
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
    case 7u: { return vec4f(1.6, 0.65, 0.0, 0.0); }
    case 8u: { return vec4f(3.2, 1.25, 0.0, 0.0); }
    default: { return vec4f(0.45, 0.16, 0.0, 0.35); }
  }
}

struct Ani { fly: f32, ok: bool, p: vec3f, f: vec3f, u: vec3f, s: vec3f, sp: u32, sc: f32, gait: f32, graze: f32, alarm: f32, h: u32, walk: f32, look: vec3f, coat: f32 }

fn hgnd(p: vec2f) -> f32 { return heightAny(p); }

// encounter actors (groups 53+): G1 = travel dir x, z, t0, duration; G2 = type, intensity, scale, seed
fn actor(g: u32, k: u32) -> Ani {
  var A: Ani; A.ok = false;
  let G0 = HG[g * 3u]; let G1 = HG[g * 3u + 1u]; let G2 = HG[g * 3u + 2u];
  if (f32(k) >= G0.w) { return A; }
  let ty = u32(G2.x); let rel = FR.time.x - G1.z;
  if (rel < 0.0 || rel > G1.w) { return A; }
  let dir = normalize(G1.xy + vec2f(1e-5, 0.0)); let sd2 = vec2f(-dir.y, dir.x);
  A.h = hu(i32(g), i32(k), 0x5A1u); A.sc = 1.0; A.look = vec3f(0.0, 1.0, 0.0); A.coat = lfRand(A.h, 5u);
  var pos: vec2f; var y = 0.0; var f3 = vec3f(dir.x, 0.0, dir.y); var swim = true;
  if (ty == 1u) {
    // orca pod travelling up the fjord, surfacing in turn (mirrored for ripples in lifefx.js)
    A.sp = 7u;
    let ph = f32(k) * 0.23;
    let al = rel * 3.5 - 60.0 + (f32((k * 37u) % 11u) - 5.0) * 2.2;
    pos = G0.xy + dir * al + sd2 * (f32(k) - 2.0) * 7.0;
    let f = fract(rel / 7.0 + ph);
    let bump = select(0.0, sin(3.1416 * f / 0.4), f < 0.4);
    y = -2.4 + 2.55 * bump;
    let dy = select(0.0, 0.45 * 2.55 * 3.1416 / 2.8 * cos(3.1416 * f / 0.4), f < 0.4); // body pitch follows the roll gently
    f3 = normalize(vec3f(dir.x * 3.5, dy, dir.y * 3.5));
    A.sc = select(1.0, 1.2, k == 0u);
  } else if (ty == 4u) {
    // humpback: blows at the surface, then the breach (launch at 20 s, crash at ~22.4 s)
    A.sp = 8u;
    pos = G0.xy + dir * (rel * 1.5 - 30.0);
    let tau = rel - 20.0;
    if (tau >= 0.0 && tau < 2.6) {
      y = -5.0 + 12.0 * tau - 4.9 * tau * tau;
      let pa = mix(1.25, -0.5, tau / 2.6);
      f3 = normalize(vec3f(dir.x * cos(pa), sin(pa), dir.y * cos(pa)));
      pos += dir * tau * 2.5;
    } else {
      let f = fract(rel / 7.0);
      let bump = select(0.0, sin(3.1416 * f / 0.45), f < 0.45);
      y = -3.0 + 2.6 * bump;
      f3 = normalize(vec3f(dir.x * 1.5, select(0.0, 2.6 * 3.1416 / 3.15 * cos(3.1416 * f / 0.45), f < 0.45), dir.y * 1.5));
    }
  } else if (ty == 3u) {
    // flamingo mass take-off: a wave of running starts across the flock, then flight away low over the water
    A.sp = 2u; swim = false;
    let a = f32(k) * 2.4; let r = 3.0 + sqrt(f32(k)) * 3.2;
    pos = G0.xy + vec2f(cos(a), sin(a)) * r;
    let tk = 6.0 + f32(k) * 0.12;
    let tau = rel - tk;
    A.alarm = sstep(0.0, 5.0, rel);
    if (tau > 0.0) {
      let along = select(1.5 * tau * tau, 2.16 + 3.6 * (tau - 1.2) + 1.5 * (tau - 1.2) * (tau - 1.2), tau > 1.2);
      pos += dir * along;
      A.walk = select(1.0, 0.0, tau > 1.4);
      A.gait = along;
      A.fly = sstep(0.8, 1.6, tau);
      y = select(0.0, 0.7 * pow(tau - 1.2, 1.4), tau > 1.2);
    }
  } else {
    // migration of giants: a slow file walking across the horizon
    A.sp = 6u; swim = false;
    A.sc = 24.0 + 4.0 * f32(k % 3u);
    let along = rel * 3.0 - 200.0 + f32(k % 2u) * 70.0;
    pos = G0.xy + dir * along + sd2 * (f32(k) - 2.0) * 160.0;
    A.walk = 1.0; A.gait = rel * 3.0;
  }
  if (swim) {
    A.p = vec3f(pos.x, y, pos.y);
    A.f = f3;
    A.s = normalize(cross(f3, vec3f(0.0, 1.0, 0.0)));
    A.u = cross(A.s, f3);
  } else {
    let L = spA(A.sp).x * A.sc;
    let gf = hgnd(pos + dir * L * 0.42); let gb = hgnd(pos - dir * L * 0.42);
    let g0 = min(0.5 * (gf + gb), hgnd(pos)); // never above the ground under the belly
    let fwd = normalize(vec3f(dir.x * L * 0.84, (gf - gb) * (1.0 - A.fly), dir.y * L * 0.84));
    A.f = fwd; A.s = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0))); A.u = cross(A.s, fwd);
    A.p = vec3f(pos.x, select(g0, max(g0, 0.0) - 0.02, A.sp == 2u) + y, pos.y);
  }
  let rad = spA(A.sp).x * A.sc;
  if (!lfVisible(A.p - VW.cam.xyz, rad)) { return A; }
  A.ok = true;
  return A;
}

fn animal(ii: u32) -> Ani {
  var A: Ani; A.ok = false;
  // encounter actors: slots of 64 instances after the 53 herd groups of 16
  if (ii >= 848u) { return actor(53u + (ii - 848u) / 64u, (ii - 848u) % 64u); }
  let g = ii / 16u; let k = ii % 16u;
  let G0 = HG[g * 3u]; let G1 = HG[g * 3u + 1u]; let G2 = HG[g * 3u + 2u];
  if (f32(k) >= G0.w) { return A; }
  let sp = u32(G0.z); A.sp = sp;
  let sa = spA(sp); let sb = spB(sp);
  let t = FR.time.x;
  let h = hu(i32(G2.w), i32(k), 0x4E1u); A.h = h;
  let r1 = lfRand(h, 1u); let r2 = lfRand(h, 2u); let r3 = lfRand(h, 3u); let r4 = lfRand(h, 4u);
  A.sc = G2.z * (0.85 + 0.3 * r4);
  // coat: horses are bay, chestnut or dark brown; at most one grey per herd (its first animal, in some herds)
  A.coat = lfRand(h, 5u) * 0.999;
  if (sp == 1u && k == 0u && lfRand(hu(i32(G2.w), 9, 0x6E1u), 1u) < 0.3) { A.coat = 1.5; }
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
  // body on the terrain: pitch from the ground under the shoulders and hips, roll from the ground either side
  let L = sa.x * A.sc;
  let gf = hgnd(pos + dir * L * 0.42); let gb = hgnd(pos - dir * L * 0.42); let gc = hgnd(pos);
  let sd0 = vec2f(dir.y, -dir.x); let W = L * 0.25;
  let gl = hgnd(pos + sd0 * W); let gr = hgnd(pos - sd0 * W);
  // never above the ground under the belly, and never sunk into a bank or a terrace step: the body stays within
  // reach of the highest ground under it (the legs take up the rest, each hoof on its own ground)
  let gmax = max(max(gf, gb), max(gc, max(gl, gr)));
  let g0 = max(min(0.5 * (gf + gb), gc), gmax - L * 0.16);
  if (sp == 2u) { if (g0 > 0.05 || g0 < -0.6) { return A; } }        // flamingos stand in the shallows
  else if (sp == 4u) { if (g0 < 0.05) { return A; } }
  else if (g0 < 0.2) { return A; }                                     // land animals keep out of the water
  let fwd = normalize(vec3f(dir.x * L * 0.84, clamp(gf - gb, -0.5 * L, 0.5 * L), dir.y * L * 0.84));
  let side0 = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  // roll: half the cross slope
  let gsl = dot(side0.xz, sd0) * (gl - gr) / (2.0 * W);
  let sr = side0 + vec3f(0.0, 0.5 * clamp(gsl, -1.0, 1.0), 0.0);
  let side = normalize(sr - fwd * dot(sr, fwd));
  let up = normalize(cross(side, fwd));
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
  @location(6) ax: vec3f,                      // part axis (hair and feather direction)
}

// two-bone leg: hip, foot, bone lengths l (each), knee bends along kd
fn knee(hip: vec3f, foot: vec3f, l: f32, kd: vec3f) -> vec3f {
  let m = 0.5 * (hip + foot);
  let hd = 0.5 * length(foot - hip);
  return m + kd * sqrt(max(l * l - hd * hd, 0.0));
}

fn herdVert(vi: u32, ii: u32) -> HV {
  var o: HV; o.pos = LF_DEAD;
  let A = animal(ii);
  if (!A.ok) { return o; }
  if (isSkinned(A.sp)) { return skinVert(vi, A); }
  let part = vi / HP_VERTS; let pv = vi % HP_VERTS;
  let sa = spA(A.sp) * A.sc; let sb = spB(A.sp) * A.sc;
  let L = sa.x; let R = sa.y; let LL = sa.z;
  let F = A.f; let U = A.u; let S = A.s;
  let t = FR.time.x;
  var bodyY = select(LL * 0.92 + R * 0.35, R * 0.75, A.sp == 4u);
  let sw = A.sp >= 7u;
  if (sw) { bodyY = 0.0; }
  let breathe = 1.0 + 0.015 * sin(t * 1.7 + f32(A.h & 255u));
  let bob = 0.04 * LL * A.walk * abs(sin(A.gait / max(LL * 1.6, 0.1) * 6.2832));
  let gph = A.gait / max(LL * 1.6, 0.1) * 6.2832;
  let C = A.p + U * (bodyY + bob) + S * (0.025 * LL * A.walk * sin(gph * 0.5));   // weight shifts side to side
  var c = C; var ax = F; var hl = L * 0.5; var rr = R * breathe;
  var flat0 = 1.0; // squash of the second cross-section axis (seal lies flat; fins and wings are thin)
  var bref = vec3f(0.0, 1.0, 0.0); var useRef = false; var wmark = 0.0;
  var flat1 = 1.0; var tap = 0.0; // width squash (first cross-section axis); taper from start (+) to end
  let biped = A.sp == 2u;
  // neck and head
  let shoulder = C + F * L * select(0.38, 0.1, biped) + U * R * 0.4;
  let lookUp = sstep(0.15, 0.5, A.alarm);
  let lk = normalize(mix(F, A.look, 0.6 * lookUp));
  var nd = normalize(F * 0.55 + U * mix(mix(0.85, -1.1, A.graze), 1.4, lookUp));
  if (biped) { nd = normalize(mix(F * 0.35 + U * mix(0.9, -1.3, A.graze), F + U * 0.08, A.fly)); }
  if (A.sp == 4u) { nd = normalize(F + U * (0.3 + 0.4 * sstep(0.6, 1.0, sin(t * 0.13 + f32(A.h & 63u))))); }
  let neckEnd = shoulder + nd * sa.w;
  let nod = A.walk * select(0.08, 0.2, A.sp == 1u) * sin(gph + 1.2);                // the head nods with each step
  let hdir = normalize(mix(nd, lk, 0.5) + U * (select(-0.5, -0.9, biped) + nod) + F * 0.3);
  if (sw) {
    // orca / whale: body, head, dorsal fin, flukes, two pectorals
    let st = FR.time.x;
    if (part == 0u) { hl = L * 0.5; rr = R; }
    else if (part == 1u) {
      let fh = select(select(0.9, 1.8, A.sc > 1.1), 0.35, A.sp == 8u) * select(1.0, 2.0, A.sp == 8u);
      ax = normalize(U - F * select(0.15, 0.6, A.sp == 8u)); c = C + U * (R * 0.85 + fh * 0.4) - F * L * select(0.02, 0.18, A.sp == 8u);
      hl = fh * 0.5; rr = select(0.38, 0.5, A.sp == 8u); bref = S; useRef = true; flat0 = 0.18;
    } else if (part == 2u) { c = C + F * L * 0.3; ax = F; hl = L * 0.22; rr = R * 0.8; }
    else if (part == 3u) {
      c = C - F * L * 0.53 + U * L * 0.01 * sin(st * 1.6); ax = S; hl = L * 0.17; rr = L * 0.05;
      bref = U; useRef = true; flat0 = 0.2;
    } else if (part == 4u || part == 5u) {
      let sg = select(-1.0, 1.0, part == 4u);
      let pl = select(0.1, 0.3, A.sp == 8u);
      ax = normalize(S * sg - U * 0.55 - F * 0.35); c = C + F * L * 0.18 - U * R * 0.55 + S * sg * R * 0.8 + ax * L * pl * 0.5;
      hl = L * pl * 0.5; rr = L * select(0.03, 0.035, A.sp == 8u); bref = F; useRef = true; flat0 = 0.25;
    } else { return o; }
  } else if (part == 0u) {
    if (biped) { hl = L * 0.5; rr = R; }
    if (A.sp == 4u) { flat0 = 0.7; ax = normalize(F + U * 0.05); }
  } else if (part == 1u) {
    c = 0.5 * (shoulder + neckEnd); ax = nd; hl = sa.w * 0.55; rr = R * select(0.42, 0.18, biped);
    if (A.sp == 0u) { rr = R * 0.55; }
    if (A.sp == 1u) { rr = R * 0.6; flat1 = 0.6; }                     // a horse's neck: deep and flat-sided
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
  } else if (part >= 13u) {
    // ears: sheep hold theirs out sideways, horses and foxes upright (the fox's big and pointed)
    if (!(A.sp == 0u || A.sp == 1u || A.sp == 3u || A.sp == 5u || A.sp == 6u)) { return o; }
    let sg = select(-1.0, 1.0, part == 13u);
    let hs = normalize(cross(hdir, U) + vec3f(1e-4, 0.0, 0.0));
    let hu2 = normalize(cross(hs, hdir));
    var ed = normalize(hu2 * 0.95 + hs * sg * 0.25 - hdir * 0.25);
    var el = 0.13 * A.sc; var er = 0.3;
    if (A.sp == 0u) { ed = normalize(hs * sg * 0.9 - hu2 * 0.15 - hdir * 0.1); el = 0.1 * A.sc; er = 0.38; }
    if (A.sp == 3u) { ed = normalize(hu2 + hs * sg * 0.4); el = 0.075 * A.sc; er = 0.42; }
    if (A.sp >= 5u) { ed = normalize(hu2 * 0.4 + hs * sg - hdir * 0.4); el = sb.x * 0.6; er = 0.25; }
    let base = neckEnd + hdir * sb.x * 0.2 + hu2 * sb.y * 0.75 + hs * sg * sb.y * 0.45;
    c = base + ed * el * 0.5; ax = ed; hl = el * 0.5; rr = el * er; bref = hdir; useRef = true; flat0 = 0.35;
  } else {
    // legs: parts 4..11 = 4 legs x (upper, lower)
    let li = (part - 4u) / 2u; let seg = (part - 4u) % 2u;
    if (biped && li >= 2u) {
      if (A.fly <= 0.0) { return o; }
      // wings (flight): inner and outer panels from the shoulder, flapping with a lag
      let sg = select(-1.0, 1.0, li == 2u);
      let ft = FR.time.x * 8.5 + f32(A.h & 15u);
      let a1 = A.fly * 0.85 * sin(ft); let a2 = a1 + A.fly * 0.5 * sin(ft - 0.8);
      let w1 = normalize(S * sg * cos(a1) + U * sin(a1)); let w2 = normalize(S * sg * cos(a2) + U * sin(a2));
      let sh = C + F * L * 0.15 + U * R * 0.3;
      let span = 0.42 * A.sc;
      let e = sh + w1 * span;
      if (seg == 0u) { c = sh + w1 * span * 0.5; ax = w1; } else { c = e + w2 * span * 0.5; ax = w2; }
      hl = span * 0.5; rr = select(0.17, 0.12, seg == 1u) * A.sc * A.fly; bref = U; useRef = true; flat0 = 0.12;
      wmark = 2.0 + f32(seg);
    } else {
    if (A.sp == 4u) { return o; }
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
    if (A.fly > 0.0) { fx = mix(fx, -LL * 0.95, A.fly); lift = mix(lift, LL * 0.9, A.fly); }
    let fxz = hip.xz + F.xz * fx;
    let fy = mix(hgnd(fxz) + 0.02 * LL, hip.y - LL, A.fly) + lift;
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
  }
  // ellipsoid vertex
  let q = pv / 6u; let co = HCO[pv % 6u];
  let sgi = q % HP_SEG + co.x; let rg = q / HP_SEG + co.y;
  let thv = f32(rg) / f32(HP_RING) * 3.1416;
  let ph = f32(sgi) / f32(HP_SEG) * 6.2832;
  let rf = select(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(ax.y) > 0.9), bref, useRef);
  let b1 = normalize(cross(ax, rf));
  let b2 = cross(ax, b1);
  // shape: land bodies are deeper than wide; necks, legs, tails and muzzles taper toward their ends
  if (!sw && A.sp != 4u) {
    if (part == 0u) { flat1 = select(0.8, 0.9, biped); }
    else if (part == 1u) { tap = 0.22; flat1 = min(flat1, 0.75); }
    else if (part == 2u) { tap = 0.28; flat1 = 0.8; }
    else if (part == 3u) { tap = 0.45; }
    else if (part >= 4u && part <= 11u && wmark == 0.0) { tap = 0.12; hl += rr * 0.6; }   // segments overlap at the knee
  }
  // superellipsoid along the axis: limbs, necks and tails are cylinders with rounded ends (not strings of beads),
  // bodies full barrels (not balloons); heads, ears, fins and wings stay rounder
  var se = 1.0;
  if (!sw && wmark == 0.0) {
    if (part == 0u) { se = 0.55; }
    else if (part == 1u || part == 3u || (part >= 4u && part <= 11u)) { se = 0.3; }
    else if (part == 2u) { se = 0.75; }
  }
  let sth = pow(max(sin(thv), 0.0), se);
  let ring = (b1 * cos(ph) * flat1 + b2 * sin(ph) * flat0) * sth;
  var rk = rr * (1.0 + tap * cos(thv));
  if (part == 0u) { rk *= 1.0 + 0.06 * cos(thv); }
  let wp = c + ax * (-cos(thv)) * hl + ring * rk;
  let nring = (b1 * cos(ph) / flat1 + b2 * sin(ph) / max(flat0, 0.05)) * sth; // ellipse normal
  o.n = normalize(ax * (-cos(thv)) * pow(abs(cos(thv)), 1.0 / se - 1.0) * select(1.0, 0.0, abs(cos(thv)) < 1e-4) / max(hl, 1e-3) * se + nring / max(rk, 1e-3));
  o.ax = ax;
  o.wp = wp;
  o.loc = vec2f(-cos(thv), ph);
  o.part = part; o.sp = A.sp;
  o.tint = vec4f(A.coat, lfRand(A.h, 6u), select(A.alarm, wmark, wmark > 0.0), f32(A.h & 1023u));
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
      // face, ears and lower legs are short hair, not wool: black-faced or white-faced
      let face = select(vec3f(0.5, 0.46, 0.4), vec3f(0.045, 0.038, 0.034), v2 > 0.5 || v > 0.9);
      let bare = part == 2u || part == 12u || part == 13u || part == 14u || (part == 1u && loc.x > 0.35) ||
        (part >= 4u && part <= 11u && loc.x > -0.45);
      if (bare) { return face * (0.9 + 0.2 * vn(wp.xz * 20.0 + wp.y * 9.0, 962u)); }
      return w * (0.85 + 0.25 * vn(wp.xz * 9.0 + wp.y * 7.0, 961u));
    }
    case 1u: {
      // bay (black points), chestnut, dark brown; one grey in some herds. Mane and tail dark, muzzle paler, hooves
      let dark = vec3f(0.025, 0.02, 0.017);
      var w = vec3f(0.14, 0.068, 0.032);                                 // bay
      var pts = dark;
      if (v >= 0.45 && v < 0.75) { w = vec3f(0.2, 0.085, 0.035); pts = vec3f(0.13, 0.055, 0.025); }   // chestnut
      if (v >= 0.75 && v < 1.0) { w = vec3f(0.055, 0.036, 0.024); }      // dark brown
      if (v >= 1.0) {                                                    // grey, dappled
        w = vec3f(0.3, 0.3, 0.29) * (0.8 + 0.35 * sstep(0.45, 0.6, vn(wp.xz * 7.0 + wp.y * 5.0, 966u)));
        pts = vec3f(0.12, 0.12, 0.12);
      }
      w *= 0.9 + 0.2 * v2;
      if (part == 15u || part == 3u) { return pts * 0.9 + 0.01; }        // mane and tail
      // lighter belly and lower flank (mealy), a darker dorsal line, a subtle dapple
      if (part <= 2u) {
        let sn = sin(loc.y);
        w = mix(w, w * 1.45 + vec3f(0.03, 0.025, 0.015), sstep(-0.05, -0.75, sn) * select(0.7, 0.35, part == 2u));
        w *= 1.0 - 0.3 * sstep(0.88, 0.99, sn) * select(1.0, 0.0, part == 2u);
        w *= 0.92 + 0.16 * sstep(0.35, 0.65, vn(wp.xz * 6.0 + wp.y * 4.0, 967u));
      }
      if (part == 2u) { w = mix(w, pts, 0.25 * sstep(0.2, 1.0, loc.x)); }  // the face darkens toward the nose
      if (part == 12u) { w = mix(w, vec3f(0.16, 0.12, 0.09), 0.55); }    // muzzle (pale, mealy)
      if (part >= 4u && part <= 11u) {
        w = mix(w, pts, sstep(-0.35, 0.3, loc.x));                       // points below the knee
        if (loc.x > 0.78) { w = vec3f(0.05, 0.045, 0.04); }              // hoof
      }
      return w;
    }
    case 2u: {
      if (tint.z >= 2.0) {
        // wings: deep pink coverts, black flight feathers on the outer half
        let outer = tint.z >= 3.0 && loc.x > -0.3;
        return select(vec3f(0.85, 0.22, 0.3), vec3f(0.02, 0.018, 0.02), outer);
      }
      if (part >= 4u && part <= 11u) { return vec3f(0.62, 0.3, 0.3); }
      if (part == 12u) { return mix(vec3f(0.82, 0.62, 0.55), vec3f(0.02), sstep(0.0, 0.6, loc.x)); }
      return mix(vec3f(0.85, 0.42, 0.42), vec3f(0.9, 0.55, 0.5), v);
    }
    case 3u: { return mix(vec3f(0.78, 0.8, 0.82), vec3f(0.62, 0.6, 0.56), v * 0.5); }
    case 4u: {
      // harbour seal: grey-brown with small dark spots (not bands), paler belly
      let base = mix(vec3f(0.2, 0.19, 0.17), vec3f(0.28, 0.27, 0.24), vn(wp.xz * 1.5 + wp.y, 962u));
      let spots = sstep(0.62, 0.7, vn(wp.xz * 13.0 + wp.y * 11.0, 965u));
      return base * (1.0 - 0.5 * spots) * mix(1.0, 1.4, sstep(-0.2, -0.6, loc.y));
    }
    case 7u: {
      // orca: black back, white belly running forward, white eye patch, grey saddle behind the fin
      let belly = sin(loc.y);
      var w = vec3f(0.018, 0.018, 0.02);
      if (part == 0u && belly > 0.45 - 0.35 * sstep(-0.2, 0.6, loc.x) && loc.x > -0.55) { w = vec3f(0.78, 0.78, 0.76); }
      if (part == 2u && belly > 0.5) { w = vec3f(0.78, 0.78, 0.76); }
      if (part == 2u && abs(cos(loc.y)) > 0.75 && belly < 0.05 && belly > -0.55 && loc.x > -0.2 && loc.x < 0.55) { w = vec3f(0.8, 0.8, 0.78); }
      if (part == 0u && loc.x > -0.2 && loc.x < 0.05 && belly < -0.85) { w = vec3f(0.07, 0.07, 0.075); }
      return w;
    }
    case 8u: {
      // humpback: slate back, mottled pale belly, white pectorals and fluke undersides
      let m = vn(wp.xz * 0.9 + wp.y * 0.7, 964u);
      var w = vec3f(0.045, 0.05, 0.055) * (0.8 + 0.4 * m);
      if ((part == 0u || part == 2u) && sin(loc.y) > 0.55) { w = mix(w, vec3f(0.55, 0.55, 0.53), sstep(0.3, 0.7, m + 0.2)); }
      if (part == 4u || part == 5u) { w = mix(vec3f(0.7, 0.7, 0.68), w, sstep(0.3, 0.8, -cos(loc.y)) * 0.6); }
      if (part == 3u && sin(loc.y) > 0.2) { w = vec3f(0.62, 0.62, 0.6); }
      return w;
    }
    default: { return vec3f(0.06, 0.05, 0.08); }
  }
}

struct HOut { @location(0) c: vec4f, @location(1) d: vec4f }

// coat lighting: fur and feathers are not balloons. Per species: clumped normals (wool curls, fox ruff, feather
// rows), a soft wrapped terminator, a Kajiya-Kay sheen along the hair direction (the part axis), a fuzzy rim that
// catches the sky and a low sun from behind, and occlusion under the belly and between the legs.
fn herdShade(in: HV) -> vec3f {
  let cam = VW.cam.xyz;
  let toC = cam - in.wp; let dist = length(toC); let V = toC / dist;
  var n = normalize(in.n);
  let L = FR.sun.xyz; let sc = sunCol();
  let alb = coat(in.sp, in.part, in.tint, in.loc, in.wp);
  let isLeg = in.part >= 4u && in.part <= 11u && in.tint.z < 2.0;
  // per species: wrap, sheen exponent and strength, fuzz, clump bump strength and scale
  var wrapK = 0.2; var shp = 30.0; var shs = 0.05; var fuzz = 0.1; var bmp = 0.0; var bsc = 6.0;
  switch in.sp {
    case 0u: { wrapK = 0.55; shp = 6.0; shs = 0.035; fuzz = 0.4; bmp = 0.45; bsc = 14.0; }   // wool
    case 1u: { wrapK = 0.22; shp = 18.0; shs = 0.14; fuzz = 0.06; bmp = 0.05; bsc = 3.0; }   // short coat: broad soft sheen
    case 2u: { wrapK = 0.3; shp = 24.0; shs = 0.07; fuzz = 0.15; bmp = 0.15; bsc = 9.0; }    // feathers
    case 3u: { wrapK = 0.5; shp = 14.0; shs = 0.07; fuzz = 0.35; bmp = 0.3; bsc = 8.0; }     // thick winter fur
    case 4u: { wrapK = 0.15; shp = 60.0; shs = 0.25; fuzz = 0.04; }                          // wet seal
    default: {}
  }
  let T0 = normalize(in.ax - n * dot(in.ax, n) + vec3f(1e-4, 0.0, 0.0));
  if (bmp > 0.0 && dist < 120.0) {
    // clumps: noise across and along the hair, faded with distance (no shimmer far off)
    let q = vec2f(in.loc.y * bsc * 0.5, in.loc.x * bsc) + in.tint.w;
    let e = 0.05;
    let n0 = vn(q, 971u); let nx = vn(q + vec2f(e, 0.0), 971u); let ny = vn(q + vec2f(0.0, e), 971u);
    let B = normalize(cross(n, T0));
    let k = bmp * (1.0 - sstep(40.0, 120.0, dist));
    n = normalize(n - (B * (nx - n0) + T0 * (ny - n0)) / e * k * 0.15);
  }
  let ndl = dot(n, L);
  var sh = lfShadow(in.wp + n * 0.15, dist, 0.5, 8);              // terrain and cloud shadow: animals stand in the shade too
  if (isLeg) { sh *= mix(1.0, 0.45, sstep(0.25, 0.8, L.y)); }       // the body shades its own legs under a high sun
  // occlusion: belly and the insides of the legs, darker toward the hips
  var ao = 1.0;
  if (in.part == 0u) { ao = mix(0.5, 1.0, sstep(-0.9, 0.25, n.y)); }
  if (isLeg) { ao = select(0.85, mix(0.45, 0.95, sstep(-1.0, 0.0, in.loc.x)), ((in.part - 4u) & 1u) == 0u); }
  var col = alb * (sc * sh * max((ndl + wrapK) / (1.0 + wrapK), 0.0) + lfAmb(n.y, alb) * ao);
  // sheen along the hair (Kajiya-Kay), tinted by the coat
  let H = normalize(L + V);
  let th = dot(T0, H);
  let kk = pow(sqrt(max(1.0 - th * th, 0.0)), shp);
  col += sc * sh * kk * shs * 0.25 * (alb * 2.0 + 0.04) * max(ndl, 0.0); // tinted by the coat, only on the lit side
  if (in.sp == 1u && in.part != 15u && in.part != 3u) {
    col += sc * sh * pow(max(dot(n, H), 0.0), 10.0) * 0.045 * max(ndl, 0.0);   // a broad soft lobe off the short coat
  }
  // fuzzy rim: the sky in the hair at grazing angles, and the low sun shining through it from behind
  let rim = pow(1.0 - abs(dot(n, V)), 3.0);
  let back = pow(max(dot(-V, L), 0.0), 3.0);
  col += rim * fuzz * (lfAmb(max(n.y, 0.2), alb + 0.15) * ao + sc * sh * back * (alb + 0.1) * 2.0);
  if (in.sp >= 7u) {
    // wet skin: tight highlight and sky reflection at grazing angles; darker below the waterline
    col += sc * sh * pow(max(dot(n, H), 0.0), 120.0) * 0.9;
    let fr = 0.04 + 0.5 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    col += lfAmb(max(n.y, 0.0), vec3f(1.0)) * fr * 0.6 * sstep(-0.3, 0.1, in.wp.y);
    col *= mix(0.35, 1.0, sstep(-1.2, 0.1, in.wp.y));
  }
  if (in.sp == 5u || in.sp == 6u) {
    // light-eaters: dark translucent hide; the light they graze glows inside in slow soft patches
    let gc = glowCol(in.wp.xz, in.tint.x);
    let pat = sstep(0.2, 0.7, vn(vec2f(in.loc.y * 1.3, in.loc.x * 3.0 + FR.time.x * 0.15) + in.tint.w, 963u));
    let fres = pow(1.0 - abs(dot(n, V)), 2.0);
    col += gc * (0.04 + 0.5 * pat * select(0.2, 1.0, in.part == 0u) + 0.25 * fres);
  }
  return col;
}

@fragment fn fsHerd(in: HV) -> HOut {
  var o: HOut;
  o.c = vec4f(herdShade(in), 1.0);
  o.d = vec4f(length(VW.cam.xyz - in.wp), 0.0, 0.0, 1.0);
  return o;
}

// ---- murmuration (encounter type 2): starlings at dusk, a single folding cloud around the drone ----
// HG[193] = rel, duration, intensity, active; HG[194] = encounter centre (x, y, z). Each bird is two wing triangles.
// The flock is a closed-form deforming body: a stretched cloud that twists and sends density waves through itself,
// orbiting the drone and, at its peak, wrapping round it with a hollow the drone sits in.
const MURM_N = 16000u;
fn murmP(i: u32, t: f32, D: vec3f, M: vec4f) -> vec3f {
  let h = hu(i32(i), 7, 0x3A7u);
  // a folded sheet: birds on a disc a few metres thick, bent by travelling folds, twisted and squeezed by a
  // density wave, so the cloud shows dark ridges where the sheet is seen edge-on and thins where it faces the eye
  let a = lfRand(h, 1u) * 6.2832; let r = sqrt(lfRand(h, 2u));
  let e = 1.0 - 0.18 * sin(a * 3.0 + t * 0.4);                       // ragged, breathing rim
  var q = vec3f(cos(a) * r * 55.0 * e, (lfRand(h, 3u) - 0.5) * 6.0, sin(a) * r * 24.0 * e);
  q.y += 15.0 * sin(q.x * 0.05 + t * 0.55) * cos(q.z * 0.07 - t * 0.31) + 6.0 * sin(q.z * 0.1 + t * 0.8);
  q.x += 8.0 * sin(q.x * 0.07 - t * 0.9);                          // density wave along the flock
  let tw = 0.8 * sin(t * 0.19 + q.x * 0.02) + 0.4 * sin(t * 0.11);  // twist
  let c = cos(tw); let s = sin(tw);
  q = vec3f(q.x, q.y * c - q.z * s, q.y * s + q.z * c);
  let ya = t * 0.07 + 0.8 * sin(t * 0.05);
  q = vec3f(q.x * cos(ya) - q.z * sin(ya), q.y, q.x * sin(ya) + q.z * cos(ya));
  // the flock arrives from the encounter point, then circles the drone; at the peak it folds round it
  let build = sstep(0.0, 30.0, M.x) * (1.0 - sstep(M.y - 15.0, M.y, M.x));
  let H = HG[194].xyz;
  let a0 = atan2(H.z - D.z, H.x - D.x);
  let oa = a0 + 0.05 * (M.x - 38.0) * build;
  let sweep = sstep(42.0, 50.0, M.x) * (1.0 - sstep(54.0, 62.0, M.x));      // it sweeps over the drone and parts round it
  let orb = mix(length(H.xz - D.xz) + 120.0, 95.0 - 85.0 * sweep, build);
  let cen = D + vec3f(cos(oa) * orb, mix(60.0, 22.0 + 10.0 * sin(t * 0.2), build), sin(oa) * orb);
  var p = cen + q;
  // hollow around the drone: birds keep outside a bubble and crowd onto its wall
  let dv = p - D; let dl = length(dv) + 1e-3;
  p = D + dv / dl * sqrt(dl * dl + 300.0 * build);
  return p;
}
struct MV { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) sh: f32 }
@vertex fn vsHerd(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> HV { return herdVert(vi, ii); }


@vertex fn vsMurm(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MV {
  var o: MV; o.pos = LF_DEAD;
  let M = HG[193];
  if (M.w < 0.5) { return o; }
  let n = u32(f32(MURM_N) * clamp(M.z, 0.0, 1.0));
  if (ii >= n) { return o; }
  let D = VW.cam.xyz - vec3f(0.0, 1.5, 0.0); let t = FR.time.x; // the viewer (the drone camera)
  let p = murmP(ii, t, D, M);
  let v = (p - murmP(ii, t - 0.1, D, M)) * 10.0;
  let f = normalize(v + vec3f(1e-3, 0.0, 0.0));
  let sd = normalize(cross(f, vec3f(0.0, 1.0, 0.0)));
  let up = cross(sd, f);
  let d = length(p - VW.cam.xyz);
  let pix = d * 2.0 * VW.fwd.w * VW.size.w;
  let sz = max(0.2, pix * 0.9);              // starling: 0.4 m span; never thinner than about a pixel
  let fl = sin(t * 15.0 + f32(ii) * 0.37);
  let tri = vi / 3u; let cv = vi % 3u;
  let sg = select(-1.0, 1.0, tri == 0u);
  let tip = sd * sg * cos(fl * 0.6) + up * sin(fl * 0.6);
  var wp = p;
  if (cv == 0u) { wp = p + f * sz * 0.6; } else if (cv == 1u) { wp = p - f * sz * 0.5; } else { wp = p + tip * sz; }
  o.wp = wp;
  o.sh = 0.6 + 0.4 * fl;
  o.pos = VW.vp * vec4f(wp - VW.cam.xyz, 1.0);
  return o;
}
@fragment fn fsMurm(in: MV) -> HOut {
  let toC = VW.cam.xyz - in.wp; let dist = length(toC);
  let sc = sunCol();
  let col = vec3f(0.018, 0.017, 0.02) * (lfAmb(0.5, vec3f(1.0)) + sc * 0.15 * in.sh);
  var o: HOut;
  o.c = vec4f(col, 1.0);
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
