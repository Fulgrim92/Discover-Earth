// sky.wgsl: analytic sky per realm (sun, glow, stars, aurora, ringed giant, moons) and the fog integrals.
// (Clouds are volumetric: clouds.wgsl.) Shared by the opaque-pass sky draw, the composite and reflections.

fn rowv(f: u32) -> vec4f { return FR.row[f]; }

fn hg(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

fn dirAzEl(az: f32, el: f32) -> vec3f {
  let a = radians(az); let e = radians(el);
  return vec3f(sin(a) * cos(e), sin(e), -cos(a) * cos(e));
}

fn sunCol() -> vec3f {
  let L = FR.sun.xyz;
  return rowv(S1).rgb * rowv(S0).z * sstep(-0.035, 0.06, L.y);
}

// base sky gradient without the sun disc / night objects (used by fog and reflections)
fn skyBase(d: vec3f) -> vec3f {
  let L = FR.sun.xyz;
  let I = rowv(S3).w;
  let zen = rowv(S2).rgb * I;
  let hor = rowv(S3).rgb * I;
  let sw = rowv(S4).rgb * I;
  let y = max(d.y, 0.0);
  let t = pow(1.0 - y, rowv(S2).w);
  var c = mix(zen, hor, t);
  let dl = length(d.xz); let ll = length(L.xz);
  var az = 0.5;
  if (dl > 1e-4 && ll > 1e-4) { az = dot(d.xz / dl, L.xz / ll) * 0.5 + 0.5; }
  let sunw = pow(az, rowv(S4).w) * t * t;
  c = mix(c, sw, sunw * 0.85);
  // afterglow band for suns below the horizon
  c += sw * rowv(S6).z * exp(-y * 14.0) * pow(az, 2.5) * 0.7;
  // Lumen: warm rose air under the ringed giant (light thrown back by its day side)
  let gz = rowv(S5).z;
  if (gz > 0.01) {
    let G = giantDir();
    var ga = 0.5;
    if (dl > 1e-4) { ga = dot(d.xz / dl, normalize(G.xz)) * 0.5 + 0.5; }
    c += vec3f(0.95, 0.38, 0.42) * I * gz * pow(ga, 6.0) * exp(-y * 5.0) * 0.55;
  }
  // below the horizon: a slightly darker haze
  if (d.y < 0.0) { c = mix(c, hor * 0.75, sstep(0.0, -0.25, d.y)); }
  // Mie glow around the sun
  let mu = dot(d, L);
  let sc = sunCol();
  c += sc * rowv(S1).w * (hg(mu, 0.8) * 0.06 + hg(mu, 0.35) * 0.04);
  return c;
}

// ---- stars: three magnitude layers, a steep brightness distribution, colour temperature, slight twinkle ----
fn starCol(t: f32) -> vec3f {
  // hot blue-white .. white .. orange-red (rough blackbody, normalised luminance)
  let hot = vec3f(0.62, 0.74, 1.25); let mid = vec3f(1.0, 0.98, 0.94); let cool = vec3f(1.35, 0.82, 0.5);
  return select(mix(mid, cool, (t - 0.55) / 0.45), mix(hot, mid, t / 0.55), t < 0.55);
}
const MW_N: vec3f = vec3f(0.36, 0.46, 0.81); // Milky Way pole

fn stars(d: vec3f, pix: f32, mw: f32) -> vec3f {
  var s = vec3f(0.0);
  let band = exp(-pow(dot(d, normalize(MW_N)), 2.0) * 22.0);
  for (var l = 0; l < 3; l++) {
    let sc = 110.0 * pow(2.1, f32(l));
    let p = d * sc;
    let c = floor(p);
    let ci = vec3i(c);
    let h = hf3(ci.x, ci.y, ci.z + l * 1000);
    // more (faint) stars per cell in the finer layers and inside the galactic band
    let prob = (0.03 + 0.015 * f32(l)) * (1.0 + band * mw * 2.5);
    if (h < prob) {
      let o = vec3f(hf3(ci.x, ci.y, ci.z + 77), hf3(ci.x, ci.y, ci.z + 78), hf3(ci.x, ci.y, ci.z + 79));
      let sp = c + 0.15 + 0.7 * o;
      let dd = length(p - sp);
      let rad = max(pix * sc * 0.55, 0.02);
      // magnitude: most stars faint, a few very bright (brighter in the coarse layer)
      let m = h / prob;
      let mag = exp(-m * 7.0 - f32(l) * 1.2) * 7.0;
      let tw = 0.82 + 0.18 * sin(FR.time.x * (1.7 + 4.0 * o.x) + o.y * 40.0);
      let ct = fract(o.z * 7.31 + o.x * 3.1);
      s += starCol(ct * ct) * mag * tw * exp(-dd * dd / (rad * rad)) * min(1.0, 0.02 / (rad * rad) + 0.25);
    }
  }
  return s;
}

// faint galactic band with dust lanes (Ice and Lumen nights)
fn milkyWay(d: vec3f) -> vec3f {
  let n = normalize(MW_N);
  let b = dot(d, n);
  let band = exp(-b * b * 18.0);
  if (band < 0.01) { return vec3f(0.0); }
  let u = normalize(cross(n, vec3f(0.0, 1.0, 0.0)));
  let v = cross(n, u);
  let q = vec2f(atan2(dot(d, v), dot(d, u)) * 2.2, b * 9.0);
  let cl = fbm(q * 1.4, 5, 450u) * 0.5 + 0.5;
  let dust = sstep(0.05, 0.4, fbm(q * vec2f(3.0, 5.0) + 7.0, 4, 451u) + (0.25 - abs(b) * 3.0));
  let core = exp(-b * b * 60.0);
  var c = vec3f(0.55, 0.6, 0.85) * band * (0.5 + cl) + vec3f(0.95, 0.8, 0.6) * core * cl * 0.8;
  c *= 1.0 - 0.75 * dust * sstep(0.0, 0.4, band);
  return c * 0.012;
}

// ---- aurora: meandering curtains at altitude (vertical sheets standing on a wavy foot line), fine vertical rays,
// a bright ragged green lower edge fading up through teal to magenta, uneven brightness with dark gaps.
// Each view ray meets each sheet once (fixed-point solve on the foot line), so it costs a few ALU per curtain.
// Altitude units: 1 = curtain base (~100 km); the sheets reach 3.4.
fn auroraCen(x: f32, off: f32, amp: f32, fr: f32, tm: f32) -> f32 {
  return off + amp * sin(x * 0.42 + tm * 0.03 + fr * 2.1) + 0.24 * amp * sin(x * 1.37 - tm * 0.05 + fr * 4.0) + 0.05 * sin(x * 3.3 + tm * 0.17 + fr);
}
fn aurora(d: vec3f) -> vec3f {
  if (d.y < 0.004) { return vec3f(0.0); }
  let tm = FR.time.x;
  let green = vec3f(0.1, 1.0, 0.4);
  let teal = vec3f(0.04, 0.55, 0.7);
  let mag = vec3f(0.6, 0.08, 0.9);
  var acc = vec3f(0.0);
  let g = d.xz / d.y; // ground-plane point per unit altitude
  for (var r = 0; r < 4; r++) {
    let fr = f32(r);
    let ang = 0.25 + fr * 0.33;
    let ax = vec2f(cos(ang), sin(ang));
    let px = vec2f(-ax.y, ax.x);
    let off = -(0.75 + fr * 0.95 + fr * fr * 0.25);
    let amp = 0.6 - fr * 0.08;
    let gx = dot(g, ax); let gy = dot(g, px);
    if (gy * off <= 1e-4) { continue; }
    var H = off / gy;
    for (var k = 0; k < 4; k++) { H = auroraCen(gx * H, off, amp, fr, tm) / gy; }
    let res = abs(gy * H - auroraCen(gx * H, off, amp, fr, tm));
    if (H < 0.9 || H > 4.0 || res > 0.15) { continue; }
    let x = gx * H;
    let u = sqrt(max(H - 1.0, 0.0) / 2.4); // 0 at the lower edge, 1 at the top
    // fine rays along the sheet, rippling sideways; patches with dark gaps between them
    let xr = x * 24.0 + 2.5 * sin(x * 1.7 + tm * 0.25) + tm * 0.2;
    let rays = 0.2 + 0.8 * pow(0.5 + 0.5 * vn(vec2f(xr, fr * 9.0), 460u), 2.5) + 0.35 * pow(0.5 + 0.5 * vn(vec2f(xr * 3.1, fr * 3.0), 464u), 4.0);
    let pat = sstep(-0.45, 0.35, vn(vec2f(x * 0.8 - tm * 0.02, fr * 5.0 + 1.0), 461u) + 0.35 * vn(vec2f(x * 2.9 + tm * 0.04, fr), 462u));
    let edge = 0.06 * (0.5 + 0.5 * vn(vec2f(x * 9.0 + tm * 0.1, fr * 3.0), 463u));
    let h1 = H - 1.0 - edge;
    let prof = sstep(-0.03, 0.02, h1) * (exp(-max(h1, 0.0) * 1.6) * 0.8 + 0.2 * exp(-max(h1, 0.0) * 0.5)) * sstep(3.4, 2.6, H);
    // brighter where we look along the sheet (longer path through it)
    let slope = 0.42 * amp * cos(x * 0.42 + tm * 0.03 + fr * 2.1);
    let tang = normalize(vec2f(1.0, slope));
    let sn = abs(tang.x * gy - tang.y * gx) / max(length(vec2f(gx, gy)), 1e-4);
    let path = min(1.0 / max(sn, 0.12), 5.0);
    var col = mix(green, teal, sstep(0.12, 0.5, u));
    col = mix(col, mag, sstep(0.4, 0.95, u));
    acc += col * (rays * pat * prof * path * (1.0 - fr * 0.17));
  }
  let fade = sstep(0.004, 0.08, d.y);
  return acc * fade * 0.3;
}

// ---- ringed giant + two moons for Lumen Deep, lit by the realm sun; returns rgb and coverage ----
fn ringDens(rr: f32) -> f32 {
  var dens = 0.55 + 0.25 * sin(rr * 41.0) + 0.2 * sin(rr * 13.0 + 1.0) + 0.1 * sin(rr * 97.0);
  dens *= sstep(1.3, 1.42, rr) * sstep(2.25, 2.1, rr) * (1.0 - 0.9 * sstep(1.83, 1.87, rr) * sstep(1.96, 1.92, rr));
  return clamp(dens, 0.0, 1.0) * 0.75;
}
fn giantDir() -> vec3f { return dirAzEl(38.0, 26.0); }
fn giant(d: vec3f) -> vec4f {
  let G = giantDir();
  let rad = sin(radians(12.5));
  let L = FR.sun.xyz;
  let gup = normalize(vec3f(0.0, 1.0, 0.0) - G * G.y);
  let grt = normalize(cross(G, gup));
  let pole = normalize(normalize(gup * 0.92 + grt * 0.4) - G * 0.22);
  var col = vec3f(0.0); var a = 0.0;
  // planet
  let b = dot(d, G);
  let disc = b * b - (1.0 - rad * rad);
  var tp = 1e9;
  if (disc > 0.0 && b > 0.0) {
    tp = b - sqrt(disc);
    let P = d * tp;
    let N = normalize(P - G);
    let lat = dot(N, pole);
    let ex = normalize(cross(pole, vec3f(0.0, 0.0, 1.0)));
    let lon = atan2(dot(N, cross(pole, ex)), dot(N, ex));
    let bandv = lat * 9.0 + 0.6 * fbm(vec2f(lon * 3.0, lat * 18.0), 4, 410u);
    var pc = mix(vec3f(0.85, 0.62, 0.42), vec3f(0.48, 0.3, 0.42), 0.5 + 0.5 * sin(bandv * 2.3));
    pc = mix(pc, vec3f(0.95, 0.88, 0.75), sstep(0.6, 0.95, sin(bandv * 1.1 + 1.0)) * 0.5);
    let ndl = dot(N, L);
    var lit = sstep(-0.08, 0.35, ndl);
    // ring shadow on the planet: march from the surface toward the sun to the ring plane
    let dl = dot(L, pole);
    if (abs(dl) > 1e-4) {
      let sr = dot(G - P, pole) / dl;
      if (sr > 0.0) { lit *= 1.0 - 0.85 * ringDens(length(P + L * sr - G) / rad); }
    }
    let rim = pow(1.0 - max(dot(N, -d), 0.0), 3.0);
    // night side: faint violet sky-shine; day side rim haze
    col = pc * (lit * 1.25 + 0.018) + vec3f(0.55, 0.45, 1.0) * rim * (0.08 + 0.6 * lit);
    a = sstep(0.0, 0.002, disc);
  }
  // rings
  let dn = dot(d, pole);
  if (abs(dn) > 1e-4) {
    let tr = dot(G, pole) / dn;
    if (tr > 0.0) {
      let X = d * tr;
      let rr = length(X - G) / rad;
      if (rr > 1.3 && rr < 2.25) {
        let dens = ringDens(rr);
        // planet shadow on the rings (soft edge)
        let toS = X - G;
        let bs = dot(toS, L);
        let ax = length(toS - L * bs) / rad;
        let shadow = 1.0 - select(0.0, 0.9 * sstep(1.04, 0.96, ax), bs < 0.0);
        // lit face vs. back face of the rings
        let face = 0.55 + 0.45 * abs(dot(L, pole));
        let rc = vec3f(0.9, 0.8, 0.7) * (0.85 * shadow * face + 0.03);
        if (tr < tp) { col = mix(col, rc, dens); a = max(a, dens); }
        else if (a < 1.0) { col = mix(rc, col, a); a = max(a, dens); }
      }
    }
  }
  // moons
  for (var m = 0; m < 2; m++) {
    let M = select(dirAzEl(115.0, 18.0), dirAzEl(-20.0, 34.0), m == 1);
    let mr = select(sin(radians(1.6)), sin(radians(0.9)), m == 1);
    let bm = dot(d, M);
    let dm = bm * bm - (1.0 - mr * mr);
    if (dm > 0.0 && bm > 0.0) {
      let N = normalize(d * (bm - sqrt(dm)) - M);
      let mc = select(vec3f(0.8, 0.85, 0.95), vec3f(0.95, 0.75, 0.85), m == 1);
      col = mix(col, mc * (sstep(-0.1, 0.3, dot(N, L)) + 0.03), sstep(0.0, 2e-5, dm));
      a = max(a, sstep(0.0, 2e-5, dm));
    }
  }
  return vec4f(col, a);
}

fn skyFull(d: vec3f, pix: f32) -> vec3f {
  var c = skyBase(d);
  let L = FR.sun.xyz;
  let mu = dot(d, L);
  let dr = radians(rowv(S0).w * 0.5);
  let disc = sstep(cos(dr), cos(dr * 0.7), mu);
  c += sunCol() * disc * 60.0;
  let s5 = rowv(S5);
  let night = 1.0 - sstep(-0.05, 0.1, L.y);
  if (s5.x > 0.01 && d.y > 0.0) {
    let hz = sstep(0.0, 0.12, d.y);
    let mw = sstep(0.45, 0.9, s5.x);
    var sky = stars(d, pix, mw) * 0.55;
    sky += milkyWay(d) * mw;
    c += sky * s5.x * mix(0.25, 1.0, night) * hz;
  }
  if (s5.y > 0.01) { c += aurora(d) * s5.y; }
  if (s5.z > 0.01 && d.y > -0.05) {
    let g = giant(d);
    c = mix(c, g.rgb * s5.z + c * 0.12, g.a * s5.z);
  }
  return c;
}

// ---- fog: aerial perspective (exponential) + low mist (capped exponential) ----
fn odExp(y0: f32, dy: f32, t: f32, k: f32) -> f32 {
  // integral of exp(-k y) along y0 + dy s for s in [0, t]
  // written as a difference of two exponentials so a long ray down from altitude cannot overflow (inf * 0 = NaN)
  let a = k * dy * t;
  if (abs(a) < 1e-4) { return exp(-k * y0) * t; }
  return (exp(-k * y0) - exp(-k * (y0 + dy * t))) / (k * dy);
}
fn odMist(y0: f32, dy: f32, t: f32, top: f32, k: f32) -> f32 {
  // density 1 below `top`, exp(-k (y - top)) above
  let y1 = y0 + dy * t;
  if (y0 <= top && y1 <= top) { return t; }
  if (y0 >= top && y1 >= top) { return odExp(y0 - top, dy, t, k); }
  let tc = (top - y0) / dy;
  if (y0 < top) { return tc + odExp(0.0, dy, t - tc, k); }
  return odExp(y0 - top, dy, tc, k) + (t - tc);
}

fn applyFog(col: vec3f, ro: vec3f, d: vec3f, t: f32) -> vec3f {
  let f0 = rowv(F0); let f1 = rowv(F1); let f2 = rowv(F2);
  let oa = f0.w * odExp(max(ro.y, 0.0), d.y, t, f2.z);
  let om = f1.w * odMist(ro.y, d.y, t, f2.x, f2.y);
  let L = FR.sun.xyz;
  let mu = dot(d, L);
  let sc = sunCol();
  let hz = skyBase(vec3f(d.x, max(d.y, 0.02) * 0.35, d.z));
  let ca = hz * f0.rgb * 1.6 + sc * hg(mu, 0.7) * f2.w * 0.25;
  let I = rowv(S3).w;
  let cm = f1.rgb * (mix(rowv(S3).rgb, rowv(S2).rgb, 0.4) * I * 1.2 + sc * (0.12 + hg(mu, 0.6) * f2.w * 0.5)) + rowv(S7).rgb * rowv(S7).w;
  let ta = exp(-oa); let tm = exp(-om);
  var c = col * ta + ca * (1.0 - ta);
  c = c * tm + cm * (1.0 - tm);
  return c;
}


struct SkyOut { @builtin(position) pos: vec4f }
@vertex fn vsSky(@builtin(vertex_index) i: u32) -> SkyOut {
  var o: SkyOut;
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
struct SkyF { @location(0) c: vec4f, @location(1) d: vec4f }
@fragment fn fsSky(in: SkyOut) -> SkyF {
  let uv = in.pos.xy * VW.size.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let d = viewRay(in.pos.xy);
  let pix = 2.0 * VW.fwd.w * VW.size.w;
  var o: SkyF;
  o.c = vec4f(skyFull(d, pix), 1.0);
  o.d = vec4f(60000.0, 0.0, 0.0, 1.0);
  return o;
}
