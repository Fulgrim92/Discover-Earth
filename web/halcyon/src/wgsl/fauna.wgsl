// fauna.wgsl: birds (flamingos, seabirds, geese) and sky jellies. Every pose is a closed-form function of time and
// instance index: no CPU simulation, no buffers. Flocks live on world-snapped cells around the camera
// (group = instance_index >> 16). Birds are opaque (opaque pass); jellies and the flamingos' mirror images are
// blended after the composite (particles.js owns that pass) and depth-tested against the resolved linear depth.

const FB_SEG = 6u;     // body lathe segments around
const FB_RINGS = 10u;  // body lathe bands along the axis
const FB_BODY = 360u;  // FB_SEG * FB_RINGS * 6
const FB_VERTS = 384u; // + two wings of two panels
const CO6 = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));

// group: cell size (m), cells per side, birds per flock, existence probability
const FG = array<vec4f, 4>(
  vec4f(700.0, 3.0, 24.0, 0.75),   // flamingos
  vec4f(450.0, 3.0, 12.0, 0.8),    // seabird colonies
  vec4f(2600.0, 3.0, 13.0, 0.45),  // geese
  vec4f(230.0, 5.0, 1.0, 0.6),     // jellies
);

// body profiles: x along the axis (m, + forward), radius (m); 11 points per kind
fn bodyProf(kind: u32, k: u32) -> vec2f {
  if (kind == 0u) {
    switch k {
      case 0u: { return vec2f(-1.05, 0.0); } case 1u: { return vec2f(-1.0, 0.018); } case 2u: { return vec2f(-0.45, 0.014); }
      case 3u: { return vec2f(-0.3, 0.05); } case 4u: { return vec2f(-0.12, 0.11); } case 5u: { return vec2f(0.08, 0.12); }
      case 6u: { return vec2f(0.22, 0.07); } case 7u: { return vec2f(0.32, 0.03); } case 8u: { return vec2f(0.78, 0.028); }
      case 9u: { return vec2f(0.86, 0.04); } default: { return vec2f(1.0, 0.0); }
    }
  }
  if (kind == 1u) {
    switch k {
      case 0u: { return vec2f(-0.26, 0.0); } case 1u: { return vec2f(-0.22, 0.03); } case 2u: { return vec2f(-0.12, 0.06); }
      case 3u: { return vec2f(-0.02, 0.075); } case 4u: { return vec2f(0.07, 0.075); } case 5u: { return vec2f(0.13, 0.06); }
      case 6u: { return vec2f(0.17, 0.045); } case 7u: { return vec2f(0.21, 0.046); } case 8u: { return vec2f(0.245, 0.03); }
      case 9u: { return vec2f(0.27, 0.012); } default: { return vec2f(0.3, 0.0); }
    }
  }
  switch k {
    case 0u: { return vec2f(-0.42, 0.0); } case 1u: { return vec2f(-0.36, 0.05); } case 2u: { return vec2f(-0.2, 0.12); }
    case 3u: { return vec2f(0.0, 0.14); } case 4u: { return vec2f(0.15, 0.12); } case 5u: { return vec2f(0.25, 0.06); }
    case 6u: { return vec2f(0.32, 0.04); } case 7u: { return vec2f(0.52, 0.036); } case 8u: { return vec2f(0.58, 0.045); }
    case 9u: { return vec2f(0.63, 0.03); } default: { return vec2f(0.69, 0.0); }
  }
}
// wing: semi-span, chord, elbow fraction; per kind
fn wingDim(kind: u32) -> vec3f {
  if (kind == 0u) { return vec3f(0.8, 0.27, 0.45); }
  if (kind == 1u) { return vec3f(0.66, 0.19, 0.42); }
  return vec3f(0.82, 0.3, 0.45);
}

struct Bird { ok: bool, p: vec3f, fwd: vec3f, up: vec3f, flapA: f32, flapP: f32, size: f32, kind: u32, h: u32, pet: f32 }

fn flockCell(g: u32, fi: u32) -> vec2i {
  let fg = FG[g];
  let n = u32(fg.y);
  let cam = VW.anc.xyz; // the head, shared by both eyes
  let c0 = vec2i(floor(cam.xz / fg.x)) - vec2i(i32(n / 2u));
  return c0 + vec2i(i32(fi % n), i32(fi / n));
}

