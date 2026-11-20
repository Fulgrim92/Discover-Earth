// herdskin.wgsl: quadrupeds (sheep, wild horses, arctic foxes) as one continuous skinned mesh instead of assembled
// primitives. fx/herd.js generates the shape at startup (skinTables): per species a ring table along the spine
// (tail root -> croup -> barrel -> chest -> neck -> poll -> muzzle: position s, half width, half height, centre offset),
// a ring table along the legs (hip -> knee/hock -> fetlock -> hoof) and the rig (spine control points, hips, neck,
// head, tail and ear sizes). Here the rig is posed per animal (terrain frame, gait, grazing, alarm), the spine is a
// Catmull-Rom curve through the posed control points, every ring is swept along it, legs are two-bone chains
// driven by the gait phase with a fetlock and hoof below, the tail and the horse's mane hang as swept hair masses.
//
// Vertex layout per animal (constants from herd.js): spine tube, 4 legs, tail, mane, 2 ears; the rest is culled.

fn skIdx(sp: u32) -> u32 { return select(select(2u, 1u, sp == 1u), 0u, sp == 0u); }
fn isSkinned(sp: u32) -> bool { return sp == 0u || sp == 1u || sp == 3u; }

// tube vertex: ring (0..nr-1) and side (0..ns) of local vertex lv
fn skTube(lv: u32, ns: u32) -> vec2u {
  let q = lv / 6u; let co = HCO[lv % 6u];
  return vec2u(q / ns + co.y, q % ns + co.x);
}

fn crom(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f, t: f32) -> vec3f {
  let t2 = t * t; let t3 = t2 * t;
  return 0.5 * ((2.0 * p1) + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t3);
}
// spine curve through Q[1..7] (s = 0..6); Q[0] and Q[8] extend the ends
fn skCurve(Q: array<vec3f, 9>, s: f32) -> vec3f {
  let i = u32(clamp(floor(s), 0.0, 5.0)); let t = s - f32(i);
  return crom(Q[i], Q[i + 1u], Q[i + 2u], Q[i + 3u], t);
}

struct SkRing { c: vec3f, b1: vec3f, b2: vec3f, w: f32, h: f32 }
fn skRing(Q: array<vec3f, 9>, k: u32, i: u32, sc: f32, S: vec3f) -> SkRing {
  var r: SkRing;
  let R = SKR[k * SK_NR + min(i, SK_NR - 1u)];
  let c = skCurve(Q, R.x);
  let T = normalize(skCurve(Q, min(R.x + 0.03, 6.0)) - skCurve(Q, max(R.x - 0.03, 0.0)) + vec3f(0.0, 1e-5, 0.0));
  r.b1 = normalize(S - T * dot(S, T) + vec3f(0.0, 1e-5, 0.0));
  r.b2 = cross(r.b1, T);
  r.c = c + r.b2 * R.w * sc;
  r.w = R.y * sc; r.h = R.z * sc;
  return r;
}
// superellipse-ish cross-section: the barrel a little boxy, the neck and head plain ellipses
fn skPt(r: SkRing, th: f32, e: f32) -> vec3f {
  let cs = cos(th); let sn = sin(th);
  return r.c + r.b1 * sign(cs) * pow(abs(cs), e) * r.w + r.b2 * sign(sn) * pow(abs(sn), e) * r.h;
}

