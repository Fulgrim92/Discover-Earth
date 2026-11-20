// xr.wgsl: what only VR needs (sky.wgsl first). Controllers in the opaque pass (a procedural mesh from fx/xrfx.js,
// lit like the drone body so hands sit in the scene's light) and the in-world HUD panel in the effects pass: a
// dot-matrix 5x7 font, mode / view / speed / height and the two sticks, drawn analytically per pixel.

struct XrU {
  g: array<vec4f, 4>, // left grip pos (w = tracked), left grip quat, right grip pos, right grip quat
  hp: vec4f,          // HUD centre (world), visible
  hq: vec4f,          // HUD orientation (panel +Z faces the eyes)
  hs: vec4f,          // half width, half height (m)
  v0: vec4f,          // flight mode (0 GPS, 1 Angle, 2 Acro), view (0 line of sight, 1 FPV), speed (m/s), height (m)
  v1: vec4f,          // physical sticks lx, ly, rx, ry (-1..1, up/right +)
  v2: vec4f,          // sport, boost, rings passed, comfort vignette on
}
@group(1) @binding(0) var<uniform> XU: XrU;
@group(1) @binding(1) var<storage, read> CM: array<f32>;

fn xq(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// ---------------- controllers ----------------
struct CV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) @interpolate(flat) mat: u32,
}
@vertex fn vsCtl(@builtin(vertex_index) vi: u32, @builtin(instance_index) hand: u32) -> CV {
  var o: CV;
  let p = XU.g[hand * 2u]; let q = XU.g[hand * 2u + 1u];
  if (p.w < 0.5) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); return o; }
  let k = vi * 7u;
  var bp = vec3f(CM[k], CM[k + 1u], CM[k + 2u]);
  var bn = vec3f(CM[k + 3u], CM[k + 4u], CM[k + 5u]);
  if (hand == 0u) { bp.x = -bp.x; bn.x = -bn.x; } // left hand: mirror image
  o.wp = p.xyz + xq(q, bp);
  o.n = xq(q, bn);
  o.mat = u32(CM[k + 6u]);
  o.pos = VW.vp * vec4f(o.wp - VW.cam.xyz, 1.0);
  return o;
}
struct CF { @location(0) c: vec4f, @location(1) d: vec4f }
@fragment fn fsCtl(in: CV, @builtin(front_facing) ff: bool) -> CF {
  var n = normalize(in.n);
  if (!ff) { n = -n; }
  let V = normalize(VW.cam.xyz - in.wp);
  let L = FR.sun.xyz;
  var alb = vec3f(0.014, 0.015, 0.018); var rough = 0.4; var em = vec3f(0.0);
  if (in.mat == 1u) { alb = vec3f(0.55, 0.57, 0.6); rough = 0.3; }
  if (in.mat == 2u) { alb = vec3f(0.02); rough = 0.7; }
  if (in.mat == 3u) { em = vec3f(0.3, 1.0, 0.9) * 2.5; }
  let I = rowv(S3).w;
  let amb = mix(rowv(S3).rgb, rowv(S2).rgb, 0.5 + 0.5 * n.y) * I * rowv(S6).x * 0.9 + rowv(S7).rgb * rowv(S7).w;
  let ndl = max(dot(n, L), 0.0);
  let h = normalize(L + V);
  let a = rough * rough; let a2 = a * a;
  let nh = max(dot(n, h), 0.0); let dd = nh * nh * (a2 - 1.0) + 1.0;
  let spec = a2 / (PI * dd * dd) * 0.04;
  var c = alb * (sunCol() * ndl * select(1.0, 0.0, L.y < -0.05) + amb) + sunCol() * ndl * spec + em;
  let fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
  c += amb * fres * 0.25;
  var o: CF;
  o.c = vec4f(c, 1.0);
  o.d = vec4f(length(VW.cam.xyz - in.wp), 0.0, 0.0, 1.0);
  return o;
}

