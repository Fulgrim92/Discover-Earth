// terrain.wgsl: clipmap grid mesh (one draw per level, geomorphed, skirted) and the per-realm terrain material.
//
// Material model: every realm builds an albedo, a roughness, an emission and a detail height gradient `dg`
// (world-space metres per metre). Detail is procedural and band-limited by the pixel footprint `fp` (an octave
// fades out before its wavelength drops under ~4 pixels), so close ground has grain, cracks and pebbles and far
// ground never shimmers. Layer transitions are height-blended (the taller layer wins) instead of soft noise mixes.
// Cost control: realm rows read once when one realm owns the pixel, occlusion comes from the baked concavity
// (no per-pixel horizon search), shadow steps drop with distance, and micro detail only runs where it is visible.

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) @interpolate(flat) lvl: u32,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) li: u32) -> VOut {
  let G = i32(FR.misc.y);
  let W = u32(G + 3);
  var ix = i32(vi % W) - 1;
  var iz = i32(vi / W) - 1;
  let skirt = ix < 0 || iz < 0 || ix > G || iz > G;
  ix = clamp(ix, 0, G); iz = clamp(iz, 0, G);
  let mc = FR.mc[li];
  let s = mc.z;
  let hg = G / 2;
  let gp = mc.xy + vec2f(f32(ix - hg), f32(iz - hg)) * s;
  let half = f32(hg) * s;
  let cam = VW.cam.xyz;
  let dc = max(abs(gp.x - cam.x), abs(gp.y - cam.z)) / half;
  var m = clamp((dc - 0.62) / 0.26, 0.0, 1.0);
  if (li + 1u >= nLevels()) { m = 0.0; }
  let odd = vec2f(f32(ix & 1), f32(iz & 1));
  let p = gp - odd * s * m;
  var h = clipH(li, p);
  if (m > 0.0) { h = mix(h, clipH(li + 1u, p), m); }
  if (skirt) { h -= s * 1.5 + 2.0; }
  var o: VOut;
  o.wp = vec3f(p.x, h, p.y);
  o.pos = VW.vp * vec4f(o.wp - cam, 1.0);
  o.lvl = li;
  return o;
}

struct FOut { @location(0) c: vec4f, @location(1) d: vec4f }

// realm field: one row read when a single realm owns the point (most pixels), the full blend otherwise
fn bfx(r: RWt, f: u32) -> vec4f {
  if (r.id[1] < 0) { return RT[u32(r.id[0]) * ROW + f]; }
  return bf(r, f);
}

// band-limit weight for a feature of wavelength lam (m) at pixel footprint fp (m)
fn bl(lam: f32, fp: f32) -> f32 { return sstep(1.5 * fp, 4.0 * fp, lam); }

// geographic realm transition: noise breaks the blend weight into patches, but 0 stays 0 and 1 stays 1
fn geo(w: f32, n: f32) -> f32 { return sstep(0.3, 0.7, w + n * w * (1.0 - w) * 4.0); }

// 3D value noise with analytic gradient: (value in [-1,1], d/dx, d/dy, d/dz)
fn vn3d(p: vec3f) -> vec4f {
  let i = floor(p); let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let x = i32(i.x); let y = i32(i.y); let z = i32(i.z);
  let a = hf3(x, y, z); let b = hf3(x + 1, y, z); let c = hf3(x, y + 1, z); let d = hf3(x + 1, y + 1, z);
  let e = hf3(x, y, z + 1); let g = hf3(x + 1, y, z + 1); let k = hf3(x, y + 1, z + 1); let l = hf3(x + 1, y + 1, z + 1);
  let k1 = b - a; let k2 = c - a; let k3 = e - a; let k4 = a - b - c + d; let k5 = a - c - e + k; let k6 = a - b - e + g;
  let k7 = -a + b + c - d + e - g - k + l;
  let v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  let gr = du * vec3f(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z, k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4f(v * 2.0 - 1.0, gr * 2.0);
}

// rock surface: lumps, grain and cracks from 3D noise (no stretching on cliffs). Returns (albedo factor, dH/dp).
// sc scales the pattern (basalt fine, limestone coarse); cr is the crack strength.
fn rockDetail(p: vec3f, fp: f32, sc: f32, cr: f32) -> vec4f {
  var a = 1.0; var g = vec3f(0.0);
  let l0 = 3.1 * sc; let w0 = bl(l0, fp);
  if (w0 > 0.0) {
    let n = vn3d(p / l0 + vec3f(0.0, 0.0, 17.0));
    g += n.yzw * (0.35 * w0);                 // lumps: 0.35 l0 amplitude
    a += n.x * 0.1 * w0;
    // cracks: thin dark grooves where a second noise crosses zero
    let m = vn3d(p / (l0 * 0.8) + vec3f(31.0, 7.0, 0.0));
    let cw = 0.09;
    let inC = 1.0 - sstep(0.0, cw, abs(m.x));
    g += sign(m.x) * m.yzw * (0.6 * inC * cr * w0);
    a -= inC * 0.45 * cr * w0;
  }
  let l1 = 0.42 * sc; let w1 = bl(l1, fp);
  if (w1 > 0.0) {
    let n = vn3d(p / l1);
    g += n.yzw * (0.09 * w1);
    a += n.x * 0.12 * w1;
  }
  let l2 = 0.11 * sc; let w2 = bl(l2, fp);
  if (w2 > 0.0) {
    let n = vn3d(p / l2 + vec3f(5.0, 3.0, 1.0));
    g += n.yzw * (0.07 * w2);
    a += n.x * 0.08 * w2;
  }
  return vec4f(a, g);
}

// ground surface (soil, turf): 2D bumps in xz, band-limited. Returns (height-ish value, dH/dx, dH/dz, 0)
fn groundDetail(xz: vec2f, fp: f32) -> vec4f {
  var v = 0.0; var g = vec2f(0.0);
  let w0 = bl(1.7, fp);
  if (w0 > 0.0) { let n = vnoised(xz * (1.0 / 1.7), 230u); g += n.yz * (0.07 * w0); v += n.x * 0.5 * w0; }
  let w1 = bl(0.55, fp);
  if (w1 > 0.0) { let n = vnoised(xz * (1.0 / 0.55), 231u); g += n.yz * (0.07 * w1); v += n.x * 0.3 * w1; }
  let w2 = bl(0.16, fp);
  if (w2 > 0.0) { let n = vnoised(xz * (1.0 / 0.16), 232u); g += n.yz * (0.05 * w2); v += n.x * 0.2 * w2; }
  return vec4f(v, g, 0.0);
}

// pebbles / scree: domed stones on a jittered grid (cell c in m). Returns (stone height 0..1, dH/dx, dH/dz, tone)
fn pebbles(xz: vec2f, c: f32) -> vec4f {
  let q = xz / c;
  let g = floor(q);
  var best = vec4f(0.0, 0.0, 0.0, 0.5);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let ci = i32(g.x) + i; let cj = i32(g.y) + j;
      let pt = vec2f(f32(ci), f32(cj)) + 0.15 + 0.7 * vec2f(hf(ci, cj, 400u), hf(ci, cj, 401u));
      let r = 0.42 + 0.3 * hf(ci, cj, 402u);
      let d = (q - pt) / r;
      let dd = dot(d, d);
      if (dd < 1.0) {
        let s = sqrt(1.0 - dd);
        let hh = s * r;
        if (hh > best.x) { best = vec4f(hh, -d / max(s, 0.15) * 0.9, hf(ci, cj, 403u)); }
      }
    }
  }
  return best;
}

