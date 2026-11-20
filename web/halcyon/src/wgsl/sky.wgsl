// sky.wgsl: the sky per realm (physical air from the atmo LUT, sun, moon, stars, aurora, ringed giant) and fog.
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

// the key light's colour x irradiance at the camera's realm row: the sun, or the moon at night (common.wgsl)
fn sunCol() -> vec3f { return keyLight(rowv(S0), rowv(S1), rowv(S8), FR.sun.w).col; }

// ---- the physical sky (fx/atmo.js bakes the sky-view LUT for this frame's camera, air, sun and moon) ----
fn atmoUV(d: vec3f) -> vec2f {
  let az = atan2(d.x, -d.z) * (0.5 / PI);
  let el = asin(clamp(d.y, -1.0, 1.0));
  let v = clamp(0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI)), 0.5 / 128.0, 127.5 / 128.0);
  return vec2f(az, v * (128.0 / 129.0));
}
// display radiance of the clear sky along d (in-scattered light only); a = mean transmittance along d
fn atmoSky(d: vec3f) -> vec4f { return textureSampleLevel(atmoT, atmoS, atmoUV(d), 0.0); }
// per-frame values: x 0 = sun irradiance at the camera, x 1 = moon irradiance at the camera
fn atmoInfo(i: i32) -> vec3f { return textureLoad(atmoT, vec2i(i, 128), 0).rgb; }

// sky without the sun / moon discs and the night objects (used by fog, reflections, cloud ambient)
fn skyBase(d: vec3f) -> vec3f {
  var c = atmoSky(d).rgb;
  // Lumen: warm rose air under the ringed giant (light thrown back by its day side)
  let gz = rowv(S5).z;
  if (gz > 0.01) {
    let G = giantDir();
    let dl = length(d.xz);
    var ga = 0.5;
    if (dl > 1e-4) { ga = dot(d.xz / dl, normalize(G.xz)) * 0.5 + 0.5; }
    c += vec3f(0.95, 0.38, 0.42) * luma(rowv(S3).rgb) * gz * pow(ga, 6.0) * exp(-max(d.y, 0.0) * 5.0) * 0.6;
  }
  return c;
}

// ---- stars: three magnitude layers, a steep brightness distribution, colour temperature, slight twinkle ----
fn starCol(t: f32) -> vec3f {
  // hot blue-white .. white .. orange-red (rough blackbody, normalised luminance)
  let hot = vec3f(0.62, 0.74, 1.25); let mid = vec3f(1.0, 0.98, 0.94); let cool = vec3f(1.35, 0.82, 0.5);
  return select(mix(mid, cool, (t - 0.55) / 0.45), mix(hot, mid, t / 0.55), t < 0.55);
}
const MW_N: vec3f = vec3f(0.36, 0.46, 0.81); // Milky Way pole

