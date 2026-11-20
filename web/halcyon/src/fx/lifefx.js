// fx/lifefx.js: uploads the encounter director's slots (src/encounters.js) and the water ripple sources (layout in
// lifefx.wgsl). Ripple sources are recomputed every frame from the same closed-form actor motion the shaders use
// (orca surfacings, whale breach, flamingo take-off), so they need no history. Allocation-free per frame.
import { G, bgl, bindGroup, buffer, FO, VO } from '../gpu.js';
import * as director from '../encounters.js';
import { ENC, DIR, PH, IN } from '../encounters.js';
import { v as DV } from '../sim/drone.js';
export { ENC, DIR, PH } from '../encounters.js';

const RIP = new Float32Array(64);
const IMG = new Float32Array(160);         // enc (64) | rip (64) | ph (32): 640 bytes
export const lifeFx = { buf: null, bgl: null, bg: null };

export function init() {
  if (lifeFx.buf) return;
  lifeFx.buf = buffer(IMG.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'lifefx');
  lifeFx.bgl = bgl('u', 'lifefx');
  lifeFx.bg = bindGroup(lifeFx.bgl, [lifeFx.buf], 'lifefx');
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  director.init(q, q && q.get('seed') ? +q.get('seed') : 1);
}

export function update(ctx, view) {
  const t = ctx.frame[FO.time], d = view.data;
  IN[0] = t; IN[1] = d[VO.anc]; IN[2] = d[VO.anc + 1]; IN[3] = d[VO.anc + 2];
  IN[4] = d[VO.fwd]; IN[5] = d[VO.fwd + 2]; IN[6] = DV[0]; IN[7] = DV[2]; IN[8] = d[VO.fwd + 3];
  director.update();
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
  IMG.set(ENC, 0); IMG.set(RIP, 64); IMG.set(PH, 128);
  G.queue.writeBuffer(lifeFx.buf, 0, IMG);
}
