// fx.wgsl: the post-composite effects pass (sky.wgsl first). Drawn into the composited HDR target with manual,
// soft depth against the resolved scene distance, so water, fog and clouds never paint over them:
// drone blob shadow (multiply), motion-blurred props (alpha), navigation-light halos (add), light rings and the
// spark trail toward the next ring (add). The drone body itself is opaque geometry in the main pass (drone.wgsl).

struct Ring { a: vec4f, b: vec4f, c: vec4f } // pos, radius | normal, state | burst age (s), id hash, 0, fade

@group(1) @binding(0) var distT: texture_2d<f32>;
@group(1) @binding(1) var<uniform> U: FxU;
@group(1) @binding(2) var<storage, read> RINGS: array<Ring>;

fn sceneDist(pp: vec2f) -> f32 {
  let s = vec2i(textureDimensions(distT));
  return textureLoad(distT, clamp(vec2i(pp), vec2i(0), s - 1), 0).x;
}
// world-space size of one pixel at distance t
fn pixAt(t: f32) -> f32 { return t * 2.0 * VW.fwd.w * VW.size.w; }
fn toClip(p: vec3f) -> vec4f { return VW.vp * vec4f(p - VW.cam.xyz, 1.0); }
fn clipToPix(c: vec4f) -> vec2f {
  let n = c.xy / max(c.w, 1e-4);
  return vec2f((n.x * 0.5 + 0.5) * VW.size.x, (0.5 - n.y * 0.5) * VW.size.y);
}
// transmittance of the air (aerial + mist) from the eye along d for t metres (sky.wgsl integrals), and the
// Stone Forest cloud sea slab
fn airT(d: vec3f, t: f32) -> f32 {
  let ro = VW.cam.xyz;
  let f0 = rowv(F0); let f1 = rowv(F1); let f2 = rowv(F2);
  let oa = f0.w * odExp(max(ro.y, 0.0), d.y, t, f2.z);
  let om = f1.w * odMist(ro.y, d.y, t, f2.x, f2.y);
  var od = oa + om;
  let c1 = rowv(C1); let c2 = rowv(C2);
  if (c1.w > 0.01) {
    let y0 = ro.y; let y1 = ro.y + d.y * t;
    let lo = min(y0, y1); let hi = max(y0, y1);
    let inside = max(min(hi, c2.y) - max(lo, c2.x), 0.0) / max(abs(d.y), 0.02);
    od += min(inside, t) * c2.z * 0.03 * c1.w;
  }
  return exp(-od);
}
fn hash11(n: u32) -> f32 { return hf(i32(n), 17, 900u); }

// ------------------------------------------------------------------------------------------------- unit cube
const CUBE = array<vec3f, 8>(vec3f(-1, -1, -1), vec3f(1, -1, -1), vec3f(-1, 1, -1), vec3f(1, 1, -1),
  vec3f(-1, -1, 1), vec3f(1, -1, 1), vec3f(-1, 1, 1), vec3f(1, 1, 1));
const CUBEI = array<u32, 36>(0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6,
  1, 3, 5, 3, 7, 5);
const QUAD = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));

// ------------------------------------------------------------------------------------------------- blob shadow
struct SOut { @builtin(position) pos: vec4f }
@vertex fn vsShadow(@builtin(vertex_index) vi: u32) -> SOut {
  var o: SOut;
  let c = CUBE[CUBEI[vi]];
  let agl = U.dinfo.z;
  let r = 0.6 + agl * 0.25;
  let p = U.drone.xyz + vec3f(c.x * r, c.y * (agl * 0.5 + 1.5) - agl * 0.5, c.z * r);
  o.pos = toClip(p);
  if (U.drone.w < 0.5 || agl > 8.0) { o.pos = vec4f(0.0); }
  return o;
}
@fragment fn fsShadow(in: SOut) -> @location(0) vec4f {
  let s = sceneDist(in.pos.xy);
  if (s > 50000.0) { discard; }
  let P = VW.cam.xyz + viewRay(in.pos.xy) * s;
  let h = U.drone.y - P.y;              // height of the drone above this ground point
  let below = sstep(0.03, 0.09, h);     // never darken the drone itself
  let rad = 0.17 + 0.08 * max(h, 0.0); // penumbra grows with height
  let x = length(P.xz - U.drone.xz) / rad;
  let blob = exp(-x * x * 2.2);
  let k = 0.62 * blob * below * sstep(6.0, 0.4, h) * select(1.0, 0.75, U.dinfo.x > 0.5);
  return vec4f(0.0, 0.0, 0.0, k);
}

