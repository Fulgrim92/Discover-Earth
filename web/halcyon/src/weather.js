// weather.js (sky programmer, DESIGN 12.1): the CPU mirror of the weather field in common.wgsl (wxCell, rainAt),
// evaluated at the camera once a frame for the sound and the near-camera rain, plus the lightning schedule.
// Deterministic from position and time only; allocation-free (inputs and outputs are typed arrays).
//
// The field: cells of clear sky, building cumulus, rain squalls (and fog banks on their own field) drifting with
// the planet's one wind. What falls under a squall depends on the realm: rain (Home, Mirror, Stone), virga that
// never reaches the ground (Painted), snow (Ice), spores (Lumen).

import { hu8, W_ID, W_W } from './realms.js';

const WIND_X = 4.2, WIND_Z = 1.7; // m/s, common.wgsl CLOUD_WIND
const OFS_X = 1448825, OFS_Z = -259896; // common.wgsl WX_OFS
// per realm id: liquid rain on the ground, visible precipitation, kind (0 rain, 1 virga, 2 snow, 3 spores)
export const WX_LIQUID = new Float64Array([1.0, 0.0, 0.55, 0.85, 0.0, 0.0, 1.0, 0.0, 0.8]); // + wave 1 (terrain-art placeholder; sky owns)
export const WX_PRECIP = new Float64Array([1.0, 0.7, 0.55, 0.85, 0.85, 0.7, 1.0, 0.6, 0.85]);
export const WX_KIND = new Int32Array([0, 1, 0, 0, 2, 3, 0, 1, 0]);

// inputs: camera x, z, time (s). Outputs: WX_CAM = liquid rain, precipitation, kind, fog bank (all at the camera);
// WX_BOLT = lightning x, z, intensity (0 when none), seconds into the flash
export const WX_IN = new Float64Array(3);
export const WX_CAM = new Float64Array(4);
export const WX_BOLT = new Float32Array(4);
// a pinned squall (main.js, URL wx=): centre x, z, radius (0 = none); [3] is set by wxTick: 1 when any squall lies
// within 16 km of the camera (FR.wxp.w: the shaders skip all rain work without one)
export const WX_PIN = new Float64Array(4);
const S = new Float64Array(8);

function sstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
// value noise exactly as common.wgsl vnoised().x; result in S[7] (no double crosses a call boundary as a return)
function vn(s) { // reads S[5], S[6] as x, y
  const x = S[5], y = S[6];
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = (hu8(ix, iy, s) * (1 / 16777216)) * 2 - 1, b = (hu8(ix + 1, iy, s) * (1 / 16777216)) * 2 - 1, c = (hu8(ix, iy + 1, s) * (1 / 16777216)) * 2 - 1, d = (hu8(ix + 1, iy + 1, s) * (1 / 16777216)) * 2 - 1;
  S[7] = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
// wxCell at (S[0], S[1]) and time S[2] into S[3]
function cell() {
  const qx = S[0] - WIND_X * S[2] + OFS_X, qz = S[1] - WIND_Z * S[2] + OFS_Z;
  S[5] = qx / 16000; S[6] = qz / 16000; vn(720); const a = S[7];
  S[5] = qx / 5200; S[6] = qz / 5200; vn(721);
  S[3] = a * 0.72 + S[7] * 0.28;
  if (WX_PIN[2] > 0) {
    const ex = (S[0] - WX_PIN[0]) / WX_PIN[2], ez = (S[1] - WX_PIN[1]) / WX_PIN[2];
    S[3] = Math.max(S[3], 1 - 0.9 * (ex * ex + ez * ez));
  }
}

// after realms.js realmWeightsA() ran at the camera (main.js prepareFrame: blendAtA)
export function wxTick() {
  S[0] = WX_IN[0]; S[1] = WX_IN[1]; S[2] = WX_IN[2];
  cell();
  const st = sstep(0.40, 0.62, S[3]);
  let liq = 0, pre = 0, kind = 0, kw = 0;
  for (let i = 0; i < 4; i++) {
    const id = W_ID[i];
    if (id < 0) continue;
    liq += W_W[i] * WX_LIQUID[id]; pre += W_W[i] * WX_PRECIP[id];
    if (W_W[i] > kw) { kw = W_W[i]; kind = WX_KIND[id]; }
  }
  // any squall within 16 km (a 9x9 grid of 4 km; cells are 3-8 km across)? Checked every 8th frame-call is enough
  // but it is 81 cheap evaluations, so every call
  let near = 0;
  for (let i = -4; i <= 4 && near === 0; i++) for (let j = -4; j <= 4; j++) {
    S[0] = WX_IN[0] + i * 4000; S[1] = WX_IN[1] + j * 4000; cell();
    if (S[3] > 0.33) { near = 1; break; }
  }
  WX_PIN[3] = near;
  WX_CAM[0] = st * liq; WX_CAM[1] = kind === 1 ? 0 : st * pre; WX_CAM[2] = kind;
  const fq = WX_IN[2] * 0.5;
  S[5] = (WX_IN[0] - WIND_X * fq) / 5200 + 427; S[6] = (WX_IN[1] - WIND_Z * fq) / 5200 + 303; vn(730);
  WX_CAM[3] = sstep(0.72, 0.92, S[7]);
  // lightning: every 5 s one candidate strike somewhere within 14 km; it fires only inside a squall cell
  const slot = Math.floor(WX_IN[2] / 5);
  const into = WX_IN[2] - slot * 5;
  S[0] = Math.round(WX_IN[0] / 1000) * 1000 + ((hu8(slot, 3, 950) * (1 / 16777216)) - 0.5) * 28000;
  S[1] = Math.round(WX_IN[1] / 1000) * 1000 + ((hu8(slot, 4, 951) * (1 / 16777216)) - 0.5) * 28000;
  cell();
  const go = (hu8(slot, 5, 952) * (1 / 16777216)) < 0.7 ? sstep(0.45, 0.7, S[3]) : 0;
  // a flash with a second, weaker return stroke; 0.45 s in all
  const env = into < 0.08 ? 1 : into < 0.16 ? 0.25 : into < 0.24 ? 0.7 : Math.max(0, 1 - (into - 0.24) / 0.2) * 0.3;
  WX_BOLT[0] = S[0]; WX_BOLT[1] = S[1]; WX_BOLT[2] = go * env; WX_BOLT[3] = into;
}
