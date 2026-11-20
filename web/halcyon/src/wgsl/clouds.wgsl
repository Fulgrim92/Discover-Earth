// clouds.wgsl: half-resolution ray-marched volumetric clouds (main layer + the Stone Forest cloud sea), one
// fullscreen pass with three targets: front clouds (rgb in-scatter incl. aerial perspective, a = opacity), clouds
// seen in the water mirror (same encoding, water pixels only), and the scene distance the pixel was marched to
// (for the depth-aware upsample in composite.wgsl). Needs clip.wgsl (terrain occlusion of sun light) and sky.wgsl.

@group(2) @binding(0) var<uniform> CU: CloudU;
@group(2) @binding(1) var baseT: texture_3d<f32>;
@group(2) @binding(2) var detT: texture_3d<f32>;
@group(2) @binding(3) var wxT: texture_2d<f32>;
@group(2) @binding(4) var wyT: texture_2d<f32>;
@group(2) @binding(5) var cDistT: texture_2d<f32>;
@group(2) @binding(6) var repS: sampler;
@group(2) @binding(7) var clS: sampler;

const BASE_TILE: f32 = 3600.0;  // m per base-noise tile (128 texels, 4 mips)
const DET_TILE: f32 = 640.0;    // m per detail tile (64 texels)
const SEA_TILE: f32 = 640.0;
const SEA_DET: f32 = 130.0;
const EXT: f32 = 0.04;         // extinction per metre at density 1 (main layer)
const SEA_EXT: f32 = 0.05;      // cloud sea: ~80 m visibility inside at density 0.8

fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn remap(x: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return c + (x - a) / (b - a) * (d - c); }

// weather: wx = (coverage, base, top, density), wy = (type, erosion, sea amount, sea top)
fn wuv(xz: vec2f) -> vec2f { return (xz - CU.win.xy) / (CU.win.z * CU.win.w); }
fn wxAt(xz: vec2f) -> vec4f {
  let uv = wuv(xz);
  var w = textureSampleLevel(wxT, clS, uv, 0.0);
  let e = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
  w.x *= sstep(0.5, 0.44, e);
  return w;
}
fn wyAt(xz: vec2f) -> vec4f { return textureSampleLevel(wyT, clS, wuv(xz), 0.0); }

fn windOfs() -> vec2f { return CLOUD_WIND * FR.time.x; }