fn skinVert(vi: u32, A: Ani) -> HV {
  var o: HV; o.pos = LF_DEAD;
  let k = skIdx(A.sp); let sc = A.sc;
  let P0 = SKQ[k * 6u]; let P1 = SKQ[k * 6u + 1u]; let P2 = SKQ[k * 6u + 2u];
  let HH = SKQ[k * 6u + 3u]; let HF = SKQ[k * 6u + 4u]; let P5 = SKQ[k * 6u + 5u];
  let F = A.f; let U = A.u; let S = A.s; let t = FR.time.x;
  let LL = HF.y * sc;                                       // leg length (front hip height)
  let gph = A.gait / max(LL * 1.6, 0.1) * 6.2832;
  let bob = 0.035 * LL * A.walk * abs(sin(gph));
  let base = A.p + U * bob + S * (0.02 * LL * A.walk * sin(gph * 0.5));   // weight shifts with the gait
  // neck and head pose: grazing lowers the neck to the ground, alarm raises it and turns the head to the drone
  let lookUp = sstep(0.15, 0.5, A.alarm);
  let lk = normalize(mix(F, A.look, 0.6 * lookUp));
  let nodA = A.walk * select(0.06, 0.16, A.sp == 1u) * sin(gph + 1.2);       // the head nods with each step
  let nd = normalize(F * 0.62 + U * (mix(mix(0.75, -1.05, A.graze), 1.3, lookUp) + nodA * 0.5));
  let hdir = normalize(mix(nd, lk, 0.45) + U * (-0.85 + nodA) + F * 0.25);
  var Q: array<vec3f, 9>;
  Q[1] = base + (F * P0.x + U * P0.y) * sc;                  // tail root
  Q[2] = base + (F * P0.z + U * P0.w) * sc;                  // croup / hip
  Q[3] = base + (F * P1.x + U * P1.y) * sc;                  // girth (chest)
  Q[4] = base + (F * P1.z + U * P1.w) * sc;                  // neck base (withers front)
  Q[5] = Q[4] + nd * P2.x * sc * 0.5 + U * P2.x * sc * 0.06; // neck mid (a slight crest)
  Q[6] = Q[4] + nd * P2.x * sc;                              // poll
  Q[7] = Q[6] + hdir * P2.y * sc;                            // muzzle
  Q[0] = 2.0 * Q[1] - Q[2]; Q[8] = 2.0 * Q[7] - Q[6];

  let vSp = (SK_NR - 1u) * SK_NS * 6u;
  let vLeg = (SK_NL - 1u) * SK_LS * 6u;
  let vTail = (SK_NT - 1u) * SK_TS * 6u;
  let vMane = (SK_NM - 1u) * 4u * 6u;
  let vEar = 2u * SK_ES * 6u;
  var wp: vec3f; var n: vec3f; var ax = F; var part = 0u; var loc = vec2f(0.0);
  if (vi < vSp) {
    // ---- spine tube: torso, neck and head in one surface
    let rs = skTube(vi, SK_NS);
    let th = f32(rs.y) / f32(SK_NS) * 6.2832;
    let ri = rs.x;
    let r0 = skRing(Q, k, ri, sc, S);
    let rp = skRing(Q, k, select(ri - 1u, 0u, ri == 0u), sc, S);
    let rn = skRing(Q, k, min(ri + 1u, SK_NR - 1u), sc, S);
    let sv = SKR[k * SK_NR + ri].x;
    let e = select(0.85, 1.0, sv > 3.0);
    wp = skPt(r0, th, e);
    let dth = skPt(r0, th + 0.05, e) - skPt(r0, th - 0.05, e);
    let ds = skPt(rn, th, e) - skPt(rp, th, e);
    n = cross(dth, ds);
    if (dot(n, wp - r0.c) < 0.0) { n = -n; }
    if (length(n) < 1e-7) { n = select(-1.0, 1.0, sv > 3.0) * normalize(rn.c - rp.c + vec3f(0.0, 1e-5, 0.0)); }
    ax = normalize(rn.c - rp.c + vec3f(0.0, 1e-5, 0.0));
    part = select(select(2u, 1u, sv < 5.0), 0u, sv < 3.0);
    if (sv > 5.75) { part = 12u; }
    loc = vec2f(select(select((sv - 5.0) * 2.0 - 1.0, sv - 4.0, sv < 5.0), sv / 1.5 - 1.0, sv < 3.0), th);
  } else if (vi < vSp + 4u * vLeg) {
    // ---- legs: two-bone chains from the posed hips; stance 60 % with the hoof planted, swing 40 %
    let lv = vi - vSp; let li = lv / vLeg; let rs = skTube(lv % vLeg, SK_LS);
    let front = li < 2u; let left = (li & 1u) == 0u;
    let Hd = select(HH, HF, front);
    let hipY = Hd.y * sc;
    let hip = base + (F * Hd.x + U * hipY + S * select(-Hd.z, Hd.z, left) * 1.0 * sc);
    let stride = hipY * 0.75;
    let cyc = stride / 0.6;
    let off = select(select(0.25, 0.75, left), select(0.5, 0.0, left), front);
    let phs = fract(A.gait / cyc + off);
    var fx = 0.0; var lift = 0.0;
    if (phs < 0.6) { fx = stride * (0.5 - phs / 0.6); }
    else { let q = (phs - 0.6) / 0.4; fx = stride * (-0.5 + q); lift = sin(3.1416 * q) * 0.2 * hipY; }
    fx *= A.walk; lift *= A.walk;
    let fxz = (hip - U * hipY).xz + F.xz * fx;
    let gy = hgnd(fxz);
    let fetH = hipY * 0.13;
    var hoof = vec3f(fxz.x, gy + lift, fxz.y);
    // fetlock above the hoof; in the swing the lower leg folds back (the hoof trails)
    var fet = hoof + U * fetH - F * fetH * 0.15 * (1.0 + 2.0 * sstep(0.0, 0.15 * hipY, lift));
    let bl = (hipY - fetH) * 0.52;
    let dl = length(fet - hip);
    if (dl > bl * 2.0) { fet = hip + (fet - hip) * (bl * 2.0 / dl); hoof = fet - U * fetH; }
    let kn = knee(hip, fet, bl, select(-F, F, front));
    let ri = rs.x; let th = f32(rs.y) / f32(SK_LS) * 6.2832;
    let LR = SKL[k * SK_NL + ri];
    let u = LR.x;
    var a0 = hip; var a1 = kn; var tu = u;
    if (u >= 2.0) { a0 = fet; a1 = hoof; tu = u - 2.0; } else if (u >= 1.0) { a0 = kn; a1 = fet; tu = u - 1.0; }
    let c = mix(a0, a1, clamp(tu, 0.0, 1.05));
    let T = normalize(a1 - a0 + vec3f(0.0, 1e-5, 0.0));
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    let rx = LR.y * sc; let rz = LR.z * sc;
    wp = c + b1 * cos(th) * rx + b2 * sin(th) * rz;
    n = normalize(b1 * cos(th) / max(rx, 1e-4) + b2 * sin(th) / max(rz, 1e-4));
    if (u > 2.97) { n = normalize(-T + n * 0.3); }
    ax = T;
    part = 4u + li * 2u + select(0u, 1u, u >= 1.0);
    loc = vec2f(u / 1.5 - 1.0, th);
  } else if (vi < vSp + 4u * vLeg + vTail) {
    // ---- tail: a swept hair mass from the tail root, swinging with the gait and the wind
    let lv = vi - vSp - 4u * vLeg; let rs = skTube(lv, SK_TS);
    let u = f32(rs.x) / f32(SK_NT - 1u); let th = f32(rs.y) / f32(SK_TS) * 6.2832;
    let tl = P2.z * sc;
    let sway = S * tl * (0.06 * sin(t * 1.7 + f32(A.h & 31u)) + 0.08 * A.walk * sin(gph * 0.5));
    let root = Q[1] - F * P5.x * sc * 0.3;
    var p1 = root - F * tl * 0.3 - U * tl * 0.05; var p2 = root - F * tl * 0.38 - U * tl * 0.92;  // horse: hangs
    if (A.sp == 3u) { p1 = root - F * tl * 0.55 + U * tl * 0.02; p2 = root - F * tl * 0.92 - U * tl * 0.3; }  // fox brush
    if (A.sp == 0u) { p1 = root - F * tl * 0.3; p2 = root - F * tl * 0.35 - U * tl * 0.8; }
    p2 += sway * u;
    let c = mix(mix(root, p1, u), mix(p1, p2, u), u);
    let T = normalize(mix(p1 - root, p2 - p1, u) + vec3f(0.0, 1e-5, 0.0));
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    // radius: thin at the dock, full in the hair mass, a soft point at the end
    var rw = P5.x * sc * mix(0.55, 1.0, sstep(0.0, 0.3, u)) * (1.0 - sstep(0.7, 1.0, u) * 0.75);
    if (A.sp == 3u) { rw = P5.x * sc * (0.6 + 0.6 * sin(3.1416 * min(u * 1.1, 1.0))); }
    if (rs.x == SK_NT - 1u) { rw = 0.0; }
    let rd = rw * P5.y;
    wp = c + b1 * cos(th) * rw + b2 * sin(th) * rd;
    n = normalize(b1 * cos(th) / max(rw, 1e-4) + b2 * sin(th) / max(rd, 1e-4));
    ax = T; part = 3u; loc = vec2f(u * 2.0 - 1.0, th);
  } else if (vi < vSp + 4u * vLeg + vTail + vMane) {
    // ---- mane (horses): a hair crest along the top of the neck, falling a little to one side
    if (A.sp != 1u) { return o; }
    let lv = vi - vSp - 4u * vLeg - vTail; let rs = skTube(lv, 4u);
    let u = f32(rs.x) / f32(SK_NM - 1u); let th = f32(rs.y) / 4.0 * 6.2832 + 0.7854;
    let s = mix(3.05, 5.05, u);
    let c0 = skCurve(Q, s);
    let T = normalize(skCurve(Q, s + 0.03) - skCurve(Q, s - 0.03) + vec3f(0.0, 1e-5, 0.0));
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    // neck height at s from the ring table (nearest ring)
    var nh = 0.0;
    for (var i = 0u; i < SK_NR; i++) { let R = SKR[k * SK_NR + i]; if (R.x <= s) { nh = R.z + R.w; } }
    let mh = 0.07 * sc * (1.0 - 0.6 * u) * (1.0 - sstep(0.85, 1.0, u)) + 0.005;
    let side = select(-1.0, 1.0, (A.h & 2u) == 0u);
    let c = c0 + b2 * (nh * sc * 0.95 + mh * 0.6) + b1 * side * mh * 0.35;
    let ww = 0.022 * sc;
    wp = c + b1 * cos(th) * ww + (b2 * 0.9 + b1 * side * 0.3) * sin(th) * mh;
    n = normalize(b1 * cos(th) / ww + b2 * sin(th) / mh);
    ax = b2; part = 15u; loc = vec2f(u * 2.0 - 1.0, th);
  } else if (vi < vSp + 4u * vLeg + vTail + vMane + 2u * vEar) {
    // ---- ears: cupped cones at the poll (sheep hold theirs out sideways)
    let lv = vi - vSp - 4u * vLeg - vTail - vMane; let ei = lv / vEar; let rs = skTube(lv % vEar, SK_ES);
    let sg = select(-1.0, 1.0, ei == 0u);
    let s = 5.03;
    let c0 = skCurve(Q, s);
    let T = normalize(skCurve(Q, s + 0.03) - skCurve(Q, s - 0.03) + vec3f(0.0, 1e-5, 0.0));
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    var ed = normalize(b2 * 0.9 + b1 * sg * 0.3 - T * 0.25);
    if (A.sp == 0u) { ed = normalize(b1 * sg - b2 * 0.1 - T * 0.15); }
    if (A.sp == 3u) { ed = normalize(b2 + b1 * sg * 0.35 + T * 0.05); }
    let el = P2.w * sc;
    let eb = c0 + b2 * P5.z * sc * 0.8 + b1 * sg * P5.z * sc * 0.55;
    let u = f32(rs.x) * 0.5; let th = f32(rs.y) / f32(SK_ES) * 6.2832;
    let er = el * select(0.32, 0.4, A.sp == 0u) * sin(3.1416 * min(u * 0.9 + 0.12, 1.0)) * select(1.0, 0.0, rs.x == 2u);
    let e1 = normalize(cross(ed, T) + vec3f(1e-5, 0.0, 0.0)); let e2 = cross(ed, e1);
    wp = eb + ed * el * u + e1 * cos(th) * er + e2 * sin(th) * er * 0.45;
    n = normalize(e1 * cos(th) + e2 * sin(th) * 2.0);
    ax = ed; part = 13u + ei; loc = vec2f(u * 2.0 - 1.0, th);
  } else { return o; }
  o.n = n; o.ax = ax; o.wp = wp; o.loc = loc; o.part = part; o.sp = A.sp;
  o.tint = vec4f(A.coat, lfRand(A.h, 6u), A.alarm, f32(A.h & 1023u));
  o.pos = VW.vp * vec4f(wp - VW.cam.xyz, 1.0);
  return o;
}
