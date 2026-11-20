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
  let dc = max(abs(gp.x - VW.anc.x), abs(gp.y - VW.anc.z)) / half; // morph from the head: same mesh in both eyes
  var m = clamp((dc - 0.62) / 0.26, 0.0, 1.0);
  if (li + 1u >= nLevels()) { m = 0.0; }
  let odd = vec2f(f32(ix & 1), f32(iz & 1));
  let p = gp - odd * s * m;
  // never sample a level whose baked square does not hold this vertex (stale or not baked yet after a jump):
  // FR.lv only moves when the level is rebaked, so clipLevel falls back to the coarser level until it is ready
  var h = 0.0;
  if (!isOff(OFF_TVERT)) {
    let lh = clipLevel(p, li, 1.0);
    h = clipH(lh, p);
    if (m > 0.0 && lh == li) { h = mix(h, clipH(clipLevel(p, li + 1u, 1.0), p), m); }
  }
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
  // measured-style albedos of Zhangye sandstones: maroon mudstone, brick red, orange, ochre, buff (r/g 1.2-2.6)
  var c0 = vec3f(0.17, 0.075, 0.055); var c1 = vec3f(0.3, 0.12, 0.08);
  if (i >= 1.0) { c0 = c1; c1 = vec3f(0.4, 0.19, 0.11); }
  if (i >= 2.0) { c0 = c1; c1 = vec3f(0.45, 0.29, 0.16); }
  if (i >= 3.0) { c0 = c1; c1 = vec3f(0.47, 0.38, 0.25); }
  if (i >= 4.0) { c0 = c1; c1 = vec3f(0.55, 0.49, 0.38); }
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


// Everything read from a level other than l0 is cross-faded by the same edge weight e as the l0 data, so no
// material or shading input switches at a level boundary (no hard seams where blurry meets sharp ground).
// concavity (per texel) at the first level >= lmin covering p
fn concL(lmin: u32, l0: u32, e: f32, p: vec2f) -> f32 {
  let a = clipLevel(p, max(l0, lmin), 4.0);
  var c = clipS(a, p).w / FR.lv[a].z;
  if (e > 0.0 && l0 + 1u >= lmin && l0 + 1u < nLevels()) {
    let b = clipLevel(p, l0 + 1u, 4.0);
    c = mix(c, clipS(b, p).w / FR.lv[b].z, e);
  }
  return c;
}
// baked shade `off` levels above l0
fn shadeL(off: u32, l0: u32, e: f32, p: vec2f) -> vec4f {
  let n = nLevels() - 1u;
  var s = clipSH(clipLevel(p, min(l0 + off, n), 4.0), p);
  if (e > 0.0 && l0 + off < n) { s = mix(s, clipSH(clipLevel(p, l0 + off + 1u, 4.0), p), e); }
  return s;
}

// ---- deferred terrain shading ----
// The terrain mesh is dense (sliver triangles at grazing angles) and the material is heavy, so the raster pass only
// marks coverage (fs: colour 0, dist.y = 1) and fsShade, a full-screen pass after the opaque pass, shades each pixel
// once from a terrain sample's depth and adds colour x terrain coverage into the resolved scene. Flora, fauna and the
// drone stay in the MSAA pass, so edges against them and the sky keep their sample coverage. Where the terrain
// samples of a pixel lie at clearly different depths (a ridge in front of far ground) both are shaded and weighted.
@fragment fn fs(in: VOut) -> FOut {
  var o: FOut;
  o.c = vec4f(0.0, 0.0, 0.0, 1.0);
  o.d = vec4f(length(VW.cam.xyz - in.wp), 1.0, 0.0, 1.0);
  return o;
}

@group(2) @binding(0) var tDistMS: texture_multisampled_2d<f32>; // the opaque pass's dist target (y: terrain mark)
@group(2) @binding(1) var tDepthMS: texture_depth_multisampled_2d;
const TNS: i32 = 4; // samples (terrain.js rewrites these three declarations for msaa 1)

@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}
fn unproject(fragXY: vec2f, z: f32) -> vec3f {
  let uv = fragXY * VW.size.zw;
  let r = VW.ivp * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return VW.cam.xyz + r.xyz / r.w;
}
@fragment fn fsShade(@builtin(position) fpos: vec4f) -> @location(0) vec4f {
  let px = vec2i(fpos.xy);
  var n0 = 0.0; var n1 = 0.0; var z0 = -1.0; var z1 = -1.0;
  for (var s = 0; s < TNS; s++) {
    if (textureLoad(tDistMS, px, s).y > 0.5) {
      let z = textureLoad(tDepthMS, px, s);
      if (z0 < 0.0) { z0 = z; n0 = 1.0; }
      else if (abs(z - z0) <= 0.02 * z0) { n0 += 1.0; }  // same surface (reverse-Z: relative depth)
      else { if (z1 < 0.0) { z1 = z; } n1 += 1.0; }
    }
  }
  let p0 = unproject(fpos.xy, max(z0, 1e-9));
  let fwh = min(fwidth(p0.y), 4.0); // uniform control flow here
  if (n0 == 0.0) { return vec4f(0.0); }
  let inv = 1.0 / f32(TNS);
  var c = terrainShade(p0, fpos.xy, fwh).c.rgb * (n0 * inv);
  if (n1 > 0.0) { c += terrainShade(unproject(fpos.xy, z1), fpos.xy, fwh).c.rgb * (n1 * inv); }
  return vec4f(c, 0.0);
}