// ---------------- HUD panel ----------------
// panel space: 100 x 64 dots, origin top-left; one dot = 2 * hs.x / 100 m
const GLYPH = array<vec2u, 29>(
  vec2u(0xa33ae62eu, 0x3u), vec2u(0x884210c4u, 0x3u), vec2u(0xc444422eu, 0x7u), vec2u(0xe107420fu, 0x3u),
  vec2u(0x11f4a988u, 0x2u), vec2u(0xa3083c3fu, 0x3u), vec2u(0xa317844cu, 0x3u), vec2u(0x8422221fu, 0x0u),
  vec2u(0xa317462eu, 0x3u), vec2u(0x910f462eu, 0x1u), vec2u(0x8c000000u, 0x1u), vec2u(0x00000000u, 0x0u),
  vec2u(0x631fc62eu, 0x4u), vec2u(0xa210862eu, 0x3u), vec2u(0xe318c62fu, 0x3u), vec2u(0xc217843fu, 0x7u),
  vec2u(0x4217843fu, 0x0u), vec2u(0xa31e862eu, 0x7u), vec2u(0xc2108421u, 0x7u), vec2u(0x631ad771u, 0x4u),
  vec2u(0x631cd671u, 0x4u), vec2u(0xa318c62eu, 0x3u), vec2u(0x4217c62fu, 0x0u), vec2u(0x5257c62fu, 0x4u),
  vec2u(0xe107043eu, 0x3u), vec2u(0x0842109fu, 0x1u), vec2u(0x1518c631u, 0x1u), vec2u(0x44222110u, 0x0u),
  vec2u(0x000f8000u, 0x0u));
// codes: digits 0-9, .=10 space=11 A=12 C=13 D=14 E=15 F=16 G=17 L=18 M=19 N=20 O=21 P=22 R=23 S=24 T=25 V=26 /=27 -=28
const SP = 11u;
const MODEW = array<u32, 15>(17u, 22u, 24u, SP, SP, 12u, 20u, 17u, 18u, 15u, 12u, 13u, 23u, 21u, SP); // GPS ANGLE ACRO
const VIEWW = array<u32, 6>(18u, 21u, 24u, 16u, 22u, 26u);                                         // LOS FPV
const LBL = array<u32, 9>(24u, 22u, 14u, 12u, 18u, 25u, 19u, 27u, 24u);                            // SPD ALT M/S

fn glyphBit(code: u32, gx: i32, gy: i32) -> bool {
  if (gx < 0 || gx > 4 || gy < 0 || gy > 6) { return false; }
  let i = u32(gy * 5 + gx);
  let g = GLYPH[code];
  if (i < 32u) { return ((g.x >> i) & 1u) == 1u; }
  return ((g.y >> (i - 32u)) & 1u) == 1u;
}
// digit k (0 = units) of a non-negative integer, blank for leading zeros above the units
fn digitCode(v: u32, k: u32) -> u32 {
  var p = 1u;
  for (var i = 0u; i < k; i++) { p *= 10u; }
  if (k > 0u && v < p) { return SP; }
  return (v / p) % 10u;
}
// character at column c of text row r (or SP)
fn charAt(r: i32, c: i32) -> u32 {
  if (r == 0) {
    if (c >= 0 && c < 5) { return MODEW[u32(clamp(XU.v0.x, 0.0, 2.0)) * 5u + u32(c)]; }
    if (c >= 6 && c < 11 && XU.v2.x > 0.5 && XU.v0.x < 0.5) { return array<u32, 5>(24u, 22u, 21u, 23u, 25u)[c - 6]; } // SPORT
    if (c >= 12 && c < 15) { return VIEWW[u32(clamp(XU.v0.y, 0.0, 1.0)) * 3u + u32(c - 12)]; }
    return SP;
  }
  if (c >= 0 && c < 3) { return LBL[u32(r - 1) * 3u + u32(c)]; }
  if (r == 1) {
    // speed with one decimal: cols 5..9 = "xxx.x"
    let v = u32(round(clamp(XU.v0.z, 0.0, 999.9) * 10.0));
    if (c == 8) { return 10u; }
    if (c == 9) { return v % 10u; }
    if (c >= 5 && c < 8) { return digitCode(v / 10u, u32(7 - c)); }
    if (c >= 11 && c < 14) { return LBL[6 + c - 11]; }
    return SP;
  }
  if (r == 2) {
    let v = u32(round(clamp(XU.v0.w, 0.0, 99999.0)));
    if (c >= 5 && c < 10) { return digitCode(v, u32(9 - c)); }
    if (c == 11) { return 19u; }
    return SP;
  }
  return SP;
}

