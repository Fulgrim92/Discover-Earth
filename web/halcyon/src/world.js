// world.js: CPU mirror of terrfn.wgsl (height path only). Alloc-free: numbers in, numbers out.
// Hot-path calling convention: the noise helpers take their coordinates and return their results through small
// Float64Array scratch slots and only small integers cross function boundaries. V8 boxes every double passed to or
// returned from a function it does not inline, and heightAt is far too big to inline its helpers, so with plain
// double arguments it allocated ~400 bytes per call on the sim's frame path. Results are bit-identical.
import { hu8, realmWeightsA, W_IN, blendFields, blendAt as blendRow, blendAtA, ROWF, W_NEAR } from './realms.js';

export { W_NEAR };

// blended terrain fields T0..T8 (9 vec4) in scratch
const T = new Float64Array(36);

// smoothstep through scratch: SX = [e0, e1, x] -> SX[3] (a call with no double arguments or result: nothing to box
// whether or not V8 inlines it)
const SX = new Float64Array(4);
function sstepA() {
  const e0 = SX[0], e1 = SX[1];
  let t = (SX[2] - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  SX[3] = t * t * (3 - 2 * t);
}

// value noise with derivatives at (NI[0], NI[1]) -> N3 = [value, d/dx, d/dy]
const NI = new Float64Array(2);
const N3 = new Float64Array(3);
function vnoised(s) {
  const px = NI[0], py = NI[1];
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1), duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hu8(ix, iy, s) * (1 / 16777216) * 2 - 1, b = hu8(ix + 1, iy, s) * (1 / 16777216) * 2 - 1;
  const c = hu8(ix, iy + 1, s) * (1 / 16777216) * 2 - 1, d = hu8(ix + 1, iy + 1, s) * (1 / 16777216) * 2 - 1;
  const k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  N3[0] = a + k1 * ux + k2 * uy + k3 * ux * uy;
  N3[1] = dux * (k1 + k3 * uy);
  N3[2] = duy * (k2 + k3 * ux);
}