// ------------------------------------------------------------------------------------------------- props
struct POut { @builtin(position) pos: vec4f, @location(0) lp: vec2f, @location(1) wp: vec3f, @location(2) @interpolate(flat) mi: u32 }
// motor positions (body, metres): RR FR RL FL; camera drone front props sit higher than the rear ones
fn motorPos(i: u32, five: bool) -> vec3f {
  let sx = select(-1.0, 1.0, i == 0u || i == 1u);
  let sz = select(-1.0, 1.0, i == 0u || i == 2u);
  if (five) { return vec3f(sx * 0.078, -0.004, sz * 0.078); }
  let front = sz < 0.0;
  return vec3f(sx * 0.070, select(-0.004, 0.018, front), sz * 0.070);
}
fn propR(five: bool) -> f32 { return select(0.066, 0.0635, five); }

@vertex fn vsProp(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  var o: POut;
  let five = U.dinfo.x > 0.5;
  let R = propR(five) * 1.04;
  let l = QUAD[vi];
  let b = motorPos(ii, five) + vec3f(l.x * R, 0.0, l.y * R);
  let wp = U.drone.xyz + qrot(U.dq, b);
  o.pos = toClip(wp);
  if (U.drone.w < 0.5) { o.pos = vec4f(0.0); }
  o.lp = l * 1.04; o.wp = wp; o.mi = ii;
  return o;
}

// fraction of the exposure during which a blade (angular half width hw) covers angle u, sweep [0, arc]
fn sweepCover(u: f32, hw: f32, arc: f32) -> f32 {
  var s = 0.0;
  for (var k = -1; k <= 1; k++) {
    let x = u + f32(k) * 6.2831853;
    s += max(0.0, min(x + hw, arc) - max(x - hw, 0.0));
  }
  return s;
}

@fragment fn fsProp(in: POut) -> @location(0) vec4f {
  let five = U.dinfo.x > 0.5;
  let r = length(in.lp);
  if (r > 1.0) { discard; }
  let d = length(in.wp - VW.cam.xyz);
  let s = sceneDist(in.pos.xy);
  let vis = clamp((s - d) / 0.012 + 0.5, 0.0, 1.0);
  if (vis <= 0.0) { discard; }
  let lvl = U.motors[in.mi];
  // spin: m0 RR CW, m1 FR CCW, m2 RL CCW, m3 FL CW (seen from above)
  let cw = in.mi == 0u || in.mi == 3u;
  let sdir = select(1.0, -1.0, cw);
  let rps = lvl * select(300.0, 450.0, five);
  let arc = clamp(rps * 6.2831853 * U.dinfo.y, 0.06, 6.2831853);
  let nb = select(2u, 3u, five);
  // blade: chord tapers to the tip; a little sweep-back
  let chord = mix(0.30, 0.13, r) * select(0.85, 1.0, five);
  let hw = chord * 0.5 / max(r, 0.12);
  let th = atan2(in.lp.y, in.lp.x);
  var cov = 0.0;
  for (var k = 0u; k < nb; k++) {
    let a0 = U.props[in.mi] + f32(k) * 6.2831853 / f32(nb) + r * r * 0.35 * sdir;
    var u = sdir * (th - a0);
    u = u - 6.2831853 * floor(u / 6.2831853);
    cov += sweepCover(u, hw, arc);
  }
  cov = min(cov / arc, 1.0);
  // soft tip and hub
  let edge = sstep(1.0, 0.94, r) * sstep(0.08, 0.16, r);
  // blades are nearly opaque; spun up they smear into a disc (a real prop disc at hover reads at ~25% density)
  var a = min(cov * select(2.2, 1.7, five), 1.0) * edge * select(0.9, 0.8, five);
  let blur = sstep(1.0, 6.0, arc);
  a = max(a, blur * 0.07 * edge * sstep(0.55, 0.98, r));
  a *= vis;
  if (a < 0.002) { discard; }
  // light: sun on a thin disc (both sides), sky ambient
  let n = qrot(U.dq, vec3f(0.0, 1.0, 0.0));
  let L = FR.sun.xyz;
  let I = rowv(S3).w;
  let amb = mix(rowv(S3).rgb, rowv(S2).rgb, 0.5) * I * rowv(S6).x * 0.6;
  var alb = select(vec3f(0.2, 0.205, 0.215), vec3f(0.85, 0.30, 0.06), five);
  let sh = 0.35 + 0.65 * abs(dot(n, L));
  var col = alb * (sunCol() * sh * 0.8 + amb);
  // specular sheen of the spinning disc
  let V = normalize(VW.cam.xyz - in.wp);
  let hv = normalize(V + L);
  col += sunCol() * pow(abs(dot(n, hv)), 60.0) * 0.6 * blur;
  return vec4f(col * a, a);
}