fn bird(ii: u32) -> Bird {
  var B: Bird; B.ok = false;
  let g = ii >> 16u; let li = ii & 0xFFFFu;
  let fg = FG[g];
  let per = u32(fg.z);
  let fi = li / per; let k = li % per;
  let ci = flockCell(g, fi);
  let hc = hu(ci.x, ci.y, 9100u + g);
  let cen = (vec2f(ci) + 0.5 + (vec2f(lfRand(hc, 2u), lfRand(hc, 3u)) - 0.5) * 0.5) * fg.x;
  // The Drift: a flock exists by the realm weights at its own home, not at the camera, so creatures cross borders
  // and thin out through the zone without popping
  let rwc = realmWeights(cen);
  if (lfRand(hc, 1u) > fg.w * bf(rwc, V2)[g]) { return B; }
  let hb = hu(i32(hc), i32(k), 0x33u);
  let t = FR.time.x;
  B.kind = g; B.h = hb; B.size = 1.0;
  let w1 = vec3f(vn(vec2f(t * 0.11, f32(k) * 3.1), 911u), vn(vec2f(t * 0.09, f32(k) * 3.1 + 7.0), 912u), vn(vec2f(t * 0.13, f32(k) * 3.1 + 3.0), 913u));
  if (g == 0u || g == 2u) {
    // a skein crossing its cell along a straight line, wrapping with a size fade at the far ends
    let th = lfRand(hc, 4u) * 6.2832;
    let dir = vec2f(cos(th), sin(th));
    let len = fg.x * 2.0;
    let speed = select(16.0, 11.0, g == 0u);
    let s = (fract(t * speed / len + lfRand(hc, 5u)) - 0.5) * len;
    let lead = cen + dir * s;
    let side = vec2f(-dir.y, dir.x);
    let arm = select(-1.0, 1.0, (k & 1u) == 1u);
    let idx = f32((k + 1u) / 2u);
    var off: vec2f; var y: f32;
    if (g == 0u) {
      // flamingos: a long wavy echelon a few metres above the mirror
      off = -dir * (idx * 1.9 + abs(w1.x) * 1.5) + side * (arm * idx * 0.9 + w1.y * 1.2);
      y = 3.0 + 4.0 * lfRand(hc, 6u) + w1.z * 0.8 + idx * 0.08;
    } else {
      off = -dir * idx * 2.6 + side * arm * idx * 2.0 + vec2f(w1.x, w1.y) * 0.6;
      y = 420.0 + 160.0 * lfRand(hc, 6u) + w1.z * 1.5;
      y = max(y, heightAny(lead) + 180.0);
    }
    let p2 = lead + off;
    B.p = vec3f(p2.x, y, p2.y);
    B.fwd = normalize(vec3f(dir.x, 0.0, dir.y) + vec3f(w1.y, w1.z, -w1.x) * 0.06);
    B.up = vec3f(0.0, 1.0, 0.0);
    B.size = sstep(len * 0.5, len * 0.5 - 120.0, abs(s));
    let fq = select(3.2, 2.6, g == 0u);
    B.flapP = t * fq * 6.2832 + lfRand(hb, 1u) * 6.2832 + idx * 0.5;
    B.flapA = 0.7;
    if (g == 0u) {
      // flamingos glide in short bursts
      B.flapA = mix(0.12, 0.75, sstep(-0.3, 0.2, sin(t * 0.45 + lfRand(hb, 2u) * 6.0)));
    }
  } else {
    // seabirds wheeling over a steep coastal slope
    let s0 = clipS(clipLevel(cen, 0u, 8.0), cen);
    let st = length(s0.yz);
    let v4 = bf(rwc, V4);
    if (v4.y > 0.5) {
      // Aurora Ice: snow petrels in a loose swirling flock low over the ice, catching the aurora (all 12 per colony)
      let r = 14.0 + 40.0 * lfRand(hb, 1u);
      let cw = select(-1.0, 1.0, lfRand(hb, 7u) > 0.3);
      let v = 9.0 + 3.0 * lfRand(hb, 2u);
      let a = t * v / r * cw + lfRand(hb, 3u) * 6.2832;
      let wob = vec2f(sin(t * 0.21 + f32(k)), cos(t * 0.17 + f32(k) * 1.7)) * 18.0;
      let p2 = cen + vec2f(w1.x, w1.y) * 40.0 + wob + vec2f(cos(a), sin(a)) * r;
      let y = max(heightAny(p2), 0.0) + 14.0 + 30.0 * lfRand(hb, 4u) + 8.0 * sin(t * 0.4 + lfRand(hb, 5u) * 6.0);
      B.p = vec3f(p2.x, y, p2.y);
      let tg = vec2f(-sin(a), cos(a)) * cw;
      B.fwd = normalize(vec3f(tg.x, 0.05 * cos(t * 0.4), tg.y));
      let bank = atan(v * v / (r * 9.8));
      B.up = normalize(vec3f(0.0, cos(bank), 0.0) - vec3f(cos(a), 0.0, sin(a)) * sin(bank));
      B.flapP = t * 5.0 * 6.2832 + lfRand(hb, 6u) * 6.2832;
      B.flapA = 0.7 * sstep(0.2, 0.6, sin(t * 0.8 + lfRand(hb, 7u) * 6.2832));
      B.size = 2.0;
      B.pet = 1.0;
    } else {
    let skyMode = v4.x > 0.5; // Stone: over the cloud sea
    if (!skyMode && (s0.x < -60.0 || s0.x > 220.0 || st < 0.2)) { return B; }
    let r = select(18.0, 40.0, skyMode) + select(50.0, 90.0, skyMode) * lfRand(hb, 1u);
    let cw = select(-1.0, 1.0, lfRand(hc, 7u) > 0.5);
    let v = 8.0 + 3.0 * lfRand(hb, 2u);
    let a = t * v / r * cw + lfRand(hb, 3u) * 6.2832;
    let c2 = cen + vec2f(w1.x, w1.y) * 25.0;
    let p2 = c2 + vec2f(cos(a), sin(a)) * r;
    var y = max(s0.x, 0.0) + 30.0 + 70.0 * lfRand(hb, 4u) + 6.0 * sin(t * 0.3 + lfRand(hb, 5u) * 6.0);
    if (v4.x > 0.5) { y = bf(rwc, C2).y + 12.0 + 55.0 * lfRand(hb, 4u) + 4.0 * sin(t * 0.3 + lfRand(hb, 5u) * 6.0); }
    y = max(y, heightAny(p2) + 10.0);
    B.p = vec3f(p2.x, y, p2.y);
    let tg = vec2f(-sin(a), cos(a)) * cw;
    B.fwd = normalize(vec3f(tg.x, 0.03 * cos(t * 0.3), tg.y));
    let bank = atan(v * v / (r * 9.8));
    let inward = -vec3f(cos(a), 0.0, sin(a));
    B.up = normalize(vec3f(0.0, cos(bank), 0.0) + inward * sin(bank));
    B.flapP = t * 3.6 * 6.2832 + lfRand(hb, 6u) * 6.2832;
    B.flapA = 0.65 * sstep(0.35, 0.75, sin(t * 0.37 + lfRand(hb, 7u) * 6.2832));
    }
  }
  // reaction to the drone (the shared head anchor; closed-form, so it is the same in both eyes and every frame)
  let D = VW.anc.xyz;
  var esc = 0.0;
  if (g == 1u && fi == 0u && k == 0u && B.pet < 0.5) {
    // the curious one: every 75 s one seabird of the nearest colony flies alongside the drone for about 16 s
    let ph = fract(t / 75.0 + lfRand(hc, 9u));
    esc = sstep(0.0, 0.04, ph) * (1.0 - sstep(0.2, 0.25, ph));
    let fw = normalize(vec3f(VW.fwd.x, 0.0, VW.fwd.z) + vec3f(1e-4, 0.0, 0.0));
    let sd = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
    let ep = D + sd * (7.0 + 1.5 * sin(t * 0.31)) + vec3f(0.0, 1.5 + 0.8 * sin(t * 0.7), 0.0) + fw * (3.0 * sin(t * 0.23));
    B.p = mix(B.p, ep, esc);
    B.fwd = normalize(mix(B.fwd, fw, esc));
    B.up = normalize(mix(B.up, vec3f(0.0, 1.0, 0.0) + sd * 0.15 * sin(t * 0.5), esc));
    B.flapA = mix(B.flapA, 0.15 + 0.55 * sstep(0.3, 0.8, sin(t * 0.6)), esc);
  }
  // the rest of the flock lifts and wheels away from a drone that comes within about 70 m, then settles back
  let dv = B.p - D; let dd = length(dv) + 1e-3;
  let rep = sstep(70.0, 12.0, dd) * (1.0 - esc);
  let away = dv / dd;
  let wheel = normalize(cross(vec3f(0.0, 1.0, 0.0), away) + vec3f(1e-4, 0.0, 0.0));
  B.p += (away * 26.0 + vec3f(0.0, 16.0, 0.0) + wheel * 12.0 * select(-1.0, 1.0, (hc & 1u) == 1u)) * rep;
  B.fwd = normalize(mix(B.fwd, normalize(away + vec3f(0.0, 0.5, 0.0)), rep * 0.7));
  B.flapA = mix(B.flapA, 0.85, rep);
  let d = length(B.p - VW.anc.xyz);
  B.size *= sstep(1500.0, 1000.0, d);
  if (B.size < 0.01) { return B; }
  let rel = B.p - VW.cam.xyz;
  if (!lfVisible(rel, 2.0) && !(g == 0u && lfVisible(vec3f(rel.x, -B.p.y - VW.cam.y, rel.z), 2.0))) { return B; }
  B.ok = true;
  return B;
}

