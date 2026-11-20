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
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// strata surface offset (terrfn.wgsl strataTilt)
export function strataTilt(px, py) {
  return 0.035 * (px * 0.83 + py * 0.55) + 80 * vn(px * (1 / 1900), py * (1 / 1900), 34) + 18 * vn(px * (1 / 560), py * (1 / 560), 35);
}
// pillar cluster strength (terrfn.wgsl pillarCluster)
function pillarCluster(qx, qy) {
  const a = vn(qx * (1 / 760), qy * (1 / 760), 140) + 0.5 * vn(qx * (1 / 270), qy * (1 / 270), 141);
  const rg = 1 - Math.abs(vn(qx * (1 / 1300) + 4.1, qy * (1 / 1300) + 2.7, 142));
  return Math.max(sstep(0.05, 0.5, a), sstep(0.86, 0.97, rg) * sstep(-0.45, -0.1, a) * 0.8);
}
// rounded tree crowns (terrfn.wgsl crowns)
function crowns(px, py) {
  const c = 5.5;
  const gx = Math.floor(px / c), gy = Math.floor(py / c);
  let m = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ci = gx + i, cj = gy + j;
      cellPt(ci, cj, c, 160);
      const r = c * (0.62 + 0.35 * hf(ci, cj, 162));
      const d = len(px - CPX, py - CPY) / r;
      const k = Math.max(0, 1 - d * d);
      m = Math.max(m, Math.sqrt(k) * (2.2 + 2.6 * hf(ci, cj, 163)));
    }
  }
  return m;
}
// hexagon frame distance (terrfn.wgsl hexD)
function hexD(vx, vy, ci, cj) {
  let ux = hf(ci, cj, 97) - 0.5 + 1e-3, uy = hf(ci, cj, 98) - 0.5;
  const ul = Math.sqrt(ux * ux + uy * uy); ux /= ul; uy /= ul;
  const ax = Math.abs(vx * ux + vy * uy), ay = Math.abs(vy * ux - vx * uy);
  return Math.max(ax * 0.8660254 + ay * 0.5, ay) * 1.1547005;
}
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
    const j = strataTilt(px, py);
    const s1 = h - j;
    const k = Math.floor(s1 / T[13]);
    const hs = terrace(s1, T[13], 0.3 + 0.45 * hf(k, 17, 33));
    const hs2 = terrace(hs, T[13] * 0.29, 0.6);
    h = mix(h, mix(hs, hs2, 0.45) + j, T[12]);
  }
  if (T[14] > 0.001) {
    const j = 4 * vn(px * (1 / 90), py * (1 / 90), 32);
    h = mix(h, terrace(h + j, T[15], 0.72) - j, T[14]);
  }
  if (T[6] > 0.001) h += T[6] * fbm(px * (1 / 48), py * (1 / 48), 4, 50);

  if (T[16] > 0.001) {
    const cell = T[17];
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    const wob = 0.05 * vn(px * (1 / 13), py * (1 / 13), 61) + 0.03 * vn(px * (1 / 4.5), py * (1 / 4.5), 62);
    let best = 0, bf1 = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        cellPt(ci, cj, cell, 64);
        const ptx = CPX, pty = CPY;
        const clu = pillarCluster(ptx, pty);
        if (hf(ci, cj, 63) > 0.04 + 0.9 * clu) continue;
        const giant = hf(ci, cj, 70) < 0.07 ? 1.35 : 1;
        const rb = T[19] * cell * (0.55 + 0.55 * hf(ci, cj, 66)) * (0.8 + 0.3 * clu) * giant;
        const ht = Math.min(T[18] * (0.25 + 0.75 * clu) * (0.7 + 0.45 * hf(ci, cj, 67)) * giant, rb * 14);
        const rt = rb - Math.max(rb * (0.15 + 0.25 * hf(ci, cj, 68)), ht * (1 / 45));
        const lx = (hf(ci, cj, 69) - 0.5) * 0.7 * (rb - rt), ly = (hf(ci, cj, 71) - 0.5) * 0.7 * (rb - rt);
        const dvx = px - ptx, dvy = py - pty;
        const dl = len(dvx, dvy);
        const dm = Math.max(dl, 1e-3);
        const dx = dvx / dm, dy = dvy / dm;
        const flute = 0.045 * vn(dx * 5 + (ci & 63) * 7, dy * 5 + (cj & 63) * 7, 72) + 0.02 * vn(dx * 13, dy * 13, 73) + wob;
        const db = dl / rb + flute;
        if (db >= 1) continue;
        const dt = len(dvx - lx, dvy - ly) / rt + flute;
        let f = 1;
        if (dt > 1) f = (1 - db) / Math.max((1 - db) + (dt - 1), 1e-4);
        let v = ht * f;
        const lst = 26 + 10 * hf(ci, cj, 74);
        v = mix(v, terrace(v, lst, 0.6), 0.4 * sstep(0.02, 0.3, f) * sstep(0.995, 0.9, f));
        if (v > best) { best = v; bf1 = f; }
      }
    }
    const top = sstep(0.93, 1, bf1) * sstep(1, 20, best);
    let can = 0;
    if (top > 0.001) can = crowns(px, py) * top;
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
    if (cm > 0.05) {
      const rqx = px * (1 / 140) + 0.35 * vn(px * (1 / 330), py * (1 / 330), 77);
      const rqy = py * (1 / 140) + 0.35 * vn(px * (1 / 330) + 5, py * (1 / 330) + 3, 78);
      const rg = rfbm(rqx, rqy, 4, 150);
      cm += (rg - 0.42) * 46 * sstep(0.5, 70, cm) + 3 * fbm(px * (1 / 17), py * (1 / 17), 2, 155) * sstep(0.2, 6, cm);
      cm = Math.max(cm, 0);
    }
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
        cellPt(ci, cj, cell, 92);
        const ptx = CPX, pty = CPY;
        const cl = sstep(0.05, 0.45, vn(ptx * (1 / 420), pty * (1 / 420), 93));
        if (hf(ci, cj, 91) > 0.03 + 0.75 * cl) continue;
        const spire = hf(ci, cj, 96) < 0.12 * cl ? 2 : 1;
        const r = (2.5 + 4.5 * hf(ci, cj, 94)) * spire;
        const k = 1 - hexD(px - ptx, py - pty, ci, cj) / r;
        if (k <= 0) continue;
        const H = T[34] * (0.25 + 0.75 * hf(ci, cj, 95)) * (0.4 + 0.6 * cl) * spire * spire;
        const c = H * Math.min(k * 2.8, 0.7 + (k - 0.25) * 0.4);
        if (c > cm) cm = c;
      }
    }
    h += T[32] * cm;
  }

  const glac = sstep(50, 130, h) * T[29];
  if (T[28] > 0.001 && glac > 0.001) {
    const ax = px * (1 / 900), ay = py * (1 / 900);
    const cqx = px * (1 / 240) + 0.7 * vn(ax, ay, 86), cqy = py * (1 / 240) + 0.7 * vn(ax + 3, ay + 1, 87);
    const c1 = 1 - sstep(0, 0.018, Math.abs(vn(cqx, cqy, 88)));
    const c2 = 1 - sstep(0, 0.022, Math.abs(vn(cqx * 2.3 + 1.7, cqy * 2.3 + 4.1, 89)));
    const cr = Math.max(c1, c2 * 0.8) * glac;
    h -= T[28] * cr * 14;
  }
  if (T[30] > 0.001) {
    const lag = sstep(-1.5, -6, h);
    if (lag > 0.001) {
      const cell = 70;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let bh = -100;
      const wob = 0.06 * vn(px * (1 / 9), py * (1 / 9), 96);
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const ci = gx + i, cj = gy + j;
          if (hf(ci, cj, 97) > 0.3) continue;
          cellPt(ci, cj, cell, 98);
          const r = 9 + 16 * hf(ci, cj, 100);
          const d = hexD(px - CPX, py - CPY, ci, cj + 7) / r + wob;
          const tilt = ((px - CPX) * (hf(ci, cj, 101) - 0.5) + (py - CPY) * (hf(ci, cj, 102) - 0.5)) * 0.18;
          const b = clamp01((1 - d) * 3.5);
          const ht = 1.5 + 8 * hf(ci, cj, 104) + tilt;
          const shelf = -1.4 - 4 * Math.max(d - 1, 0);
          const top = ht * b + shelf * (1 - b);
          if (top > bh) bh = top;
        }
      }
      h = mix(h, Math.max(h, bh), T[30] * lag);
    }
  }

  if (T[31] > 0.001) {
    const low = sstep(0.42, 0.22, hn);
    if (low > 0.001) {
      const cell = 900;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let best = 9;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const ci = gx + i, cj = gy + j;
          if (hf(ci, cj, 105) > 0.42) continue;
          cellPt(ci, cj, cell, 106);
          const r = 60 + 80 * hf(ci, cj, 108);
          best = Math.min(best, len(px - CPX, py - CPY) / r);
        }
      }
      const pm = sstep(1, 0.85, best);
      const rim = sstep(1.3, 1, best) * sstep(0.85, 1, best);
      h += T[31] * low * (rim * 0.6 - pm * 1.5);
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
