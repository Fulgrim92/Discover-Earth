// fx/rings.js: the light rings and the post-composite effects pass they share with the drone (fx.wgsl).
// Rings are thin luminous tori drawn analytically: each ring is a box proxy (back faces, so it also works from
// inside) whose fragment shader finds the closest approach of the view ray to the ring circle and paints a hot
// core plus a soft halo, additive, HDR, with soft intersection against the resolved scene distance and the air's
// transmittance. idle = dim and realm-tinted, next = bright, breathing, with a bead of light running round it and
// a trail of drifting sparks from the previous ring, passed = a widening white burst, then a ghost that fades.
// Instance data: one preallocated Float32Array (64 rings x 12 floats) uploaded with writeBuffer each frame.
import { G, shader, bgl, bindGroup, buffer, pipeline, tsBoth, TS_FX } from '../gpu.js';
import SKY from '../wgsl/sky.wgsl';
import FXU from '../wgsl/fxu.wgsl';
import FXW from '../wgsl/fx.wgsl';
import { CLK, C_TIME } from '../clock.js';

export const RING_MAX = 64, RING_FLOATS = 12, MAX_COURSE = 4096, SPARKS = 72;
// FxU layout (floats), see fxu.wgsl
export const FXO = { drone: 0, dq: 4, motors: 8, props: 12, dinfo: 16, sp0: 20, sp1: 24, rinfo: 28, N: 32 };
export const FX = { u: new Float32Array(FXO.N), buf: null, bgl: null, bg: null, desc: null, pShadow: null, pProp: null, pLed: null, pRing: null, pSpark: null };

const inst = new Float32Array(RING_MAX * RING_FLOATS);
const burstT = new Float32Array(MAX_COURSE);
const S = new Float64Array(4); // passed count seen, ring count drawn
let ringBuf;