struct BV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) loc: vec2f,  // body: axis x (m) / wing: span fraction, chord fraction
  @location(3) @interpolate(flat) part: u32, // 0 body, 1 wing
  @location(4) @interpolate(flat) kind: u32,
  @location(5) sh: f32,
}

fn birdVertex(vi: u32, B: Bird, mirror: bool) -> BV {
  var o: BV;
  let cam = VW.cam.xyz;
  let fwd = B.fwd;
  let side = normalize(cross(fwd, B.up));
  let up = cross(side, fwd);
  let sc = B.size * (0.9 + 0.25 * lfRand(B.h, 9u));
  var lp: vec3f; var ln: vec3f; // local: x fwd, y up, z side
  var loc: vec2f; var part = 0u;
  if (vi < FB_BODY) {
    let q = vi / 6u; let c = CO6[vi % 6u];
    let seg = q % FB_SEG + c.x; let ring = q / FB_SEG + c.y;
    let pr = bodyProf(B.kind, ring);
    let a = f32(seg) / f32(FB_SEG) * 6.2832;
    var yo = 0.0;
    if (B.kind == 0u) { yo = -0.07 * sstep(0.3, 0.9, pr.x) - 0.05 * sstep(-0.4, -1.0, pr.x); }
    if (B.kind == 2u) { yo = 0.02 * sstep(0.3, 0.6, pr.x); }
    lp = vec3f(pr.x, yo + sin(a) * pr.y * 0.9, cos(a) * pr.y);
    let pa = bodyProf(B.kind, max(ring, 1u) - 1u); let pb = bodyProf(B.kind, min(ring + 1u, 10u));
    let dr = (pb.y - pa.y) / max(pb.x - pa.x, 1e-3);
    ln = normalize(vec3f(-dr, sin(a), cos(a)));
    loc = vec2f(pr.x, sin(a));
  } else {
    // wings: inner panel (shoulder -> elbow) and outer panel (elbow -> tip), flapping with a lag
    let w = vi - FB_BODY;
    let wing = w / 12u; let wv = w % 12u;
    let panel = wv / 6u; let c = CO6[wv % 6u];
    let wd = wingDim(B.kind);
    let sgn = select(-1.0, 1.0, wing == 1u);
    let ph = B.flapP;
    var ai = B.flapA * sin(ph) + 0.08;
    var ao = B.flapA * 1.25 * sin(ph - 0.6) + 0.02;
    if (B.kind == 1u) { ai += 0.12 * (1.0 - B.flapA); ao -= 0.18 * (1.0 - B.flapA); } // gull wing in glide
    let s1 = wd.x * wd.z;
    let u = select(f32(c.x) * s1, s1 + f32(c.x) * (wd.x - s1), panel == 1u);
    let span01 = u / wd.x;
    let chord = wd.y * mix(1.0, 0.45, span01 * span01);
    let sweep = -0.25 * wd.y * span01 * span01;
    let cc = f32(c.y);
    var xc = 0.08 - cc * chord + sweep + select(0.0, 0.1, B.kind == 0u);
    let dI = vec2f(cos(ai), sin(ai));
    let dO = vec2f(cos(ao), sin(ao));
    var sp: vec2f; var nn: vec2f;
    if (panel == 0u) { sp = dI * u; nn = vec2f(-dI.y, dI.x); }
    else { sp = dI * s1 + dO * (u - s1); nn = vec2f(-dO.y, dO.x); }
    lp = vec3f(xc, 0.03 + sp.y, sgn * (0.05 + sp.x));
    ln = normalize(vec3f(0.0, nn.y, -sgn * nn.x));
    loc = vec2f(span01, cc);
    part = 1u;
  }
  var wp = B.p + (fwd * lp.x + up * lp.y + side * lp.z) * sc;
  var n = normalize(fwd * ln.x + up * ln.y + side * ln.z);
  if (mirror) { wp.y = -wp.y; n.y = -n.y; }
  o.wp = wp; o.n = n; o.loc = loc; o.part = part; o.kind = B.kind;
  if (B.pet > 0.5) { o.kind = 4u; } // snow petrel: gull shape, own colour and light
  o.sh = select(0.0, lfCloudShadow(B.p), FR.sun.y > -0.03); // birds fly above the terrain's shadows: cloud shadow only, no march per vertex
  o.pos = VW.vp * vec4f(wp - cam, 1.0);
  return o;
}