// Stars with real statistics: counts rise ~2.8x per magnitude (N(<m) ~ 10^(0.45 m)) down to magnitude 9, flux
// 10^(-0.4 m) relative to the moon's (a full moon is magnitude -12.7), drawn as a pixel-sized point spread so the
// energy does not depend on resolution, dimmed by the air along the view. unit = irradiance of a magnitude-0 star.
fn stars(d: vec3f, pix: f32, unit: f32) -> vec3f {
  var s = vec3f(0.0);
  let sig = max(pix * 0.6, 2.5e-4);
  let norm = unit / (2.0 * PI * sig * sig);
  for (var l = 0; l < 2; l++) {
    let sc = select(110.0, 260.0, l == 1);
    let p = d * sc;
    let c = floor(p);
    let ci = vec3i(c);
    let h = hf3(ci.x, ci.y, ci.z + l * 1000);
    // ~70k stars per layer over the sky (about 1/3 of the cells hold one)
    let prob = select(0.33, 0.06, l == 1);
    if (h < prob) {
      let o = vec3f(hf3(ci.x, ci.y, ci.z + 77), hf3(ci.x, ci.y, ci.z + 78), hf3(ci.x, ci.y, ci.z + 79));
      let sp = normalize(c + 0.15 + 0.7 * o);
      let dd = length(d - sp);
      // magnitude by inverse CDF: most stars faint, a handful brighter than magnitude 1
      let m = 9.0 + log(max(h / prob, 1e-7)) / (0.45 * 2.302585) + f32(l) * 1.2;
      let flux = exp2(-1.328771 * m); // 10^(-0.4 m)
      // scintillation: a little, more near the horizon
      let tw = 1.0 + (0.08 + 0.25 * (1.0 - d.y)) * sin(FR.time.x * (9.0 + 13.0 * o.x) + o.y * 40.0);
      let ct = fract(o.z * 7.31 + o.x * 3.1);
      s += starCol(ct * ct) * (flux * tw * exp(-dd * dd / (2.0 * sig * sig)));
    }
  }
  return s * norm;
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

// ---- aurora: a few long ribbons (thin, softly folding vertical sheets) high above the ground ----
// Each ribbon is a Gaussian sheet around a meandering, domain-warped centre line (the warp makes it curl back on
// itself in folds). Along the view ray we take a handful of altitude samples; between two samples the signed
// distance to the sheet is linear, so the sheet's emission over that segment is integrated exactly with erf.
// That gives continuous curtains with no stepping artefacts, and folds (where the ray runs along the sheet)
// brighten by line-of-sight overlap on their own. Units: 1 = the lower hem (~100 km); curtains fade out by ~3.6.
fn erfA(x: f32) -> f32 {
  let x2 = x * x;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
}
// signed horizontal distance from p (ribbon frame: x along, y across) to ribbon r's centre line
fn aurF(p: vec2f, off: f32, r: f32, tm: f32) -> f32 {
  let X = p.x + 0.6 * sin(p.y * 1.6 + p.x * 0.27 + r * 3.0 + tm * 0.017);
  let a1 = X * 0.21 + r * 2.1 + tm * 0.011; let a2 = X * 0.57 - tm * 0.019 + r * 4.0;
  let c = off + 0.95 * sin(a1) + 0.32 * sin(a2) + 0.07 * sin(X * 1.9 + tm * 0.06 + r);
  let dc = 0.2 * cos(a1) + 0.18 * cos(a2);
  return (p.y - c) * inverseSqrt(1.0 + dc * dc);
}
fn aurora(d: vec3f) -> vec3f {
  if (d.y < 0.003) { return vec3f(0.0); }
  let tm = FR.time.x;
  let green = vec3f(0.12, 1.0, 0.36);
  let teal = vec3f(0.05, 0.62, 0.62);
  let viol = vec3f(0.55, 0.12, 0.8);
  let g = d.xz / d.y; // horizontal offset per unit altitude
  var acc = vec3f(0.0);
  let NS = 14;
  for (var r = 0; r < 4; r++) {
    let fr = f32(r);
    // ribbons run roughly east-west across the northern sky, one nearly overhead, one low on the horizon
    let ang = 0.12 + fr * 0.21 - fr * fr * 0.05;
    let off = select(select(select(-1.35, -2.4, r == 1), -4.6, r == 2), 1.6, r == 3);
    let wdt = 0.03 + 0.012 * fr;             // sheet half-thickness
    let bright = select(1.0, 0.7, r == 3);
    let ax = vec2f(cos(ang), sin(ang));
    let gr = vec2f(dot(g, ax), dot(g, vec2f(-ax.y, ax.x)));
    // skip ribbons this ray cannot reach between the hem and the top
    let y0 = gr.y * 0.92; let y1 = gr.y * 3.65;
    if (max(y0, y1) < off - 1.7 || min(y0, y1) > off + 1.7) { continue; }
    var hp = 0.92;
    var fp = aurF(gr * hp, off, fr, tm);
    for (var k = 1; k <= NS; k++) {
      let u = f32(k) / f32(NS);
      let h = 0.92 + 2.73 * u * u; // denser near the bright hem
      let f = aurF(gr * h, off, fr, tm);
      let a0 = fp / wdt; let a1 = f / wdt;
      let dh = h - hp;
      // fraction of the unit-normalised sheet crossed in this segment (exact for linear f)
      var I = 0.0;
      if (min(abs(a0), abs(a1)) < 3.0 || a0 * a1 < 0.0) {
        if (abs(a1 - a0) > 1e-3) { I = dh * 0.5 * (erfA(a1) - erfA(a0)) / (a1 - a0) / wdt; }
        else { I = dh * exp(-a0 * a0) / (wdt * 1.7724539); }
      }
      // grazing paths (looking straight up a sheet, fold edges) saturate softly: no overhead wash, no streaks
      I = I / (1.0 + I * 0.8);
      if (I > 1e-4) {
        // where in the segment the ray is closest to the sheet
        var hs = select(h, hp, abs(fp) < abs(f));
        if (fp * f < 0.0) { hs = hp + dh * fp / (fp - f); }
        let X = dot(gr * hs, vec2f(1.0, 0.0));
        // ragged, slowly rippling lower hem
        let hem = 1.0 + 0.045 * vn(vec2f(X * 5.0 + tm * 0.08, fr * 7.0), 463u) + 0.02 * sin(X * 13.0 + tm * 0.3);
        let z = hs - hem;
        var prof = sstep(-0.035, 0.015, z) * (0.6 * exp(-max(z, 0.0) * 2.2) + 0.4 * exp(-max(z, 0.0) * 0.6));
        prof *= sstep(3.65, 2.4, hs);
        // fine rays: soft brightness variations inside the sheet, stretched along the field lines, drifting
        let xr = X * 11.0 + 0.8 * sin(X * 0.9 + tm * 0.13) + tm * 0.09;
        let rays = 0.62 + 0.3 * vn(vec2f(xr, hs * 0.45), 460u) + 0.16 * vn(vec2f(xr * 2.7 - tm * 0.35, hs * 0.8), 464u);
        // long bright and quiet stretches along the ribbon
        let pat = 0.14 + 0.86 * sstep(-0.55, 0.45, vn(vec2f(X * 0.33 - tm * 0.012, fr * 5.0 + 1.0), 461u));
        var col = mix(green, teal, sstep(1.35, 2.05, hs));
        col = mix(col, viol, sstep(1.75, 2.7, hs));
        // far curtains dim and sink into the haze near the horizon
        let ext = exp(-length(gr) * hs * 0.035);
        acc += col * (I * prof * rays * pat * bright * ext / max(d.y, 0.06)); // per altitude -> per ray length
      }
      hp = h; fp = f;
    }
  }
  // soft saturation: corona and folds glow without clipping to flat white
  let l = max(max(acc.r, acc.g), acc.b);
  acc *= 1.0 / (1.0 + l * 0.2);
  // diffuse airglow under the curtains near the horizon
  acc += green * 0.08 * exp(-d.y * 9.0);
  return acc * sstep(0.003, 0.06, d.y) * 0.16;
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
    let Eg = rowv(A2).rgb * rowv(S0).z * 0.55; // the star's light on the giant's cloud tops (albedo ~0.55)
    col = pc * Eg * (lit + 0.006) + vec3f(0.55, 0.45, 1.0) * luma(Eg) * rim * (0.05 + 0.35 * lit);
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
        let rc = vec3f(0.9, 0.8, 0.7) * rowv(A2).rgb * rowv(S0).z * 0.5 * (0.85 * shadow * face + 0.01);
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
      col = mix(col, mc * rowv(A2).rgb * rowv(S0).z * 0.4 * (sstep(-0.1, 0.3, dot(N, L)) + 0.01), sstep(0.0, 2e-5, dm));
      a = max(a, sstep(0.0, 2e-5, dm));
    }
  }
  return vec4f(col, a);
}

