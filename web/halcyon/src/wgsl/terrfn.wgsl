// terrfn.wgsl: the shared terrain function. world.js heightAt() mirrors the height path line by line.
// Masks (mA, mB) are GPU only.

// texel size of the clipmap level being baked (0 outside the bake): mask-only lines widen to stay band-limited
var<private> TEXEL: f32 = 0.0;

struct TP { t0: vec4f, t1: vec4f, t2: vec4f, t3: vec4f, t4: vec4f, t5: vec4f, t6: vec4f, t7: vec4f, t8: vec4f }
struct TerrOut { h: f32, mA: vec4f, mB: vec4f }
// mA: sinkhole distance (Lumen pulse phase), pillar top height / 600 m, hot pool ring coordinate + steam mask, veins
// mB: crevasse, crystal, cone (salt) or berg (> 0.5 ice, < 0.45 submerged shelf), glacier

fn terrParams(r: RWt) -> TP {
  var t: TP;
  t.t0 = bf(r, T0); t.t1 = bf(r, T1); t.t2 = bf(r, T2); t.t3 = bf(r, T3); t.t4 = bf(r, T4);
  t.t5 = bf(r, T5); t.t6 = bf(r, T6); t.t7 = bf(r, T7); t.t8 = bf(r, T8);
  return t;
}

fn efbm(p: vec2f, oct: i32, eros: f32, seed: u32) -> f32 {
  var q = p; var a = 0.5; var s = 0.0; var d = vec2f(0.0);
  for (var o = 0; o < oct; o++) {
    let n = vnoised(q, seed + u32(o));
    d += n.yz;
    s += a * n.x / (1.0 + eros * dot(d, d));
    a *= 0.5; q = rot2(q);
  }
  return s;
}

fn rfbm(p: vec2f, oct: i32, seed: u32) -> f32 {
  var q = p; var a = 0.5; var s = 0.0; var w = 1.0;
  for (var o = 0; o < oct; o++) {
    var n = 1.0 - abs(vn(q, seed + u32(o)));
    n = n * n * w;
    w = clamp(n * 2.0, 0.0, 1.0);
    s += n * a; a *= 0.5; q = rot2(q);
  }
  return s;
}

fn terrace(h: f32, st: f32, sharp: f32) -> f32 {
  let x = h / st; let fl = floor(x); let fr = x - fl;
  return st * (fl + sstep(sharp, 1.0, fr));
}

fn cellPt(ci: i32, cj: i32, cell: f32, s: u32) -> vec2f {
  return (vec2f(f32(ci), f32(cj)) + 0.2 + 0.6 * vec2f(hf(ci, cj, s), hf(ci, cj, s + 1u))) * cell;
}

// strata surface offset (m): a gentle regional dip plus slow folds. The material shader uses the same function.
fn strataTilt(p: vec2f) -> f32 {
  return 0.035 * (p.x * 0.83 + p.y * 0.55) + 80.0 * vn(p * (1.0 / 1900.0), 34u) + 18.0 * vn(p * (1.0 / 560.0), 35u);
}

// distance to a hexagon edge frame (circumradius units), rotated per cell by a hashed unit vector
fn hexD(v: vec2f, ci: i32, cj: i32) -> f32 {
  let u = normalize(vec2f(hf(ci, cj, 97u) - 0.5, hf(ci, cj, 98u) - 0.5) + vec2f(1e-3, 0.0));
  let q = vec2f(v.x * u.x + v.y * u.y, v.y * u.x - v.x * u.y);
  let a = abs(q);
  return max(a.x * 0.8660254 + a.y * 0.5, a.y) * 1.1547005;
}

// pillar cluster strength at a point: massifs plus a few long ridges, wide empty gaps between
fn pillarCluster(q: vec2f) -> f32 {
  let a = vn(q * (1.0 / 760.0), 140u) + 0.5 * vn(q * (1.0 / 270.0), 141u);
  let rg = 1.0 - abs(vn(q * (1.0 / 1300.0) + vec2f(4.1, 2.7), 142u));
  return max(sstep(0.05, 0.5, a), sstep(0.86, 0.97, rg) * sstep(-0.45, -0.1, a) * 0.8);
}

