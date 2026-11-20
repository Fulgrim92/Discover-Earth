// weather.js (sky programmer, DESIGN 12.1): the CPU mirror of the weather field in common.wgsl (wxCell, rainAt),
// evaluated at the camera once a frame for the sound and the near-camera rain, plus the lightning schedule.
// Deterministic from position and time only; allocation-free (inputs and outputs are typed arrays).
//
// The field: cells of clear sky, building cumulus, rain squalls (and fog banks on their own field) drifting with
// the planet's one wind. What falls under a squall depends on the realm: rain (Home, Mirror, Stone), virga that
// never reaches the ground (Painted), snow (Ice), spores (Lumen).

import { hf, W_ID, W_W } from './realms.js';

const WIND_X = 4.2, WIND_Z = 1.7; // m/s, common.wgsl CLOUD_WIND
const OFS_X = -12644, OFS_Z = 110304; // common.wgsl WX_OFS
// per realm id: liquid rain on the ground, visible precipitation, kind (0 rain, 1 virga, 2 snow, 3 spores)
export const WX_LIQUID = new Float64Array([1.0, 0.0, 0.55, 0.85, 0.0, 0.0]);
export const WX_PRECIP = new Float64Array([1.0, 0.7, 0.55, 0.85, 0.85, 0.7]);
export const WX_KIND = new Int32Array([0, 1, 0, 0, 2, 3]);

// inputs: camera x, z, time (s). Outputs: WX_CAM = liquid rain, precipitation, kind, fog bank (all at the camera);
// WX_BOLT = lightning x, z, intensity (0 when none), seconds into the flash
export const WX_IN = new Float64Array(3);
export const WX_CAM = new Float64Array(4);
export const WX_BOLT = new Float32Array(4);
const S = new Float64Array(8);

function sstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
// value noise exactly as common.wgsl vnoised().x; result in S[7] (no double crosses a call boundary as a return)
function vn(s) { // reads S[5], S[6] as x, y
  const x = S[5], y = S[6];
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hf(ix, iy, s) * 2 - 1, b = hf(ix + 1, iy, s) * 2 - 1, c = hf(ix, iy + 1, s) * 2 - 1, d = hf(ix + 1, iy + 1, s) * 2 - 1;
  S[7] = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
// wxCell at (S[0], S[1]) and time S[2] into S[3]
function cell() {
  const qx = S[0] - WIND_X * S[2] + OFS_X, qz = S[1] - WIND_Z * S[2] + OFS_Z;
  S[5] = qx / 6500; S[6] = qz / 6500; vn(720); const a = S[7];
  S[5] = qx / 2300; S[6] = qz / 2300; vn(721);
  S[3] = a * 0.65 + S[7] * 0.35;
}

// after realms.js realmWeightsA() ran at the camera (main.js prepareFrame: blendAtA)
export function wxTick() {
  S[0] = WX_IN[0]; S[1] = WX_IN[1]; S[2] = WX_IN[2];
  cell();
  const st = sstep(0.28, 0.58, S[3]);
  let liq = 0, pre = 0, kind = 0, kw = 0;
  for (let i = 0; i < 4; i++) {
    const id = W_ID[i];
    if (id < 0) continue;
    liq += W_W[i] * WX_LIQUID[id]; pre += W_W[i] * WX_PRECIP[id];
    if (W_W[i] > kw) { kw = W_W[i]; kind = WX_KIND[id]; }
  }
  WX_CAM[0] = st * liq; WX_CAM[1] = kind === 1 ? 0 : st * pre; WX_CAM[2] = kind;
  const fq = WX_IN[2] * 0.5;
  S[5] = (WX_IN[0] - WIND_X * fq) / 5200 + 40; S[6] = (WX_IN[1] - WIND_Z * fq) / 5200 - 7; vn(730);
  WX_CAM[3] = sstep(0.3, 0.62, S[7]);
  // lightning: every 5 s one candidate strike somewhere within 14 km; it fires only inside a squall cell
  const slot = Math.floor(WX_IN[2] / 5);
  const into = WX_IN[2] - slot * 5;
  S[0] = Math.round(WX_IN[0] / 1000) * 1000 + (hf(slot, 3, 950) - 0.5) * 28000;
  S[1] = Math.round(WX_IN[1] / 1000) * 1000 + (hf(slot, 4, 951) - 0.5) * 28000;
  cell();
  const go = hf(slot, 5, 952) < 0.7 ? sstep(0.45, 0.7, S[3]) : 0;
  // a flash with a second, weaker return stroke; 0.45 s in all
  const env = into < 0.08 ? 1 : into < 0.16 ? 0.25 : into < 0.24 ? 0.7 : Math.max(0, 1 - (into - 0.24) / 0.2) * 0.3;
  WX_BOLT[0] = S[0]; WX_BOLT[1] = S[1]; WX_BOLT[2] = go * env; WX_BOLT[3] = into;
}