// ---- main layer density ----
fn densMain(p: vec3f, w: vec4f, y: vec4f, lod: f32, det: f32) -> f32 {
  let cov = w.x;
  if (cov < 0.004 || p.y <= w.y || p.y >= w.z) { return 0.0; }
  let hf = (p.y - w.y) / (w.z - w.y);
  let ty = y.x;
  // height profile. Cumulus (ty 1): crisp flat base, tops rise with coverage so each cloud is a dome or a tower.
  // Veil / stratus (ty 0): a thin lens in the middle of the layer.
  let topF = mix(0.75, mix(0.5, 1.0, cov), ty);
  let pc = sstep(0.0, 0.045, hf) * sstep(topF, topF * 0.55, hf);
  let vh = 0.5 * sqrt(cov);
  let pv = sstep(0.5 - vh, 0.5, hf) * sstep(0.5 + vh, 0.5, hf);
  let prof = mix(pv, pc, sstep(0.2, 0.6, ty));
  if (prof <= 0.001) { return 0.0; }
  let wo = windOfs();
  // veils are sheared flat along the wind; cumulus slightly tall
  let q = vec3f(p.x - wo.x, p.y * mix(2.6, 0.85, ty), (p.z - wo.y) * mix(0.55, 1.0, ty));
  let n = textureSampleLevel(baseT, repS, q * (1.0 / BASE_TILE), lod);
  let low = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  // cumulus take the height profile before the coverage threshold (domes), veils after it (thin lenses)
  let pk = sstep(0.1, 0.5, ty);
  var base = sat(remap(n.r, low - 1.0, 1.0, 0.0, 1.0)) * mix(1.0, prof, pk);
  // cumulus narrow with height (domes and towers, not prisms): coverage shrinks toward the local top
  let ce = min(cov, 0.78) * (1.0 - 0.8 * ty * pow(hf, 1.5));
  var c = sat(remap(base, 1.0 - ce, 1.0, 0.0, 1.0)) * ce * mix(prof, 1.0, pk);
  // luminous veils (emission > 0) are ribbed like noctilucent cloud: long parallel billows, slowly drifting
  let em = rowv(C4).w;
  if (em > 0.0 && c > 0.0) {
    let rb = sin(dot(q.xz, vec2f(0.017, 0.011)) + n.g * 6.0 + FR.time.x * 0.05);
    c *= mix(1.0, 0.45 + 0.55 * sstep(-0.7, 0.9, rb), sat(em * 4.0));
  }
  if (c > 0.0 && det > 0.0) {
    let tm = FR.time.x;
    let dq = (q + vec3f(tm * 1.5, -tm * 0.9, tm * 0.6)) * (1.0 / DET_TILE);
    let dn = textureSampleLevel(detT, repS, dq, 0.0).rgb;
    var hfb = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    if (det > 1.5) { // close up: a finer octave so near cloud edges keep their curls
      let d2 = textureSampleLevel(detT, repS, dq * 4.1 + 0.37, 0.0).rgb;
      hfb = mix(hfb, d2.r * 0.6 + d2.g * 0.4, 0.35 * sat(det - 1.5));
    }
    let md = mix(hfb, 1.0 - hfb, sat(hf * 4.0));
    // (veils erode relative to their own thin density, cumulus absolutely)
    let cm = mix(ce * mix(prof, 1.0, pk), 1.0, pk);
    c = sat(remap(c, md * y.y * 0.95 * min(det, 1.0) * cm, cm, 0.0, cm));
  }
  // cumulus are crisp (dense right behind the edge), veils stay soft
  c = sat(c * mix(1.3, 5.0, ty * ty));
  return c * w.w;
}

// ---- cloud sea (low flat layer) density ----
fn pillarNear(xz: vec2f, top: f32) -> f32 {
  // the coarse clip level, bilinearly filtered, gives a soft halo around the pillars
  let l = clipLevel(xz, 4u, 8.0);
  return sstep(top - 10.0, top + 120.0, clipH(l, xz));
}
fn densSea(p: vec3f, y: vec4f, lod: f32, det: f32) -> f32 {
  let amt = y.z;
  if (amt < 0.003) { return 0.0; }
  let base = CU.slab.z; let top = y.w;
  if (p.y < base || p.y > top + 40.0) { return 0.0; }
  let tm = FR.time.x;
  let wo = windOfs() * 0.6;
  let q = vec3f(p.x - wo.x, p.y * 2.0 - tm * 0.5, p.z - wo.y);
  let n = textureSampleLevel(baseT, repS, q * (1.0 / SEA_TILE), lod);
  let prox = pillarNear(p.xz, top);
  let th = top - base;
  // the upper surface heaves and climbs the pillar walls
  let surf = top + (n.r - 0.55) * 22.0 + (n.g - 0.5) * 14.0 + prox * 30.0;
  let hb = (p.y - base) / th;
  var c = sstep(0.0, 0.55, hb) * sstep(surf, surf - th * 0.55, p.y);
  c *= 0.65 + 0.35 * n.b;
  if (c > 0.0 && det > 0.0) {
    let dq = (vec3f(p.x - wo.x * 1.4, p.y - tm * 0.8, p.z - wo.y * 1.4)) * (1.0 / SEA_DET);
    let dn = textureSampleLevel(detT, repS, dq, 0.0).rgb;
    let hfb = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    let er = sstep(surf - th * 0.7, surf, p.y);
    c = sat(remap(c, hfb * (0.25 + 0.6 * er) * det, 1.0, 0.0, 1.0));
  }
  return c * amt;
}

fn terrOcc(q: vec3f) -> f32 {
  if (q.y > 1800.0) { return 0.0; }
  let l = clipLevel(q.xz, 2u, 8.0);
  return select(0.0, 1.0, clipH(l, q.xz) > q.y);
}