// ------------------------------------------------------------------------------------------------- nav lights
struct LOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f }
@vertex fn vsLed(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LOut {
  var o: LOut;
  let five = U.dinfo.x > 0.5;
  // LEDs under the arms: 0, 1 front (white), 2, 3 rear (red)
  let sx = select(-1.0, 1.0, ii == 1u || ii == 3u);
  let front = ii < 2u;
  var b: vec3f;
  if (five) { b = vec3f(sx * 0.050, -0.030, select(0.050, -0.050, front)); }
  else { b = vec3f(sx * 0.070, select(-0.017, 0.004, front), select(0.070, -0.070, front)); }
  let c = U.drone.xyz + qrot(U.dq, b);
  let d = length(c - VW.cam.xyz);
  // occlusion: test the light centre against the scene (max of 5 taps survives MSAA-averaged edges)
  let cc = toClip(c);
  let pp = clipToPix(cc);
  var sd = sceneDist(pp);
  sd = max(sd, sceneDist(pp + vec2f(2.0, 0.0))); sd = max(sd, sceneDist(pp - vec2f(2.0, 0.0)));
  sd = max(sd, sceneDist(pp + vec2f(0.0, 2.0))); sd = max(sd, sceneDist(pp - vec2f(0.0, 2.0)));
  var vis = clamp((sd - d) / 0.02 + 1.0, 0.0, 1.0);
  if (cc.w <= 0.0 || U.drone.w < 0.5) { vis = 0.0; }
  // size: a 1 cm glow, never under ~3 px so the drone can be found against the sky
  let ps = pixAt(d);
  let sz = max(0.01, ps * 3.0);
  let V = normalize(VW.cam.xyz - c);
  let l = QUAD[vi];
  let wp = c + (VW.right.xyz * l.x + VW.up.xyz * l.y) * sz;
  o.pos = toClip(wp);
  if (vis <= 0.0) { o.pos = vec4f(0.0); }
  o.uv = l;
  // energy: a small light spreads over more pixels far away; keep some of it so it still reads at 300 m
  let e = pow(0.01 / sz, 1.1) * vis * airT(-V, d);
  let blink = select(1.0, 0.55 + 0.45 * step(0.5, fract(U.dinfo.w * 1.1)), !front);
  o.col = select(vec3f(14.0, 0.7, 0.3), vec3f(9.0, 9.4, 10.0), front) * e * blink;
  return o;
}
@fragment fn fsLed(in: LOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  let g = exp(-r2 * 7.0) + 0.25 * exp(-r2 * 2.0);
  return vec4f(in.col * g, 0.0);
}

// ------------------------------------------------------------------------------------------------- rings
struct ROut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) ri: u32 }
fn basis(n: vec3f) -> mat3x3f {
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let t1 = normalize(cross(a, n));
  let t2 = cross(n, t1);
  return mat3x3f(t1, t2, n);
}
// half thickness of the proxy box around the tube (the halo must fade out inside it)
fn ringExt(C: vec3f, r: f32) -> f32 { return max(0.9, pixAt(max(length(C - VW.cam.xyz) - r, 0.1)) * 7.0); }
fn ringRadius(g: Ring) -> f32 {
  let age = g.c.x;
  if (g.b.w > 1.5) { return g.a.w * (1.0 + 0.22 * (1.0 - exp(-age * 3.0))); }
  return g.a.w;
}
@vertex fn vsRing(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ROut {
  var o: ROut;
  let g = RINGS[ii];
  let r = ringRadius(g);
  let C = g.a.xyz;
  let ext = ringExt(C, r);
  let B = basis(g.b.xyz);
  let c = CUBE[CUBEI[vi]];
  let p = C + B * vec3f(c.x * (r + ext), c.y * (r + ext), c.z * ext);
  o.pos = toClip(p);
  if (g.a.w <= 0.0 || g.c.w <= 0.0) { o.pos = vec4f(0.0); }
  o.ri = ii;
  return o;
}

fn realmTint() -> vec3f {
  // a whisper of the realm's own light: its sunward horizon, or its emission colour where it has one
  let s4 = rowv(S4).rgb;
  var t = s4 / max(max(s4.r, max(s4.g, s4.b)), 1e-3);
  let m6 = rowv(M6);
  if (m6.w > 0.05) { t = mix(t, m6.rgb / max(max(m6.r, max(m6.g, m6.b)), 1e-3), 0.7); }
  return mix(vec3f(1.0), t, 0.55);
}

@fragment fn fsRing(in: ROut) -> @location(0) vec4f {
  let g = RINGS[in.ri];
  let C = g.a.xyz; let n = g.b.xyz; let r = ringRadius(g);
  let O = VW.cam.xyz;
  let D = viewRay(in.pos.xy);
  // closest approach between the view ray and the ring circle (plane hit, then 3 alternating projections)
  let dn = dot(D, n);
  var t = dot(C - O, D);
  if (abs(dn) > 0.08) { t = dot(C - O, n) / dn; }
  t = max(t, 0.0);
  var P = O + D * t;
  var Q = C;
  for (var i = 0; i < 4; i++) {
    var v = P - C; v -= n * dot(v, n);
    let lv = length(v);
    if (lv < 1e-4) { v = basis(n)[0]; } else { v /= lv; }
    Q = C + v * r;
    t = max(dot(Q - O, D), 0.0);
    P = O + D * t;
  }
  let dm = length(P - Q);
  let tq = length(Q - O);
  // soft intersection with the scene: fade as the ring point nears the surface behind it
  let s = sceneDist(in.pos.xy);
  let soft = 0.35 + tq * 0.004;
  let vis = clamp((s - t) / soft, 0.0, 1.0);
  if (vis <= 0.0) { discard; }

  let ps = pixAt(tq);
  let tube = 0.045;
  let wc = max(tube, ps * 0.9);
  let core = exp(-(dm * dm) / (wc * wc) * 1.6) * pow(tube / wc, 0.55);
  // halo: a few pixels wide far away (so a ring reads at 300 m), at most a hand's width up close, and dimmer there,
  // so a ring a few metres away is a crisp line of light rather than a milky band
  let wh = max(0.25, ps * 3.5);
  let ext = ringExt(C, r);
  let win = sstep(ext, ext * 0.55, dm);
  let halo = exp(-dm / wh) * pow(0.5 / max(wh, 0.5), 0.6) * mix(0.5, 1.0, sstep(0.25, 0.5, wh)) * win;

  let state = g.b.w;
  let tm = U.dinfo.w;
  let tint = realmTint();
  var col: vec3f;
  if (state > 1.5) {
    // passed: a white burst that widens, then a faint ghost that fades
    let age = g.c.x;
    let burst = exp(-age * 4.0);
    let ghost = 0.25 * exp(-age * 0.7);
    col = mix(tint, vec3f(1.0, 0.95, 0.85), burst) * (core * (40.0 * burst + 3.0 * ghost) + halo * (6.0 * burst + 0.3 * ghost));
  } else if (state > 0.5) {
    // next: bright warm white, breathing gently, with a bead of light running round it
    let pulse = 0.82 + 0.18 * sin(tm * 2.4);
    var v = Q - C; let B = basis(n);
    let ang = atan2(dot(v, B[1]), dot(v, B[0]));
    var da = ang - tm * 1.9; da -= 6.2831853 * floor(da / 6.2831853 + 0.5);
    let bead = exp(-da * da * r * r * 1.2);
    let hot = vec3f(1.0, 0.86, 0.62);
    col = hot * (core * (22.0 * pulse + 30.0 * bead) + halo * (1.5 * pulse + 1.0 * bead));
  } else {
    // idle: dim, tinted by the realm; rings further down the line fade out
    let k = 0.9 * g.c.w;
    col = tint * (core * 5.0 + halo * 0.25) * k;
  }
  col *= vis * airT(D, tq);
  return vec4f(col, 0.0);
}

// ------------------------------------------------------------------------------------------------- sparks
struct KOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f }
@vertex fn vsSpark(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> KOut {
  var o: KOut;
  let N = U.sp0.w;
  let A = U.sp0.xyz; let Bp = U.sp1.xyz;
  let tm = U.dinfo.w;
  let h = hash11(ii);
  let s = fract(f32(ii) / max(N, 1.0) + tm * 0.07 + h * 0.013);
  let ax = Bp - A;
  let L = length(ax);
  let dir = ax / max(L, 1e-3);
  let B = basis(dir);
  // a loose helix of motes drifting along the line
  let ph = h * 6.2831853 + tm * (0.6 + h * 0.5) + s * 9.0;
  let rad = (0.25 + 0.35 * hash11(ii + 77u)) * sin(3.1415926 * s);
  let c = A + ax * s + (B[0] * cos(ph) + B[1] * sin(ph)) * rad;
  let d = length(c - VW.cam.xyz);
  let ps = pixAt(d);
  // a guide, not a light source: each mote stays about 1.5 px wide at any distance (so a run of near motes never
  // stacks into a bright column), dim, and fades out within ~20 m of the camera and of the drone
  let sz = max(ps * 1.6, 0.004);
  let l = QUAD[vi];
  let wp = c + (VW.right.xyz * l.x + VW.up.xyz * l.y) * sz;
  o.pos = toClip(wp);
  let tw = 0.6 + 0.4 * sin(tm * (3.0 + h * 4.0) + h * 40.0);
  let near = sstep(5.0, 22.0, d) * sstep(4.0, 20.0, length(c - U.drone.xyz));
  let e = sin(3.1415926 * s) * tw * near * U.sp1.w * airT(normalize(c - VW.cam.xyz), d);
  // hide motes behind the scene (tested at the centre)
  let pp = clipToPix(o.pos);
  let vis = clamp((sceneDist(pp) - d) / 0.5, 0.0, 1.0);
  if (f32(ii) >= N || o.pos.w <= 0.0 || vis <= 0.0 || L < 1.0 || e <= 0.001) { o.pos = vec4f(0.0); }
  o.uv = l;
  o.col = vec3f(1.0, 0.8, 0.5) * e * vis * 0.55;
  return o;
}
@fragment fn fsSpark(in: KOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  return vec4f(in.col * exp(-r2 * 6.0), 0.0);
}