// irregular salt polygons (1-3 m): distance to the nearest cell edge in cell units (mirrored in composite.wgsl)
fn saltEdge(xz: vec2f) -> f32 {
  let q = xz * (1.0 / 2.1);
  let g = floor(q);
  var d1 = 9.0; var d2 = 9.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let ci = i32(g.x) + i; let cj = i32(g.y) + j;
      let pt = vec2f(f32(ci), f32(cj)) + 0.1 + 0.8 * vec2f(hf(ci, cj, 410u), hf(ci, cj, 411u));
      let d = length(q - pt);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return (d2 - d1) * 0.5;
}

fn ggx(n: vec3f, v: vec3f, l: vec3f, rough: f32, f0: f32) -> f32 {
  let hv = normalize(v + l);
  let nh = max(dot(n, hv), 0.0); let nl = max(dot(n, l), 0.0); let nv = max(dot(n, v), 1e-3);
  let a = max(rough * rough, 0.002); let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let Gv = nv / (nv * (1.0 - k) + k); let Gl = nl / (nl * (1.0 - k) + k);
  let F = f0 + (1.0 - f0) * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  return D * Gv * Gl * F / (4.0 * nv + 1e-3) ;
}

// ---- Painted Range strata ----
// same as terrfn.wgsl strataTilt (the terrain module does not include terrfn): keep the two in step
fn strataTilt(p: vec2f) -> f32 {
  return 0.035 * (p.x * 0.83 + p.y * 0.55) + 80.0 * vn(p * (1.0 / 1900.0), 34u) + 18.0 * vn(p * (1.0 / 560.0), 35u);
}
// Beds: each 6.5 m cycle holds three beds of hashed thickness. The formation tone drifts slowly up the section
// (rust and ochre dominate, buff and cream are accents) and the thinnest bed of a cycle is sometimes a teal or plum
// seam. Saturation is mineral: chroma in the midtones, never candy.
fn danxia(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0) * 5.0;
  let i = floor(x); let f = x - i;
  var c0 = vec3f(0.15, 0.03, 0.016); var c1 = vec3f(0.33, 0.055, 0.022);
  if (i >= 1.0) { c0 = c1; c1 = vec3f(0.45, 0.12, 0.035); }
  if (i >= 2.0) { c0 = c1; c1 = vec3f(0.5, 0.26, 0.07); }
  if (i >= 3.0) { c0 = c1; c1 = vec3f(0.52, 0.38, 0.22); }
  if (i >= 4.0) { c0 = c1; c1 = vec3f(0.68, 0.57, 0.4); }
  return mix(c0, c1, sstep(0.0, 1.0, f));
}
fn strataAt(s: f32) -> vec3f {
  let x = s * (1.0 / 6.5);
  let k = floor(x); let fr = x - k;
  let ki = i32(k);
  let b1 = 0.14 + 0.32 * hf(ki, 1, 310u);
  let b2 = min(b1 + 0.1 + 0.42 * hf(ki, 2, 311u), 0.93);
  var bed = 0; var th = b1;
  if (fr > b1) { bed = 1; th = b2 - b1; }
  if (fr > b2) { bed = 2; th = 1.0 - b2; }
  let F = vn(vec2f(k * 0.23, 3.7), 312u) + 0.35 * vn(vec2f(k * 0.9, 1.3), 316u);
  let off = hf(ki, 3 + bed, 313u) - 0.5;
  var c = danxia(0.4 + 0.42 * F + off * 0.32);
  // rare mineral seams in thin beds
  let sh = hf(ki, 10 + bed, 314u);
  if (th < 0.24 && sh < 0.3) {
    c = select(vec3f(0.08, 0.16, 0.13), vec3f(0.19, 0.075, 0.11), sh < 0.13);
  }
  return c * (0.9 + 0.2 * hf(ki, 20 + bed, 315u));
}