@vertex fn vsBird(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BV {
  let B = bird(ii);
  if (!B.ok) { var o: BV; o.pos = LF_DEAD; return o; }
  return birdVertex(vi, B, false);
}

fn birdAlbedo(in: BV) -> vec3f {
  let k = in.kind;
  if (k == 0u) {
    if (in.part == 1u) {
      // coverts deep pink, flight feathers black along the trailing edge and the outer wing
      let blk = sstep(0.45, 0.6, in.loc.y + in.loc.x * 0.35);
      return mix(vec3f(0.9, 0.16, 0.24), vec3f(0.015, 0.012, 0.015), blk);
    }
    var c = vec3f(0.92, 0.36, 0.40);
    c = mix(c, vec3f(0.95, 0.5, 0.5), sstep(-0.3, -0.6, in.loc.x)); // legs
    c = mix(c, vec3f(0.02, 0.02, 0.02), sstep(0.9, 0.95, in.loc.x)); // beak tip
    return c;
  }
  if (k == 1u) {
    if (in.part == 1u) { return mix(vec3f(0.42, 0.45, 0.5), vec3f(0.015), sstep(0.8, 0.9, in.loc.x)); }
    return mix(vec3f(0.85, 0.85, 0.83), vec3f(0.85, 0.6, 0.1), sstep(0.25, 0.27, in.loc.x));
  }
  if (k == 4u) { return mix(vec3f(0.9, 0.92, 0.94), vec3f(0.02), sstep(0.25, 0.27, in.loc.x) * f32(in.part == 0u)); } // petrel, black bill
  if (in.part == 1u) { return mix(vec3f(0.16, 0.14, 0.12), vec3f(0.03, 0.03, 0.03), sstep(0.5, 0.7, in.loc.x)); }
  var c = mix(vec3f(0.2, 0.17, 0.14), vec3f(0.45, 0.42, 0.38), sstep(0.2, -0.6, in.loc.y));
  c = mix(c, vec3f(0.02), sstep(0.3, 0.34, in.loc.x));
  return c;
}

fn birdShade(in: BV) -> vec3f {
  let cam = VW.cam.xyz;
  let V = normalize(cam - in.wp);
  var n = normalize(in.n);
  if (in.part == 1u && dot(n, V) < 0.0) { n = -n; }
  let L = FR.sun.xyz;
  let sc = sunCol();
  let alb = birdAlbedo(in);
  let ndl = dot(n, L);
  let wrap = max((ndl + 0.3) / 1.3, 0.0);
  let tr = select(0.0, 0.5, in.part == 1u);
  let mu = max(dot(-V, L), 0.0);
  let thru = (max(-ndl, 0.0) * 0.5 + pow(mu, 6.0) * 1.5) * tr;
  var col = alb * (sc * in.sh * (wrap + thru) + lfAmb(n.y, alb));
  let hv = normalize(L + V);
  col += sc * in.sh * pow(max(dot(n, hv), 0.0), 30.0) * 0.04;
  if (in.kind == 4u) {
    // snow petrels in the polar night: lit by the aurora above them and the snow below
    let m6 = rowv(M6);
    let fres = pow(1.0 - abs(dot(n, V)), 2.0);
    col += alb * m6.rgb * m6.w * (0.9 * max(n.y, 0.0) + 0.8 * fres + 0.15) + alb * lfAmb(-1.0, vec3f(0.8)) * max(-n.y, 0.0) * 0.6;
  }
  return col;
}

struct FOut { @location(0) c: vec4f, @location(1) d: vec4f }

@fragment fn fsBird(in: BV) -> FOut {
  var o: FOut;
  o.c = vec4f(birdShade(in), 1.0);
  o.d = vec4f(length(VW.cam.xyz - in.wp), 0.0, 0.0, 1.0);
  return o;
}

// ---------------- transparent: flamingo reflections in the mirror and sky jellies ----------------
@group(2) @binding(0) var sceneDist: texture_2d<f32>;

@vertex fn vsBirdMirror(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BV {
  let B = bird(ii);
  if (!B.ok || VW.cam.y <= 0.05) { var o: BV; o.pos = LF_DEAD; return o; }
  return birdVertex(vi, B, true);
}

@fragment fn fsBirdMirror(in: BV) -> @location(0) vec4f {
  let ro = VW.cam.xyz;
  let d = normalize(in.wp - ro);
  if (d.y >= -0.0005) { discard; }
  let tw = ro.y / -d.y;
  let sd = textureLoad(sceneDist, vec2i(in.pos.xy), 0).x;
  // something stands in front of the water here (an island, a reed), or this pixel is not the salt mirror
  if (sd + max(0.6, sd * 0.0015) < tw) { discard; }
  let P = ro + d * tw;
  let w2 = rowv(W2);
  let fr = 0.02 + 0.98 * pow(1.0 - max(-d.y, 0.0), 5.0);
  let refl = clamp(max(fr, w2.w), 0.0, 1.0) * sstep(0.2, 0.6, rowv(M4).y);
  var n = in;
  n.wp = vec3f(in.wp.x, -in.wp.y, in.wp.z);
  n.n = vec3f(in.n.x, -in.n.y, in.n.z);
  var c = birdShade(n);
  let total = length(in.wp - ro);
  c = applyFog(c, ro, d, total);
  return vec4f(c, refl * 0.92);
}

// ---- sky jellies: pulsing translucent medusae drifting 40-200 m over Lumen Deep ----
const JS = 16u;       // bell segments
const JR = 6u;        // bell rings
const J_BELL = 576u;  // JS * JR * 6
const J_TENT = 8u;    // marginal tentacles
const J_TSEG = 14u;
const J_ARMS = 4u;    // oral arms
const J_ASEG = 10u;
const J_VERTS = 1488u; // 576 + 8*14*6 + 4*10*6

struct Jelly { ok: bool, p: vec3f, R: f32, c: f32, h: u32, col: vec3f, vel: vec3f, fog: vec3f }

fn jelly(ii: u32) -> Jelly {
  var J: Jelly; J.ok = false;
  let li = ii & 0xFFFFu;
  let fg = FG[3];
  let ci = flockCell(3u, li);
  let hc = hu(ci.x, ci.y, 9203u);
  let cen = (vec2f(ci) + 0.5 + (vec2f(lfRand(hc, 2u), lfRand(hc, 3u)) - 0.5) * 0.7) * fg.x;
  if (lfRand(hc, 1u) > fg.w * bf(realmWeights(cen), V2).w) { return J; } // by the weights at its home (The Drift)
  let t = FR.time.x;
  let ph = lfRand(hc, 4u) * 100.0;
  let drift = vec2f(sin(t * 0.013 + ph), cos(t * 0.011 + ph * 1.3)) * 45.0;
  let p2 = cen + drift;
  let g = heightAny(cen);
  let T = 3.5 + 2.5 * lfRand(hc, 5u);
  let f = fract(t / T + lfRand(hc, 6u));
  J.c = sstep(0.0, 0.22, f) * sstep(1.0, 0.3, f);
  let y = max(g, 0.0) + 12.0 + 190.0 * pow(lfRand(hc, 7u), 2.2) + 7.0 * sin(t * 0.05 + ph) + J.c * 1.5;
  J.p = vec3f(p2.x, y, p2.y);
  J.R = 8.0 + 12.0 * lfRand(hc, 8u);
  J.h = hc;
  J.vel = vec3f(cos(t * 0.013 + ph) * 0.013, 0.0, -sin(t * 0.011 + ph * 1.3) * 0.011) * 45.0;
  let k = lfRand(hc, 9u);
  J.col = vec3f(0.2, 0.95, 0.9);
  if (k > 0.45) { J.col = vec3f(0.35, 0.6, 1.0); }
  if (k > 0.75) { J.col = vec3f(0.95, 0.35, 0.9); }
  if (k > 0.92) { J.col = vec3f(1.0, 0.65, 0.25); }
  // jelly gathering (encounter type 5): the swarm drifts together into a slow rising spiral and pulses in step
  let ge = lfEnc(5.0);
  if (ge.w > 0.0) {
    let gw = sstep(0.0, 25.0, ge.x) * (1.0 - sstep(ge.y - 15.0, ge.y, ge.x));
    let E = lfEncPos(5.0);
    let fl = f32(li % 25u);
    let ga = fl * 2.4 + t * 0.06;
    let gp = E + vec3f(cos(ga) * (10.0 + 7.0 * sqrt(fl)), 25.0 + fl * 4.0 + 3.0 * sin(t * 0.2 + fl), sin(ga) * (10.0 + 7.0 * sqrt(fl)));
    J.p = mix(J.p, gp, gw);
    J.vel = mix(J.vel, vec3f(-sin(ga), 0.05, cos(ga)) * 0.6, gw);
    let fs = fract(t / 4.5 - fl * 0.02);
    J.c = mix(J.c, sstep(0.0, 0.22, fs) * sstep(1.0, 0.3, fs), gw);
  }
  let cam = VW.cam.xyz;
  let d = length(J.p - cam);
  if (length(J.p - VW.anc.xyz) > 1300.0 || !lfVisible(J.p - cam - vec3f(0.0, J.R * 1.5, 0.0), J.R * 4.0)) { return J; }
  J.fog = lfFogT(cam, normalize(J.p - cam), d);
  J.ok = true;
  return J;
}

struct JV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) loc: vec2f,
  @location(3) @interpolate(flat) part: u32,
  @location(4) @interpolate(flat) col: vec3f,
  @location(5) @interpolate(flat) fog: vec3f,
  @location(6) @interpolate(flat) pr: vec4f, // contraction, R, hash, 0
}