// optical depth toward the sun (density only, coarse), plus hard terrain occlusion
fn lightOD(p: vec3f, L: vec3f, sea: bool, n: i32, jit: f32) -> f32 {
  var od = 0.0;
  var t = 0.0;
  var stp = select(32.0, 3.5, sea);
  for (var i = 0; i < n; i++) {
    let s = stp * (0.92 + 0.16 * jit);
    t += s;
    let q = p + L * (t - s * 0.5);
    var d = 0.0;
    if (sea) { d = densSea(q, wyAt(q.xz), 1.0, select(0.0, 1.0, i < 2)) * SEA_EXT; }
    else { d = densMain(q, wxAt(q.xz), wyAt(q.xz), f32(i) * 0.5 + 0.5, select(0.0, 0.6, i < 1)) * EXT; }
    od += d * s;
    od += terrOcc(q) * 40.0;
    stp *= 2.0;
  }
  if (sea) {
    // long reach for pillar shadows across the sea
    for (var k = 0; k < 3; k++) {
      t += 140.0 + f32(k) * 260.0;
      od += terrOcc(p + L * t) * 40.0;
    }
  }
  return od;
}

// march state; the sample budget (dense samples nd, iterations it) is shared by the sea and the main layer, so a ray
// through both costs no more than one through either (the worst case was 2x before: the p99 spikes)
struct MS { scat: vec3f, T: f32, tw: f32, ww: f32, nd: i32, it: i32, cap: i32 }
// cost ablation: flip to false to drop a part of the cloud cost (the front march, the mirror march)
const CLOUD_MARCH_ON: bool = true;
const CLOUD_REFL_ON: bool = true;
// stop once the clouds in front are this opaque (what is left behind would add < 3%)
const T_MIN: f32 = 0.03;

fn phaseC(mu: f32, c: f32) -> f32 {
  return hg(mu, 0.62 * c) * 0.62 + hg(mu, 0.9 * c) * 0.06 + hg(mu, -0.25 * c) * 0.32;
}

// Light for the clouds of one pixel: the realm blended where the ray first meets cloud, so a neighbouring realm's
// clouds are lit by its own sun and sky (the next realm on the horizon shows its own light).
struct CL { L: vec3f, sc: vec3f, zen: vec3f, hor: vec3f, sw: vec3f, night: vec3f, tint: vec3f, emis: vec3f, amb: f32, aur: f32 }
var<private> gCL: CL;
var<private> gCLok: bool;
fn cloudLight(xz: vec2f) -> CL {
  let rw = realmWeights(xz);
  let s0 = bf(rw, S0); let s1 = bf(rw, S1); let s3 = bf(rw, S3);
  var o: CL;
  o.L = sunDirFrom(s0, FR.sun.w);
  o.sc = s1.rgb * s0.z * sstep(-0.035, 0.06, o.L.y);
  let I = s3.w;
  o.zen = bf(rw, S2).rgb * I; o.hor = s3.rgb * I; o.sw = bf(rw, S4).rgb * I;
  let s7 = bf(rw, S7); o.night = s7.rgb * s7.w;
  o.tint = bf(rw, C1).rgb;
  // luminous clouds glow only in their own sky (no cyan blobs in a neighbour's night)
  o.emis = rowv(C4).rgb * min(rowv(C4).w, bf(rw, C4).w); // and only the luminous realm's own clouds
  o.amb = bf(rw, S6).x;
  o.aur = bf(rw, S5).y;
  // halfway to the camera realm's light: a neighbour's clouds keep their own sun but sit in this sky
  // (at night the neighbours' sun is mostly withheld: they stay dark shapes against this sky)
  // a moonlit realm (S5.w without a giant) counts as night here
  let moonR = sstep(0.5, 0.9, rowv(S5).w) * (1.0 - sstep(0.01, 0.2, rowv(S5).z));
  let k = 0.3 * sstep(-0.12, 0.08, FR.sun.y) * (1.0 - moonR);
  let I0 = rowv(S3).w;
  o.L = normalize(mix(FR.sun.xyz, o.L, k));
  o.sc = mix(sunCol(), o.sc, k);
  o.zen = mix(rowv(S2).rgb * I0, o.zen, k); o.hor = mix(rowv(S3).rgb * I0, o.hor, k); o.sw = mix(rowv(S4).rgb * I0, o.sw, k);
  o.night = mix(rowv(S7).rgb * rowv(S7).w, o.night, k);
  o.amb = mix(rowv(S6).x, o.amb, k);
  o.tint = mix(rowv(C1).rgb, o.tint, k);
  return o;
}

