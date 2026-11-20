// terrfn.wgsl: the shared terrain function. world.js heightAt() mirrors the height path line by line.
// Masks (mA, mB) are GPU only.

// texel size of the clipmap level being baked (0 outside the bake): mask-only lines widen to stay band-limited
var<private> TEXEL: f32 = 0.0;
// height footprint: the texel size on levels of 4 m and coarser, else 0 (fine levels and physics see full detail).
// Features narrower than ~1.5 texels widen (and lower, keeping their volume) and noise octaves under ~4 texels fade
// to their mean, so coarse levels never alias pillars, crystals or ridge creases into sawtooth spikes.
// world.js setFootprint() mirrors it for the heightcheck.
fn footprint() -> f32 { return select(0.0, TEXEL, TEXEL >= 4.0); }
// octave weight for wavelength lam (m) at footprint F
fn octW(lam: f32, F: f32) -> f32 { if (F <= 0.0) { return 1.0; } return sstep(1.5 * F, 4.0 * F, lam); }

struct TP { t0: vec4f, t1: vec4f, t2: vec4f, t3: vec4f, t4: vec4f, t5: vec4f, t6: vec4f, t7: vec4f, t8: vec4f }
struct TerrOut { h: f32, mA: vec4f, mB: vec4f }
// mA: sinkhole distance (Lumen pulse phase), pillar top height / 600 m, hot pool ring coordinate + steam mask, veins
// mB: crevasse, crystal, cone (salt) or berg (> 0.5 ice, < 0.45 submerged shelf), glacier

// Through a border the large shapes (T0-T2: relief, ridges, valleys) blend with the realm weights, while the
// features (T3-T8: strata, pillars, salt, dunes, glacier, crystals) blend with sharpened weights (w^3), so the
// ground morphs first and the features hand over in the middle of the zone instead of all fading to mush.
// world.js heightCore mirrors this.
fn terrParams(r: RWt) -> TP {
  var t: TP;
  t.t0 = bf(r, T0); t.t1 = bf(r, T1); t.t2 = bf(r, T2);
  var k = r;
  var sum = 0.0;
  for (var s = 0; s < 4; s++) { k.w[s] = r.w[s] * r.w[s] * r.w[s]; sum += k.w[s]; }
  k.w /= max(sum, 1e-12);
  t.t3 = bf(k, T3); t.t4 = bf(k, T4);
  t.t5 = bf(k, T5); t.t6 = bf(k, T6); t.t7 = bf(k, T7); t.t8 = bf(k, T8);
  return t;
}

// lam0: wavelength (m) of the first octave, for the footprint fade
fn efbm(p: vec2f, oct: i32, eros: f32, seed: u32, lam0: f32) -> f32 {
  var q = p; var a = 0.5; var s = 0.0; var d = vec2f(0.0);
  let F = footprint(); var lam = lam0;
  for (var o = 0; o < oct; o++) {
    let n = vnoised(q, seed + u32(o));
    d += n.yz;
    s += a * n.x / (1.0 + eros * dot(d, d)) * octW(lam, F);
    a *= 0.5; q = rot2(q); lam *= 1.0 / 2.03;
  }
  return s;
}