// fbm family: start point in NI, result in FB[0] (efbm reads its erosion from FB[1])
const FB = new Float64Array(2);
function fbm(oct, seed) {
  let qx = NI[0], qy = NI[1], a = 0.5, s = 0;
  for (let o = 0; o < oct; o++) {
    NI[0] = qx; NI[1] = qy; vnoised(seed + o);
    s += a * N3[0]; a *= 0.5;
    const nx = (0.8 * qx - 0.6 * qy) * 2.03; qy = (0.6 * qx + 0.8 * qy) * 2.03; qx = nx;
  }
  FB[0] = s;
}
function efbm(oct, seed) {
  const eros = FB[1];
  let qx = NI[0], qy = NI[1], a = 0.5, s = 0, dx = 0, dy = 0;
  for (let o = 0; o < oct; o++) {
    NI[0] = qx; NI[1] = qy; vnoised(seed + o);
    const n = N3[0];
    dx += N3[1]; dy += N3[2];
    s += a * n / (1 + eros * (dx * dx + dy * dy));
    a *= 0.5;
    const nx = (0.8 * qx - 0.6 * qy) * 2.03; qy = (0.6 * qx + 0.8 * qy) * 2.03; qx = nx;
  }
  FB[0] = s;
}
function rfbm(oct, seed) {
  let qx = NI[0], qy = NI[1], a = 0.5, s = 0, w = 1;
  for (let o = 0; o < oct; o++) {
    NI[0] = qx; NI[1] = qy; vnoised(seed + o);
    let n = 1 - Math.abs(N3[0]);
    n = n * n * w;
    w = n * 2; w = w < 0 ? 0 : w > 1 ? 1 : w;
    s += n * a; a *= 0.5;
    const nx = (0.8 * qx - 0.6 * qy) * 2.03; qy = (0.6 * qx + 0.8 * qy) * 2.03; qx = nx;
  }
  FB[0] = s;
}
// terrace: TR = [h, step, sharpness] in, TR[3] out
const TR = new Float64Array(4);
function terrace() {
  const h = TR[0], st = TR[1], sharp = TR[2];
  const x = h / st, fl = Math.floor(x), fr = x - fl;
  TR[3] = st * (fl + (SX[2] = fr, SX[0] = sharp, SX[1] = 1, sstepA(), SX[3]));
}
// lattice point of cell (ci, cj) with cell size CP[2] -> CP[0], CP[1]
const CP = new Float64Array(3);
function cellPt(ci, cj, s) {
  const cell = CP[2];
  CP[0] = (ci + 0.2 + 0.6 * (hu8(ci, cj, s) * (1 / 16777216))) * cell;
  CP[1] = (cj + 0.2 + 0.6 * (hu8(ci, cj, s + 1) * (1 / 16777216))) * cell;
}
// strata surface offset (terrfn.wgsl strataTilt). Inlined in heightCore; this wrapper is for other callers.
export function strataTilt(px, py) {
  return 0.035 * (px * 0.83 + py * 0.55) + 80 * (NI[0] = px * (1 / 1900), NI[1] = py * (1 / 1900), vnoised(34), N3[0]) + 18 * (NI[0] = px * (1 / 560), NI[1] = py * (1 / 560), vnoised(35), N3[0]);
}
// pillar cluster strength (terrfn.wgsl pillarCluster): PC = [qx, qy] -> PC[2]
const PC = new Float64Array(3);
function pillarCluster() {
  const qx = PC[0], qy = PC[1];
  const a = (NI[0] = qx * (1 / 760), NI[1] = qy * (1 / 760), vnoised(140), N3[0]) + 0.5 * (NI[0] = qx * (1 / 270), NI[1] = qy * (1 / 270), vnoised(141), N3[0]);
  const rg = 1 - Math.abs((NI[0] = qx * (1 / 1300) + 4.1, NI[1] = qy * (1 / 1300) + 2.7, vnoised(142), N3[0]));
  PC[2] = Math.max((SX[2] = a, SX[0] = 0.05, SX[1] = 0.5, sstepA(), SX[3]), (SX[2] = rg, SX[0] = 0.86, SX[1] = 0.97, sstepA(), SX[3]) * (SX[2] = a, SX[0] = -0.45, SX[1] = -0.1, sstepA(), SX[3]) * 0.8);
}
// rounded tree crowns (terrfn.wgsl crowns): CR = [px, py] -> CR[2]
const CR = new Float64Array(3);
function crowns() {
  const px = CR[0], py = CR[1];
  const c = 5.5;
  const gx = Math.floor(px / c), gy = Math.floor(py / c);
  let m = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ci = gx + i, cj = gy + j;
      CP[2] = c; cellPt(ci, cj, 160);
      const r = c * (0.62 + 0.35 * (hu8(ci, cj, 162) * (1 / 16777216)));
      const d = Math.sqrt((px - CP[0]) * (px - CP[0]) + (py - CP[1]) * (py - CP[1])) / r;
      const k = Math.max(0, 1 - d * d);
      m = Math.max(m, Math.sqrt(k) * (2.2 + 2.6 * (hu8(ci, cj, 163) * (1 / 16777216))));
    }
  }
  CR[2] = m;
}
// hexagon frame distance (terrfn.wgsl hexD): HX = [vx, vy] -> HX[2]
const HX = new Float64Array(3);
function hexD(ci, cj) {
  const vx = HX[0], vy = HX[1];
  let ux = (hu8(ci, cj, 97) * (1 / 16777216)) - 0.5 + 1e-3, uy = (hu8(ci, cj, 98) * (1 / 16777216)) - 0.5;
  const ul = Math.sqrt(ux * ux + uy * uy); ux /= ul; uy /= ul;
  const ax = Math.abs(vx * ux + vy * uy), ay = Math.abs(vy * ux - vx * uy);
  HX[2] = Math.max(ax * 0.8660254 + ay * 0.5, ay) * 1.1547005;
}