fn shade(p: vec3f, d: vec3f, hf: f32, od: f32, dens: f32, sea: bool) -> vec3f {
  let L = gCL.L;
  let mu = dot(d, L);
  // multiple scattering octaves (Wrenninge): extinction, energy and phase eccentricity fall off together
  var s = 0.0; var a = 1.0; var b = 1.0; var c = 1.0;
  for (var k = 0; k < 3; k++) { s += b * exp(-od * a) * phaseC(mu, c); a *= 0.42; b *= 0.6; c *= 0.55; }
  // powder: dark edges when facing away from the sun, none when looking into it
  let powder = mix(1.0, 1.0 - exp(-od * 2.2 - dens * 0.4), 0.55 * sat(0.6 - mu * 0.6));
  // sun on cloud: a touch less saturated than the sun itself (cream-gold lit sides, not orange)
  let sc = mix(vec3f(luma(gCL.sc)), gCL.sc, 0.72);
  // sky ambient: cool zenith light from above (lavender-blue shadowed cores, never brown), the warm horizon and a
  // peach-pink bounce of the low sun on the undersides
  let top = mix(gCL.hor, gCL.zen, 0.78) * vec3f(0.96, 0.94, 1.08) * 1.3;
  let bot = mix(gCL.hor, gCL.sw, 0.4) * 0.6 + gCL.sc * vec3f(1.0, 0.72, 0.74) * (0.04 + 0.1 * sat(1.0 - L.y * 3.0));
  var amb = mix(bot, top, sat(hf)) * mix(0.6, 1.0, sat(hf)) + gCL.night * 0.5;
  var sunK = 8.0;
  if (sea) {
    // inside the cloud sea: light from above dies off quickly, the forest below tints it green
    let h2 = sat(hf) * sat(hf);
    amb *= mix(0.07, 1.0, h2);
    amb = mix(amb * vec3f(0.62, 0.9, 0.7), amb, sat(hf));
    sunK = mix(0.25, 5.0, h2);
  }
  // aurora light on night clouds
  amb += vec3f(0.05, 0.4, 0.2) * gCL.aur * 0.08;
  return gCL.tint * (sc * s * powder * sunK + amb * gCL.amb * 0.95) + gCL.emis;
}