fn rfbm(p: vec2f, oct: i32, seed: u32, lam0: f32) -> f32 {
  var q = p; var a = 0.5; var s = 0.0; var w = 1.0;
  let F = footprint(); var lam = lam0;
  for (var o = 0; o < oct; o++) {
    var n = mix(0.6, 1.0 - abs(vn(q, seed + u32(o))), octW(lam, F));
    lam *= 1.0 / 2.03;
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
  var hn = efbm(qf, 7, t.t1.y, 20u, 1.0 / freq) * 0.75 + 0.5;
  if (t.t1.x > 0.001) { hn = mix(hn, rfbm(qf * 1.1 + vec2f(3.7, 9.1), 5, 40u, 1.0 / (freq * 1.1)), t.t1.x); }
  hn = clamp(hn, 0.0, 1.0);
  var h = pow(max(hn, 1e-6), t.t1.w) * t.t0.y;
  if (t.t2.x > 0.001) {
    let vq = q * (freq * t.t2.w);
    var v = abs(vn(vq, 21u)) + 0.35 * abs(vn(vq * 2.7 + vec2f(3.1, 7.7), 22u));
    // tributaries: a finer, shallower valley set joins the trunks (drainage network rather than isolated troughs)
    v = min(v, 0.3 + 0.8 * abs(vn(vq * 3.3 + vec2f(8.3, 2.9), 23u)));
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
    let F = footprint();
    var best = 0.0; var bf1 = 0.0; var bht = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        let pt = cellPt(ci, cj, cell, 64u);
        let clu = pillarCluster(pt);
        if (hf(ci, cj, 63u) > 0.04 + 0.9 * clu) { continue; }
        let giant = select(1.0, 1.35, hf(ci, cj, 70u) < 0.07);
        let rb0 = t.t4.w * cell * (0.55 + 0.55 * hf(ci, cj, 66u)) * (0.8 + 0.3 * clu) * giant;
        // tall pillars must be girthy, and walls keep a minimum horizontal span (bounded slope for the heightcheck)
        let ht0 = min(t.t4.z * (0.25 + 0.75 * clu) * (0.7 + 0.45 * hf(ci, cj, 67u)) * giant, rb0 * 14.0);
        let rt0 = rb0 - max(rb0 * (0.15 + 0.25 * hf(ci, cj, 68u)), ht0 * (1.0 / 45.0));
        // coarse levels: at least 1.25 texels of radius, lowered so the far silhouette keeps its mass, not spikes
        let fs = max(1.0, 1.25 * F / rb0);
        let rb = rb0 * fs; let rt = rt0 * fs; let ht = ht0 / fs;
        let lv = vec2f(hf(ci, cj, 69u) - 0.5, hf(ci, cj, 71u) - 0.5) * 0.7 * (rb - rt);
        let dv = p - pt;
        let dl = length(dv);
        let dir = dv / max(dl, 1e-3);
        let flute = 0.045 * vn(dir * 5.0 + vec2f(f32(ci & 63), f32(cj & 63)) * 7.0, 72u) + 0.02 * vn(dir * 13.0, 73u) + wob;
        let db = dl / rb + flute;
        if (db >= 1.35) { continue; }
        // talus apron of fallen blocks around the foot
        let tq = clamp((1.35 - db) * (1.0 / 0.35), 0.0, 1.0);
        let tal = min(10.0, ht * 0.05) * (0.6 + 0.8 * hf(ci, cj, 76u)) * tq * tq;
        var f = 0.0;
        var v = tal;
        if (db < 1.0) {
          let dt = length(p - pt - lv) / rt + flute;
          f = 1.0;
          if (dt > 1.0) { f = (1.0 - db) / max((1.0 - db) + (dt - 1.0), 1e-4); }
          // weathered, rounded shoulders: the rim of the top rolls over into the wall
          let shH = min(7.0, rt * 0.3);
          let drop = shH * select(sstep(0.6, 1.0, dt), sstep(0.0, 0.6, f), dt > 1.0);
          var w = ht * f - drop;
          // bedding ledges: short benches every ~30 m up the walls
          let lst = 26.0 + 10.0 * hf(ci, cj, 74u);
          w = mix(w, terrace(w, lst, 0.6), 0.4 * sstep(0.02, 0.3, f) * sstep(0.995, 0.9, f));
          v = max(w, tal);
        }
        if (v > best) { best = v; bf1 = f; bht = ht; }
      }
    }
    // rounded canopy crowns (5-7 m) on the tops
    let top = sstep(0.93, 1.0, bf1) * sstep(1.0, 20.0, best);
    var can = 0.0;
    if (top > 0.001 && F < 11.0) { can = crowns(p) * top * (1.0 - sstep(4.0, 11.0, F)); }
    // pillars only where the Stone Forest dominates: in a border they shrink as a whole instead of leaking half-height
    // spikes into the neighbour (lowered pillars still read as karst)
    let pw = sstep(0.35, 0.85, t.t4.x);
    h += pw * (best + can);
    // pillar top height / 600 m over the whole pillar footprint (0 off pillars): the material compares it with the
    // pixel height to find the canopy (h > top - 2.5) and the rim where green spills down the walls
    o.mA.y = select(0.0, clamp((h - pw * (best + can) + pw * bht) / 600.0, 0.0, 1.0), best * pw > 1.0);
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
      let rg = rfbm(rq, 4, 150u, 140.0);
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
    var cm = 0.0; var km = 0.0; var kc = 1.0;
    let F = footprint();
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        let pt = cellPt(ci, cj, cell, 92u);
        let cl = sstep(0.05, 0.45, vn(pt * (1.0 / 420.0), 93u));
        if (hf(ci, cj, 91u) > 0.03 + 0.75 * cl) { continue; }
        let spire = select(1.0, 2.0, hf(ci, cj, 96u) < 0.12 * cl);
        let r0 = (2.5 + 4.5 * hf(ci, cj, 94u)) * spire;
        let r = max(r0, 1.5 * F); // coarse levels: wider, lower (volume kept)
        let k = 1.0 - hexD(p - pt, ci, cj) / r;
        if (k <= 0.0) { continue; }
        let H = t.t8.z * (0.25 + 0.75 * hf(ci, cj, 95u)) * (0.4 + 0.6 * cl) * spire * spire * (r0 / r) * (r0 / r);
        // prism wall to 70% of the height, then a pyramid tip (planar facets)
        let c = H * min(k * 2.8, 0.7 + (k - 0.25) * 0.4);
        if (c > cm) { cm = c; km = k; kc = (r0 / r) * (r0 / r); }
      }
    }
    h += t.t8.x * cm;
    o.mB.y = sstep(0.0, 0.1, km) * t.t8.x * kc; // widened crystals keep their coverage
  }

  // Aurora Ice glacier (T7.y). An ice surface lies a varying thickness above a smoothed copy of the land (its first
  // three octaves): it fills the valleys as a broad tongue and the higher, sharper ground stands out of it as dark
  // nunatak ridges. Where the smoothed land falls to sea level the ice ends in a 20-40 m calving cliff over the
  // lagoon; bare land just above the sea is flattened into a black-sand outwash plain. Crevasse fields and serac
  // blocks break the ice in icefall zones and behind the front.
  var glac = 0.0;
  if (t.t7.y > 0.001) {
    // smoothed land without the ridge noise: the ridged crests stand above the ice, their troughs fill with it
    let hl = mix(efbm(qf, 3, t.t1.y, 20u, 1.0 / freq) * 0.75 + 0.5, 0.32, t.t1.x);
    let base = pow(max(clamp(hl, 0.0, 1.0), 1e-6), t.t1.w) * t.t0.y + t.t0.z;
    // the front is where fb crosses 0: at the sea in places (calving cliff), inland elsewhere (outwash plain below)
    let inl = sstep(0.15, 0.5, vn(p * (1.0 / 1500.0), 306u)); // 1: the tongue ends on land
    let fb = base + 9.0 * vn(p * (1.0 / 340.0), 301u) + 2.0 - 75.0 * inl;
    let gF = sstep(-0.35, 0.35, fb) * t.t7.y;
    let thick = 24.0 + 10.0 * vn(p * (1.0 / 520.0), 302u) - 14.0 * sstep(0.1, 0.6, vn(p * (1.0 / 900.0), 304u));
    var iceS = max(base, 0.0) + thick + 0.02 * max(fb, 0.0);
    // outwash plain: low bare land compressed towards the sea
    let ow = sstep(-1.0, 3.0, h) * sstep(28.0, 12.0, h) * t.t7.y * (1.0 - gF);
    h = mix(h, 0.5 + 0.12 * h, ow);
    // proglacial lagoon hugging a calving front
    h = mix(h, min(h, -5.0 + 0.1 * fb), sstep(-34.0, -14.0, fb) * (1.0 - gF) * (1.0 - inl) * t.t7.y);
    // nunatak ridges: long sharp rock crests that stand 30-60 m out of the ice
    let nw = p * (1.0 / 1100.0) + 0.45 * vec2f(vn(p * (1.0 / 2600.0), 312u), vn(p * (1.0 / 2600.0) + vec2f(7.0, 3.0), 313u));
    let nr = 1.0 - abs(vn(nw, 311u));
    h += gF * 80.0 * sstep(0.8, 0.97, nr) * sstep(-0.3, 0.2, vn(p * (1.0 / 1700.0), 314u));
    // icefall / crevasse zones: patches of the tongue and a band behind the front
    let zone = max(sstep(0.3, 0.55, vn(p * (1.0 / 560.0), 303u)), sstep(45.0, 8.0, fb)) * gF;
    var cr = 0.0; var ser = 0.0;
    if (zone > 0.001) {
      // seracs: tilted blocks 8-14 m across, 1-6 m proud
      let sc = 11.0;
      let sg = floor(p / sc);
      var bh = 0.0;
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(sg.x) + i; let cj = i32(sg.y) + j;
          let pt = cellPt(ci, cj, sc, 305u);
          let d = hexD(p - pt, ci, cj + 11) / (sc * (0.5 + 0.25 * hf(ci, cj, 307u)));
          if (d >= 1.0) { continue; }
          let tl = dot(p - pt, vec2f(hf(ci, cj, 308u) - 0.5, hf(ci, cj, 309u) - 0.5)) * 0.35;
          bh = max(bh, (1.0 + 5.0 * hf(ci, cj, 310u) + tl) * sstep(1.0, 0.75, d));
        }
      }
      ser = sstep(0.5, 2.0, bh) * zone;
      iceS += bh * zone * (1.0 - sstep(4.0, 12.0, footprint()));
      // crevasses: parallel rows ~22 m apart in a slowly turning direction, broken into en-echelon segments,
      // ~3 m wide and 12 m deep; coarse levels widen them to a texel and keep the volume
      // (rotation from a polynomial, not cos/sin: GPU trig is too coarse at |p| ~ 10 km for the heightcheck)
      let ca = vn(p * (1.0 / 1800.0), 315u);
      let cc = 1.0 - 0.45 * ca * ca; let cs = 0.95 * ca;
      let rp = vec2f(cc * p.x + cs * p.y, cc * p.y - cs * p.x);
      let cx = rp.x * (1.0 / 22.0) + 0.7 * vn(rp * vec2f(1.0 / 160.0, 1.0 / 70.0), 316u);
      let ck = floor(cx);
      let cd = abs(cx - ck - 0.5) * 22.0;
      let cg = max(1.0, footprint() / 3.0);
      let cw = (1.2 + 1.0 * hf(i32(ck), 3, 317u)) * cg;
      let seg = sstep(-0.05, 0.25, vn(vec2f(ck * 1.7, rp.y * (1.0 / 45.0)), 318u));
      cr = (1.0 - sstep(cw * 0.45, cw, cd)) * seg * zone;
      iceS -= cr * 12.0 * t.t7.x / cg;
    }
    let cover = gF * sstep(-0.3, 0.6, iceS - h);
    h = mix(h, max(h, iceS), gF);
    glac = cover;
    o.mB.x = cr * cover * t.t7.x;
    o.mB.y = ser * cover;
  }
  o.mB.w = glac;
  if (t.t7.z > 0.001) {
    let lag = sstep(-1.5, -6.0, h);
    if (lag > 0.001) {
      // bergs of very different sizes: many small growlers, a few large tabular-to-pinnacled bergs
      let cell = 110.0;
      let g = floor(p / cell);
      var bh = -100.0; var bmk = 0.0;
      let wob = 0.06 * vn(p * (1.0 / 9.0), 96u);
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(g.x) + i; let cj = i32(g.y) + j;
          if (hf(ci, cj, 97u) > 0.45) { continue; }
          let pt = cellPt(ci, cj, cell, 98u);
          let sz = hf(ci, cj, 100u);
          let r = 4.0 + 46.0 * sz * sz * sz;
          // faceted: hexagonal footprint, tilted planar top, planar walls, a pale shelf just under the water
          let d = hexD(p - pt, ci, cj + 7) / r + wob;
          let tilt = dot(p - pt, vec2f(hf(ci, cj, 101u) - 0.5, hf(ci, cj, 102u) - 0.5)) * 0.18;
          let b = clamp((1.0 - d) * 3.5, 0.0, 1.0);
          let ht = 1.0 + r * (0.12 + 0.3 * hf(ci, cj, 104u)) + tilt;
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
      if (rho > 0.8 && rho < 7.5) {
        let dir = dv / max(length(dv), 1e-3);
        let sq = sqrt(rho);
        let k = sinkR / 55.0;
        let wq = 0.25 * vec2f(vn(p * (1.0 / 37.0), 125u), vn(p * (1.0 / 37.0) + vec2f(3.0, 9.0), 126u));
        // distance (m) to the zero lines from the analytic gradient (angular scale only): constant width in metres.
        // Three tiers make a delta: few thick trunks from the pool, branches only beside a trunk, twigs only beside
        // a branch, each narrower and reaching further out.
        let ang = k * sq / max(rho * sinkR, 1.0);
        // trunks: few and nearly radial; branches and twigs wander more
        let n1 = vnoised(dir * (k * sq * 0.45) + vec2f(rho * 0.1, -rho * 0.07) + wq * 0.5, 123u);
        let n2 = vnoised(dir * (k * sq * 1.4) + vec2f(-rho * 0.3, rho * 0.25) + wq + vec2f(11.0, 4.0), 124u);
        let n3 = vnoised(dir * (k * sq * 3.6) + vec2f(rho * 0.7, rho * 0.5) + wq * 1.5 + vec2f(3.0, 17.0), 127u);
        let d1 = abs(n1.x) / max(length(n1.yz) * ang * 0.45, 1e-4);
        let d2 = abs(n2.x) / max(length(n2.yz) * ang * 1.4, 1e-4);
        let d3 = abs(n3.x) / max(length(n3.yz) * ang * 3.6, 1e-4);
        // at coarse bake levels the lines widen to a texel and dim to keep their coverage (no aliasing far away)
        let W1t = 7.0 * (1.3 - 0.13 * rho); let W2t = 2.6; let W3t = 1.0;
        let W1 = max(W1t, TEXEL * 1.2); let W2 = max(W2t, TEXEL * 1.2); let W3 = max(W3t, TEXEL * 1.2);
        let trunk = (1.0 - sstep(W1 * 0.35, W1, d1)) * (W1t / W1) * sstep(5.5, 3.5, rho);
        let branch = (1.0 - sstep(W2 * 0.35, W2, d2)) * (W2t / W2) * sstep(1.3, 2.0, rho) * sstep(6.5, 4.5, rho) * sstep(45.0, 12.0, d1);
        let twig = (1.0 - sstep(W3 * 0.35, W3, d3)) * (W3t / W3) * sstep(2.0, 3.0, rho) * sstep(18.0, 5.0, d2) * sstep(55.0, 15.0, d1);
        o.mA.w = max(trunk, max(branch * 0.72, twig * 0.5)) * sstep(7.5, 5.5, rho) * sstep(0.8, 1.05, rho) * t.t6.z;
      }
    }
  }
  return o;
}

fn terrainAt(p: vec2f, masks: bool) -> TerrOut {
  return terrainEval(p, terrParams(realmWeights(p)), masks);
}