// Terrain height (m) at world (x, z). Matches the GPU bake to centimetres.
// heightCore: (HQ[0], HQ[1]) -> HQ[2], split into per-feature sections so each stays small enough for V8 to
// inline its helpers (one huge function ran out of inlining budget and boxed every sstep/len result); heightAt is
// the convenient (boxing) wrapper for cold callers.
const HQ = new Float64Array(4); // x, z -> height; [3] = base noise hn for the sections
export function heightAt(x, z) { HQ[0] = x; HQ[1] = z; heightCore(); return HQ[2]; }
function sec16() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[16] > 0.001) {
    const cell = T[17];
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    const wob = 0.05 * (NI[0] = px * (1 / 13), NI[1] = py * (1 / 13), vnoised(61), N3[0]) + 0.03 * (NI[0] = px * (1 / 4.5), NI[1] = py * (1 / 4.5), vnoised(62), N3[0]);
    let best = 0, bf1 = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        CP[2] = cell; cellPt(ci, cj, 64);
        const ptx = CP[0], pty = CP[1];
        const clu = (PC[0] = ptx, PC[1] = pty, pillarCluster(), PC[2]);
        if ((hu8(ci, cj, 63) * (1 / 16777216)) > 0.04 + 0.9 * clu) continue;
        const giant = (hu8(ci, cj, 70) * (1 / 16777216)) < 0.07 ? 1.35 : 1;
        const rb = T[19] * cell * (0.55 + 0.55 * (hu8(ci, cj, 66) * (1 / 16777216))) * (0.8 + 0.3 * clu) * giant;
        const ht = Math.min(T[18] * (0.25 + 0.75 * clu) * (0.7 + 0.45 * (hu8(ci, cj, 67) * (1 / 16777216))) * giant, rb * 14);
        const rt = rb - Math.max(rb * (0.15 + 0.25 * (hu8(ci, cj, 68) * (1 / 16777216))), ht * (1 / 45));
        const lx = ((hu8(ci, cj, 69) * (1 / 16777216)) - 0.5) * 0.7 * (rb - rt), ly = ((hu8(ci, cj, 71) * (1 / 16777216)) - 0.5) * 0.7 * (rb - rt);
        const dvx = px - ptx, dvy = py - pty;
        const dl = Math.sqrt(dvx * dvx + dvy * dvy);
        const dm = Math.max(dl, 1e-3);
        const dx = dvx / dm, dy = dvy / dm;
        const flute = 0.045 * (NI[0] = dx * 5 + (ci & 63) * 7, NI[1] = dy * 5 + (cj & 63) * 7, vnoised(72), N3[0]) + 0.02 * (NI[0] = dx * 13, NI[1] = dy * 13, vnoised(73), N3[0]) + wob;
        const db = dl / rb + flute;
        if (db >= 1) continue;
        const dt = Math.sqrt((dvx - lx) * (dvx - lx) + (dvy - ly) * (dvy - ly)) / rt + flute;
        let f = 1;
        if (dt > 1) f = (1 - db) / Math.max((1 - db) + (dt - 1), 1e-4);
        let v = ht * f;
        const lst = 26 + 10 * (hu8(ci, cj, 74) * (1 / 16777216));
        const tw = 0.4 * (SX[2] = f, SX[0] = 0.02, SX[1] = 0.3, sstepA(), SX[3]) * (SX[2] = f, SX[0] = 0.995, SX[1] = 0.9, sstepA(), SX[3]);
        v = (v * (1 - tw) + ((TR[0] = v, TR[1] = lst, TR[2] = 0.6, terrace(), TR[3])) * tw);
        if (v > best) { best = v; bf1 = f; }
      }
    }
    const top = (SX[2] = bf1, SX[0] = 0.93, SX[1] = 1, sstepA(), SX[3]) * (SX[2] = best, SX[0] = 1, SX[1] = 20, sstepA(), SX[3]);
    let can = 0;
    if (top > 0.001) can = (CR[0] = px, CR[1] = py, crowns(), CR[2]) * top;
    h += T[16] * (best + can);
  }
  HQ[2] = h;
}

function sec20() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[20] > 0.001) h = (h * (1 - T[20]) + T[21] * T[20]);
  HQ[2] = h;
}