// Adaptive march: coarse steps through empty air (cheap coverage test), fine steps once inside cloud, back to
// coarse after a few empty samples. Step length grows with distance (far clouds are small on screen).
fn marchSeg(ro: vec3f, d: vec3f, t0: f32, t1: f32, n: i32, jit: f32, sea: bool, nl: i32, ms: ptr<function, MS>) {
  if (t1 <= t0) { return; }
  let kf = select(0.006, 0.004, sea);
  let fmin = select(10.0, 1.6, sea);
  let fmax = select(260.0, 30.0, sea);
  var t = t0 + clamp(t0 * kf, fmin, fmax) * jit * 2.0;
  var empty = 8;
  var lastDt = 0.0;
  loop {
    // a shared budget of dense (lit) samples, twice that in iterations; it shrinks when the ray starts inside cloud
    if (t >= t1 || (*ms).nd >= (*ms).cap || (*ms).it >= n * 2 || (*ms).T < T_MIN) { break; }
    (*ms).it++;
    let p = ro + d * t;
    let dtf = clamp(t * kf, fmin, fmax);
    let y = wyAt(p.xz);
    var dens = 0.0;
    var hf = 0.0;
    let det = sstep(select(16000.0, 3000.0, sea), select(4000.0, 700.0, sea), t) + select(sstep(700.0, 250.0, t), 0.0, sea) * 2.0;
    let lod = clamp(log2(dtf / select(28.0, 6.0, sea)), 0.0, 3.0);
    var possible = true;
    if (sea) {
      dens = densSea(p, y, lod, det) * SEA_EXT;
      hf = (p.y - CU.slab.z) / max(y.w - CU.slab.z, 1.0);
      possible = y.z > 0.003;
    } else {
      let w = wxAt(p.xz);
      possible = w.x > 0.004 && p.y > w.y - 30.0 && p.y < w.z + 30.0;
      if (possible) {
        dens = densMain(p, w, y, lod, det) * EXT;
        hf = (p.y - w.y) / max(w.z - w.y, 1.0);
      }
    }
    var dt = dtf;
    if (dens > 1e-5) {
      if (lastDt > dtf * 1.6) {
        // came in on a coarse step: back up and enter the cloud with fine steps
        t -= lastDt - dtf; lastDt = dtf; empty = 0;
        continue;
      }
      empty = 0; (*ms).nd++;
      if (!gCLok) {
        gCL = cloudLight(p.xz); gCLok = true;
        // starting inside cloud: visibility is short, so a smaller budget is enough (the inside-the-sea spikes)
        if (t < dtf * 3.0) { (*ms).cap = min((*ms).cap, n * 3 / 5); }
      }
      // deep samples matter little: fewer light steps once the pixel is half opaque
      let od = lightOD(p, gCL.L, sea, select(nl, max(nl / 2, 2), (*ms).T < 0.5), jit);
      let Ls = shade(p, d, hf, od, dens / select(EXT, SEA_EXT, sea), sea);
      let ddt = min(dt, t1 - t);
      let a = 1.0 - exp(-dens * ddt);
      (*ms).scat += (*ms).T * Ls * a;
      (*ms).tw += (*ms).T * a * t; (*ms).ww += (*ms).T * a;
      (*ms).T *= 1.0 - a;
    } else {
      empty++;
      if (!possible) { dt = max(dtf * 5.0, min(t * 0.035, select(1500.0, 120.0, sea))); }
      else if (empty > 3) { dt = dtf * 2.5; }
    }
    lastDt = dt;
    t += dt;
  }
}

// ray/slab interval [a, b] clipped to [0, tmax]
fn slab(ro: vec3f, d: vec3f, y0: f32, y1: f32, tmax: f32) -> vec2f {
  if (y1 <= y0) { return vec2f(1.0, 0.0); }
  if (abs(d.y) < 1e-5) {
    if (ro.y > y0 && ro.y < y1) { return vec2f(0.0, tmax); }
    return vec2f(1.0, 0.0);
  }
  let ta = (y0 - ro.y) / d.y; let tb = (y1 - ro.y) / d.y;
  return vec2f(max(min(ta, tb), 0.0), min(max(ta, tb), tmax));
}

fn marchAll(ro: vec3f, d: vec3f, tmax: f32, n: i32, nl: i32, jit: f32) -> vec4f {
  var ms: MS;
  gCLok = false;
  ms.scat = vec3f(0.0); ms.T = 1.0; ms.tw = 0.0; ms.ww = 0.0; ms.nd = 0; ms.it = 0; ms.cap = n;
  let maxD = min(tmax, CU.q.z);
  let sS = slab(ro, d, CU.slab.z, CU.slab.w, min(maxD, 9000.0));
  let sM = slab(ro, d, CU.slab.x, CU.slab.y, maxD);
  let hasS = sS.y > sS.x; let hasM = sM.y > sM.x;
  if (hasS && (!hasM || sS.x <= sM.x)) {
    marchSeg(ro, d, sS.x, sS.y, n, jit, true, nl, &ms);
    if (hasM) { marchSeg(ro, d, sM.x, sM.y, n, jit, false, nl, &ms); }
  } else {
    if (hasM) { marchSeg(ro, d, sM.x, sM.y, n, jit, false, nl, &ms); }
    if (hasS) { marchSeg(ro, d, sS.x, sS.y, n, jit, true, nl, &ms); }
  }
  // what the early exit left behind: count it as fully absorbed (no visible step at the stop)
  let op = select(1.0 - ms.T, 1.0, ms.T < T_MIN);
  if (op < 1e-4) { return vec4f(0.0); }
  // aerial perspective at the opacity-weighted depth of the clouds
  let tm = ms.tw / max(ms.ww, 1e-6);
  var c = applyFog(ms.scat / op, ro, d, tm);
  // far clouds (often a neighbour realm's weather) melt into the sky colour behind them: no hard cut-outs or
  // foreign colours on the horizon; they still hide the stars and aurora behind them
  c = mix(c, skyBase(d), 0.75 * sstep(6000.0, 28000.0, tm));
  return vec4f(c * op, op);
}