@fragment fn fs(in: VOut) -> FOut {
  let p = in.wp;
  let cam = VW.cam.xyz;
  let toCam = cam - p;
  let dist = length(toCam);
  let V = toCam / dist;
  let tm = FR.time.x;
  let q = FR.time.w;
  let fwh = fwidth(p.y); // height change per pixel (strata anti-aliasing); uniform control flow here

  // clipmap data at the finest covering level, cross-faded to the next at its edge
  let l0 = clipLevel(p.xz, 0u, 6.0);
  let e = clipEdge(l0, p.xz);
  var cd = clipS(l0, p.xz);
  var mA = clipMA(l0, p.xz);
  var mB = clipMB(l0, p.xz);
  if (e > 0.0 && l0 + 1u < nLevels()) {
    cd = mix(cd, clipS(l0 + 1u, p.xz), e);
    mA = mix(mA, clipMA(l0 + 1u, p.xz), e);
    mB = mix(mB, clipMB(l0 + 1u, p.xz), e);
  }
  // baked occlusion: ring concavity at fixed coarse scales (4 m, 16 m, 64 m texels)
  let la = clipLevel(p.xz, max(l0, 3u), 4.0);
  let lb = clipLevel(p.xz, max(l0, 5u), 4.0);
  let lcv = clipLevel(p.xz, max(l0, 7u), 4.0);
  let ca = clipS(la, p.xz).w / FR.lv[la].z;
  let cb = clipS(lb, p.xz).w / FR.lv[lb].z;
  let cc = clipS(lcv, p.xz).w / FR.lv[lcv].z;
  let conc = cb; // broad concavity (+ = gully, - = ridge)
  let gn = normalize(vec3f(-cd.y, 1.0, -cd.z));
  let slope = 1.0 - gn.y;
  let h = p.y;
  let ndvG = max(dot(gn, V), 0.04);
  let fp = dist * 2.0 * VW.fwd.w * VW.size.w * inverseSqrt(ndvG); // pixel footprint on the surface (m)

  // realm blend
  let rw = realmWeights(p.xz);
  let M0v = bfx(rw, M0); let M1v = bfx(rw, M1); let M2v = bfx(rw, M2); let M3v = bfx(rw, M3);
  let M4v = bfx(rw, M4); let M5v = bfx(rw, M5); let M6v = bfx(rw, M6);
  let S0v = bfx(rw, S0); let S1v = bfx(rw, S1); let S2v = bfx(rw, S2); let S3v = bfx(rw, S3);
  let S5v = bfx(rw, S5); let S6v = bfx(rw, S6); let S7v = bfx(rw, S7);
  let T3v = bfx(rw, T3);

  // breakup noise at three scales
  let nL = fbm(p.xz * (1.0 / 380.0), 3, 200u);
  let nM = fbm(p.xz * (1.0 / 41.0), 2, 210u);
  var nS = 0.0;
  let wS = bl(3.1, fp);
  if (wS > 0.0) { nS = vn(p.xz * (1.0 / 3.1), 220u) * wS; }

  // tangent frame along the contour (for streaks, flutes and rills)
  let gl2 = length(cd.yz);
  let down = select(vec2f(1.0, 0.0), -cd.yz / gl2, gl2 > 1e-4); // downhill in xz
  let tng = vec2f(-down.y, down.x);
  let u = dot(p.xz, tng);

  // geographic realm weights (outcrops, not cross-fades)
  let wPaint = geo(M4v.x, nL * 0.8 + 0.5 * (slope - 0.25));
  let wSalt = geo(M4v.y, nL);
  let wStone = geo(M4v.z, nL);
  let wIce = geo(M4v.w, nL);
  let wLum = geo(M5v.x, nL);
  let wHome = geo(M5v.z, nL);

  // ---- base: grass / soil / scree / rock, height-blended ----
  var dg = vec3f(0.0); // detail height gradient (world)
  let gd = groundDetail(p.xz, fp);
  dg += vec3f(gd.y, 0.0, gd.z);
  var rd = vec4f(1.0, 0.0, 0.0, 0.0);
  let rockMask = clamp(sstep(0.2, 0.42, slope + 0.1 * nM) + sstep(-0.05, -0.25, conc) * sstep(0.08, 0.2, slope) * 0.8, 0.0, 1.0);
  if (rockMask > 0.02 || mB.z > 0.1) { rd = rockDetail(p, fp, 1.0, 1.0); }
  let rH = 0.5 + 0.3 * nM + 0.4 * (rd.x - 1.0) + 0.15 * nS;
  let gH = 0.5 + 0.15 * gd.x;
  let tw = 0.06 + min(fp * 0.02, 0.2);
  let rockW = sstep(-tw, tw, (rockMask - 0.5) * 1.7 + (rH - gH) * 0.8) * step(0.02, rockMask);
  // scree collects in hollows under rock; soil shows at the edges of the turf
  let rockNear = sstep(0.12, 0.3, slope + 0.1 * nM);
  let screeW = (1.0 - rockW) * rockNear * sstep(-0.1, 0.35, nS + 0.6 * conc + 0.3 * nM);
  let soilW = (1.0 - rockW) * (1.0 - screeW) * sstep(0.3, 0.6, rockMask + 0.25 * nS) * 0.55;

  // grass: wind-swept lighter ridges, darker damp hollows, heather and ochre patches on the slopes
  let ridge = sstep(0.0, -0.25, conc);
  let hollow = sstep(0.02, 0.35, conc);
  var grass = M0v.rgb * (0.85 + 0.22 * nL + 0.12 * gd.x);
  grass = mix(grass, grass * vec3f(1.3, 1.22, 0.78), ridge * 0.65);
  grass = mix(grass, grass * vec3f(0.62, 0.78, 0.72), hollow * 0.7);
  // heather and dry ochre grass: drifts elongated along the contours, muted, never blotches
  let along0 = dot(p.xz, down);
  let patchN = vn(vec2f(u * (1.0 / 140.0), along0 * (1.0 / 45.0)), 255u) + 0.2 * vn(p.xz * (1.0 / 17.0), 256u) + 0.25 * nM;
  let onSlope = sstep(0.05, 0.14, slope) * sstep(0.42, 0.26, slope) * (1.0 - hollow);
  let heather = sstep(0.25, 0.6, patchN) * onSlope * M5v.w;
  let ochre = sstep(0.25, 0.6, 0.7 * ridge - 0.4 * patchN) * M5v.w;
  grass = mix(grass, vec3f(0.085, 0.05, 0.06) * (0.85 + 0.3 * gd.x), heather * 0.55);
  grass = mix(grass, vec3f(0.2, 0.15, 0.05) * (0.85 + 0.3 * gd.x), ochre * 0.45);
  // close turf: blade-scale tone so the ground under the flora is never a smear
  let wT = bl(0.08, fp);
  if (wT > 0.0) { grass *= 1.0 + 0.25 * vn(p.xz * (1.0 / 0.08), 236u) * wT; }
  let wC = bl(0.35, fp);
  if (wC > 0.0) { grass *= 1.0 - 0.3 * sstep(0.15, 0.6, vn(p.xz * (1.0 / 0.35), 237u)) * wC; } // soil between tufts

  let soil = mix(vec3f(0.11, 0.075, 0.045), M1v.rgb * 1.4, 0.3) * (0.85 + 0.3 * gd.x);
  var scree = M1v.rgb * 1.35;
  var screeD = vec3f(0.0);
  if (screeW > 0.01 && fp < 0.12) {
    let pb = pebbles(p.xz, 0.32);
    let pw = bl(0.32, fp);
    scree = mix(soil * 0.7, M1v.rgb * (1.0 + 0.9 * pb.w), sstep(0.02, 0.12, pb.x) * pw + (1.0 - pw) * 0.6);
    screeD = vec3f(pb.y, 0.0, pb.z) * 0.6 * pw;
  }
  let rock = M1v.rgb * (0.75 + 0.3 * nM) * rd.x;

  var alb = grass;
  alb = mix(alb, soil, soilW * M0v.w);
  alb = mix(alb, scree, screeW);
  alb = mix(alb, rock, max(rockW, 1.0 - M0v.w * (1.0 - screeW)));
  dg += rd.yzw * rockW + screeD * screeW;
  let hi = sstep(M2v.w - 50.0, M2v.w + 50.0, h + 60.0 * nL) * (1.0 - rockW * 0.6);
  alb = mix(alb, M2v.rgb * (0.9 + 0.2 * nM), hi);
  let shore = sstep(M3v.w + 1.2, M3v.w - 0.6, h + nS * 0.6 + nM * 0.5);
  alb = mix(alb, M3v.rgb * (0.85 + 0.3 * nM), shore);
  var rough = 0.88;
  var f0 = 0.03;
  var emis = vec3f(0.0);
  var wet = shore * 0.6 + hollow * 0.25 * M0v.w;
  var sheen = 0.0;

  // ---- Home Fjords: dark basalt with green ledges, waterfalls with spray, a pale tide line ----
  if (wHome > 0.01) {
    // basalt flows: horizontal layers of slightly different tone, ledges carry turf
    let lay = (h + 3.0 * vn(p.xz * (1.0 / 140.0), 32u));
    let flowT = 0.8 + 0.3 * hf(i32(floor(lay / 4.3)), 5, 244u);
    let led = fract((h + 4.0 * vn(p.xz * (1.0 / 90.0), 32u)) / max(T3v.w, 1.0));
    let tread = sstep(0.5, 0.3, slope) * rockMask * sstep(4.0, 1.0, FR.lv[l0].z);
    let ledge = clamp(sstep(0.62, 0.8, led) * T3v.z * 6.0 + tread * 0.6, 0.0, 1.0);
    let broken = sstep(-0.25, 0.35, vn(vec2f(u * (1.0 / 9.0), h * 0.1), 245u) + 0.3 * nS);
    let ledgeG = sstep(0.45, 0.6, ledge + 0.3 * (gH - 0.5) + 0.2 * nS) * broken;
    var bas = M1v.rgb * flowT * rd.x * vec3f(0.82, 0.9, 1.05);
    bas = mix(bas, bas * 0.6, (1.0 - sstep(0.0, 0.05, abs(fract(lay / 4.3) - 0.5) - 0.42)) * bl(1.0, fp) * 0.5);
    let homeRock = mix(bas, M0v.rgb * (0.65 + 0.4 * nS + 0.2 * gd.x), ledgeG * 0.9);
    alb = mix(alb, homeRock, rockW * wHome);
    // thread-thin waterfalls on steep concave faces (coverage-preserving: thin threads stay visible far away)
    let cell = floor(u / 26.0);
    let cu = u - cell * 26.0 - 4.0 - 18.0 * hf(i32(cell), i32(floor(h / 400.0)), 240u);
    let present = select(0.0, 1.0, hf(i32(cell), 3, 241u) < 0.35);
    let wid = 0.25 + 0.4 * hf(i32(cell), 4, 242u);
    let wv = max(wid, fp * 0.7);
    let strk = sstep(wv, wv * 0.3, abs(cu)) * present * (wid / wv);
    let gully = sstep(0.02, 0.25, conc);
    let steep = sstep(0.35, 0.6, slope);
    let flow = 0.55 + 0.45 * vn(vec2f(u * 0.5, (h + tm * 7.0) * 0.25), 243u);
    let fall = strk * steep * max(gully, 0.25) * wHome * flow * sstep(1.0, 8.0, h);
    // spray: a wider wet halo around each thread and a white mist at the foot of the drop
    let halo = sstep(6.0, 0.5, abs(cu)) * present * max(gully, 0.25) * wHome;
    let foot = halo * sstep(16.0, 2.0, h) * sstep(0.2, 0.5, slope);
    wet = max(wet, halo * steep * 0.55);
    alb = mix(alb, alb * 0.6, sstep(0.0, 0.3, conc) * steep * wHome * 0.6);
    alb = mix(alb, vec3f(0.82, 0.86, 0.88), clamp(fall + foot * 0.45 * (0.6 + 0.4 * nS), 0.0, 1.0));
    // pale tide line on the rock just above the sea, dark wet rock below it
    let tl = h + 0.25 * nS + 0.3 * nM;
    let tide = sstep(0.1, 0.5, tl) * sstep(2.0, 1.3, tl) * wHome;
    alb = mix(alb, vec3f(0.42, 0.42, 0.38) * (0.8 + 0.3 * rd.x), tide * 0.8);
    wet = max(wet, sstep(0.6, 0.0, tl) * wHome);
    // meadow flowers (yellow, white, violet): sparse dots under the flora
    if (M5v.w > 0.01 && fp < 0.12 && dist > 20.0) {
      let fc = floor(p.xz * 3.0);
      let fh = hf(i32(fc.x), i32(fc.y), 250u);
      let fpp = p.xz * 3.0 - fc - 0.5;
      let dens = sstep(0.1, 0.5, vn(p.xz * (1.0 / 23.0), 251u)) * (1.0 - rockW) * (1.0 - shore) * (1.0 - heather);
      if (fh < 0.22 * dens) {
        let dot1 = sstep(0.22, 0.1, length(fpp)) * bl(0.33, fp) * M5v.w * sstep(20.0, 35.0, dist); // real flowers take over near
        let k = hf(i32(fc.x), i32(fc.y), 252u);
        var fcol = vec3f(0.85, 0.62, 0.05);
        if (k > 0.55) { fcol = vec3f(0.85, 0.85, 0.8); }
        if (k > 0.82) { fcol = vec3f(0.32, 0.16, 0.6); }
        alb = mix(alb, fcol, dot1);
      }
    }
  }

  // ---- Painted Range: dipping, folded strata with sub-bands, rills across the beds, prismatic pools ----
  if (wPaint > 0.01) {
    var s = h - strataTilt(p.xz);
    // erosion rills run downhill across the beds; beds sag into them
    var rill = 0.0;
    let wr = bl(5.0, fp) * sstep(0.1, 0.28, slope) * (1.0 - sstep(0.2, 0.4, mA.z));
    if (wr > 0.0) {
      let rn = vnoised(vec2f(u * (1.0 / 5.0), dot(p.xz, down) * (1.0 / 45.0)), 317u);
      let ar = abs(rn.x);
      rill = (1.0 - sstep(0.0, 0.2, ar)) * wr;
      s += rill * 1.4;
      let gu = sign(rn.x) * rn.y * (1.0 / 5.0) * 1.2 * (1.0 - sstep(0.0, 0.2, ar)) * wr;
      dg += vec3f(tng.x, 0.0, tng.y) * gu;
    }
    // two taps across the pixel's height span, a cycle-averaged tone when beds get sub-pixel
    let sp = min(fwh, 2.0) * 0.35;
    var sc = 0.5 * (strataAt(s - sp) + strataAt(s + sp));
    let farT = danxia(0.4 + 0.42 * (vn(vec2f(floor(s / 6.5) * 0.23, 3.7), 312u)));
    sc = mix(sc, farT * 1.05, sstep(1.2, 4.0, fwh));
    // gentle ground is mantled by sand washed off the beds: bands show on the faces, not as marbling on the flats
    sc = mix(sc, mix(farT, vec3f(0.42, 0.2, 0.08), 0.4) * (0.95 + 0.1 * nM), sstep(0.13, 0.04, slope) * 0.65);
    // fine sub-banding and sandy grain
    let sb = bl(0.6, fwh * 3.0 + fp);
    sc *= 1.0 + 0.09 * sb * vn(vec2f(s * (1.0 / 0.33), u * 0.02), 318u);
    sc *= 0.92 + 0.12 * nS + 0.08 * gd.x;
    sc *= 1.0 - 0.28 * rill;
    // sediment fans in the hollows, sparse dry turf on the treads
    sc = mix(sc, vec3f(0.5, 0.3, 0.15), hollow * 0.45);
    let veg = sstep(0.16, 0.05, slope) * sstep(0.15, 0.55, nM + 0.25 * gd.x) * M0v.w;
    let painted = mix(sc, vec3f(0.17, 0.17, 0.07) * (0.85 + 0.3 * gd.x), veg * 0.8);
    alb = mix(alb, painted, wPaint);
    rough = mix(rough, 0.95, wPaint);
    dg += vec3f(gd.y, 0.0, gd.z) * 0.5 * wPaint; // sandier
    // hot pools: rho 0 centre .. 1 water edge .. 2.4 mat tips
    if (mA.z > 0.01) {
      let rho = (1.0 - mA.z) * 2.4;
      var pc = vec3f(0.62, 0.58, 0.5); // sinter crust between the fingers
      pc = mix(pc, vec3f(0.3, 0.085, 0.025), sstep(2.35, 1.9, rho));   // rust mats
      pc = mix(pc, vec3f(0.55, 0.2, 0.03), sstep(1.6, 1.35, rho));     // orange
      pc = mix(pc, vec3f(0.62, 0.45, 0.08), sstep(1.22, 1.08, rho));   // yellow
      pc = mix(pc, vec3f(0.2, 0.36, 0.1), sstep(1.04, 0.97, rho));     // green edge
      pc = mix(pc, vec3f(0.05, 0.32, 0.4), sstep(0.97, 0.85, rho));    // cyan
      pc = mix(pc, vec3f(0.005, 0.06, 0.26), sstep(0.8, 0.5, rho));    // deep blue
      let pw = sstep(2.4, 2.2, rho) * wPaint;
      let mats = sstep(0.0, 0.25, mA.z);
      alb = mix(alb, pc * (0.9 + 0.15 * nS), pw * mats);
      let water = sstep(1.02, 0.96, rho) * wPaint;
      rough = mix(rough, 0.04, water);
      f0 = mix(f0, 0.02, water);
      dg *= 1.0 - water;
      wet = max(wet, sstep(1.4, 1.0, rho) * 0.5 * wPaint);
      emis += pc * water * 0.04;
    }
  }

  // ---- Mirror Salt: salt polygons; cone islands of dark volcanic rock, ochre lichen, salt crust ----
  if (wSalt > 0.01) {
    var salt = M0v.rgb * (0.9 + 0.08 * nM);
    if (fp < 0.3) {
      let ed = saltEdge(p.xz);
      let rim = (1.0 - sstep(0.0, 0.06, ed)) * bl(2.0, fp);
      salt *= 1.0 + 0.12 * rim - 0.05 * nS;
    }
    let cone = sstep(0.15, 0.6, mB.z);
    let crd = rd;
    var volc = vec3f(0.034, 0.027, 0.026) * (0.8 + 0.5 * nM) * crd.x;
    let lich = sstep(0.15, 0.4, fbm(p.xz * (1.0 / 11.0), 2, 262u) + 0.3 * nM) * sstep(0.45, 0.15, slope);
    volc = mix(volc, vec3f(0.3, 0.17, 0.035) * (0.8 + 0.3 * crd.x), lich * 0.85);
    let crust = sstep(2.6, 0.6, h + 0.8 * nS + 0.6 * nM);
    volc = mix(volc, vec3f(0.78, 0.72, 0.66), crust);
    let sa = mix(salt, volc, cone);
    alb = mix(alb, sa, wSalt);
    dg += rd.yzw * cone * wSalt * (1.0 - rockW);
    rough = mix(rough, mix(0.75, 0.9, cone), wSalt);
  }

  // ---- Stone Forest: fluted, bedded limestone pillars; canopy crowns that spill over the rims; jungle floor ----
  if (wStone > 0.01) {
    // pillar top height: max over the bilinear footprint, so walls never see a top blurred with the ground
    let tg = textureGather(1, clipA, clipSm, clipUV(l0, p.xz), l0);
    let topH = max(max(tg.x, tg.y), max(tg.z, tg.w)) * 600.0;
    let below = topH - h; // m under the pillar top
    let wf = select(0.0, clamp(1.0 - below / max(topH - 40.0, 20.0), 0.0, 1.0), topH > 1.0); // ~0 foot .. 1 top
    let fineGeo = sstep(4.0, 1.0, FR.lv[l0].z); // slope is trustworthy only on fine levels
    let onPillar = sstep(1.0, 3.0, topH) * sstep(1.5, 4.0, below) * sstep(0.02, 0.1, wf);
    let wall = max(sstep(0.4, 0.75, slope), onPillar * sstep(0.15, 0.35, slope));
    let sd = rockDetail(p * vec3f(1.0, 0.6, 1.0), fp, 1.6, 0.6);
    // vertical fluting: grooves across the contour direction
    let wfl = bl(2.4, fp) * wall;
    var flute = 0.0;
    if (wfl > 0.0) {
      let fl = vnoised(vec2f(u * (1.0 / 2.4), h * (1.0 / 60.0)), 285u);
      flute = fl.x;
      dg += vec3f(tng.x, 0.0, tng.y) * fl.y * (1.0 / 2.4) * 0.5 * wfl;
    }
    // bedding cracks: thin horizontal dark lines of irregular spacing
    let bedS = h + 1.5 * vn(vec2f(u * (1.0 / 30.0), 2.0), 286u);
    let bk = floor(bedS / 4.0);
    let bedPos = 4.0 * (bk + 0.3 + 0.4 * hf(i32(bk), 2, 287u));
    let bw = max(0.12, fp * 0.6);
    let crack = (1.0 - sstep(bw * 0.4, bw, abs(bedS - bedPos))) * (0.12 / bw) * bl(1.0, fp) * wall;
    var lime = M1v.rgb * (0.9 + 0.25 * flute + 0.15 * nS) * sd.x;
    lime = mix(lime, lime * vec3f(1.15, 0.95, 0.7), sstep(0.0, 0.6, vn(vec2f(u * 0.04, h * 0.01), 284u)) * 0.6); // ochre stain
    let streak = vn(vec2f(u * 0.3, h * 0.015), 280u) * 0.5 + vn(vec2f(u * 1.1, h * 0.05), 281u) * 0.3;
    lime = mix(lime, lime * vec3f(0.45, 0.48, 0.42), sstep(0.05, 0.45, -streak) * 0.8); // water stains
    lime *= 1.0 - 0.6 * min(crack, 1.0);
    // ledges with clinging green: any less-steep spot on a wall, and the lips of bedding cracks
    let ledgeV = sstep(0.5, 0.3, slope) * onPillar * fineGeo;
    let cling = sstep(0.45, 0.7, ledgeV + 0.5 * min(crack, 1.0) * sstep(0.1, 0.5, vn(vec2f(u * 0.12, h * 0.25), 289u)) + 0.25 * nS);
    lime = mix(lime, M0v.rgb * (0.7 + 0.4 * nS), cling * 0.85);
    // canopy: rounded crowns (geometry) shaded from their own normals; green spills down the rim in strands
    let crownT = 0.55 + 0.6 * sstep(-0.3, 0.6, vn(p.xz * (1.0 / 5.5), 283u) + 0.5 * nM) + 0.3 * gd.x;
    let canopy = M0v.rgb * crownT * mix(vec3f(1.0), vec3f(1.25, 1.18, 0.7), sstep(0.3, 0.8, nL) * 0.4);
    let strand = sstep(0.0, 0.5, vn(vec2f(u * (1.0 / 1.6), 0.5), 288u) + 0.3 * nS);
    let spill = sstep(6.0 + 14.0 * strand, 2.0, below) * sstep(1.0, 3.0, topH);
    let top = sstep(2.5, 0.5, below) * sstep(1.0, 3.0, topH);
    // jungle floor: dark, damp, mossy; darker still at the pillar feet
    var floorC = M3v.rgb * (0.7 + 0.4 * gd.x + 0.2 * nM);
    floorC = mix(floorC, M0v.rgb * 0.55, sstep(-0.2, 0.4, nM + 0.3 * gd.x) * 0.7);
    var sf = mix(floorC, lime, wall);
    sf = mix(sf, canopy, max(top, spill * wall));
    sf = mix(sf, canopy * 0.8, sstep(0.55, 0.3, slope) * sstep(30.0, 8.0, below) * onPillar * fineGeo);
    alb = mix(alb, sf, wStone);
    dg += sd.yzw * wall * wStone;
    rough = mix(rough, 0.95, wStone);
    let low = sstep(70.0, 30.0, h) * (1.0 - wall);
    wet = max(wet, low * 0.6 * wStone);
  }

  // ---- Aurora Ice: blue-white glacier with ogives and sastrugi, narrow deep-blue crevasses glowing from inside,
  //      black sand with a wet sheen and stranded ice, faceted striated bergs ----
  if (wIce > 0.01) {
    let gl = mB.w;
    // ogives: dirt bands across the flow (flow = broad downhill direction)
    let cl = clipS(lb, p.xz);
    let bd = select(vec2f(1.0, 0.0), -cl.yz / max(length(cl.yz), 1e-4), length(cl.yz) > 1e-4);
    let along = dot(p.xz, bd) + 18.0 * vn(p.xz * (1.0 / 260.0), 291u);
    let og = sstep(0.55, 0.9, 0.5 + 0.5 * sin(along * (6.2832 / 75.0))) * bl(30.0, fp);
    var ice = mix(vec3f(0.5, 0.66, 0.78), vec3f(0.78, 0.86, 0.92), sstep(-0.4, 0.5, nM + 0.4 * nS));
    // wind-packed snow on the flats, bare compacted blue ice where it is scoured
    let snow = sstep(-0.1, 0.35, fbm(p.xz * (1.0 / 70.0), 3, 294u) + 0.3 * nS) * sstep(0.25, 0.1, slope);
    ice = mix(ice * vec3f(0.85, 0.95, 1.05), vec3f(0.86, 0.9, 0.95), snow * 0.8);
    ice = mix(ice, ice * vec3f(0.55, 0.52, 0.5), og * 0.6 * (1.0 - snow * 0.7));
    ice = mix(ice, vec3f(0.22, 0.45, 0.65), sstep(0.4, 0.8, slope)); // blue on steep ice faces
    // sastrugi: wind ridges, fine and elongated
    let ws = bl(0.9, fp);
    if (ws > 0.0) {
      let sq = vec2f(p.x * 0.8 + p.z * 0.6, -p.x * 0.6 + p.z * 0.8) * vec2f(1.0 / 0.9, 1.0 / 5.0);
      let sn = vnoised(sq, 292u);
      dg += vec3f(sn.y * (0.8 / 0.9) - sn.z * (0.6 / 5.0), 0.0, sn.y * (0.6 / 0.9) + sn.z * (0.8 / 5.0)) * 0.12 * ws * gl * (0.3 + 0.7 * snow);
      ice *= 1.0 + 0.05 * sn.x * ws;
    }
    // crevasses: rim white -> cyan -> deep blue with depth
    let crev = mB.x;
    ice = mix(ice, vec3f(0.12, 0.45, 0.7), sstep(0.08, 0.45, crev));
    ice = mix(ice, vec3f(0.01, 0.05, 0.2), sstep(0.45, 0.95, crev));
    // black sand with a wet sheen near the water and stranded ice chunks
    var sand = M3v.rgb * (0.8 + 0.4 * gd.x + 0.3 * nM);
    let wetS = sstep(1.2, 0.2, h + 0.3 * nS);
    var chunk = 0.0;
    if (fp < 0.2 && h > 0.05 && h < 3.0) {
      let pb = pebbles(p.xz + vec2f(13.0, 7.0), 1.2);
      let has = select(0.0, 1.0, pb.w < 0.1) * sstep(0.05, 0.2, pb.x) * bl(1.2, fp);
      chunk = has;
      dg += vec3f(pb.y, 0.0, pb.z) * 1.4 * has;
    }
    sand = mix(sand, vec3f(0.62, 0.8, 0.88), chunk);
    var ia = mix(sand, ice, gl);
    let bergM = mB.z;
    let berg = sstep(0.5, 0.6, bergM);
    let shelf = sstep(0.0, 0.08, bergM) * (1.0 - berg);
    let thin = (1.0 - sstep(0.5, 0.8, bergM)) * berg; // thin rim of the berg
    var bc = mix(vec3f(0.55, 0.78, 0.88), vec3f(0.85, 0.93, 0.97), sstep(-0.2, 0.4, vn(vec2f(h * (1.0 / 0.7), u * 0.05), 293u)));
    bc = mix(bc, vec3f(0.2, 0.62, 0.78), max(thin, sstep(0.5, 0.85, slope)) * 0.7); // translucent cyan edges
    ia = mix(ia, bc, berg);
    ia = mix(ia, vec3f(0.3, 0.75, 0.82), shelf);
    alb = mix(alb, ia, wIce);
    let glow = crev * crev * 0.55 + berg * (thin * 0.35 + sstep(0.5, 0.9, slope) * 0.12) + shelf * 0.5 + gl * sstep(0.5, 0.85, slope) * 0.06;
    let gcol = mix(M6v.rgb, vec3f(0.05, 0.3, 0.9), crev * 0.6);
    emis += gcol * M6v.w * glow * wIce * 0.6;
    rough = mix(rough, mix(mix(0.3, 0.12, chunk), 0.22, gl), wIce);
    rough = mix(rough, 0.14, wetS * (1.0 - gl) * wIce);
    f0 = mix(f0, mix(0.03, 0.05, chunk), wIce);
    wet = max(wet, (1.0 - gl) * wetS * 0.7 * wIce);
    dg *= 1.0 - shelf;
  }

  // ---- Lumen Deep: near-black velvet ground, delta veins pulsing out of glowing sinkholes, amber lichen,
  //      pale teal faceted crystals with inner glow ----
  if (wLum > 0.01) {
    var lg = M1v.rgb * (0.75 + 0.35 * gd.x + 0.25 * nM);
    // amber-gold lichen patches: the complementary accent
    let lichN = fbm(p.xz * (1.0 / 14.0), 2, 302u) + 0.35 * nM;
    let lich = sstep(0.55, 0.7, lichN) * (1.0 - sstep(0.3, 0.5, slope)) * sstep(0.2, 0.5, vn(p.xz * (1.0 / 3.3), 304u) + 0.4);
    lg = mix(lg, vec3f(0.22, 0.11, 0.015) * (0.75 + 0.5 * gd.x), lich * 0.9);
    emis += vec3f(0.45, 0.22, 0.03) * lich * 0.03 * wLum;
    // veins: bold, branching, pulsing outward from the nearest sinkhole
    let rho = mA.x * 6.0;
    let vein = mA.w;
    let pulse = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(rho * 3.2 - tm * 0.9), 5.0);
    let core = sstep(0.55, 0.95, vein);
    let vcol = mix(M6v.rgb, vec3f(0.75, 1.0, 0.95), core * 0.6);
    emis += vcol * (vein * vein * 0.7 + core * 0.5) * pulse * M6v.w * wLum * 0.6;
    lg = mix(lg, vec3f(0.02, 0.1, 0.1), vein);
    // crystals
    let cr = mB.y * M5v.y;
    let ccol = vec3f(0.3, 0.68, 0.64);
    let inner = 0.2 + 0.8 * pow(1.0 - max(dot(gn, V), 0.0), 2.0);
    emis += M6v.rgb * cr * M6v.w * inner * 0.28 * wLum;
    lg = mix(lg, ccol, cr);
    // sinkhole floor glows through the water
    let underL = sstep(0.0, -4.0, h);
    emis += M6v.rgb * underL * 0.6 * M6v.w * wLum;
    // sparse glints in the velvet
    if (fp < 0.1) {
      let sc = floor(p.xz * 2.0);
      let sh = hf(i32(sc.x), i32(sc.y), 301u);
      let sp = sstep(0.25, 0.05, length(p.xz * 2.0 - sc - 0.5)) * select(0.0, 1.0, sh < 0.03) * bl(0.5, fp);
      emis += vec3f(0.6, 0.9, 1.0) * sp * wLum * (0.5 + 0.5 * sin(tm * 3.0 + sh * 600.0)) * 0.6;
    }
    alb = mix(alb, lg, wLum);
    rough = mix(rough, mix(0.9, 0.18, cr), wLum);
    f0 = mix(f0, mix(0.03, 0.08, cr), wLum);
    sheen = wLum * (1.0 - cr);
    if (fp < 0.1) { let fz = vnoised(p.xz * (1.0 / 0.07), 303u); dg += vec3f(fz.y, 0.0, fz.z) * 0.04 * bl(0.07, fp) * wLum; }
  }

  // underwater: darker, wet
  let under = sstep(0.3, -0.5, h);
  wet = max(wet, under);
  alb *= 1.0 - 0.45 * clamp(wet, 0.0, 1.0);
  rough = mix(rough, 0.25, clamp(wet, 0.0, 1.0) * 0.7);

  // detail normal: remove the part of the detail gradient along the normal, tilt against it
  var n = normalize(gn - (dg - gn * dot(dg, gn)));
  if (dot(n, V) < 0.02) { n = normalize(n + V * (0.02 - dot(n, V))); }

  // ---- light ----
  let L = sunDirFrom(S0v, FR.sun.w);
  let horizon = sstep(-0.035, 0.06, L.y);
  let sunC = S1v.rgb * S0v.z * horizon;
  let jit = ign(in.pos.xy);
  var sh = 0.0;
  let ndl = dot(n, L);
  if (horizon > 0.0 && dot(gn, L) > -0.1) {
    var steps = i32(mix(22.0, 10.0, sstep(400.0, 4000.0, dist)));
    if (q < 0.5) { steps = steps / 2 + 1; }
    sh = sunShadow(p + gn * (0.3 + dist * 0.002), L, dist, S6v.y, jit, steps);
    sh *= cloudShadow(p, L, rw); // cloud shadows (common.wgsl, same coverage field as the cloud pass)
  }
  // occlusion from the baked ring concavity at three scales
  let occ = max(ca, 0.0) * 0.9 + max(cb, 0.0) * 1.6 + max(cc, 0.0) * 2.2;
  let ao = clamp(1.0 - occ, 0.3, 1.0) * clamp(1.0 - max(conc, 0.0) * 0.5, 0.55, 1.0);

  let zen = S2v.rgb * S3v.w;
  let hor = S3v.rgb * S3v.w;
  let skyUp = mix(hor, zen, 0.55) * S6v.x + S7v.rgb * S7v.w;
  let ground = (hor * 0.25 + alb * sunC * max(L.y, 0.0) * 0.6) * S6v.w;
  let amb = mix(ground, skyUp, 0.5 + 0.5 * n.y) * ao;
  var col = alb * (sunC * max(ndl, 0.0) * sh + amb);
  // Lumen: the ringed giant and the moons light the dunes from the sky; velvet sheen at grazing angles
  if (sheen > 0.0) {
    let Gd = vec3f(0.553, 0.438, -0.708);
    let gcol = vec3f(0.5, 0.36, 0.42) * S5v.z;
    let wrapG = clamp((dot(n, Gd) + 0.3) / 1.3, 0.0, 1.0);
    col += alb * gcol * wrapG * 1.2 * ao;
    let rimF = pow(1.0 - max(dot(n, V), 0.0), 4.0);
    col += mix(hor, vec3f(0.3, 0.28, 0.7) * S3v.w, 0.6) * rimF * sheen * 0.3 * ao * (0.4 + 0.6 * wrapG);
  }
  // specular: sun + sky reflection for smooth surfaces
  let sp = ggx(n, V, L, rough, f0) * max(ndl, 0.0) * sh;
  col += sunC * sp;
  let R = reflect(-V, n);
  let fr = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  col += mix(hor, zen, clamp(R.y, 0.0, 1.0)) * fr * (1.0 - rough) * ao;
  col += emis;

  var o: FOut;
  o.c = vec4f(col, 1.0);
  if (VW.cam.w == 2.0) { o.c = vec4f(alb, 1.0); }
  if (VW.cam.w == 3.0) { o.c = vec4f(vec3f(sh * ao), 1.0); }
  if (VW.cam.w == 4.0) { o.c = vec4f(n * 0.5 + 0.5, 1.0); }
  if (VW.cam.w == 9.0) { o.c = vec4f(mA.xyw, 1.0); }  // masks A: sink distance, pillar wall, veins
  if (VW.cam.w == 10.0) { o.c = vec4f(mB.xyz, 1.0); } // masks B: crevasse, crystal, cone/berg
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