function sec22() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[22] > 0.001) {
    const cell = 1900;
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let cm = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        if ((hu8(ci, cj, 71) * (1 / 16777216)) > 0.42) continue;
        CP[2] = cell; cellPt(ci, cj, 72);
        const r = 380 + 420 * (hu8(ci, cj, 74) * (1 / 16777216));
        const d = Math.sqrt((px - CP[0]) * (px - CP[0]) + (py - CP[1]) * (py - CP[1])) / r;
        const k = Math.max(0, 1 - d);
        let c = T[23] * (0.3 + 0.7 * (hu8(ci, cj, 75) * (1 / 16777216))) * Math.pow(k, 1.7);
        c -= T[23] * 0.05 * (SX[2] = d, SX[0] = 0.12, SX[1] = 0, sstepA(), SX[3]);
        cm = Math.max(cm, c);
      }
    }
    cm *= 1 + 0.14 * (NI[0] = px * (1 / 55), NI[1] = py * (1 / 55), vnoised(76), N3[0]);
    if (cm > 0.05) {
      const rqx = px * (1 / 140) + 0.35 * (NI[0] = px * (1 / 330), NI[1] = py * (1 / 330), vnoised(77), N3[0]);
      const rqy = py * (1 / 140) + 0.35 * (NI[0] = px * (1 / 330) + 5, NI[1] = py * (1 / 330) + 3, vnoised(78), N3[0]);
      const rg = (NI[0] = rqx, NI[1] = rqy, rfbm(4, 150), FB[0]);
      cm += (rg - 0.42) * 46 * (SX[2] = cm, SX[0] = 0.5, SX[1] = 70, sstepA(), SX[3]) + 3 * (NI[0] = px * (1 / 17), NI[1] = py * (1 / 17), fbm(2, 155), FB[0]) * (SX[2] = cm, SX[0] = 0.2, SX[1] = 6, sstepA(), SX[3]);
      cm = Math.max(cm, 0);
    }
    h += T[22] * cm;
  }
  HQ[2] = h;
}

function sec24() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[24] > 0.001) {
    const w = 2 * (NI[0] = px * (1 / 700), NI[1] = py * (1 / 700), vnoised(77), N3[0]);
    const x2 = (px * 0.9 + py * 0.45) * (1 / 160) + w;
    const f = x2 - Math.floor(x2);
    const prof = (SX[2] = f, SX[0] = 0, SX[1] = 0.78, sstepA(), SX[3]) * (SX[2] = f, SX[0] = 1, SX[1] = 0.8, sstepA(), SX[3]);
    h += T[24] * T[25] * prof * (0.6 + 0.4 * (NI[0] = px * (1 / 400), NI[1] = py * (1 / 400), vnoised(78), N3[0]));
  }
  HQ[2] = h;
}

function sec26() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[26] > 0.001) {
    const cell = 1100;
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let bm = 0;
    const wob = 0.15 * (NI[0] = px * (1 / 60), NI[1] = py * (1 / 60), vnoised(81), N3[0]);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        if ((hu8(ci, cj, 82) * (1 / 16777216)) > 0.5) continue;
        CP[2] = cell; cellPt(ci, cj, 83);
        const r = 90 + 150 * (hu8(ci, cj, 85) * (1 / 16777216));
        const d = Math.sqrt((px - CP[0]) * (px - CP[0]) + (py - CP[1]) * (py - CP[1])) / r + wob;
        bm = Math.max(bm, (SX[2] = d, SX[0] = 1, SX[1] = 0.3, sstepA(), SX[3]));
      }
    }
    h = (h * (1 - (T[26] * bm)) + (-T[27]) * (T[26] * bm));
  }
  HQ[2] = h;
}

function sec32() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[32] > 0.001) {
    const cell = T[33];
    const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
    let cm = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ci = gx + i, cj = gy + j;
        CP[2] = cell; cellPt(ci, cj, 92);
        const ptx = CP[0], pty = CP[1];
        const cl = (SX[2] = (NI[0] = ptx * (1 / 420), NI[1] = pty * (1 / 420), vnoised(93), N3[0]), SX[0] = 0.05, SX[1] = 0.45, sstepA(), SX[3]);
        if ((hu8(ci, cj, 91) * (1 / 16777216)) > 0.03 + 0.75 * cl) continue;
        const spire = (hu8(ci, cj, 96) * (1 / 16777216)) < 0.12 * cl ? 2 : 1;
        const r = (2.5 + 4.5 * (hu8(ci, cj, 94) * (1 / 16777216))) * spire;
        const k = 1 - (HX[0] = px - ptx, HX[1] = py - pty, hexD(ci, cj), HX[2]) / r;
        if (k <= 0) continue;
        const H = T[34] * (0.25 + 0.75 * (hu8(ci, cj, 95) * (1 / 16777216))) * (0.4 + 0.6 * cl) * spire * spire;
        const c = H * Math.min(k * 2.8, 0.7 + (k - 0.25) * 0.4);
        if (c > cm) cm = c;
      }
    }
    h += T[32] * cm;
  }
  HQ[2] = h;
}