// rounded tree crowns: cellular domes (heights in m)
fn crowns(p: vec2f) -> f32 {
  let c = 5.5;
  let g = floor(p / c);
  var m = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let ci = i32(g.x) + i; let cj = i32(g.y) + j;
      let pt = cellPt(ci, cj, c, 160u);
      let r = c * (0.62 + 0.35 * hf(ci, cj, 162u));
      let d = length(p - pt) / r;
      let k = max(0.0, 1.0 - d * d);
      m = max(m, sqrt(k) * (2.2 + 2.6 * hf(ci, cj, 163u)));
    }
  }
  return m;
}

fn terrainEval(p: vec2f, t: TP, masks: bool) -> TerrOut {
  var o: TerrOut;
  o.mA = vec4f(0.0); o.mB = vec4f(0.0);
  let freq = t.t0.x;
  let wq = p * (freq * 0.5);
  let q = p + t.t0.w * vec2f(vn(wq, 11u), vn(wq + vec2f(5.2, 1.3), 12u));
  let qf = q * freq;
  var hn = efbm(qf, 7, t.t1.y, 20u) * 0.75 + 0.5;
  if (t.t1.x > 0.001) { hn = mix(hn, rfbm(qf * 1.1 + vec2f(3.7, 9.1), 5, 40u), t.t1.x); }
  hn = clamp(hn, 0.0, 1.0);
  var h = pow(max(hn, 1e-6), t.t1.w) * t.t0.y;
  if (t.t2.x > 0.001) {
    let vq = q * (freq * t.t2.w);
    let v = abs(vn(vq, 21u)) + 0.35 * abs(vn(vq * 2.7 + vec2f(3.1, 7.7), 22u));
    let u = sstep(0.0, t.t2.y, v);
    h = mix(h, h * u - t.t2.z * (1.0 - u), t.t2.x);
  }
  h += t.t0.z;
  // sea cliffs: land lifts by T8.w over a short band above the waterline
  if (t.t8.w > 0.001) { h += t.t8.w * sstep(-4.0, 22.0, h + 14.0 * vn(p * (1.0 / 260.0), 33u)); }
  // strata: beds dip and fold slowly; harder beds stand out as small steps of irregular height
  if (t.t3.x > 0.001) {
    let j = strataTilt(p);
    let s1 = h - j;
    let k = floor(s1 / t.t3.y);
    let hs = terrace(s1, t.t3.y, 0.3 + 0.45 * hf(i32(k), 17, 33u));
    let hs2 = terrace(hs, t.t3.y * 0.29, 0.6);
    h = mix(h, mix(hs, hs2, 0.45) + j, t.t3.x);
  }
  if (t.t3.z > 0.001) {
    let j = 4.0 * vn(p * (1.0 / 90.0), 32u);
    h = mix(h, terrace(h + j, t.t3.w, 0.72) - j, t.t3.z);
  }
  if (t.t1.z > 0.001) { h += t.t1.z * fbm(p * (1.0 / 48.0), 4, 50u); }

  // karst pillars (Zhangjiajie): clustered massifs and ridges with wide gaps, tapering and leaning frusta with
  // fluted walls and bedding ledges, rounded canopy crowns on top. Cluster strength is read at the pillar centre so
  // every pillar stays whole; dense clusters of similar heights read as flat-topped massifs on coarse levels.
  if (t.t4.x > 0.001) {
    let cell = t.t4.y;
    let g = floor(p / cell);
    let wob = 0.05 * vn(p * (1.0 / 13.0), 61u) + 0.03 * vn(p * (1.0 / 4.5), 62u);
    var best = 0.0; var bf1 = 0.0; var bht = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        let pt = cellPt(ci, cj, cell, 64u);
        let clu = pillarCluster(pt);
        if (hf(ci, cj, 63u) > 0.04 + 0.9 * clu) { continue; }
        let giant = select(1.0, 1.35, hf(ci, cj, 70u) < 0.07);
        let rb = t.t4.w * cell * (0.55 + 0.55 * hf(ci, cj, 66u)) * (0.8 + 0.3 * clu) * giant;
        // tall pillars must be girthy, and walls keep a minimum horizontal span (bounded slope for the heightcheck)
        let ht = min(t.t4.z * (0.25 + 0.75 * clu) * (0.7 + 0.45 * hf(ci, cj, 67u)) * giant, rb * 14.0);
        let rt = rb - max(rb * (0.15 + 0.25 * hf(ci, cj, 68u)), ht * (1.0 / 45.0));
        let lv = vec2f(hf(ci, cj, 69u) - 0.5, hf(ci, cj, 71u) - 0.5) * 0.7 * (rb - rt);
        let dv = p - pt;
        let dl = length(dv);
        let dir = dv / max(dl, 1e-3);
        let flute = 0.045 * vn(dir * 5.0 + vec2f(f32(ci & 63), f32(cj & 63)) * 7.0, 72u) + 0.02 * vn(dir * 13.0, 73u) + wob;
        let db = dl / rb + flute;
        if (db >= 1.0) { continue; }
        let dt = length(p - pt - lv) / rt + flute;
        var f = 1.0;
        if (dt > 1.0) { f = (1.0 - db) / max((1.0 - db) + (dt - 1.0), 1e-4); }
        var v = ht * f;
        // bedding ledges: short benches every ~30 m up the walls
        let lst = 26.0 + 10.0 * hf(ci, cj, 74u);
        v = mix(v, terrace(v, lst, 0.6), 0.4 * sstep(0.02, 0.3, f) * sstep(0.995, 0.9, f));
        if (v > best) { best = v; bf1 = f; bht = ht; }
      }
    }
    // rounded canopy crowns (5-7 m) on the tops
    let top = sstep(0.93, 1.0, bf1) * sstep(1.0, 20.0, best);
    var can = 0.0;
    if (top > 0.001) { can = crowns(p) * top; }
    h += t.t4.x * (best + can);
    // pillar top height / 600 m over the whole pillar footprint (0 off pillars): the material compares it with the
    // pixel height to find the canopy (h > top - 2.5) and the rim where green spills down the walls
    o.mA.y = select(0.0, clamp((h - t.t4.x * (best + can) + t.t4.x * bht) / 600.0, 0.0, 1.0), best > 1.0);
  }

  // salt flat + volcanic cone islands
  if (t.t5.x > 0.001) { h = mix(h, t.t5.y, t.t5.x); }
  if (t.t5.z > 0.001) {
    let cell = 1900.0;
    let g = floor(p / cell);
    var cm = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        if (hf(ci, cj, 71u) > 0.42) { continue; }
        let pt = cellPt(ci, cj, cell, 72u);
        let r = 380.0 + 420.0 * hf(ci, cj, 74u);
        let d = length(p - pt) / r;
        let k = max(0.0, 1.0 - d);
        var c = t.t5.w * (0.3 + 0.7 * hf(ci, cj, 75u)) * pow(k, 1.7);
        c -= t.t5.w * 0.05 * sstep(0.12, 0.0, d);
        cm = max(cm, c);
      }
    }
    cm *= 1.0 + 0.14 * vn(p * (1.0 / 55.0), 76u);
    // rugged volcanic rock: ridged gullies and crags, strongest high on the cone
    if (cm > 0.05) {
      let rq = p * (1.0 / 140.0) + 0.35 * vec2f(vn(p * (1.0 / 330.0), 77u), vn(p * (1.0 / 330.0) + vec2f(5.0, 3.0), 78u));
      let rg = rfbm(rq, 4, 150u);
      cm += (rg - 0.42) * 46.0 * sstep(0.5, 70.0, cm) + 3.0 * fbm(p * (1.0 / 17.0), 2, 155u) * sstep(0.2, 6.0, cm);
      cm = max(cm, 0.0);
    }
    h += t.t5.z * cm;
    o.mB.z = sstep(0.3, 3.0, cm) * t.t5.z;
  }

  // dunes and sinkholes
  if (t.t6.x > 0.001) {
    let w = 2.0 * vn(p * (1.0 / 700.0), 77u);
    let x = (p.x * 0.9 + p.y * 0.45) * (1.0 / 160.0) + w;
    let f = x - floor(x);
    let prof = sstep(0.0, 0.78, f) * sstep(1.0, 0.8, f);
    h += t.t6.x * t.t6.y * prof * (0.6 + 0.4 * vn(p * (1.0 / 400.0), 78u));
  }
  // sinkholes of glowing water; the nearest one also seeds the delta veins (masks)
  var sinkP = vec2f(0.0); var sinkR = 0.0; var sinkD = 99.0;
  if (t.t6.z > 0.001) {
    let cell = 1100.0;
    let g = floor(p / cell);
    var bm = 0.0;
    let wob = 0.15 * vn(p * (1.0 / 60.0), 81u);
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        if (hf(ci, cj, 82u) > 0.5) { continue; }
        let pt = cellPt(ci, cj, cell, 83u);
        let r = 90.0 + 150.0 * hf(ci, cj, 85u);
        let d = length(p - pt) / r + wob;
        bm = max(bm, sstep(1.0, 0.3, d));
        if (d < sinkD) { sinkD = d; sinkP = pt; sinkR = r; }
      }
    }
    h = mix(h, -t.t6.w, t.t6.z * bm);
  }

  // crystal fields: clusters of faceted hexagonal prisms with pyramid tips around rare tall spires
  if (t.t8.x > 0.001) {
    let cell = t.t8.y;
    let g = floor(p / cell);
    var cm = 0.0; var km = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        let pt = cellPt(ci, cj, cell, 92u);
        let cl = sstep(0.05, 0.45, vn(pt * (1.0 / 420.0), 93u));
        if (hf(ci, cj, 91u) > 0.03 + 0.75 * cl) { continue; }
        let spire = select(1.0, 2.0, hf(ci, cj, 96u) < 0.12 * cl);
        let r = (2.5 + 4.5 * hf(ci, cj, 94u)) * spire;
        let k = 1.0 - hexD(p - pt, ci, cj) / r;
        if (k <= 0.0) { continue; }
        let H = t.t8.z * (0.25 + 0.75 * hf(ci, cj, 95u)) * (0.4 + 0.6 * cl) * spire * spire;
        // prism wall to 70% of the height, then a pyramid tip (planar facets)
        let c = H * min(k * 2.8, 0.7 + (k - 0.25) * 0.4);
        if (c > cm) { cm = c; km = k; }
      }
    }
    h += t.t8.x * cm;
    o.mB.y = sstep(0.0, 0.1, km) * t.t8.x;
  }

  // glacier, crevasses, icebergs
  let glac = sstep(50.0, 130.0, h) * t.t7.y;
  if (t.t7.x > 0.001 && glac > 0.001) {
    let cq = p * (1.0 / 240.0) + 0.7 * vec2f(vn(p * (1.0 / 900.0), 86u), vn(p * (1.0 / 900.0) + vec2f(3.0, 1.0), 87u));
    let c1 = 1.0 - sstep(0.0, 0.018, abs(vn(cq, 88u)));
    let c2 = 1.0 - sstep(0.0, 0.022, abs(vn(cq * 2.3 + vec2f(1.7, 4.1), 89u)));
    let cr = max(c1, c2 * 0.8) * glac;
    h -= t.t7.x * cr * 14.0;
    o.mB.x = cr * t.t7.x;
  }
  o.mB.w = glac;
  if (t.t7.z > 0.001) {
    let lag = sstep(-1.5, -6.0, h);
    if (lag > 0.001) {
      let cell = 70.0;
      let g = floor(p / cell);
      var bh = -100.0; var bmk = 0.0;
      let wob = 0.06 * vn(p * (1.0 / 9.0), 96u);
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(g.x) + i; let cj = i32(g.y) + j;
          if (hf(ci, cj, 97u) > 0.3) { continue; }
          let pt = cellPt(ci, cj, cell, 98u);
          let r = 9.0 + 16.0 * hf(ci, cj, 100u);
          // faceted: hexagonal footprint, tilted planar top, planar walls, a pale shelf just under the water
          let d = hexD(p - pt, ci, cj + 7) / r + wob;
          let tilt = dot(p - pt, vec2f(hf(ci, cj, 101u) - 0.5, hf(ci, cj, 102u) - 0.5)) * 0.18;
          let b = clamp((1.0 - d) * 3.5, 0.0, 1.0);
          let ht = 1.5 + 8.0 * hf(ci, cj, 104u) + tilt;
          let shelf = -1.4 - 4.0 * max(d - 1.0, 0.0);
          let top = ht * b + shelf * (1.0 - b);
          if (top > bh) { bh = top; bmk = select(0.45 * sstep(2.1, 1.0, d), 0.5 + 0.5 * b, d < 1.0); }
        }
      }
      h = mix(h, max(h, bh), t.t7.z * lag);
      o.mB.z = max(o.mB.z, bmk * lag * t.t7.z);
    }
  }

  // hot pools in the low basins: fewer, larger; mats spread from the rim as runoff fingers.
  // mA.z encodes the mat ring coordinate rho (0 = centre, 1 = water edge, up to 2.4 = mat tips) as 1 - rho / 2.4;
  // it is also the steam mask: mA.z > 0.6 is hot open water.
  if (t.t7.w > 0.001) {
    let low = sstep(0.42, 0.22, hn);
    if (low > 0.001) {
      let cell = 900.0;
      let g = floor(p / cell);
      var best = 9.0; var bp = vec2f(0.0); var bk = vec2i(0);
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(g.x) + i; let cj = i32(g.y) + j;
          if (hf(ci, cj, 105u) > 0.42) { continue; }
          let pt = cellPt(ci, cj, cell, 106u);
          let r = 60.0 + 80.0 * hf(ci, cj, 108u);
          let d = length(p - pt) / r;
          if (d < best) { best = d; bp = pt; bk = vec2i(ci, cj); }
        }
      }
      let pm = sstep(1.0, 0.85, best);
      let rim = sstep(1.3, 1.0, best) * sstep(0.85, 1.0, best);
      h += t.t7.w * low * (rim * 0.6 - pm * 1.5);
      if (masks && best < 4.0) {
        let dir = (p - bp) / max(length(p - bp), 1e-3);
        let sd = vec2f(f32(bk.x & 31), f32(bk.y & 31)) * 5.3;
        let fing = max(vn(dir * 3.2 + sd, 109u), 0.0) * 1.5 + max(vn(dir * 8.0 + sd, 110u), 0.0) * 0.6;
        let rho = best / (1.0 + fing * sstep(0.95, 1.4, best) + 0.08 * vn(p * (1.0 / 6.0), 111u));
        o.mA.z = clamp(1.0 - rho / 2.4, 0.0, 1.0) * sstep(0.3, 0.6, low * t.t7.w);
      }
    }
  }
  o.h = h;

  if (masks) {
    // Lumen: distance to the nearest sinkhole (pulse phase) and branching delta veins fanning out from it
    if (t.t6.z > 0.001 && sinkR > 0.0) {
      let dv = p - sinkP;
      let rho = length(dv) / sinkR;
      o.mA.x = clamp(rho / 6.0, 0.0, 1.0) * t.t6.z;
      if (rho > 0.8 && rho < 5.5) {
        let dir = dv / max(length(dv), 1e-3);
        let sq = sqrt(rho);
        let k = sinkR / 55.0;
        let wq = 0.25 * vec2f(vn(p * (1.0 / 37.0), 125u), vn(p * (1.0 / 37.0) + vec2f(3.0, 9.0), 126u));
        // distance to the zero lines from the analytic gradient (angular scale only): constant width in metres
        let ang = k * sq / max(rho * sinkR, 1.0);
        let n1 = vnoised(dir * (k * sq) + vec2f(rho * 0.33, -rho * 0.21) + wq, 123u);
        let n2 = vnoised(dir * (k * sq * 2.3) + vec2f(-rho * 0.5, rho * 0.4) + wq + vec2f(11.0, 4.0), 124u);
        let d1 = abs(n1.x) / max(length(n1.yz) * ang, 1e-4);
        let d2 = abs(n2.x) / max(length(n2.yz) * ang * 2.3, 1e-4);
        // at coarse bake levels the lines widen to a texel and dim to keep their coverage (no aliasing far away)
        let W1t = 1.5 * (1.25 - 0.15 * rho); let W2t = 0.7;
        let W1 = max(W1t, TEXEL * 1.2); let W2 = max(W2t, TEXEL * 1.2);
        let trunk = (1.0 - sstep(W1 * 0.35, W1, d1)) * (W1t / W1);
        let twig = (1.0 - sstep(W2 * 0.35, W2, d2)) * sstep(1.6, 2.4, rho) * (W2t / W2);
        o.mA.w = max(trunk, twig * 0.7) * sstep(5.5, 3.0, rho) * sstep(0.8, 1.05, rho) * t.t6.z;
      }
    }
  }
  return o;
}

fn terrainAt(p: vec2f, masks: bool) -> TerrOut {
  return terrainEval(p, terrParams(realmWeights(p)), masks);
}
