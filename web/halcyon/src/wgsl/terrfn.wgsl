// terrfn.wgsl: the shared terrain function. world.js heightAt() mirrors the height path line by line.
// Masks (mA, mB) are GPU only.

struct TP { t0: vec4f, t1: vec4f, t2: vec4f, t3: vec4f, t4: vec4f, t5: vec4f, t6: vec4f, t7: vec4f, t8: vec4f }
struct TerrOut { h: f32, mA: vec4f, mB: vec4f }
// mA: strata offset, pillar/canopy, pool field, veins
// mB: crevasse, crystal, cone/berg, glacier

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
  if (t.t3.x > 0.001) {
    let j = 5.0 * vn(p * (1.0 / 170.0), 31u);
    h = mix(h, terrace(h + j, t.t3.y, 0.55) - j, t.t3.x);
  }
  if (t.t3.z > 0.001) {
    let j = 4.0 * vn(p * (1.0 / 90.0), 32u);
    h = mix(h, terrace(h + j, t.t3.w, 0.72) - j, t.t3.z);
  }
  if (t.t1.z > 0.001) { h += t.t1.z * fbm(p * (1.0 / 48.0), 4, 50u); }

  // karst pillars: sheer sides, flat canopy tops
  if (t.t4.x > 0.001) {
    let cell = t.t4.y;
    let g = floor(p / cell);
    let wob = 0.1 * vn(p * (1.0 / 13.0), 61u) + 0.06 * vn(p * (1.0 / 4.5), 62u);
    var best = 0.0; var bm = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        if (hf(ci, cj, 63u) > 0.62) { continue; }
        let pt = cellPt(ci, cj, cell, 64u);
        let r = t.t4.w * cell * (0.5 + 0.5 * hf(ci, cj, 66u));
        let d = length(p - pt) / r + wob;
        let ht = t.t4.z * (0.35 + 0.65 * hf(ci, cj, 67u));
        let m = sstep(1.0, 0.9, d);
        let v = m * ht * (1.0 - 0.06 * sstep(0.55, 0.95, d)) * (1.0 - 0.1 * sstep(0.7, 0.97, d) * sstep(0.3, 0.7, fract(ht * 0.013 + d * 3.0)));
        if (v > best) { best = v; bm = m; }
      }
    }
    let can = bm * (4.0 + 3.0 * vn(p * (1.0 / 6.0), 68u) + 2.0 * vn(p * (1.0 / 2.3), 69u));
    h += t.t4.x * (best + can);
    o.mA.y = bm * t.t4.x;
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
      }
    }
    h = mix(h, -t.t6.w, t.t6.z * bm);
  }

  // crystal spires
  if (t.t8.x > 0.001) {
    let cell = t.t8.y;
    let g = floor(p / cell);
    var cm = 0.0; var km = 0.0;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let ci = i32(g.x) + i; let cj = i32(g.y) + j;
        if (hf(ci, cj, 91u) > 0.32) { continue; }
        let pt = cellPt(ci, cj, cell, 92u);
        let r = 2.5 + 4.5 * hf(ci, cj, 94u);
        let k = max(0.0, 1.0 - length(p - pt) / r);
        let c = t.t8.z * (0.3 + 0.7 * hf(ci, cj, 95u)) * k * (0.4 + 0.6 * k);
        if (c > cm) { cm = c; km = k; }
      }
    }
    h += t.t8.x * cm;
    o.mB.y = sstep(0.0, 0.15, km) * t.t8.x;
  }

  // glacier, crevasses, icebergs
  let glac = sstep(50.0, 130.0, h) * t.t7.y;
  if (t.t7.x > 0.001 && glac > 0.001) {
    let cq = p * (1.0 / 240.0) + 0.7 * vec2f(vn(p * (1.0 / 900.0), 86u), vn(p * (1.0 / 900.0) + vec2f(3.0, 1.0), 87u));
    let c1 = 1.0 - sstep(0.0, 0.06, abs(vn(cq, 88u)));
    let c2 = 1.0 - sstep(0.0, 0.07, abs(vn(cq * 2.3 + vec2f(1.7, 4.1), 89u)));
    let cr = max(c1, c2 * 0.8) * glac;
    h -= t.t7.x * cr * 9.0;
    o.mB.x = cr * t.t7.x;
  }
  o.mB.w = glac;
  if (t.t7.z > 0.001) {
    let lag = sstep(-1.5, -6.0, h);
    if (lag > 0.001) {
      let cell = 70.0;
      let g = floor(p / cell);
      var bh = -100.0; var bmk = 0.0;
      let wob = 0.2 * vn(p * (1.0 / 9.0), 96u);
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(g.x) + i; let cj = i32(g.y) + j;
          if (hf(ci, cj, 97u) > 0.3) { continue; }
          let pt = cellPt(ci, cj, cell, 98u);
          let r = 9.0 + 16.0 * hf(ci, cj, 100u);
          let d = length(p - pt) / r + wob;
          let b = sstep(1.0, 0.75, d);
          let top = (1.5 + 8.0 * hf(ci, cj, 104u)) * b - 6.0 * (1.0 - b);
          if (top > bh) { bh = top; bmk = b; }
        }
      }
      h = mix(h, max(h, bh), t.t7.z * lag);
      o.mB.z = max(o.mB.z, bmk * lag * t.t7.z);
    }
  }

  // hot pools in the low basins
  if (t.t7.w > 0.001) {
    let low = sstep(0.42, 0.22, hn);
    if (low > 0.001) {
      let cell = 520.0;
      let g = floor(p / cell);
      var best = 9.0;
      for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
          let ci = i32(g.x) + i; let cj = i32(g.y) + j;
          if (hf(ci, cj, 105u) > 0.6) { continue; }
          let pt = cellPt(ci, cj, cell, 106u);
          let r = 30.0 + 60.0 * hf(ci, cj, 108u);
          best = min(best, length(p - pt) / r);
        }
      }
      let pm = sstep(1.0, 0.85, best);
      let rim = sstep(1.35, 1.0, best) * sstep(0.85, 1.0, best);
      h += t.t7.w * low * (rim * 0.8 - pm * 2.0);
      o.mA.z = t.t7.w * low * sstep(1.4, 1.0, best) * (1.0 - min(best, 1.0) * 0.5);
    }
  }
  o.h = h;

  if (masks) {
    o.mA.x = 0.5 + 0.5 * fbm(p * (1.0 / 520.0), 3, 120u);
    let vq = p * (1.0 / 260.0) + 0.5 * vec2f(vn(p * (1.0 / 700.0), 121u), vn(p * (1.0 / 700.0) + vec2f(7.0, 2.0), 122u));
    let v1 = 1.0 - sstep(0.0, 0.022, abs(vn(vq, 123u)));
    let v2 = 1.0 - sstep(0.0, 0.03, abs(vn(vq * 3.1 + vec2f(2.0, 5.0), 124u)));
    o.mA.w = max(v1, v2 * 0.6);
  }
  return o;
}

fn terrainAt(p: vec2f, masks: bool) -> TerrOut {
  return terrainEval(p, terrParams(realmWeights(p)), masks);
}