export function init(ctx) {
  FX.buf = buffer(FXO.N * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'fxU');
  ringBuf = buffer(inst.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'rings');
  FX.bgl = bgl('fur', 'fx1');
  const mod = shader(SKY + FXU + FXW, 'fx');
  const lay = [ctx.bgl0, FX.bgl];
  const T = 'rgba16float';
  const add = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  const over = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  const mul = { color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  FX.pShadow = pipeline({ label: 'droneShadow', module: mod, vs: 'vsShadow', fs: 'fsShadow', layouts: lay, targets: [{ format: T, blend: mul }], cull: 'front' });
  FX.pProp = pipeline({ label: 'props', module: mod, vs: 'vsProp', fs: 'fsProp', layouts: lay, targets: [{ format: T, blend: over }] });
  FX.pLed = pipeline({ label: 'navLights', module: mod, vs: 'vsLed', fs: 'fsLed', layouts: lay, targets: [{ format: T, blend: add }] });
  FX.pRing = pipeline({ label: 'rings', module: mod, vs: 'vsRing', fs: 'fsRing', layouts: lay, targets: [{ format: T, blend: add }], cull: 'front' });
  FX.pSpark = pipeline({ label: 'sparks', module: mod, vs: 'vsSpark', fs: 'fsSpark', layouts: lay, targets: [{ format: T, blend: add }] });
  burstT.fill(-1e9);
  S[0] = -1;
}

// (re)bind to the view targets: draws into the composited image, reads the resolved scene distance
export function bind(ctx, tg) {
  FX.bg = bindGroup(FX.bgl, [tg.distV, FX.buf, ringBuf]);
  FX.desc = { colorAttachments: [{ view: tg.compV, loadOp: 'load', storeOp: 'store' }], timestampWrites: tsBoth(TS_FX) };
}

// per frame, after sim.step: ring instances and the spark trail
export function update(sim) {
  const timeS = CLK[C_TIME];
  const R = sim._dbg.R, rs = sim.rings, n = sim.ringCount, next = sim.ringNextSlot;
  const wstart = R.info[2], passed = R.info[4], last = R.info[5];
  if (S[0] < 0) S[0] = passed;
  if (passed !== S[0]) { S[0] = passed; if (last >= 0 && last < MAX_COURSE) burstT[last] = timeS; }
  for (let k = 0; k < RING_MAX; k++) {
    const o = k * RING_FLOATS, s = k * 8;
    if (k >= n || rs[s + 6] <= 0) { inst[o + 3] = 0; inst[o + 11] = 0; continue; }
    const ci = wstart + k, st = rs[s + 7];
    inst[o] = rs[s]; inst[o + 1] = rs[s + 1]; inst[o + 2] = rs[s + 2]; inst[o + 3] = rs[s + 6];
    inst[o + 4] = rs[s + 3]; inst[o + 5] = rs[s + 4]; inst[o + 6] = rs[s + 5]; inst[o + 7] = st;
    let fade = 1;
    let age = 1e3;
    if (st > 1.5) {
      if (ci < MAX_COURSE) age = timeS - burstT[ci];
      fade = age < 8 ? 1 : 0;
    } else if (st < 0.5 && next >= 0) {
      const ahead = k - next;
      fade = ahead < 0 ? 0.35 : ahead <= 6 ? 1 : 1 - (ahead - 6) / 24;
      if (fade < 0.12) fade = 0.12;
    }
    inst[o + 8] = age; inst[o + 9] = ((ci * 2654435761) >>> 0) / 4294967296; inst[o + 10] = 0; inst[o + 11] = fade;
  }
  S[1] = n;
  // sparks: from the previous ring (or the drone when there is none, or the line jumps between realms) to the next
  const u = FX.u;
  if (next >= 0 && next < n) {
    const b = next * 8;
    let ax = sim.drone[0], ay = sim.drone[1], az = sim.drone[2];
    if (next > 0) {
      const a = (next - 1) * 8;
      const dx = rs[a] - rs[b], dz = rs[a + 2] - rs[b + 2];
      if (dx * dx + dz * dz < 400 * 400) { ax = rs[a]; ay = rs[a + 1]; az = rs[a + 2]; }
    }
    if (ax === sim.drone[0]) {
      // starting at the drone: begin 5 m ahead of it so the motes never swarm the airframe
      const ex = rs[b] - ax, ey = rs[b + 1] - ay, ez = rs[b + 2] - az, l = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (l > 6) { const k = 5 / l; ax += ex * k; ay += ey * k; az += ez * k; }
    }
    u[FXO.sp0] = ax; u[FXO.sp0 + 1] = ay; u[FXO.sp0 + 2] = az; u[FXO.sp0 + 3] = SPARKS;
    u[FXO.sp1] = rs[b]; u[FXO.sp1 + 1] = rs[b + 1]; u[FXO.sp1 + 2] = rs[b + 2]; u[FXO.sp1 + 3] = 1;
  } else { u[FXO.sp0 + 3] = 0; u[FXO.sp1 + 3] = 0; }
  u[FXO.rinfo] = n; u[FXO.rinfo + 1] = next;
}

export function upload() {
  G.queue.writeBuffer(FX.buf, 0, FX.u);
  G.queue.writeBuffer(ringBuf, 0, inst);
}

// ablation (?off=rings): no rings and no spark guide this frame (after update)
export function hide() { S[1] = 0; FX.u[FXO.sp0 + 3] = 0; FX.u[FXO.sp1 + 3] = 0; }

// the effects pass for one view: drone shadow / props / lights (drawFx), then rings and sparks
export function pass(ctx, enc, view, drawFx) {
  const p = enc.beginRenderPass(FX.desc);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, FX.bg);
  drawFx(p);
  if (S[1] > 0) { p.setPipeline(FX.pRing); p.draw(36, S[1]); }
  if (FX.u[FXO.sp0 + 3] > 0) { p.setPipeline(FX.pSpark); p.draw(6, SPARKS); }
  p.end();
}