// sun and moon discs: radiance = irradiance at the camera / the disc's solid angle (energy-correct, so the sun
// blooms and the moon is exactly as bright as the light it casts), soft limb, antialiased edge
fn bodyDisc(d: vec3f, B: vec3f, rad: f32, pix: f32) -> f32 {
  let ang = acos(clamp(dot(d, B), -1.0, 1.0));
  return 1.0 - sstep(rad - pix * 0.5, rad + pix * 0.5, ang);
}

// the star field turns about the celestial pole (62 degrees up in the north, the Faroes' latitude) once a day
// (FR.sky.y): a view direction is turned back into the fixed star frame (Rodrigues)
const POLE: vec3f = vec3f(0.0, 0.88295, -0.46947);
fn starFrame(d: vec3f) -> vec3f {
  let a = -FR.sky.y; let c = cos(a); let s = sin(a);
  return d * c + cross(POLE, d) * s + POLE * dot(POLE, d) * (1.0 - c);
}
fn skyFull(d: vec3f, pix: f32) -> vec3f {
  let A = atmoSky(d);
  var c = skyBase(d);
  let drift = FR.sun.w;
  let up = sstep(-0.004, 0.004, d.y); // the sea horizon hides what is below
  // the sun: limb-darkened disc
  let Ls = sunDirFrom(rowv(S0), drift);
  let rs = radians(rowv(S0).w * 0.5);
  let ds = bodyDisc(d, Ls, rs, pix);
  if (ds > 0.0) {
    let om = 2.0 * PI * (1.0 - cos(rs));
    let rho = clamp(acos(clamp(dot(d, Ls), -1.0, 1.0)) / rs, 0.0, 1.0);
    let limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - rho * rho));
    c += min(atmoInfo(0) / om * limb * 1.15, vec3f(30000.0)) * ds * up;
  }
  // the moon: lit by the sun's direction (phase), maria, a little earthshine
  let Lm = moonDirFrom(rowv(S8), drift);
  let rm = radians(rowv(S8).w * 0.5);
  let dm = bodyDisc(d, Lm, rm, pix);
  if (dm > 0.0 && rowv(S8).z > 0.0) {
    let tu = normalize(cross(Lm, vec3f(0.0, 1.0, 0.0)));
    let tv = cross(tu, Lm);
    let q = vec2f(dot(d, tu), dot(d, tv)) / sin(rm);
    let N = normalize(-Lm + (tu * q.x + tv * q.y) * 0.98);
    let ph = sstep(-0.05, 0.15, dot(N, Ls)) + 0.015;
    let mar = sstep(0.05, 0.45, fbm(q * 1.7 + 3.0, 4, 470u) * 0.5 + 0.5);
    let cr = 1.0 - 0.2 * sstep(0.55, 0.8, vn(q * 7.0, 471u) * 0.5 + 0.5);
    let om = 2.0 * PI * (1.0 - cos(rm));
    c += atmoInfo(1) / om * (mix(1.15, 0.7, mar) * cr * ph) * dm * up;
  }
  // stars and the Milky Way come out as the sun goes down (or always in a realm that asks for them, S5.x)
  let s5 = rowv(S5);
  let night = 1.0 - sstep(-0.21, -0.035, Ls.y);
  let vis = clamp(max(night, s5.x), 0.0, 1.0);
  var g = vec4f(0.0);
  // a neighbouring realm's sky features come in with its weight squared: at a small weight nothing lone shows
  let gw = s5.z * s5.z;
  if (gw > 0.001 && d.y > -0.05) { g = giant(d); g.a *= gw; }
  if (vis > 0.01 && d.y > 0.0) {
    let unit = 0.9 * 8.3e-6; // a magnitude-0 star: 10^(-0.4 * 12.7) of a full moon (0.9 in every realm)
    let ds = starFrame(d);
    var sk = stars(ds, pix, unit);
    sk += milkyWay(ds) * sstep(0.45, 0.9, s5.x);
    c += sk * vis * A.a * (1.0 - g.a);
  }
  // the aurora is only seen once the sun is well down (in a Drift it comes out with the dark, not as a streak)
  let aw = s5.y * (1.0 - sstep(-0.16, -0.02, Ls.y));
  if (aw > 0.01) { c += aurora(d) * aw * mix(1.0, A.a, 0.6); }
  // the giant is seen through the air in front of it: dimmed by its transmittance, the in-scatter stays
  if (g.a > 0.0) { c += g.rgb * gw * A.a; }
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