struct HV { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vsHud(@builtin(vertex_index) vi: u32) -> HV {
  var o: HV;
  if (XU.hp.w < 0.5) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); return o; }
  let k = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0))[vi];
  let wp = XU.hp.xyz + xq(XU.hq, vec3f(k.x * XU.hs.x, k.y * XU.hs.y, 0.0));
  o.pos = VW.vp * vec4f(wp - VW.cam.xyz, 1.0);
  o.uv = vec2f(k.x * 0.5 + 0.5, 0.5 - k.y * 0.5);
  return o;
}
fn box(p: vec2f, c: vec2f, h: vec2f, r: f32) -> f32 {
  let q = abs(p - c) - h + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
@fragment fn fsHud(in: HV) -> @location(0) vec4f {
  let p = in.uv * vec2f(100.0, 64.0);
  let aa = max(fwidth(p.x), 1e-3) * 0.75;
  // panel: dark glass with a hairline edge
  let dpan = box(p, vec2f(50.0, 32.0), vec2f(49.0, 31.0), 5.0);
  let inPan = 1.0 - sstep(-aa, aa, dpan);
  if (inPan <= 0.0) { discard; }
  var col = vec3f(0.012, 0.018, 0.03);
  var lit = 0.0;
  let edge = 1.0 - sstep(0.0, aa * 2.0 + 0.35, abs(dpan + 0.6));
  let ink = vec3f(1.5, 1.6, 1.7);
  let teal = vec3f(0.35, 1.5, 1.35);
  col = mix(col, ink * 0.35, edge * 0.6);
  // text rows at y = 6, 19, 31 (7 dots tall), columns of 6 dots from x = 6
  for (var r = 0; r < 3; r++) {
    let y0 = select(select(31.0, 19.0, r == 1), 6.0, r == 0);
    let gy = i32(floor(p.y - y0));
    if (gy < 0 || gy > 6) { continue; }
    let cx = (p.x - 4.0) / 6.0;
    let c = i32(floor(cx));
    if (c < 0 || c > 15) { continue; }
    let gx = i32(floor(p.x - 4.0 - f32(c) * 6.0));
    let code = charAt(r, c);
    if (glyphBit(code, gx, gy)) {
      // round LED dot inside its cell
      let f = fract(p - vec2f(4.0, y0)) - 0.5;
      let dot = 1.0 - sstep(0.36 - aa, 0.36 + aa, length(f));
      var ic = ink;
      if (r == 0 && c < 5) { ic = teal; }
      if (r > 0 && c < 3) { ic = ink * 0.55; }
      col = mix(col, ic, dot); lit = max(lit, dot);
    }
  }
  // sticks: two square gates with a dot each (left: yaw x / throttle y; right: roll x / pitch y)
  for (var s = 0; s < 2; s++) {
    let c = vec2f(select(70.0, 30.0, s == 0), 51.0);
    let h = 9.5;
    let dg = abs(box(p, c, vec2f(h), 2.0));
    col = mix(col, ink * 0.3, 1.0 - sstep(0.25 - aa, 0.25 + aa, dg));
    let cross = min(abs(p.x - c.x), abs(p.y - c.y));
    col = mix(col, ink * 0.12, (1.0 - sstep(0.15 - aa, 0.15 + aa, cross)) * step(max(abs(p.x - c.x), abs(p.y - c.y)), h));
    let st = select(XU.v1.zw, XU.v1.xy, s == 0);
    let dp = c + vec2f(st.x, -st.y) * (h - 2.2);
    let dd = length(p - dp);
    let dm = 1.0 - sstep(1.7 - aa, 1.7 + aa, dd);
    col = mix(col, teal, dm); lit = max(lit, dm);
    col += teal * exp(-dd * dd * 0.18) * 0.12;
  }
  // boost: a thin bar along the bottom edge
  if (XU.v2.y > 0.5) { col = mix(col, teal, (1.0 - sstep(0.4 - aa, 0.4 + aa, abs(p.y - 61.5))) * step(abs(p.x - 50.0), 20.0)); }
  // premultiplied over the scene: glass at 78 %, lit dots nearly opaque
  let a = mix(0.78, 0.97, lit) * inPan;
  return vec4f(col * a, a);
}
