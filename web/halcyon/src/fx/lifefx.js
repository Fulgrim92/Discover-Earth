// fx/lifefx.js: the living world's share of encounters and the water-side ripple hook (layout in lifefx.wgsl).
// Until integration's src/encounters.js director exists, slots come from a local stub: `?enc=<type>&et=<seconds>`
// places one encounter ahead of the camera, `et` seconds in (for captures). Ripple sources are recomputed every frame
// from the same closed-form actor motion the shaders use (orca surfacings, whale breach, flamingo take-off), so
// they need no history. Allocation-free per frame.
import { G, bgl, bindGroup, buffer, FO, VO } from '../gpu.js';

export const TYPES = ['', 'orca', 'murmuration', 'flamingo', 'breach', 'jelly', 'giants'];
const DUR = new Float32Array([0, 110, 70, 40, 45, 60, 240]);
const DIST = new Float32Array([0, 120, 260, 70, 150, 110, 1400]);
export const ENC = new Float32Array(32);   // 8 slots x 2 vec4 (see lifefx.wgsl)
export const DIR = new Float32Array(16);   // per slot travel direction x, z (CPU side, for actors)
const RIP = new Float32Array(64);
const IMG = new Float32Array(128);
const S = new Float64Array(2); S[0] = -1; // [0] stub: encounter start time (-1 = not placed yet)
export const lifeFx = { buf: null, bgl: null, bg: null };
let stubType = 0, stubEt = 0;

export function init() {
  lifeFx.buf = buffer(512, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'lifefx');
  lifeFx.bgl = bgl('u', 'lifefx');
  lifeFx.bg = bindGroup(lifeFx.bgl, [lifeFx.buf], 'lifefx');
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search), e = q.get('enc');
    if (e) { stubType = TYPES.indexOf(e) > 0 ? TYPES.indexOf(e) : +e | 0; stubEt = +(q.get('et') || 0); }
  }
}


export function update(ctx, view) {
  const t = ctx.frame[FO.time], d = view.data;
  if (stubType && S[0] < 0) {
    // place the stub encounter ahead of the camera, crossing the view
    S[0] = t - stubEt;
    const fx = d[VO.fwd], fz = d[VO.fwd + 2], l = Math.hypot(fx, fz) + 1e-6;
    const D = DIST[stubType];
    ENC[0] = stubType; ENC[1] = d[VO.cam] + fx / l * D; ENC[2] = d[VO.cam + 1]; ENC[3] = d[VO.cam + 2] + fz / l * D;
    ENC[4] = S[0]; ENC[5] = DUR[stubType]; ENC[6] = 1; ENC[7] = 1;
    // orcas come toward and under the drone; giants and whales cross the view
    if (stubType === 1) { DIR[0] = -fx / l; DIR[1] = -fz / l; } else { DIR[0] = -fz / l; DIR[1] = fx / l; }
  }
  RIP.fill(0);
  let n = 0;
  for (let s = 0; s < 8 && n < 16; s++) {
    const ty = ENC[s * 8], t0 = ENC[s * 8 + 4], rel = t - t0;
    if (!ty || rel < 0 || rel > ENC[s * 8 + 5] + 14) continue;
    const hx = ENC[s * 8 + 1], hz = ENC[s * 8 + 3], dx = DIR[s * 2], dz = DIR[s * 2 + 1];
    if (ty === 1) {
      // orcas: the latest surfacing of each of 5 (mirrors herd.wgsl orca motion)
      for (let k = 0; k < 5 && n < 16; k++) {
        const ph = k * 0.23, m = Math.floor(rel / 7 + ph - 0.2);
        const ts = (m + 0.2 - ph) * 7;
        if (ts < 0) continue;
        const al = ts * 3.5 - 60 + ((k * 37) % 11 - 5) * 2.2, lat = (k - 2) * 7;
        { const o = n++ * 4; RIP[o] = hx + dx * al - dz * lat; RIP[o + 1] = hz + dz * al + dx * lat; RIP[o + 2] = t0 + ts; RIP[o + 3] = 0.6; }
      }
    } else if (ty === 4) {
      // whale: two blows, the launch and the crash of the breach
      // along-track position at time r is r * 1.5 - 30 (herd.wgsl); the crash lands 6.5 m further on
      { const o = n++ * 4; RIP[o] = hx + dx * -21; RIP[o + 1] = hz + dz * -21; RIP[o + 2] = t0 + 6; RIP[o + 3] = 0.35; }
      { const o = n++ * 4; RIP[o] = hx + dx * -10.5; RIP[o + 1] = hz + dz * -10.5; RIP[o + 2] = t0 + 13; RIP[o + 3] = 0.35; }
      { const o = n++ * 4; RIP[o] = hx; RIP[o + 1] = hz; RIP[o + 2] = t0 + 20; RIP[o + 3] = 1.2; }
      { const o = n++ * 4; RIP[o] = hx + dx * 9.1; RIP[o + 1] = hz + dz * 9.1; RIP[o + 2] = t0 + 22.4; RIP[o + 3] = 2.6; }
    } else if (ty === 3) {
      // flamingos: each take-off run leaves a splash (latest 8)
      for (let k = 47; k >= 0 && n < 16; k--) {
        const tk = 6 + k * 0.12 + 0.6;
        if (rel < tk) continue;
        const a = k * 2.4, r = 3 + Math.sqrt(k) * 3.2;
        { const o = n++ * 4; RIP[o] = hx + Math.cos(a) * r + dx * 4; RIP[o + 1] = hz + Math.sin(a) * r + dz * 4; RIP[o + 2] = t0 + tk; RIP[o + 3] = 0.3; }
        if (n >= 12) break;
      }
    }
  }
  IMG.set(ENC, 0); IMG.set(RIP, 64);
  G.queue.writeBuffer(lifeFx.buf, 0, IMG);
}