// Aerial perspective from the realm's air: Rayleigh (8 km) and Mie (A1.w km) extinction along the segment, plus
// the realm's extra ground haze (F0.w, falloff F2.z); the in-scattered light is the clear sky along the same
// direction scaled to this segment's opacity. Then the low mist (F1, F2.x, F2.y).
fn applyFog(col: vec3f, ro: vec3f, d: vec3f, t: f32) -> vec3f {
  let a0 = rowv(A0); let a1 = rowv(A1);
  let f0 = rowv(F0); let f1 = rowv(F1); let f2 = rowv(F2);
  let y0 = max(ro.y, 0.0);
  let oR = odExp(y0, d.y, t, 1.0 / 8000.0);
  let oM = odExp(y0, d.y, t, 1.0 / (max(a1.w, 0.2) * 1000.0));
  let oH = f0.w * odExp(y0, d.y, t, f2.z);
  let tau = a1.rgb * (1e-6 * a0.x) * oR + vec3f(3.996e-6 * a0.y / 0.9 * oM + oH);
  let T = exp(-tau);
  let S = atmoSky(vec3f(d.x, max(d.y, 0.0) + 0.01, d.z));
  let Lu = S.rgb / max(1.0 - S.a, 0.05);
  var c = col * T + Lu * (1.0 - dot(T, vec3f(0.3333)));
  // low mist: lit by the sky and the key light
  // fog banks (common.wgsl wxFogBank) drift through: thicker low mist where a bank lies over the path
  let fb = 0.5 * (wxFogBank(ro.xz) + wxFogBank(ro.xz + d.xz * min(t, 6000.0)));
  let om = f1.w * odMist(ro.y, d.y, t, f2.x, f2.y) * (1.0 + 3.0 * fb);
  let mu = dot(d, FR.sun.xyz);
  let sc = sunCol();
  let cm = f1.rgb * (mix(rowv(S3).rgb, rowv(S2).rgb, 0.4) * 1.2 + sc * (0.12 + hg(mu, 0.6) * f2.w * 0.5)) + rowv(S7).rgb * rowv(S7).w;
  let tm = exp(-om);
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
