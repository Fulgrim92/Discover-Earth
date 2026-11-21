// herdskin.wgsl: quadrupeds (sheep, wild horses, arctic foxes) as one continuous skinned mesh instead of assembled
// primitives. fx/herd.js generates the shape at startup (skinTables): per species a ring table along the spine
// (tail root -> croup -> barrel -> chest -> neck -> poll -> muzzle) whose sections are not circles (half width, top
// and bottom radii, an egg factor that widens the lower half, a ridge on top for the spine, withers and crest, a side
// bump for the eyes, a squareness exponent), fore and hind leg ring tables (forearm or gaskin, knee or hock, cannon,
// fetlock, pastern, hoof) and the rig. Here the rig is posed per animal (terrain frame, gait, grazing, alarm), the
// spine is a Catmull-Rom curve through the posed control points, every ring is swept along it, legs are two-bone
// chains with unequal bones (the hind ones bent at a hock set behind) planted on the terrain under each hoof, the
// tail hangs from a high dock as a tapered hair mass and the horse's mane lies to one side with a forelock.
//
// Vertex layout per animal (constants from herd.js): spine tube, 4 legs, tail, mane, 2 ears, forelock; the rest is
// culled. SKQ holds 9 vec4 per species: spine points (2), lengths, fore leg (2), hind leg (2), tail, extra.

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
fn skTan(Q: array<vec3f, 9>, s: f32) -> vec3f {
  return normalize(skCurve(Q, min(s + 0.03, 6.0)) - skCurve(Q, max(s - 0.03, 0.0)) + vec3f(0.0, 1e-5, 0.0));
}

struct SkRing { c: vec3f, b1: vec3f, b2: vec3f, w: f32, top: f32, bot: f32, egg: f32, ridge: f32, bump: f32, e: f32, s: f32, lump: f32 }
fn skRing(Q: array<vec3f, 9>, k: u32, i: u32, sc: f32, S: vec3f) -> SkRing {
  var r: SkRing;
  let j = k * SK_NR + min(i, SK_NR - 1u);
  let R = SKR[j]; let D = SKD[j];
  let T = skTan(Q, R.x);
  r.b1 = normalize(S - T * dot(S, T) + vec3f(0.0, 1e-5, 0.0));
  r.b2 = cross(r.b1, T);
  r.c = skCurve(Q, R.x);
  r.w = R.y * sc; r.top = R.z * sc; r.bot = R.w * sc;
  r.egg = D.x; r.ridge = D.y * sc; r.bump = D.z * sc; r.e = D.w; r.s = R.x;
  // fleece: lumps over the body and the base of the neck (sheep), none where the ring closes
  r.lump = SKQ[k * 9u + 8u].z * sc * (1.0 - sstep(3.1, 3.45, R.x)) * sstep(0.0, 0.25, R.x);
  return r;
}
// a section point: elliptical with separate top and bottom radii, wider low (egg), a ridge on top, eye bumps on the
// upper sides, squarer with e < 1, fleece lumps along the radius
fn skPt(r: SkRing, th: f32, hs: f32) -> vec3f {
  let cs = cos(th); let sn = sin(th);
  let hh = select(r.bot, r.top, sn > 0.0);
  let ww = r.w * (1.0 - r.egg * sn);
  var x = sign(cs) * pow(abs(cs), r.e) * ww;
  let y = sign(sn) * pow(abs(sn), r.e) * hh + r.ridge * exp(-cs * cs * 12.0) * max(sn, 0.0);
  x += sign(cs) * r.bump * exp(-(sn - 0.45) * (sn - 0.45) * 12.0);
  var p = r.c + r.b1 * x + r.b2 * y;
  if (r.lump > 0.0) {
    let l = vn(vec2f(cs * 1.8 + r.s * 3.1 + hs, sn * 1.8 + r.s * 2.3 - hs), 977u) * 2.0 - 1.0;
    p += (r.b1 * cs + r.b2 * sn) * l * r.lump;
  }
  return p;
}
// two-bone chain with unequal bones l1 (upper) and l2 (lower); the joint bends toward kd
fn skKnee(a: vec3f, b: vec3f, l1: f32, l2: f32, kd: vec3f) -> vec3f {
  let ab = b - a; let d = clamp(length(ab), 1e-4, (l1 + l2) * 0.999);
  let dir = ab / max(length(ab), 1e-4);
  let x = (l1 * l1 - l2 * l2 + d * d) / (2.0 * d);
  let h = sqrt(max(l1 * l1 - x * x, 0.0));
  let pd = normalize(kd - dir * dot(kd, dir) + vec3f(0.0, 0.0, 1e-5));
  return a + dir * x + pd * h;
}
// top radius (plus ridge) of the spine table at s, unscaled
fn skTopAt(k: u32, s: f32) -> f32 {
  var v = 0.0;
  for (var i = 1u; i < SK_NR; i++) {
    let a = SKR[k * SK_NR + i - 1u]; let b = SKR[k * SK_NR + i];
    if (s >= a.x && s <= b.x) {
      let f = (s - a.x) / max(b.x - a.x, 1e-4);
      v = mix(a.z + SKD[k * SK_NR + i - 1u].y, b.z + SKD[k * SK_NR + i].y, f);
    }
  }
  return v;
}

