// sky.wgsl: analytic sky per realm (sun, glow, stars, aurora, ringed giant, moons), the 2D high cloud layer
// and the fog integrals. Shared by the opaque-pass sky draw, the composite and reflections.

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
  // below the horizon: a slightly darker haze
  if (d.y < 0.0) { c = mix(c, hor * 0.75, sstep(0.0, -0.25, d.y)); }
  // Mie glow around the sun
  let mu = dot(d, L);
  let sc = sunCol();
  c += sc * rowv(S1).w * (hg(mu, 0.8) * 0.06 + hg(mu, 0.35) * 0.04);
  return c;
}

fn stars(d: vec3f, pix: f32) -> f32 {
  var s = 0.0;
  for (var l = 0; l < 2; l++) {
    let sc = 150.0 + 170.0 * f32(l);
    let p = d * sc;
    let c = floor(p);
    let ci = vec3i(c);
    let h = hf3(ci.x, ci.y, ci.z + l * 1000);
    if (h > 0.965) {
      let o = vec3f(hf3(ci.x, ci.y, ci.z + 77), hf3(ci.x, ci.y, ci.z + 78), hf3(ci.x, ci.y, ci.z + 79));
      let sp = c + 0.2 + 0.6 * o;
      let dd = length(p - sp);
      let rad = max(pix * sc * 0.45, 0.012);
      let mag = pow((h - 0.965) / 0.035, 6.0) * 1.5 + 0.08;
      s += mag * exp(-dd * dd / (rad * rad)) * (0.7 + 0.3 * sin(FR.time.x * (2.0 + 5.0 * o.x) + o.y * 30.0));
    }
  }
  return s * 2.5;
}

fn aurora(d: vec3f) -> vec3f {
  if (d.y < 0.01) { return vec3f(0.0); }
  let tm = FR.time.x;
  var acc = vec3f(0.0);
  let green = vec3f(0.075, 1.0, 0.36);
  let mag = vec3f(0.66, 0.07, 1.0);
  for (var i = 0; i < 26; i++) {
    let fi = f32(i) / 26.0;
    let hgt = 1.0 + fi * 0.9;
    let pt = d.xz * (hgt / d.y) * 0.6;
    let w = 1.3 * fbm(vec2f(pt.x * 0.22 + tm * 0.015, 1.7), 3, 400u) + 0.4 * vn(vec2f(pt.x * 0.9 - tm * 0.05, 3.3), 401u);
    let c1 = exp(-abs(pt.y + 3.2 - w * 2.2) * 2.2);
    let c2 = exp(-abs(pt.y + 6.0 - w * 1.8) * 2.8) * 0.7;
    let rays = 0.55 + 0.45 * vn(vec2f(pt.x * 7.0 + tm * 0.3, fi * 2.0), 402u);
    let fall = pow(1.0 - fi, 1.6);
    let col = mix(green, mag, sstep(0.25, 0.95, fi));
    acc += col * (c1 + c2) * rays * fall;
  }
  let fade = sstep(0.01, 0.12, d.y) * sstep(1.0, 0.75, d.y);
  return acc * fade * 0.035;
}