function sec28() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  const glac = (SX[2] = h, SX[0] = 50, SX[1] = 130, sstepA(), SX[3]) * T[29];
  if (T[28] > 0.001 && glac > 0.001) {
    const ax = px * (1 / 900), ay = py * (1 / 900);
    const cqx = px * (1 / 240) + 0.7 * (NI[0] = ax, NI[1] = ay, vnoised(86), N3[0]), cqy = py * (1 / 240) + 0.7 * (NI[0] = ax + 3, NI[1] = ay + 1, vnoised(87), N3[0]);
    const c1 = 1 - (SX[2] = Math.abs((NI[0] = cqx, NI[1] = cqy, vnoised(88), N3[0])), SX[0] = 0, SX[1] = 0.018, sstepA(), SX[3]);
    const c2 = 1 - (SX[2] = Math.abs((NI[0] = cqx * 2.3 + 1.7, NI[1] = cqy * 2.3 + 4.1, vnoised(89), N3[0])), SX[0] = 0, SX[1] = 0.022, sstepA(), SX[3]);
    const cr = Math.max(c1, c2 * 0.8) * glac;
    h -= T[28] * cr * 14;
  }
  HQ[2] = h;
}

function sec30() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  if (T[30] > 0.001) {
    const lag = (SX[2] = h, SX[0] = -1.5, SX[1] = -6, sstepA(), SX[3]);
    if (lag > 0.001) {
      const cell = 70;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let bh = -100;
      const wob = 0.06 * (NI[0] = px * (1 / 9), NI[1] = py * (1 / 9), vnoised(96), N3[0]);
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const ci = gx + i, cj = gy + j;
          if ((hu8(ci, cj, 97) * (1 / 16777216)) > 0.3) continue;
          CP[2] = cell; cellPt(ci, cj, 98);
          const r = 9 + 16 * (hu8(ci, cj, 100) * (1 / 16777216));
          const d = (HX[0] = px - CP[0], HX[1] = py - CP[1], hexD(ci, cj + 7), HX[2]) / r + wob;
          const tilt = ((px - CP[0]) * ((hu8(ci, cj, 101) * (1 / 16777216)) - 0.5) + (py - CP[1]) * ((hu8(ci, cj, 102) * (1 / 16777216)) - 0.5)) * 0.18;
          let b = (1 - d) * 3.5; b = b < 0 ? 0 : b > 1 ? 1 : b;
          const ht = 1.5 + 8 * (hu8(ci, cj, 104) * (1 / 16777216)) + tilt;
          const shelf = -1.4 - 4 * Math.max(d - 1, 0);
          const top = ht * b + shelf * (1 - b);
          if (top > bh) bh = top;
        }
      }
      h = (h * (1 - (T[30] * lag)) + (Math.max(h, bh)) * (T[30] * lag));
    }
  }
  HQ[2] = h;
}

function sec31() {
  const px = HQ[0], py = HQ[1];
  let h = HQ[2];
  const hn = HQ[3];
  if (T[31] > 0.001) {
    const low = (SX[2] = hn, SX[0] = 0.42, SX[1] = 0.22, sstepA(), SX[3]);
    if (low > 0.001) {
      const cell = 900;
      const gx = Math.floor(px / cell), gy = Math.floor(py / cell);
      let best = 9;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const ci = gx + i, cj = gy + j;
          if ((hu8(ci, cj, 105) * (1 / 16777216)) > 0.42) continue;
          CP[2] = cell; cellPt(ci, cj, 106);
          const r = 60 + 80 * (hu8(ci, cj, 108) * (1 / 16777216));
          best = Math.min(best, Math.sqrt((px - CP[0]) * (px - CP[0]) + (py - CP[1]) * (py - CP[1])) / r);
        }
      }
      const pm = (SX[2] = best, SX[0] = 1, SX[1] = 0.85, sstepA(), SX[3]);
      const rim = (SX[2] = best, SX[0] = 1.3, SX[1] = 1, sstepA(), SX[3]) * (SX[2] = best, SX[0] = 0.85, SX[1] = 1, sstepA(), SX[3]);
      h += T[31] * low * (rim * 0.6 - pm * 1.5);
    }
  }
  HQ[2] = h;
}