fn bellPt(J: Jelly, ring: u32, seg: u32) -> vec3f {
  let th = f32(ring) / f32(JR) * 1.85;  // apex .. slightly past the equator
  let a = f32(seg) / f32(JS) * 6.2832;
  let lap = 1.0 + 0.06 * sstep(0.7, 1.0, f32(ring) / f32(JR)) * cos(a * 8.0);
  let squeeze = 1.0 - 0.28 * J.c * sstep(0.2, 1.0, th / 1.85);
  let r = J.R * sin(th) * squeeze * lap;
  let y = J.R * 0.72 * cos(th) * (1.0 + 0.15 * J.c);
  return vec3f(cos(a) * r, y, sin(a) * r);
}

@vertex fn vsJelly(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> JV {
  let J = jelly(ii);
  var o: JV;
  if (!J.ok) { o.pos = LF_DEAD; return o; }
  let cam = VW.cam.xyz;
  let t = FR.time.x;
  var wp: vec3f; var n: vec3f; var loc: vec2f; var part = 0u;
  if (vi < J_BELL) {
    let q = vi / 6u; let c = CO6[vi % 6u];
    let seg = q % JS + c.x; let ring = q / JS + c.y;
    let p = bellPt(J, ring, seg);
    let pa = bellPt(J, ring + 1u, seg);
    let pb = bellPt(J, ring, seg + 1u);
    n = normalize(cross(pb - p, pa - p));
    if (ring == 0u) { n = vec3f(0.0, 1.0, 0.0); }
    wp = J.p + p;
    loc = vec2f(f32(seg) / f32(JS), f32(ring) / f32(JR));
  } else {
    // ribbons: marginal tentacles from the rim, oral arms from the centre; billboarded, waving, trailing
    let w = vi - J_BELL;
    var idx: u32; var sgi: u32; var nseg: u32; var root: vec3f; var len: f32; var wid: f32;
    let tv = J_TENT * J_TSEG * 6u;
    if (w < tv) {
      idx = w / (J_TSEG * 6u); let r = w % (J_TSEG * 6u); sgi = r; nseg = J_TSEG;
      let a = (f32(idx) + 0.5) / f32(J_TENT) * 6.2832;
      let rim = bellPt(J, JR, 0u);
      let rr = length(rim.xz);
      root = vec3f(cos(a) * rr, rim.y, sin(a) * rr);
      len = J.R * (2.6 + 1.4 * lfRand(J.h, 20u + idx));
      wid = 0.22 + 0.04 * J.R;
      part = 1u;
    } else {
      let w2 = w - tv;
      idx = w2 / (J_ASEG * 6u); let r = w2 % (J_ASEG * 6u); sgi = r; nseg = J_ASEG;
      let a = (f32(idx) + 0.25) / f32(J_ARMS) * 6.2832;
      root = vec3f(cos(a), 0.0, sin(a)) * J.R * 0.15 + vec3f(0.0, J.R * 0.1, 0.0);
      len = J.R * 1.6;
      wid = J.R * 0.18;
      part = 2u;
    }
    let q = sgi / 6u; let c = CO6[sgi % 6u];
    let sgf = f32(q + c.y) / f32(nseg);
    let ph = f32(idx) * 1.7 + lfRand(J.h, 30u) * 6.0;
    let lag = sgf * sgf;
    let wave = vec3f(sin(t * 1.1 - sgf * 5.0 + ph), 0.0, cos(t * 0.9 - sgf * 4.0 + ph * 1.3)) * J.R * 0.35 * sgf;
    let pulseOut = J.c * (1.0 - sgf) * 0.15 * J.R;
    var cp = root * (1.0 - 0.28 * J.c * f32(part == 1u)) + vec3f(0.0, -sgf * len, 0.0) + wave - J.vel * lag * 6.0 + normalize(vec3f(root.x, 0.0, root.z) + 1e-4) * pulseOut;
    if (part == 2u) { cp += vec3f(sin(sgf * 9.0 + t + ph), 0.0, cos(sgf * 7.0 + t * 0.8 + ph)) * J.R * 0.12; }
    let tg = vec3f(0.0, -1.0, 0.0);
    let toC = normalize(cam - (J.p + cp));
    let sd = normalize(cross(tg, toC) + vec3f(1e-4, 0.0, 0.0));
    let wv = wid * (1.0 - 0.6 * sgf) * select(1.0, 1.0 + 0.6 * sin(sgf * 23.0 + t * 2.0 + ph), part == 2u);
    wp = J.p + cp + sd * (f32(c.x) - 0.5) * wv;
    n = toC;
    loc = vec2f(f32(c.x) * 2.0 - 1.0, sgf);
  }
  o.wp = wp; o.n = n; o.loc = loc; o.part = part; o.col = J.col; o.fog = J.fog;
  o.pr = vec4f(J.c, J.R, lfRand(J.h, 40u), 0.0);
  o.pos = VW.vp * vec4f(wp - cam, 1.0);
  return o;
}

// premultiplied: rgb = emitted + scattered light, a = coverage of what lies behind
@fragment fn fsJelly(in: JV, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let cam = VW.cam.xyz;
  let dist = length(in.wp - cam);
  let sd = textureLoad(sceneDist, vec2i(in.pos.xy), 0).x;
  let vis = clamp((sd - dist) / 3.0, 0.0, 1.0);
  if (vis <= 0.0) { discard; }
  let V = normalize(cam - in.wp);
  let t = FR.time.x;
  var n = normalize(in.n);
  var c = vec3f(0.0); var a = 0.0;
  let glow = in.col;
  let L = FR.sun.xyz;
  if (in.part == 0u) {
    let nv = abs(dot(n, V));
    let fres = pow(1.0 - nv, 2.5);
    let ring = in.loc.y;
    // radial canals and the gonad ring glow from inside; the rim is a bright band
    let canal = pow(abs(cos(in.loc.x * 6.2832 * 4.0)), 24.0) * sstep(0.1, 0.4, ring);
    let gon = exp(-pow((ring - 0.38) * 7.0, 2.0)) * (0.6 + 0.4 * cos(in.loc.x * 6.2832 * 4.0));
    let rim = sstep(0.82, 0.98, ring);
    let beat = 0.6 + 0.8 * in.pr.x;
    let spots = sstep(0.6, 0.9, vn(vec2f(in.loc.x * 40.0, ring * 12.0 + t * 0.3), 950u)) * 0.5;
    // a real medusa: clear jelly that shows mostly at grazing angles, light living in the gonads and canals,
    // the margin a soft row of photophores rather than an outline
    let pho = pow(0.5 + 0.5 * cos(in.loc.x * 6.2832 * 32.0), 8.0) * rim;
    c = glow * (0.02 + fres * 0.35 + canal * 0.35 + gon * 1.3 * beat + pho * 1.4 * beat + spots * fres * 0.5);
    c += lfAmb(n.y, vec3f(0.6, 0.65, 0.7)) * fres * 0.25; // the jelly lit by the sky
    c += vec3f(0.85, 0.75, 1.0) * sunCol() * pow(max(dot(-V, L), 0.0), 6.0) * 0.08;
    if (!ff) { c *= 0.6; }
    a = clamp(0.03 + fres * 0.45 + rim * 0.12, 0.0, 0.6);
  } else {
    let x = abs(in.loc.x);
    let core = sstep(1.0, 0.0, x);
    let beads = 0.5 + 0.5 * pow(0.5 + 0.5 * sin(in.loc.y * 60.0 - t * 3.0), 6.0);
    if (in.part == 1u) {
      c = glow * core * (0.1 + 0.6 * beads) * (1.0 - 0.6 * in.loc.y);
      a = core * 0.35 * (1.0 - in.loc.y * 0.7);
    } else {
      c = mix(glow, vec3f(1.0, 0.6, 0.85), 0.35) * core * 0.35 * (1.0 - in.loc.y * 0.5);
      a = core * 0.3 * (1.0 - in.loc.y * 0.6);
    }
  }
  c *= in.fog * vis;
  a *= vis * dot(in.fog, vec3f(0.333));
  return vec4f(c, a);
}