// ringed giant + two moons for Lumen Deep; returns rgb and coverage
fn giant(d: vec3f) -> vec4f {
  let G = dirAzEl(38.0, 26.0);
  let rad = sin(radians(12.5));
  let L = normalize(FR.sun.xyz + vec3f(0.0, 0.25, 0.0));
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
    let lit = sstep(-0.15, 0.4, ndl);
    let rim = pow(1.0 - max(dot(N, -d), 0.0), 3.0);
    col = pc * (lit * 1.1 + 0.025) + vec3f(0.55, 0.45, 1.0) * rim * (0.35 + lit);
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
        var dens = 0.5 + 0.5 * sin(rr * 41.0) * 0.5 + 0.3 * sin(rr * 13.0 + 1.0);
        dens *= sstep(1.3, 1.42, rr) * sstep(2.25, 2.1, rr) * (1.0 - 0.85 * sstep(1.84, 1.88, rr) * sstep(1.95, 1.91, rr));
        dens = clamp(dens, 0.0, 1.0) * 0.7;
        // planet shadow on rings
        let toS = X - G;
        let bs = dot(toS, L);
        let shadow = select(1.0, 0.15, bs < 0.0 && length(toS - L * bs) < rad);
        let rc = vec3f(0.9, 0.8, 0.7) * (0.75 * shadow + 0.04);
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
      col = mix(col, mc * (sstep(-0.1, 0.3, dot(N, L)) + 0.03), 1.0);
      a = 1.0;
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
  if (s5.x > 0.01 && d.y > 0.0) { c += vec3f(0.9, 0.93, 1.0) * stars(d, pix) * s5.x * mix(0.25, 1.0, night) * sstep(0.0, 0.1, d.y); }
  if (s5.y > 0.01) { c += aurora(d) * s5.y; }
  if (s5.z > 0.01 && d.y > -0.05) {
    let g = giant(d);
    c = mix(c, g.rgb * s5.z + c * 0.15, g.a * s5.z);
  }
  return c;
}

// ---- high cloud layer (2D, analytic; works for reflections too) ----
fn cloudCover(xz: vec2f) -> f32 {
  let c0 = rowv(C0);
  let w = rowv(C2).w * FR.time.x;
  let q = xz * (1.0 / 2600.0) + vec2f(w * (1.0 / 2600.0), 0.0);
  let base = fbm(q, 5, 500u) * 0.5 + 0.5;
  let det = fbm(q * 4.0 + 3.0, 3, 510u);
  let v = base + det * 0.12;
  return sstep(1.0 - c0.x - 0.06, 1.0 - c0.x + 0.38, v);
}

// returns premultiplied cloud colour (rgb) and transmittance (a), and hit distance through `th`
fn cloudLayer(ro: vec3f, d: vec3f, maxT: f32) -> vec4f {
  let c0 = rowv(C0);
  if (c0.x < 0.01) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let mid = c0.y + (c0.z - c0.y) * 0.35;
  if (abs(d.y) < 1e-3) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let t = (mid - ro.y) / d.y;
  if (t < 0.0 || t > maxT) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let P = ro + d * t;
  let cv = cloudCover(P.xz);
  if (cv < 0.002) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let thick = (c0.z - c0.y) * cv;
  let od = thick * c0.w * 0.012 / max(abs(d.y), 0.08);
  let alpha = (1.0 - exp(-od)) * sstep(90000.0, 20000.0, t);
  let L = FR.sun.xyz;
  // self-shadow: coverage toward the sun
  let Ls = P.xz + L.xz / max(L.y, 0.08) * (c0.z - c0.y) * 0.5;
  let cs = cloudCover(Ls);
  let mu = dot(d, L);
  let sc = sunCol();
  let lightS = exp(-cs * 2.2) * (0.6 + 2.2 * hg(mu, 0.6)) ;
  let I = rowv(S3).w;
  let amb = mix(rowv(S3).rgb, rowv(S2).rgb, 0.6) * I * (0.7 + 0.3 * (1.0 - cv));
  let tint = rowv(C1).rgb;
  var col = tint * (sc * lightS * 0.9 + amb * 1.1);
  // night realms: let the clouds pick up a little night light
  col += rowv(S7).rgb * rowv(S7).w * 2.0;
  return vec4f(col * alpha, 1.0 - alpha);
}

// ---- fog: aerial perspective (exponential) + low mist (capped exponential) ----
fn odExp(y0: f32, dy: f32, t: f32, k: f32) -> f32 {
  // integral of exp(-k y) along y0 + dy s for s in [0, t]
  let a = k * dy * t;
  if (abs(a) < 1e-4) { return exp(-k * y0) * t; }
  return exp(-k * y0) * (1.0 - exp(-a)) / (k * dy);
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