fn terrainShade(p: vec3f, fragXY: vec2f, fwh: f32) -> FOut {
  let cam = VW.cam.xyz;
  let toCam = cam - p;
  let dist = length(toCam);
  let V = toCam / dist;
  let tm = FR.time.x;
  let q = FR.time.w;
  if (isOff(OFF_TFLAT)) { var ob: FOut; ob.c = vec4f(0.12, 0.14, 0.1, 1.0); ob.d = vec4f(dist, 0.0, 0.0, 1.0); return ob; }

  // clipmap data at the finest covering level, cross-faded to the next at its edge
  let l0 = clipLevel(p.xz, 0u, 6.0);
  let e = clipEdge(l0, p.xz);
  var cd = clipS(l0, p.xz);
  var mA = clipMA(l0, p.xz);
  var mB = clipMB(l0, p.xz);
  var sd0 = clipSH(l0, p.xz); // baked shade: sun shadow, sky visibility, nL, nM
  if (e > 0.0 && l0 + 1u < nLevels()) {
    cd = mix(cd, clipS(l0 + 1u, p.xz), e);
    mA = mix(mA, clipMA(l0 + 1u, p.xz), e);
    mB = mix(mB, clipMB(l0 + 1u, p.xz), e);
    sd0 = mix(sd0, clipSH(l0 + 1u, p.xz), e);
  }
  // baked occlusion: ring concavity at fixed coarse scales (4 m, 16 m, 64 m texels)
  let lb = clipLevel(p.xz, max(l0, 5u), 4.0);
  let ca = concL(3u, l0, e, p.xz);
  let cb = concL(5u, l0, e, p.xz);
  let cc = concL(7u, l0, e, p.xz);
  // texel size at this pixel, continuous across the level fade
  var tx = FR.lv[l0].z;
  if (e > 0.0 && l0 + 1u < nLevels()) { tx = mix(tx, FR.lv[l0 + 1u].z, e); }
  let conc = cb; // broad concavity (+ = gully, - = ridge)
  let gn = normalize(vec3f(-cd.y, 1.0, -cd.z));
  let slope = 1.0 - gn.y;
  let h = p.y;
  let ndvG = max(dot(gn, V), 0.04);
  var fp = dist * 2.0 * VW.fwd.w * VW.size.w * inverseSqrt(ndvG); // pixel footprint on the surface (m)
  if (isOff(OFF_TDETAIL)) { fp = max(fp, 8.0); } // ablation: every micro-detail octave fades out as if far away

  // realm blend
  var rw: RWt;
  if (isOff(OFF_TREALM)) { rw.id = vec4i(i32(FR.flags.y), -1, -1, -1); rw.w = vec4f(1.0, 0.0, 0.0, 0.0); rw.near = vec4f(0.0); }
  else { rw = realmWeightsMap(p.xz); }
  // the skin drifts (common.wgsl driftW): materials come from flow-displaced, sharpened weights; light does not
  var rwm = driftWM(p.xz, rw);
  // Mirror Salt seeks the low ground in a border: salt crust and brine creep along hollows between the neighbour's
  // tussocks and ridges instead of averaging into a pale mid tone
  if (rwm.id[1] >= 0) {
    let lowG = sstep(-0.12, 0.2, conc + 0.12 * (sd0.w * 2.0 - 1.0));
    var sw = 0.0;
    for (var s = 0; s < 4; s++) {
      if (rwm.id[s] == 2) { rwm.w[s] *= 0.25 + 1.75 * lowG; }
      sw += rwm.w[s];
    }
    rwm.w /= max(sw, 1e-6);
  }
  let M0v = bfx(rwm, M0); let M1v = bfx(rwm, M1); let M2v = bfx(rwm, M2); let M3v = bfx(rwm, M3);
  let M4v = bfx(rwm, M4); let M5v = bfx(rwm, M5); let M6v = bfx(rwm, M6);
  var S0v = bfx(rw, S0); var S1v = bfx(rw, S1); var S2v = bfx(rw, S2); var S3v = bfx(rw, S3);
  var S5v = bfx(rw, S5); var S6v = bfx(rw, S6); var S7v = bfx(rw, S7);
  // far ground takes the light of the sky the camera sees (the camera realm's row): a neighbour realm on the horizon
  // is not sunlit under this realm's night sky (no pale sunlit pillars on the Aurora Ice horizon)
  let fcam = sstep(1500.0, 4000.0, dist);
  if (fcam > 0.0) {
    S0v = mix(S0v, FR.row[S0], fcam); S1v = mix(S1v, FR.row[S1], fcam); S2v = mix(S2v, FR.row[S2], fcam);
    S3v = mix(S3v, FR.row[S3], fcam); S5v = mix(S5v, FR.row[S5], fcam); S6v = mix(S6v, FR.row[S6], fcam);
    S7v = mix(S7v, FR.row[S7], fcam);
  }
  let T3v = bfx(rwm, T3);

  // breakup noise at three scales
  // (nL and nM are baked into the shade layer: 0 noise evaluations here)
  let nL = sd0.z * 2.0 - 1.0;
  let nM = sd0.w * 2.0 - 1.0;
  var nS = 0.0;
  let wS = bl(3.1, fp);
  if (wS > 0.0) { nS = vn(p.xz * (1.0 / 3.1), 220u) * wS; }

  // tangent frame along the contour (for streaks, flutes and rills)
  let gl2 = length(cd.yz);
  let down = select(vec2f(1.0, 0.0), -cd.yz / gl2, gl2 > 1e-4); // downhill in xz
  let tng = vec2f(-down.y, down.x);
  let u = dot(p.xz, tng);

  // realm skin weights: already shaped into drifting tongues by driftW (no thresholds, no outcrop noise)
  let wPaint = M4v.x;
  let wSalt = M4v.y;
  let wStone = M4v.z;
  let wIce = M4v.w;
  let wLum = M5v.x;
  let wHome = M5v.z;

  // material outputs (off=tmat leaves them at these constants and skips the whole material section)
  var dg = vec3f(0.0); // detail height gradient (world)
  var alb = vec3f(0.15, 0.17, 0.12);
  var rough = 0.88;
  var f0 = 0.03;
  var emis = vec3f(0.0);
  var sheen = 0.0;
  var flatN = 0.0; // 1: shade as a level surface (pool water over terraced ground)
  var iceSnow = 0.0; var iceThin = 0.0;
  if (!isOff(OFF_TMAT)) {
  // ---- base: grass / soil / scree / rock, height-blended ----
  var gd = vec4f(0.0);
  if (!isOff(OFF_TDETAIL)) { gd = groundDetail(p.xz, fp); }
  dg += vec3f(gd.y, 0.0, gd.z);
  var rd = vec4f(1.0, 0.0, 0.0, 0.0);
  let rockMask = clamp(sstep(0.2, 0.42, slope + 0.1 * nM) + sstep(-0.05, -0.25, conc) * sstep(0.08, 0.2, slope) * 0.8, 0.0, 1.0);
  if ((rockMask > 0.02 || mB.z > 0.1) && !isOff(OFF_TDETAIL)) { rd = rockDetail(p, fp, 1.0, 1.0); }
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
  grass = mix(grass, grass * vec3f(1.22, 1.28, 0.8), ridge * 0.6); // yellow-green on the dry crests
  grass = mix(grass, grass * vec3f(0.62, 0.78, 0.72), hollow * 0.7);
  // heather and dry ochre grass: drifts elongated along the contours, muted, never blotches
  let along0 = dot(p.xz, down);
  let patchN = vn(vec2f(u * (1.0 / 140.0), along0 * (1.0 / 45.0)), 255u) + 0.2 * vn(p.xz * (1.0 / 17.0), 256u) + 0.25 * nM;
  let onSlope = sstep(0.05, 0.14, slope) * sstep(0.42, 0.26, slope) * (1.0 - hollow);
  let heather = sstep(0.25, 0.6, patchN) * onSlope * M5v.w;
  let ochre = sstep(0.25, 0.6, 0.7 * ridge - 0.4 * patchN) * M5v.w;
  // heather: dark brown-green, darker than the grass rather than redder (no orange blotches under a low sun)
  grass = mix(grass, mix(grass * 0.55, vec3f(0.07, 0.05, 0.055), 0.5) * (0.85 + 0.3 * gd.x), heather * 0.3);
  grass = mix(grass, mix(grass, vec3f(0.16, 0.14, 0.06), 0.6) * (0.85 + 0.3 * gd.x), ochre * 0.18); // ochre and heather only as accents
  // close turf: blade-scale tone so the ground under the flora is never a smear
  let wT = bl(0.08, fp);
  if (wT > 0.0) { grass *= 1.0 + 0.25 * vn(p.xz * (1.0 / 0.08), 236u) * wT; }
  // mid distance (30-500 m): clump mottling (1-3 m) and wind streaks (grass bent the same way, 2 m wide, 25 m long),
  // each fading to its mean as it drops under a few pixels, so the turf keeps a grain instead of a smear
  let wCl = bl(2.2, fp);
  if (wCl > 0.0 && M0v.w > 0.0) {
    let cl1 = vn(p.xz * (1.0 / 2.2), 238u) + 0.5 * vn(p.xz * (1.0 / 0.9), 239u) * bl(0.9, fp);
    grass *= 1.0 + 0.16 * cl1 * wCl;
  }
  let wWs = bl(2.5, fp);
  if (wWs > 0.0 && M0v.w > 0.0) {
    let wd = vec2f(0.83, 0.55);
    let st = vn(vec2f(dot(p.xz, vec2f(-wd.y, wd.x)) * (1.0 / 2.5), dot(p.xz, wd) * (1.0 / 25.0)), 234u);
    grass = mix(grass, grass * vec3f(1.22, 1.2, 1.05), sstep(0.1, 0.6, st) * 0.6 * wWs); // sheen where blades lean
  }
  let wC = bl(0.35, fp);
  if (wC > 0.0) { grass *= 1.0 - 0.3 * sstep(0.15, 0.6, vn(p.xz * (1.0 / 0.35), 237u)) * wC; } // soil between tufts

  let soil = mix(vec3f(0.085, 0.07, 0.05), M1v.rgb * 1.4, 0.4) * (0.85 + 0.3 * gd.x);
  var scree = M1v.rgb * 1.35;
  var screeD = vec3f(0.0);
  if (screeW > 0.01 && fp < 0.12) {
    let pb = pebbles(p.xz, 0.32);
    let pw = bl(0.32, fp);
    scree = mix(soil * 0.7, M1v.rgb * (1.0 + 0.9 * pb.w), sstep(0.02, 0.12, pb.x) * pw + (1.0 - pw) * 0.6);
    screeD = vec3f(pb.y, 0.0, pb.z) * 0.6 * pw;
  }
  let rock = M1v.rgb * (0.75 + 0.3 * nM) * rd.x;

  alb = grass;
  alb = mix(alb, soil, soilW * M0v.w * 0.6);
  alb = mix(alb, scree, screeW);
  alb = mix(alb, rock, max(rockW, 1.0 - M0v.w * (1.0 - screeW)));
  dg += rd.yzw * rockW + screeD * screeW;
  // uplands: one coherent cover by exposure and slope (drier paler grass in the shelter, dark heather on the exposed
  // convex ground, bare rock on the steep), with a broad altitude transition instead of khaki blotches
  let hi = sstep(M2v.w - 140.0, M2v.w + 90.0, h + 30.0 * nL) * (1.0 - rockW);
  let upl = mix(grass * vec3f(1.04, 1.0, 0.86), M2v.rgb * 0.62 * (0.9 + 0.2 * nM), 0.3);
  let expo = sstep(-0.02, -0.22, conc + 0.04 * nM);
  let upland = mix(upl, mix(upl * 0.55, vec3f(0.065, 0.05, 0.05), 0.5) * (0.85 + 0.3 * gd.x + 0.15 * nM), expo * 0.35 * M5v.w);
  alb = mix(alb, upland, hi);
  let shore = sstep(M3v.w + 1.2, M3v.w - 0.6, h + nS * 0.6 + nM * 0.5);
  alb = mix(alb, M3v.rgb * (0.85 + 0.3 * nM), shore);
  var wet = shore * 0.6 + hollow * 0.25 * M0v.w;

  // ---- Home Fjords: dark basalt with green ledges, waterfalls with spray, a pale tide line ----
  if (wHome > 0.01) {
    // basalt flows (only evaluated where there is rock: grass pixels skip all of this)
    if (rockW > 0.01) {
    // flows wander in height along the face and each has its own tone; the contacts between flows show only on some
    // flows and break along the contour; columnar joints cross them, so no flow line reads as a contour
    let lay = h + 3.0 * vn(p.xz * (1.0 / 140.0), 32u) + 1.6 * vn(vec2f(u * (1.0 / 40.0), h * (1.0 / 17.0)), 246u);
    let lk = floor(lay / 4.3);
    let flowT = 0.72 + 0.42 * hf(i32(lk), 5, 244u);
    let lp = (h + 4.0 * vn(p.xz * (1.0 / 90.0), 32u) + 2.5 * vn(vec2f(u * (1.0 / 55.0), 7.0), 247u)) / max(T3v.w, 1.0);
    let led = fract(lp) * select(0.0, 1.0, hf(i32(floor(lp)), 9, 248u) < 0.6);
    let tread = sstep(0.5, 0.3, slope) * rockMask * sstep(4.0, 1.0, tx);
    let ledge = clamp(sstep(0.62, 0.8, led) * T3v.z * 6.0 + tread * 0.6, 0.0, 1.0);
    let broken = sstep(-0.25, 0.35, vn(vec2f(u * (1.0 / 9.0), h * 0.1), 245u) + 0.3 * nS);
    let ledgeG = sstep(0.45, 0.6, ledge + 0.3 * (gH - 0.5) + 0.2 * nS) * broken;
    var bas = M1v.rgb * flowT * rd.x * vec3f(0.92, 0.95, 1.02);
    let joint = (1.0 - sstep(0.0, 0.06, abs(lay / 4.3 - lk - 0.5) - 0.41)) * select(0.0, 1.0, hf(i32(lk), 8, 249u) < 0.45)
              * sstep(-0.2, 0.25, vn(vec2f(u * (1.0 / 16.0), lk * 1.7), 253u));
    bas = mix(bas, bas * 0.62, joint * bl(1.0, fp) * 0.5);
    let wcol = bl(2.0, fp);
    if (wcol > 0.0) { bas *= 1.0 + 0.16 * vn(vec2f(u * (1.0 / 1.9), lay * (1.0 / 7.0)), 254u) * wcol; } // columns
    let homeRock = mix(bas, M0v.rgb * (0.65 + 0.4 * nS + 0.2 * gd.x), ledgeG * 0.9);
    alb = mix(alb, homeRock, rockW * wHome);
    }
    // thread-thin waterfalls on steep concave faces (coverage-preserving: thin threads stay visible far away)
    let steep = sstep(0.35, 0.6, slope);
    let gully = sstep(0.02, 0.25, conc);
    if (slope > 0.2) {
    let cell = floor(u / 26.0);
    let cu = u - cell * 26.0 - 4.0 - 18.0 * hf(i32(cell), i32(floor(h / 400.0)), 240u);
    let present = select(0.0, 1.0, hf(i32(cell), 3, 241u) < 0.35);
    let wid = 0.25 + 0.4 * hf(i32(cell), 4, 242u);
    let wv = max(wid, fp * 0.7);
    let strk = sstep(wv, wv * 0.3, abs(cu)) * present * (wid / wv);
    let flow = 0.55 + 0.45 * vn(vec2f(u * 0.5, (h + tm * 7.0) * 0.25), 243u);
    let fall = strk * steep * max(gully, 0.25) * wHome * flow * sstep(1.0, 8.0, h);
    // spray: a wider wet halo around each thread and a white mist at the foot of the drop
    let halo = sstep(6.0, 0.5, abs(cu)) * present * max(gully, 0.25) * wHome;
    let foot = halo * sstep(16.0, 2.0, h) * sstep(0.2, 0.5, slope);
    wet = max(wet, halo * steep * 0.55);
    alb = mix(alb, alb * 0.6, sstep(0.0, 0.3, conc) * steep * wHome * 0.6);
    alb = mix(alb, vec3f(0.82, 0.86, 0.88), clamp(fall + foot * 0.45 * (0.6 + 0.4 * nS), 0.0, 1.0));
    }
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
      flatN = max(flatN, sstep(1.15, 0.95, rho) * wPaint);
      wet = max(wet, sstep(1.4, 1.0, rho) * 0.5 * wPaint);
      emis += pc * water * 0.04;
    }
  }

  // ---- Mirror Salt: salt polygons; cone islands of dark volcanic rock, ochre lichen, salt crust ----
  if (wSalt > 0.01) {
    var salt = RT[2u * ROW + M0].rgb * (0.9 + 0.08 * nM); // the salt's own colour, not the blended M0 (no beige mix)
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
    // brine: in a border the salt in the hollows is wet and glassy (a thin sheet creeping between the tussocks)
    let brine = wSalt * (1.0 - cone) * sstep(0.04, 0.25, conc) * (1.0 - M4v.y);
    wet = max(wet, min(brine * 3.0, 0.55));
    rough = mix(rough, 0.2, clamp(brine * 3.0, 0.0, 0.8));
  }

  // ---- Stone Forest: fluted, bedded limestone pillars; canopy crowns that spill over the rims; jungle floor ----
  if (wStone > 0.01) {
    // pillar top height: max over the bilinear footprint, so walls never see a top blurred with the ground
    let tg = textureGather(1, clipA, clipSm, clipUV(l0, p.xz), l0);
    let topH = max(max(tg.x, tg.y), max(tg.z, tg.w)) * 600.0;
    let below = topH - h; // m under the pillar top
    let wf = select(0.0, clamp(1.0 - below / max(topH - 40.0, 20.0), 0.0, 1.0), topH > 1.0); // ~0 foot .. 1 top
    let fineGeo = sstep(4.0, 1.0, tx); // slope is trustworthy only on fine levels
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
    // each bed its own tone (horizontal breakup of the walls), slightly darker near the cracks
    var lime = M1v.rgb * (0.9 + 0.25 * flute + 0.15 * nS) * sd.x * (0.84 + 0.3 * hf(i32(bk), 5, 287u) * bl(3.0, fp));
    lime = mix(lime, lime * vec3f(1.15, 0.95, 0.7), sstep(0.0, 0.6, vn(vec2f(u * 0.04, h * 0.01), 284u)) * 0.6); // ochre stain
    let streak = vn(vec2f(u * 0.3, h * 0.015), 280u) * 0.5 + vn(vec2f(u * 1.1, h * 0.05), 281u) * 0.3;
    lime = mix(lime, lime * vec3f(0.45, 0.48, 0.42), sstep(0.05, 0.45, -streak) * 0.8); // water stains
    lime *= 1.0 - 0.6 * min(crack, 1.0);
    // ledges with clinging green: any less-steep spot on a wall, and the lips of bedding cracks
    let ledgeV = sstep(0.5, 0.3, slope) * onPillar * fineGeo;
    let cling = sstep(0.45, 0.7, ledgeV + 0.5 * min(crack, 1.0) * sstep(0.1, 0.5, vn(vec2f(u * 0.12, h * 0.25), 289u)) + 0.25 * nS);
    lime = mix(lime, M0v.rgb * (0.7 + 0.4 * nS), cling * 0.85);
    // ferns in the cracks: tufts along the bedding cracks, hanging a little below them
    let wfe = bl(0.8, fp) * wall;
    if (wfe > 0.0) {
      let fern = (1.0 - sstep(0.2, 0.9, abs(bedS - bedPos + 0.25))) * sstep(0.15, 0.55, vn(vec2f(u * (1.0 / 0.9), bk * 3.1), 291u));
      lime = mix(lime, M0v.rgb * vec3f(0.8, 0.95, 0.6) * (0.7 + 0.5 * nS), fern * wfe * 0.9);
    }
    // canopy: rounded crowns (geometry) shaded from their own normals; green spills down the rim in strands
    // canopy: far, patches of olive, green and yellow-green; near, every crown (the 5.5 m domes of terrfn) has its
    // own green, a few are rust or in flower, with leaf clumps and dark gaps between the crowns
    var canopy = mix(vec3f(0.06, 0.1, 0.03), vec3f(0.1, 0.19, 0.055), sstep(-0.5, 0.3, nM));
    canopy = mix(canopy, vec3f(0.19, 0.24, 0.06), sstep(0.25, 0.75, nL + 0.35 * nM) * 0.7);
    let top = sstep(2.5, 0.5, below) * sstep(1.0, 3.0, topH);
    let sl = 3.0 + 17.0 * sstep(-0.3, 0.6, vn(vec2f(u * (1.0 / 4.3), 1.5), 288u) + 0.45 * vn(vec2f(u * (1.0 / 1.2), 3.1), 290u));
    let spill = sstep(sl, sl * 0.55, below) * sstep(1.0, 3.0, topH);
    let cfp = bl(5.5, fp);
    if (cfp > 0.0 && max(top, spill * wall) > 0.01) {
      let cg = floor(p.xz * (1.0 / 5.5));
      var bdd = 9.0; var bid = vec2i(0);
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(cg.x) + i; let cj = i32(cg.y) + j;
          let pt = (vec2f(f32(ci), f32(cj)) + 0.2 + 0.6 * vec2f(hf(ci, cj, 160u), hf(ci, cj, 161u))) * 5.5;
          let d = length(p.xz - pt) / (5.5 * (0.62 + 0.35 * hf(ci, cj, 162u)));
          if (d < bdd) { bdd = d; bid = vec2i(ci, cj); }
        }
      }
      let k = hf(bid.x, bid.y, 170u);
      var cc = mix(vec3f(0.055, 0.095, 0.03), vec3f(0.1, 0.2, 0.055), hf(bid.x, bid.y, 171u));
      cc = mix(cc, vec3f(0.13, 0.2, 0.06), sstep(0.7, 0.95, hf(bid.x, bid.y, 172u)) * 0.7); // fresh leaves, not lime
      if (k < 0.02) { cc = mix(cc, vec3f(0.2, 0.11, 0.05), 0.6); }       // rare rust crown
      else if (k < 0.032) { cc = mix(cc, vec3f(0.36, 0.3, 0.32), 0.45); } // rare pale flowering crown, half blended
      else if (k < 0.045) { cc = mix(cc, vec3f(0.3, 0.28, 0.1), 0.45); }
      let lc = 1.0 + 0.35 * vn(p.xz * (1.0 / 0.9), 173u) * bl(0.9, fp) + 0.15 * gd.x;
      let gap = sstep(0.7, 1.05, bdd);
      canopy = mix(canopy, cc * lc * (1.0 - 0.8 * gap), cfp);
    }
    // jungle floor: dark, damp, mossy; darker still at the pillar feet
    var floorC = M3v.rgb * (0.7 + 0.4 * gd.x + 0.2 * nM);
    floorC = mix(floorC, M0v.rgb * 0.55, sstep(-0.2, 0.4, nM + 0.3 * gd.x) * 0.7);
    var sf = mix(floorC, lime, wall);
    sf = mix(sf, canopy * mix(1.0, 0.75, sstep(0.0, 6.0, below)), max(top, spill * wall)); // vines darker below the rim
    sf = mix(sf, canopy * 0.8, sstep(0.55, 0.3, slope) * sstep(30.0, 8.0, below) * onPillar * fineGeo);
    alb = mix(alb, sf, wStone);
    dg += sd.yzw * wall * wStone;
    rough = mix(rough, 0.95, wStone);
    let low = sstep(70.0, 30.0, h) * (1.0 - wall);
    wet = max(wet, low * 0.6 * wStone);
  }

  // ---- Aurora Ice: a broad glacier tongue between dark nunataks, snowfields (the brightest ground), bare cyan ice
  //      with medial moraines, crevasse and serac fields, a blue calving cliff, black-sand outwash, bergs ----
  if (wIce > 0.01) {
    let gl = mB.w;
    // flow: the broad downhill direction (64 m level), moraines run along it, ogives across it
    let cl = clipS(lb, p.xz);
    let fl2 = length(cl.yz);
    let bd = select(vec2f(1.0, 0.0), -cl.yz / max(fl2, 1e-4), fl2 > 1e-4);
    let acr = dot(p.xz, vec2f(-bd.y, bd.x)) + 40.0 * nL + 9.0 * nM;
    let along = dot(p.xz, bd) + 18.0 * nM;
    // snow: wind-packed on the gentle upper ice and in hollows on the nunataks; scoured off the lower tongue
    let snowN = nM * 0.6 + 0.4 * nS + 0.5 * nL;
    let upper = sstep(110.0, 240.0, h + 60.0 * nL);
    let snowIce = sstep(-0.2, 0.25, snowN + 1.1 * upper - 0.75) * sstep(0.3, 0.12, slope);
    let snowRock = sstep(0.0, 0.3, snowN + 0.6 * max(conc, 0.0) * 4.0 + 0.4 * upper - 0.2) * sstep(0.45, 0.2, slope) * sstep(6.0, 30.0, h);
    // bare glacier ice: deep cyan, paler where weathered, darker blue on the steep faces (cliff, serac walls)
    var ice = mix(vec3f(0.3, 0.56, 0.68), vec3f(0.55, 0.74, 0.82), sstep(-0.4, 0.6, nM + 0.5 * nS));
    let og = sstep(0.6, 0.95, 0.5 + 0.5 * sin(along * (6.2832 / 90.0))) * bl(30.0, fp) * (1.0 - upper);
    ice = mix(ice, ice * vec3f(0.7, 0.74, 0.8), og * 0.5);
    // foliation: blue and white streaks drawn out along the flow
    let wfo = bl(6.0, fp);
    if (wfo > 0.0) {
      let fo = vn(vec2f(acr * (1.0 / 6.0), along * (1.0 / 140.0)), 319u);
      ice = mix(ice, mix(ice * vec3f(0.75, 0.88, 1.0), ice * vec3f(1.2, 1.12, 1.05), sstep(-0.4, 0.4, fo)), 0.6 * wfo);
    }
    // medial moraines: dark rock-debris stripes along the flow, broken and of varied width
    let mw = 0.025 + 0.03 * (0.5 + 0.5 * nL);
    let mr = (1.0 - sstep(mw * 0.5, mw, abs(fract(acr * (1.0 / 260.0)) - 0.5))) * sstep(-0.3, 0.2, nM + 0.5);
    let mor = mr * (1.0 - upper * 0.8) * sstep(0.35, 0.15, slope);
    ice = mix(ice, vec3f(0.055, 0.05, 0.048) * (0.8 + 0.5 * gd.x + 0.3 * nS), mor * 0.85);
    let steepI = sstep(0.35, 0.75, slope);
    ice = mix(ice, vec3f(0.1, 0.36, 0.55) * (0.85 + 0.3 * nS), steepI * (1.0 - mor));
    // seracs: blue-white blocks with fresh snow caps; crevasses: rim cyan -> deep blue
    let ser = mB.y;
    ice = mix(ice, vec3f(0.62, 0.8, 0.9), ser * (1.0 - steepI) * 0.6);
    let crev = mB.x;
    ice = mix(ice, vec3f(0.08, 0.4, 0.62), sstep(0.08, 0.45, crev));
    ice = mix(ice, vec3f(0.01, 0.05, 0.18), sstep(0.45, 0.95, crev));
    let snowC = vec3f(0.8, 0.84, 0.88) * (0.96 + 0.06 * nS); // snow albedo 0.8-0.9
    let snowOnIce = snowIce * (1.0 - crev) * (1.0 - mor);
    ice = mix(ice, snowC, snowOnIce);
    // sastrugi on the snow: fine elongated wind ridges
    let ws = bl(0.9, fp) * snowOnIce;
    if (ws > 0.0) {
      let sq = vec2f(p.x * 0.8 + p.z * 0.6, -p.x * 0.6 + p.z * 0.8) * vec2f(1.0 / 0.9, 1.0 / 5.0);
      let sn = vnoised(sq, 292u);
      dg += vec3f(sn.y * (0.8 / 0.9) - sn.z * (0.6 / 5.0), 0.0, sn.y * (0.6 / 0.9) + sn.z * (0.8 / 5.0)) * 0.12 * ws * gl;
      ice *= 1.0 + 0.04 * sn.x * ws;
    }
    // nunataks: near-black basalt, frost-shattered, snow in their hollows and ledges
    var nun = M1v.rgb * (0.7 + 0.4 * nM) * rd.x;
    nun = mix(nun, snowC * 0.97, snowRock);
    // black-sand outwash: braided wet channels, stranded ice chunks near the water
    var sand = M3v.rgb * (0.8 + 0.4 * gd.x + 0.3 * nM);
    let braid = 1.0 - sstep(0.04, 0.12, abs(vn(vec2f(acr * (1.0 / 35.0), along * (1.0 / 220.0)), 295u)));
    let plain = sstep(4.0, 1.5, h) * sstep(-0.2, 0.3, h) * (1.0 - gl);
    let wetS = max(sstep(1.2, 0.2, h + 0.3 * nS), braid * plain * 0.8);
    var chunk = 0.0;
    if (fp < 0.2 && h > 0.05 && h < 3.0) {
      let pb = pebbles(p.xz + vec2f(13.0, 7.0), 1.2);
      let has = select(0.0, 1.0, pb.w < 0.1) * sstep(0.05, 0.2, pb.x) * bl(1.2, fp);
      chunk = has;
      dg += vec3f(pb.y, 0.0, pb.z) * 1.4 * has;
    }
    sand = mix(sand, vec3f(0.62, 0.8, 0.88), chunk);
    var land = mix(sand, nun, max(rockW, sstep(8.0, 18.0, h)));
    var ia = mix(land, ice, gl);
    // bergs: blue-white with cyan translucent rims and faces, a pale turquoise shelf under the water
    let bergM = mB.z;
    let berg = sstep(0.5, 0.6, bergM);
    let shelf = sstep(0.0, 0.08, bergM) * (1.0 - berg);
    let thin = (1.0 - sstep(0.5, 0.8, bergM)) * berg; // thin rim of the berg
    var bc = mix(vec3f(0.6, 0.8, 0.9), vec3f(0.88, 0.94, 0.98), sstep(-0.2, 0.4, vn(vec2f(h * (1.0 / 0.7), u * 0.05), 293u)));
    bc = mix(bc, vec3f(0.18, 0.6, 0.76), max(thin, sstep(0.5, 0.85, slope)) * 0.7);
    ia = mix(ia, bc, berg);
    ia = mix(ia, vec3f(0.3, 0.75, 0.82), shelf);
    alb = mix(alb, ia, wIce);
    iceSnow = (snowOnIce * gl + snowRock * (1.0 - gl) * (1.0 - plain) + berg * (1.0 - thin) * 0.6) * wIce;
    iceThin = (thin + steepI * gl * 0.7 + crev * 0.5 + ser * 0.3 + shelf * 0.5) * wIce;
    let glow = crev * crev * 0.55 + berg * (thin * 0.35 + sstep(0.5, 0.9, slope) * 0.12) + shelf * 0.5 + gl * steepI * 0.08;
    let gcol = mix(M6v.rgb, vec3f(0.05, 0.3, 0.9), crev * 0.6);
    emis += gcol * M6v.w * glow * wIce * 0.6;
    let iceR = mix(0.3, 0.16, steepI);
    rough = mix(rough, mix(mix(mix(0.85, 0.3, chunk), iceR, gl), 0.7, max(iceSnow, 0.0)), wIce);
    rough = mix(rough, 0.14, wetS * (1.0 - gl) * wIce);
    f0 = mix(f0, mix(0.03, 0.05, max(chunk, gl * (1.0 - snowOnIce))), wIce);
    wet = max(wet, (1.0 - gl) * wetS * 0.7 * wIce);
    dg *= 1.0 - shelf;
  }

  // ---- Lumen Deep: near-black velvet ground, delta veins pulsing out of glowing sinkholes, amber lichen,
  //      pale teal faceted crystals with inner glow ----
  if (wLum > 0.01) {
    // near-black indigo velvet
    var lg = mix(M1v.rgb, vec3f(0.012, 0.01, 0.032), 0.7) * (0.75 + 0.35 * gd.x + 0.25 * nM);
    // amber-gold lichen: large soft patches (tens of metres) with a speckled edge: the complementary accent
    let lichN = 0.7 * nM + 0.55 * nL + 0.25 * nS;
    let lich = sstep(0.25, 0.7, lichN) * (1.0 - sstep(0.3, 0.5, slope)) * (0.75 + 0.25 * sstep(-0.3, 0.4, gd.x + nS));
    lg = mix(lg, vec3f(0.26, 0.13, 0.02) * (0.75 + 0.5 * gd.x), lich * 0.9);
    emis += vec3f(0.45, 0.22, 0.03) * lich * 0.035 * wLum;
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
    // the pools at the delta sources: bright cyan water and a glowing rim
    let underL = sstep(0.0, -4.0, h);
    emis += mix(M6v.rgb, vec3f(0.4, 1.0, 0.95), 0.4) * underL * 1.2 * M6v.w * wLum;
    let rim = sstep(0.9, 0.98, rho) * sstep(1.08, 1.0, rho) * sstep(-0.5, 0.6, h);
    emis += M6v.rgb * rim * 0.35 * M6v.w * wLum;
    lg = mix(lg, vec3f(0.05, 0.25, 0.24), rim * 0.5);
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

  // ---- coast and weather (DESIGN 12) ----
  // surf on the beach (clip.wgsl): the swash sheet runs up and drains back with a foam lace at its edge, leaving wet
  // sand up to the run-up; tide pools sit in rock shelves just above the water. 3 clip fetches, near the shore only.
  var foamS = 0.0;
  let surfAmt = min(bfx(rw, G3).w * 1.6, 1.0);
  if (h < 3.0 && h > -0.6 && surfAmt > 0.01 && dist < 1500.0) {
    let sw = surfSwash(p.xz, h, shoreFrame(p.xz), surfAmt, tm);
    wet = max(wet, max(sw.z * 0.75, sw.x));
    rough = mix(rough, 0.06, sw.x);
    flatN = max(flatN, sw.x * 0.6);
    foamS = sw.y;
    let pool = rockW * sstep(0.3, 0.12, slope) * sstep(-0.2, 0.3, h) * sstep(1.8, 1.2, h)
             * sstep(0.2, 0.45, vn(p.xz * (1.0 / 3.5), 569u) + 0.35 * nS);
    alb = mix(alb, vec3f(0.015, 0.035, 0.04) + alb * 0.35, pool);
    wet = max(wet, pool); rough = mix(rough, 0.04, pool); flatN = max(flatN, pool);
  }
  // rain (weather stub, fx/terrain.js): ground darkens with the wetness, puddles gather on flat hollows and dry out
  // as the wetness falls; rain roughens their surface. Snow, ice and salt crust are left alone.
  let gw = groundWet() * (1.0 - wIce) * (1.0 - wSalt);
  if (gw > 0.01) {
    wet = max(wet, gw * (0.6 + 0.4 * sstep(0.0, 0.3, conc)));
    let pud = sstep(0.08, 0.025, slope) * sstep(0.55, 0.8, gw + 0.5 * conc + 0.25 * vn(p.xz * (1.0 / 4.0), 570u) + 0.1 * nS);
    alb = mix(alb, alb * 0.5, pud);
    wet = max(wet, pud); flatN = max(flatN, pud);
    rough = mix(rough, mix(0.03, 0.2, rainNow()), pud);
  }

  // underwater: darker, wet
  let under = sstep(0.3, -0.5, h);
  wet = max(wet, under);
  alb *= 1.0 - 0.45 * clamp(wet, 0.0, 1.0);
  rough = mix(rough, 0.25, clamp(wet, 0.0, 1.0) * 0.7);
  alb = mix(alb, vec3f(0.8, 0.82, 0.82), foamS); // swash foam sits on top of the wet sand
  } // material section (off=tmat)

  // detail normal: remove the part of the detail gradient along the normal, tilt against it
  var n = normalize(gn - (dg - gn * dot(dg, gn)));
  n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), flatN));
  if (dot(n, V) < 0.02) { n = normalize(n + V * (0.02 - dot(n, V))); }

  // ---- light ----
  let L = sunDirFrom(S0v, FR.sun.w);
  let horizon = sstep(-0.035, 0.06, L.y);
  let sunC = S1v.rgb * S0v.z * horizon;
  let jit = ign(fragXY);
  var sh = 0.0;
  let ndl = dot(n, L);
  // baked shadow: each level marched its own heights toward the sun at bake time; near casters come from the fine
  // level, ridges and mountains from the coarser two (2 extra fetches, no per-pixel march)
  // the coarse levels are looked up one of their texels towards the sun: a coarse texel straddling a ridge would
  // otherwise print the shadowed side's value onto the lit face as a saw-tooth edge along the crest
  let Lh = L.xz / max(length(L.xz), 1e-3);
  let nL1 = min(l0 + 2u, nLevels() - 1u); let nL2 = min(l0 + 4u, nLevels() - 1u);
  let sd1 = shadeL(2u, l0, e, p.xz + Lh * FR.lv[nL1].z);
  let sd2 = shadeL(4u, l0, e, p.xz + Lh * FR.lv[nL2].z);
  var vis = sd0.y * mix(1.0, sd1.y, 0.7);
  if (isOff(OFF_TAO)) { vis = 1.0; }
  if (horizon > 0.0 && dot(gn, L) > -0.1) {
    sh = min(sd0.x, min(sd1.x, sd2.x));
    if (isOff(OFF_TSHADOW)) { sh = 1.0; }
    sh *= cloudShadow(p, L, rw); // cloud shadows (common.wgsl, same coverage field as the cloud pass)
  }
  // occlusion from the baked ring concavity at three scales and the baked sky visibility
  let occ = max(ca, 0.0) * 0.9 + max(cb, 0.0) * 1.6 + max(cc, 0.0) * 2.2;
  let ao = select(clamp(1.0 - occ, 0.3, 1.0) * clamp(1.0 - max(conc, 0.0) * 0.5, 0.55, 1.0) * mix(0.5, 1.0, vis), 1.0, isOff(OFF_TAO));

  let zen = S2v.rgb * S3v.w;
  let hor = S3v.rgb * S3v.w;
  let skyUp = mix(hor, zen, 0.55) * S6v.x + S7v.rgb * S7v.w;
  let ground = (hor * 0.25 + alb * sunC * max(L.y, 0.0) * 0.6) * S6v.w;
  let amb = mix(ground, skyUp, 0.5 + 0.5 * n.y) * ao;
  // energy conserving: what the surface reflects specularly (Schlick at the view angle) does not also diffuse
  let fr = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  let kd = 1.0 - fr * (1.0 - 0.6 * rough);
  var col = alb * kd * (sunC * max(ndl, 0.0) * sh + amb);
  // Lumen: the ringed giant and the moons light the dunes from the sky; velvet sheen at grazing angles
  if (sheen > 0.0) {
    let Gd = vec3f(0.553, 0.438, -0.708);
    let gcol = vec3f(0.5, 0.36, 0.42) * S5v.z;
    let wrapG = clamp((dot(n, Gd) + 0.3) / 1.3, 0.0, 1.0);
    col += alb * kd * gcol * wrapG * 1.2 * ao; // (no painted rim light: photoreal pass)
  }
  // Aurora Ice under the low moon and the aurora: snow glitters (per-crystal glints that twinkle as the view moves,
  // lit by the key light and by the sky), thin ice glows cyan from light scattered through it, and snow and ice
  // brighten looking towards the light (forward scattering)
  if (iceSnow + iceThin > 0.01) {
    let fwd = pow(max(dot(-V, L), 0.0), 6.0) * horizon;
    col += alb * sunC * fwd * (0.15 * iceSnow + 0.4 * iceThin) * mix(0.5, 1.0, sh);
    let wrap = clamp((dot(n, L) + 0.6) / 1.6, 0.0, 1.0);
    col += vec3f(0.1, 0.55, 0.7) * iceThin * (sunC * wrap * 0.25 + skyUp * 0.3) * ao; // light through thin ice
    if (iceSnow > 0.01 && fp < 0.25) {
      let gc = floor(p.xz * 6.0);
      let gh = hf(i32(gc.x), i32(gc.y), 296u);
      let gpos = length(p.xz * 6.0 - gc - 0.5);
      let vb = floor(dot(V, vec3f(37.0, 23.0, 29.0)) * 2.0); // view bucket: glints switch as the camera moves
      let tw = hf(i32(gc.x) + i32(vb), i32(gc.y), 297u);
      let gl1 = select(0.0, 1.0, gh < 0.06) * sstep(0.22, 0.05, gpos) * bl(0.17, fp) * step(0.82, tw);
      let gn2 = normalize(n + 0.5 * vec3f(hf(i32(gc.x), i32(gc.y), 298u) - 0.5, 0.0, hf(i32(gc.x), i32(gc.y), 299u) - 0.5));
      let spk = pow(max(dot(reflect(-V, gn2), L), 0.0), 24.0) * sh * horizon;
      col += (sunC * spk * 6.0 + skyUp * 0.3) * gl1 * iceSnow; // crystal facets mirroring the key light
    }
  }
  // specular: sun + sky reflection for smooth surfaces
  let sp = ggx(n, V, L, rough, f0) * max(ndl, 0.0) * sh;
  col += sunC * sp;
  let R = reflect(-V, n);
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