function heightCore() {
  const x = HQ[0], z = HQ[1];
  W_IN[0] = x; W_IN[1] = z; realmWeightsA();
  blendFields(T, 0, 0, 9);
  const px = x, py = z;
  const freq = T[0];
  const wqx = px * (freq * 0.5), wqy = py * (freq * 0.5);
  const qx = px + T[3] * (NI[0] = wqx, NI[1] = wqy, vnoised(11), N3[0]), qy = py + T[3] * (NI[0] = wqx + 5.2, NI[1] = wqy + 1.3, vnoised(12), N3[0]);
  const qfx = qx * freq, qfy = qy * freq;
  let hn = (NI[0] = qfx, NI[1] = qfy, FB[1] = T[5], efbm(7, 20), FB[0]) * 0.75 + 0.5;
  if (T[4] > 0.001) hn = (hn * (1 - T[4]) + ((NI[0] = qfx * 1.1 + 3.7, NI[1] = qfy * 1.1 + 9.1, rfbm(5, 40), FB[0])) * T[4]);
  hn = hn < 0 ? 0 : hn > 1 ? 1 : hn;
  let h = Math.pow(Math.max(hn, 1e-6), T[7]) * T[1];
  if (T[8] > 0.001) {
    const vqx = qx * (freq * T[11]), vqy = qy * (freq * T[11]);
    const v = Math.abs((NI[0] = vqx, NI[1] = vqy, vnoised(21), N3[0])) + 0.35 * Math.abs((NI[0] = vqx * 2.7 + 3.1, NI[1] = vqy * 2.7 + 7.7, vnoised(22), N3[0]));
    const u = (SX[2] = v, SX[0] = 0, SX[1] = T[9], sstepA(), SX[3]);
    h = (h * (1 - T[8]) + (h * u - T[10] * (1 - u)) * T[8]);
  }
  h += T[2];
  if (T[35] > 0.001) h += T[35] * (SX[2] = h + 14 * (NI[0] = px * (1 / 260), NI[1] = py * (1 / 260), vnoised(33), N3[0]), SX[0] = -4, SX[1] = 22, sstepA(), SX[3]);
  if (T[12] > 0.001) {
    const j = 0.035 * (px * 0.83 + py * 0.55) + 80 * (NI[0] = px * (1 / 1900), NI[1] = py * (1 / 1900), vnoised(34), N3[0]) + 18 * (NI[0] = px * (1 / 560), NI[1] = py * (1 / 560), vnoised(35), N3[0]);
    const s1 = h - j;
    const k = Math.floor(s1 / T[13]);
    const hs = (TR[0] = s1, TR[1] = T[13], TR[2] = 0.3 + 0.45 * (hu8(k, 17, 33) * (1 / 16777216)), terrace(), TR[3]);
    const hs2 = (TR[0] = hs, TR[1] = T[13] * 0.29, TR[2] = 0.6, terrace(), TR[3]);
    h = (h * (1 - T[12]) + ((hs * (1 - 0.45) + hs2 * 0.45) + j) * T[12]);
  }
  if (T[14] > 0.001) {
    const j = 4 * (NI[0] = px * (1 / 90), NI[1] = py * (1 / 90), vnoised(32), N3[0]);
    h = (h * (1 - T[14]) + ((TR[0] = h + j, TR[1] = T[15], TR[2] = 0.72, terrace(), TR[3]) - j) * T[14]);
  }
  if (T[6] > 0.001) h += T[6] * (NI[0] = px * (1 / 48), NI[1] = py * (1 / 48), fbm(4, 50), FB[0]);
  HQ[2] = h; HQ[3] = hn;
  sec16();
  sec20();
  sec22();
  sec24();
  sec26();
  sec32();
  sec28();
  sec30();
  sec31();
}

// Full blended realm row at (x, z) into outRow (Float32Array of ROWF). W_NEAR then holds the nearest site.
export function blendAt(x, z, outRow) { return blendRow(x, z, outRow); }
// the same without double arguments: (W_IN[0], W_IN[1]) = (x, z)
export { blendAtA, W_IN };
export { ROWF };

// Batched heights for the sim: xz = [x0,z0, x1,z1, ...] (n pairs) -> out[i]. Alloc-free.
export function heightBatch(xz, n, out) {
  for (let i = 0; i < n; i++) { HQ[0] = xz[i * 2]; HQ[1] = xz[i * 2 + 1]; heightCore(); out[i] = HQ[2]; }
  return out;
}
export { CURATED } from './realms.js';