struct CVO { @builtin(position) pos: vec4f }
@vertex fn vsC(@builtin(vertex_index) i: u32) -> CVO {
  var o: CVO;
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
struct CF { @location(0) front: vec4f, @location(1) refl: vec4f, @location(2) dist: vec4f }

@fragment fn fsC(in: CVO) -> CF {
  let hp = vec2i(in.pos.xy);
  let full = vec2i(VW.size.xy);
  // cloud resolution: half (2) or quarter (4, quality=low) of the view
  let S = max(i32(round(VW.size.x * CU.misc.z)), 1);
  // nearest of the corners of the SxS full-res block: the march stops at the closest surface, the upsample sorts
  // out edges
  let b = hp * S; let e = S - 1;
  let d00 = textureLoad(cDistT, min(b, full - 1), 0).x;
  let d10 = textureLoad(cDistT, min(b + vec2i(e, 0), full - 1), 0).x;
  let d01 = textureLoad(cDistT, min(b + vec2i(0, e), full - 1), 0).x;
  let d11 = textureLoad(cDistT, min(b + vec2i(e, e), full - 1), 0).x;
  let dist = min(min(d00, d10), min(d01, d11));
  let pp = in.pos.xy * f32(S);
  let d = viewRay(pp);
  let ro = VW.cam.xyz;
  var jit = ign(in.pos.xy);
  if (VW.cam.w == 13.0) { jit = 0.5; }
  let n = i32(CU.q.x); let nl = i32(CU.q.y);
  var tmax = select(dist, 1e9, dist > 50000.0);
  var o: CF;
  o.refl = vec4f(0.0);
  o.dist = vec4f(dist, 0.0, 0.0, 1.0);
  // the water plane: march the mirrored ray for the reflection, the front only up to the water
  if (ro.y > 0.0 && d.y < 0.0) {
    let tw = ro.y / -d.y;
    if (tw < tmax + max(0.6, tmax * 0.0015)) {
      tmax = tw;
      let P = ro + d * tw;
      let R = vec3f(d.x, -d.y, d.z);
      // skip the mirror march where the water reflects little (Fresnel at this angle and the realm's mirror floor,
      // as composite.wgsl weighs it): most water seen from above in all realms but Mirror Salt and Aurora Ice
      let wr = max(0.02 + 0.98 * pow(1.0 - min(-d.y, 1.0), 5.0), rowv(W2).w);
      if (CLOUD_REFL_ON && wr > 0.12) { o.refl = marchAll(P, R, 1e9, i32(CU.q.w), max(nl - 2, 2), jit); }
    }
  }
  if (CLOUD_MARCH_ON) { o.front = marchAll(ro, d, tmax, n, nl, jit); } else { o.front = vec4f(0.0); }
  if (VW.cam.w == 16.0 && d.y > 0.01) { // dbg=16: layer probe at mid-height of the camera realm's main layer
    let ym = (rowv(C0).y + rowv(C0).z) * 0.5;
    let P = ro + d * ((ym - ro.y) / d.y);
    let w = wxAt(P.xz); let y = wyAt(P.xz);
    o.front = vec4f(w.x, densMain(P, w, y, 0.0, 1.0) * 4.0, (w.z - w.y) / 4000.0, 0.95);
  }
  if (VW.cam.w == 10.0) { // dbg=10: weather coverage (red) and orographic base (green) painted on the ground
    let P = ro + d * min(dist, 30000.0);
    o.front = vec4f(wxAt(P.xz).x, sstep(0.0, 1.0, wyAt(P.xz).z), 0.0, 0.85);
  }
  return o;
}