fn Q4r(base: vec3f, F: vec3f, U: vec3f, P1: vec4f, sc: f32) -> vec3f { return base + (F * P1.z + U * P1.w) * sc; }

fn skinVert(vi: u32, A: Ani) -> HV {
  var o: HV; o.pos = LF_DEAD;
  let k = skIdx(A.sp); let sc = A.sc;
  let P0 = SKQ[k * 9u]; let P1 = SKQ[k * 9u + 1u]; let P2 = SKQ[k * 9u + 2u];
  let P5 = SKQ[k * 9u + 7u]; let EX = SKQ[k * 9u + 8u];
  let F = A.f; let U = A.u; let S = A.s; let t = FR.time.x;
  let Y = vec3f(0.0, 1.0, 0.0);
  let LL = SKQ[k * 9u + 3u].y * sc;                         // leg length (front top height)
  let gph = A.gait / max(LL * 1.6, 0.1) * 6.2832;
  let bob = 0.035 * LL * A.walk * abs(sin(gph));
  let base = A.p + U * bob + S * (0.02 * LL * A.walk * sin(gph * 0.5));   // weight shifts with the gait
  let hs = f32(A.h & 255u) * 0.37;
  // neck and head pose: grazing lowers the neck to the ground, alarm raises it and turns the head to the drone
  let lookUp = sstep(0.15, 0.5, A.alarm);
  let lk = normalize(mix(F, A.look, 0.6 * lookUp));
  let nodA = A.walk * select(0.06, 0.16, A.sp == 1u) * sin(gph + 1.2);       // the head nods with each step
  // grazing: the horse's neck slopes down gently and the head hangs near vertical; the sheep bends its short neck
  // further. The head then drops just enough for the muzzle to reach the ground from wherever the poll is.
  let gz = select(select(-1.05, -0.55, A.sp == 1u), -1.15, A.sp == 0u);
  let nd = normalize(F * 0.62 + U * (mix(mix(P5.w, gz, A.graze), 1.0, lookUp) + nodA * 0.5));
  let pollH = dot(Q4r(base, F, U, P1, sc) + nd * P2.x * sc - A.p, U);
  let sa = clamp((pollH - 0.03 * sc) / max(P2.y * sc, 1e-3), 0.0, 1.0);
  let hg = F * sqrt(1.0 - sa * sa) - U * sa;
  let hdir = normalize(mix(normalize(mix(nd, lk, 0.45) + U * (-EX.y * (1.0 - 0.35 * lookUp) + nodA) + F * 0.25), hg, A.graze));
  var Q: array<vec3f, 9>;
  Q[1] = base + (F * P0.x + U * P0.y) * sc;                  // tail root / point of buttock
  Q[2] = base + (F * P0.z + U * P0.w) * sc;                  // croup / hip
  Q[3] = base + (F * P1.x + U * P1.y) * sc;                  // girth (chest)
  Q[4] = base + (F * P1.z + U * P1.w) * sc;                  // neck base (at the shoulder)
  Q[5] = Q[4] + nd * P2.x * sc * 0.5 + U * P2.x * sc * 0.04; // neck mid (a slight crest)
  Q[6] = Q[4] + nd * P2.x * sc;                              // poll
  Q[7] = Q[6] + hdir * P2.y * sc;                            // muzzle
  Q[0] = 2.0 * Q[1] - Q[2]; Q[8] = 2.0 * Q[7] - Q[6];

  let vSp = (SK_NR - 1u) * SK_NS * 6u;
  let vLeg = (SK_NL - 1u) * SK_LS * 6u;
  let vTail = (SK_NT - 1u) * SK_TS * 6u;
  let vMane = (SK_NM - 1u) * 4u * 6u;
  let vEar = 2u * SK_ES * 6u;
  let v0Tail = vSp + 4u * vLeg; let v0Mane = v0Tail + vTail; let v0Ear = v0Mane + vMane; let v0Fl = v0Ear + 2u * vEar;
  var wp: vec3f; var n: vec3f; var ax = F; var part = 0u; var loc = vec2f(0.0);
  if (vi < vSp) {
    // ---- spine tube: torso, neck and head in one surface
    let rs = skTube(vi, SK_NS);
    let th = f32(rs.y) / f32(SK_NS) * 6.2832;
    let ri = rs.x;
    let r0 = skRing(Q, k, ri, sc, S);
    let rp = skRing(Q, k, select(ri - 1u, 0u, ri == 0u), sc, S);
    let rn = skRing(Q, k, min(ri + 1u, SK_NR - 1u), sc, S);
    let sv = r0.s;
    wp = skPt(r0, th, hs);
    let dth = skPt(r0, th + 0.05, hs) - skPt(r0, th - 0.05, hs);
    let ds = skPt(rn, th, hs) - skPt(rp, th, hs);
    n = cross(dth, ds);
    if (dot(n, wp - r0.c) < 0.0) { n = -n; }
    if (length(n) < 1e-7) { n = select(-1.0, 1.0, sv > 3.0) * normalize(rn.c - rp.c + vec3f(0.0, 1e-5, 0.0)); }
    ax = normalize(rn.c - rp.c + vec3f(0.0, 1e-5, 0.0));
    part = select(select(2u, 1u, sv < 5.0), 0u, sv < 3.0);
    if (sv > 5.75) { part = 12u; }
    loc = vec2f(select(select((sv - 5.0) * 2.0 - 1.0, sv - 4.0, sv < 5.0), sv / 1.5 - 1.0, sv < 3.0), th);
  } else if (vi < v0Tail) {
    // ---- legs: two-bone chains from the posed tops; stance 60 % with the hoof planted, swing 40 %
    let lv = vi - vSp; let li = lv / vLeg; let rs = skTube(lv % vLeg, SK_LS);
    let front = li < 2u; let left = (li & 1u) == 0u;
    let LA = SKQ[k * 9u + select(5u, 3u, front)]; let LB = SKQ[k * 9u + select(6u, 4u, front)];
    let hipY = LA.y * sc;
    let hip = base + F * LA.x * sc + U * hipY + S * select(-LA.z, LA.z, left) * sc;
    let stride = hipY * 0.75;
    let cyc = stride / 0.6;
    let off = select(select(0.25, 0.75, left), select(0.5, 0.0, left), front);
    let phs = fract(A.gait / cyc + off);
    var fx = 0.0; var lift = 0.0;
    if (phs < 0.6) { fx = stride * (0.5 - phs / 0.6); }
    else { let q = (phs - 0.6) / 0.4; fx = stride * (-0.5 + q); lift = sin(3.1416 * q) * 0.2 * hipY; }
    fx *= A.walk; lift *= A.walk;
    // the hoof stands on the terrain under itself, not on the body's plane
    let fxz = (hip - U * hipY).xz + F.xz * (fx + LA.w * sc);
    let gy = hgnd(fxz);
    let fetH = LB.z * sc;
    let fl = F - Y * dot(F, Y);
    var hoof = vec3f(fxz.x, gy + lift, fxz.y);
    // fetlock above the hoof behind a sloped pastern; in the swing the lower leg folds back (the hoof trails)
    let fb = fl * fetH * LB.w * (1.0 + 1.5 * sstep(0.0, 0.15 * hipY, lift));
    var fet = hoof + Y * fetH - fb;
    let l1 = LB.x * sc; let l2 = LB.y * sc;
    let dl = length(fet - hip);
    if (dl > (l1 + l2) * 0.995) { fet = hip + (fet - hip) * ((l1 + l2) * 0.995 / dl); hoof = fet - Y * fetH + fb; }
    let kn = skKnee(hip, fet, l1, l2, select(-F, F, front));
    let ri = rs.x; let th = f32(rs.y) / f32(SK_LS) * 6.2832;
    let LR = SKL[(k * 2u + select(1u, 0u, front)) * SK_NL + ri];
    let u = LR.x;
    var a0 = hip; var a1 = kn; var tu = u;
    if (u >= 2.0) { a0 = fet; a1 = hoof; tu = u - 2.0; } else if (u >= 1.0) { a0 = kn; a1 = fet; tu = u - 1.0; }
    let c = mix(a0, a1, clamp(tu, 0.0, 1.05));
    let T = normalize(a1 - a0 + vec3f(0.0, 1e-5, 0.0));
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);                                    // points forward on an upright leg
    let rx = LR.y * sc; let rz = select(LR.w, LR.z, sin(th) > 0.0) * sc;
    wp = c + b1 * cos(th) * rx + b2 * sin(th) * rz;
    n = normalize(b1 * cos(th) / max(rx, 1e-4) + b2 * sin(th) / max(rz, 1e-4));
    if (u > 2.97) { n = normalize(-T + n * 0.3); }
    ax = T;
    part = 4u + li * 2u + select(0u, 1u, u >= 1.0);
    loc = vec2f(u / 1.5 - 1.0, th);
  } else if (vi < v0Mane) {
    // ---- tail: a tapered hair mass from a high dock, swinging with the gait and the wind
    let lv = vi - v0Tail; let rs = skTube(lv, SK_TS);
    let u = f32(rs.x) / f32(SK_NT - 1u); let th = f32(rs.y) / f32(SK_TS) * 6.2832;
    let tl = P2.z * sc;
    let sway = S * tl * (0.06 * sin(t * 1.7 + f32(A.h & 31u)) + 0.08 * A.walk * sin(gph * 0.5));
    let root = Q[1] + U * EX.x * sc + F * (EX.w - P5.x * 0.3) * sc;
    var p1 = root - F * tl * 0.2 - U * tl * 0.02; var p2 = root - F * tl * 0.12 - U * tl * 0.95;  // horse: to the hocks
    if (A.sp == 3u) { p1 = root - F * tl * 0.55 + U * tl * 0.02; p2 = root - F * tl * 0.92 - U * tl * 0.3; }  // fox brush
    if (A.sp == 0u) { p1 = root - F * tl * 0.3; p2 = root - F * tl * 0.35 - U * tl * 0.8; }
    p2 += sway * u;
    let c = mix(mix(root, p1, u), mix(p1, p2, u), u);
    let T = normalize(mix(p1 - root, p2 - p1, u) + vec3f(0.0, 1e-5, 0.0));
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    // radius: thin at the dock, full in the hair mass, a soft point at the end
    var rw = P5.x * sc * mix(0.45, 1.0, sstep(0.0, 0.35, u)) * (1.0 - sstep(0.6, 1.0, u) * 0.75);
    if (A.sp == 3u) { rw = P5.x * sc * (0.6 + 0.6 * sin(3.1416 * min(u * 1.1, 1.0))); }
    if (rs.x == SK_NT - 1u) { rw = 0.0; }
    let rd = rw * P5.y;
    wp = c + b1 * cos(th) * rw + b2 * sin(th) * rd;
    n = normalize(b1 * cos(th) / max(rw, 1e-4) + b2 * sin(th) / max(rd, 1e-4));
    ax = T; part = 3u; loc = vec2f(u * 2.0 - 1.0, th);
  } else if (vi < v0Ear) {
    // ---- mane (horses): a short fringe from the withers to the poll, lying over one side of the crest
    if (A.sp != 1u) { return o; }
    let lv = vi - v0Mane; let rs = skTube(lv, 4u);
    let u = f32(rs.x) / f32(SK_NM - 1u); let th = f32(rs.y) / 4.0 * 6.2832;
    let s = mix(2.55, 4.98, u);
    let c0 = skCurve(Q, s);
    let T = skTan(Q, s);
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    let side = select(-1.0, 1.0, (A.h & 2u) == 0u);
    let crest = c0 + b2 * (skTopAt(k, s) * sc + 0.012 * sc);
    let fl = 0.15 * sc * sstep(0.0, 0.15, u) * (1.0 - 0.35 * u) + 0.004 * sc;   // fringe length
    let R = normalize(b1 * side * 0.9 - b2 * 0.42);           // falls over the side of the neck
    let N = normalize(b1 * side * 0.42 + b2 * 0.9);
    let wav = 0.15 * sin(u * 23.0 + hs) * fl;                 // locks
    wp = crest + R * (fl * 0.5 + wav) + R * cos(th) * fl * 0.5 + N * sin(th) * 0.014 * sc;
    n = normalize(N * sin(th) + R * cos(th) * 0.35);
    ax = R; part = 15u; loc = vec2f(u * 2.0 - 1.0, th);
  } else if (vi < v0Fl) {
    // ---- ears: cupped cones at the poll (horses upright, sheep held out sideways)
    let lv = vi - v0Ear; let ei = lv / vEar; let rs = skTube(lv % vEar, SK_ES);
    let sg = select(-1.0, 1.0, ei == 0u);
    let s = 5.03;
    let c0 = skCurve(Q, s);
    let T = skTan(Q, s);
    let b1 = normalize(S - T * dot(S, T) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, T);
    var ed = normalize(b2 * 0.9 + b1 * sg * 0.22 - T * 0.3);
    if (A.sp == 0u) { ed = normalize(b1 * sg - b2 * 0.1 - T * 0.15); }
    if (A.sp == 3u) { ed = normalize(b2 + b1 * sg * 0.35 + T * 0.05); }
    let el = P2.w * sc;
    let eb = c0 + b2 * P5.z * sc * 0.8 + b1 * sg * P5.z * sc * 0.55;
    let u = f32(rs.x) * 0.5; let th = f32(rs.y) / f32(SK_ES) * 6.2832;
    let er = el * select(0.3, 0.4, A.sp == 0u) * sin(3.1416 * min(u * 0.9 + 0.12, 1.0)) * select(1.0, 0.0, rs.x == 2u);
    let e1 = normalize(cross(ed, T) + vec3f(1e-5, 0.0, 0.0)); let e2 = cross(ed, e1);
    wp = eb + ed * el * u + e1 * cos(th) * er + e2 * sin(th) * er * 0.45;
    n = normalize(e1 * cos(th) + e2 * sin(th) * 2.0);
    ax = ed; part = 13u + ei; loc = vec2f(u * 2.0 - 1.0, th);
  } else if (vi < v0Fl + 48u) {
    // ---- forelock (horses): a flat tongue of hair from between the ears down the forehead
    if (A.sp != 1u) { return o; }
    let rs = skTube(vi - v0Fl, 4u);
    let u = f32(rs.x) * 0.5; let th = f32(rs.y) / 4.0 * 6.2832;
    let Th = normalize(Q[7] - Q[6]);
    let b1 = normalize(S - Th * dot(S, Th) + vec3f(1e-5, 0.0, 0.0));
    let b2 = cross(b1, Th);
    let top = skTopAt(k, 5.05) * sc;
    let c = skCurve(Q, 5.02) + b2 * (top + 0.02 * sc) + Th * (0.19 * sc * u) - b2 * 0.012 * sc * u;
    let ww = 0.04 * sc * (1.0 - 0.55 * u) * select(1.0, 0.15, rs.x == 2u);
    wp = c + b1 * cos(th) * ww + b2 * sin(th) * 0.01 * sc;
    n = normalize(b2 * sin(th) + b1 * cos(th) * 0.3);
    ax = Th; part = 15u; loc = vec2f(u * 2.0 - 1.0, th);
  } else { return o; }
  o.n = n; o.ax = ax; o.wp = wp; o.loc = loc; o.part = part; o.sp = A.sp;
  o.tint = vec4f(A.coat, lfRand(A.h, 6u), A.alarm, f32(A.h & 1023u));
  o.pos = VW.vp * vec4f(wp - VW.cam.xyz, 1.0);
  return o;
}
