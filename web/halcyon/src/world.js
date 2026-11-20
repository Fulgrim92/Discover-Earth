// world.js: CPU mirror of terrfn.wgsl (height path only). Alloc-free: numbers in, numbers out.
import { hf, realmWeights, blendFields, blendAt as blendRow, ROWF, W_NEAR } from './realms.js';

export { W_NEAR };

// blended terrain fields T0..T8 (9 vec4) in scratch
const T = new Float64Array(36);

function sstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// value noise with derivatives; results in NV, NDX, NDY
let NV = 0, NDX = 0, NDY = 0;
function vnoised(px, py, s) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hf(ix, iy, s) * 2 - 1, b = hf(ix + 1, iy, s) * 2 - 1, c = hf(ix, iy + 1, s) * 2 - 1, d = hf(ix + 1, iy + 1, s) * 2 - 1;
  const k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  NV = a + k1 * ux + k2 * uy + k3 * ux * uy;
  NDX = dux * (k1 + k3 * uy);
  NDY = duy * (k2 + k3 * ux);
  return NV;
}
function vn(px, py, s) { return vnoised(px, py, s); }

function fbm(px, py, oct, seed) {
  let qx = px, qy = py, a = 0.5, s = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vn(qx, qy, seed + o); a *= 0.5;
    const nx = (0.8 * qx - 0.6 * qy) * 2.03; qy = (0.6 * qx + 0.8 * qy) * 2.03; qx = nx;
  }
  return s;
}
function efbm(px, py, oct, eros, seed) {
  let qx = px, qy = py, a = 0.5, s = 0, dx = 0, dy = 0;
  for (let o = 0; o < oct; o++) {
    const n = vnoised(qx, qy, seed + o);
    dx += NDX; dy += NDY;
    s += a * n / (1 + eros * (dx * dx + dy * dy));
    a *= 0.5;
    const nx = (0.8 * qx - 0.6 * qy) * 2.03; qy = (0.6 * qx + 0.8 * qy) * 2.03; qx = nx;
  }
  return s;
}
function rfbm(px, py, oct, seed) {
  let qx = px, qy = py, a = 0.5, s = 0, w = 1;
  for (let o = 0; o < oct; o++) {
    let n = 1 - Math.abs(vn(qx, qy, seed + o));
    n = n * n * w;
    w = n * 2; w = w < 0 ? 0 : w > 1 ? 1 : w;
    s += n * a; a *= 0.5;
    const nx = (0.8 * qx - 0.6 * qy) * 2.03; qy = (0.6 * qx + 0.8 * qy) * 2.03; qx = nx;
  }
  return s;
}
function terrace(h, st, sharp) {
  const x = h / st, fl = Math.floor(x), fr = x - fl;
  return st * (fl + sstep(sharp, 1, fr));
}
let CPX = 0, CPY = 0;
function cellPt(ci, cj, cell, s) {
  CPX = (ci + 0.2 + 0.6 * hf(ci, cj, s)) * cell;
  CPY = (cj + 0.2 + 0.6 * hf(ci, cj, s + 1)) * cell;
}
function mix(a, b, t) { return a * (1 - t) + b * t; }
function len(x, y) { return Math.sqrt(x * x + y * y); }

// Terrain height (m) at world (x, z). Matches the GPU bake to centimetres.
export function heightAt(x, z) {
  realmWeights(x, z);
  blendFields(T, 0, 0, 9);
  const px = x, py = z;
  const freq = T[0];
  const wqx = px * (freq * 0.5), wqy = py * (freq * 0.5);
  const qx = px + T[3] * vn(wqx, wqy, 11), qy = py + T[3] * vn(wqx + 5.2, wqy + 1.3, 12);
  const qfx = qx * freq, qfy = qy * freq;
  let hn = efbm(qfx, qfy, 7, T[5], 20) * 0.75 + 0.5;
  if (T[4] > 0.001) hn = mix(hn, rfbm(qfx * 1.1 + 3.7, qfy * 1.1 + 9.1, 5, 40), T[4]);
  hn = hn < 0 ? 0 : hn > 1 ? 1 : hn;
  let h = Math.pow(Math.max(hn, 1e-6), T[7]) * T[1];
  if (T[8] > 0.001) {
    const vqx = qx * (freq * T[11]), vqy = qy * (freq * T[11]);
    const v = Math.abs(vn(vqx, vqy, 21)) + 0.35 * Math.abs(vn(vqx * 2.7 + 3.1, vqy * 2.7 + 7.7, 22));
    const u = sstep(0, T[9], v);
    h = mix(h, h * u - T[10] * (1 - u), T[8]);
  }
  h += T[2];
  if (T[35] > 0.001) h += T[35] * sstep(-4, 22, h + 14 * vn(px * (1 / 260), py * (1 / 260), 33));
  if (T[12] > 0.001) {
    const j = 5 * vn(px * (1 / 170), py * (1 / 170), 31);
    h = mix(h, terrace(h + j, T[13], 0.55) - j, T[12]);
  }
  if (T[14] > 0.001) {
    const j = 4 * vn(px * (1 / 90), py * (1 / 90), 32);
    h = mix(h, terrace(h + j, T[15], 0.72) - j, T[14]);
  }
  if (T[6] > 0.001) h += T[6] * fbm(px * (1 / 48), py * (1 / 48), 4, 50);

  if (T[16] > 0.001) {
    const cell = T[17];
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    const wob = 0.1 * vn(px * (1 / 13), py * (1 / 13), 61) + 0.06 * vn(px * (1 / 4.5), py * (1 / 4.5), 62);
    let best = 0, bm = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        if (hf(ci, cj, 63) > 0.62) continue;
        cellPt(ci, cj, cell, 64);
        const r = T[19] * cell * (0.5 + 0.5 * hf(ci, cj, 66));
        const d = len(px - CPX, py - CPY) / r + wob;
        const ht = T[18] * (0.35 + 0.65 * hf(ci, cj, 67));
        const m = sstep(1, 0.9, d);
        const fq = ht * 0.013 + d * 3; const v = m * ht * (1 - 0.06 * sstep(0.55, 0.95, d)) * (1 - 0.1 * sstep(0.7, 0.97, d) * sstep(0.3, 0.7, fq - Math.floor(fq)));
        if (v > best) { best = v; bm = m; }
      }
    }
    const can = bm * (4 + 3 * vn(px * (1 / 6), py * (1 / 6), 68) + 2 * vn(px * (1 / 2.3), py * (1 / 2.3), 69));
    h += T[16] * (best + can);
  }

  if (T[20] > 0.001) h = mix(h, T[21], T[20]);
  if (T[22] > 0.001) {
    const cell = 1900;
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let cm = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        if (hf(ci, cj, 71) > 0.42) continue;
        cellPt(ci, cj, cell, 72);
        const r = 380 + 420 * hf(ci, cj, 74);
        const d = len(px - CPX, py - CPY) / r;
        const k = Math.max(0, 1 - d);
        let c = T[23] * (0.3 + 0.7 * hf(ci, cj, 75)) * Math.pow(k, 1.7);
        c -= T[23] * 0.05 * sstep(0.12, 0, d);
        cm = Math.max(cm, c);
      }
    }
    cm *= 1 + 0.14 * vn(px * (1 / 55), py * (1 / 55), 76);
    h += T[22] * cm;
  }

  if (T[24] > 0.001) {
    const w = 2 * vn(px * (1 / 700), py * (1 / 700), 77);
    const x2 = (px * 0.9 + py * 0.45) * (1 / 160) + w;
    const f = x2 - Math.floor(x2);
    const prof = sstep(0, 0.78, f) * sstep(1, 0.8, f);
    h += T[24] * T[25] * prof * (0.6 + 0.4 * vn(px * (1 / 400), py * (1 / 400), 78));
  }
  if (T[26] > 0.001) {
    const cell = 1100;
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let bm = 0;
    const wob = 0.15 * vn(px * (1 / 60), py * (1 / 60), 81);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        if (hf(ci, cj, 82) > 0.5) continue;
        cellPt(ci, cj, cell, 83);
        const r = 90 + 150 * hf(ci, cj, 85);
        const d = len(px - CPX, py - CPY) / r + wob;
        bm = Math.max(bm, sstep(1, 0.3, d));
      }
    }
    h = mix(h, -T[27], T[26] * bm);
  }

  if (T[32] > 0.001) {
    const cell = T[33];
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let cm = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        if (hf(ci, cj, 91) > 0.32) continue;
        cellPt(ci, cj, cell, 92);
        const r = 2.5 + 4.5 * hf(ci, cj, 94);
        const k = Math.max(0, 1 - len(px - CPX, py - CPY) / r);
        const c = T[34] * (0.3 + 0.7 * hf(ci, cj, 95)) * k * (0.4 + 0.6 * k);
        if (c > cm) cm = c;
      }
    }
    h += T[32] * cm;
  }

  const glac = sstep(50, 130, h) * T[29];
  if (T[28] > 0.001 && glac > 0.001) {
    const ax = px * (1 / 900), ay = py * (1 / 900);
    const cqx = px * (1 / 240) + 0.7 * vn(ax, ay, 86), cqy = py * (1 / 240) + 0.7 * vn(ax + 3, ay + 1, 87);
    const c1 = 1 - sstep(0, 0.06, Math.abs(vn(cqx, cqy, 88)));
    const c2 = 1 - sstep(0, 0.07, Math.abs(vn(cqx * 2.3 + 1.7, cqy * 2.3 + 4.1, 89)));
    const cr = Math.max(c1, c2 * 0.8) * glac;
    h -= T[28] * cr * 9;
  }
  if (T[30] > 0.001) {
    const lag = sstep(-1.5, -6, h);
    if (lag > 0.001) {
      const cell = 70;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let bh = -100;
      const wob = 0.2 * vn(px * (1 / 9), py * (1 / 9), 96);
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const ci = gx + i, cj = gy + j;
          if (hf(ci, cj, 97) > 0.3) continue;
          cellPt(ci, cj, cell, 98);
          const r = 9 + 16 * hf(ci, cj, 100);
          const d = len(px - CPX, py - CPY) / r + wob;
          const b = sstep(1, 0.75, d);
          const top = (1.5 + 8 * hf(ci, cj, 104)) * b - 6 * (1 - b);
          if (top > bh) bh = top;
        }
      }
      h = mix(h, Math.max(h, bh), T[30] * lag);
    }
  }

  if (T[31] > 0.001) {
    const low = sstep(0.42, 0.22, hn);
    if (low > 0.001) {
      const cell = 520;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let best = 9;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const ci = gx + i, cj = gy + j;
          if (hf(ci, cj, 105) > 0.6) continue;
          cellPt(ci, cj, cell, 106);
          const r = 30 + 60 * hf(ci, cj, 108);
          best = Math.min(best, len(px - CPX, py - CPY) / r);
        }
      }
      const pm = sstep(1, 0.85, best);
      const rim = sstep(1.35, 1, best) * sstep(0.85, 1, best);
      h += T[31] * low * (rim * 0.8 - pm * 2);
    }
  }
  return h;
}

// Full blended realm row at (x, z) into outRow (Float32Array of ROWF). W_NEAR then holds the nearest site.
export function blendAt(x, z, outRow) { return blendRow(x, z, outRow); }
export { ROWF };

// Batched heights for the sim: xz = [x0,z0, x1,z1, ...] (n pairs) -> out[i]. Alloc-free.
export function heightBatch(xz, n, out) {
  for (let i = 0; i < n; i++) out[i] = heightAt(xz[i * 2], xz[i * 2 + 1]);
  return out;
}
export { CURATED } from './realms.js';
