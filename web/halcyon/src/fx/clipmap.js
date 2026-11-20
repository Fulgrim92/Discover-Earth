// fx/clipmap.js: 9 levels of 512x512 height/gradient + 2 mask arrays, baked on the GPU when a level's snapped
// centre moves (at most one level per frame in flight, all at once on start).
import { G, shader, bgl, bindGroup, tex, buffer, pipeline, FO } from '../gpu.js';
import CLIP from '../wgsl/clip.wgsl';
import TERRFN from '../wgsl/terrfn.wgsl';
import BAKE from '../wgsl/bake.wgsl';

export const LEVELS = 9;
export const N = 512;
export const T0 = 0.5;
const SNAP = 32; // texels

const U = GPUTextureUsage;
let pBake, pGrad, tmpH, tmpA, tmpB, data, maskA, maskB;
let bakeDesc, gradDesc = [], bakeBG = [], gradBG = [], bakeBuf = [];
const bakeU = new Float32Array(4);
const want = new Float64Array(LEVELS * 2);
const have = new Float64Array(LEVELS * 2);
const baked = new Uint8Array(LEVELS);
let cpSrcA, cpSrcB, cpDstA = [], cpDstB = [], cpSize;
export const clip = { bgl: null, bg: null, data: null, format: '' };

export function init(ctx) {
  const d = G.device;
  tmpH = tex(N + 2, N + 2, 'r32float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING, { label: 'tmpH' });
  tmpA = tex(N + 2, N + 2, 'rgba8unorm', U.RENDER_ATTACHMENT | U.COPY_SRC, { label: 'tmpA' });
  tmpB = tex(N + 2, N + 2, 'rgba8unorm', U.RENDER_ATTACHMENT | U.COPY_SRC, { label: 'tmpB' });
  data = tex(N, N, G.clipFormat, U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC, { layers: LEVELS, label: 'clip' });
  maskA = tex(N, N, 'rgba8unorm', U.COPY_DST | U.TEXTURE_BINDING, { layers: LEVELS, label: 'maskA' });
  maskB = tex(N, N, 'rgba8unorm', U.COPY_DST | U.TEXTURE_BINDING, { layers: LEVELS, label: 'maskB' });
  clip.data = data; clip.format = G.clipFormat;

  const mod = shader(CLIP + TERRFN + BAKE, 'bake');
  const bl1 = bgl('u', 'bake1'), bl2 = bgl('un', 'bake2');
  pBake = pipeline({ label: 'bake', module: mod, fs: 'fsBake', layouts: [ctx.bgl0, bl1],
    targets: [{ format: 'r32float' }, { format: 'rgba8unorm' }, { format: 'rgba8unorm' }] });
  pGrad = pipeline({ label: 'grad', module: mod, fs: 'fsGrad', layouts: [ctx.bgl0, bl2], targets: [{ format: G.clipFormat }] });

  bakeDesc = { colorAttachments: [
    { view: tmpH.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
    { view: tmpA.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
    { view: tmpB.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
  ] };
  const tmpHView = tmpH.createView();
  for (let i = 0; i < LEVELS; i++) {
    bakeBuf[i] = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'bakeU' + i);
    bakeBG[i] = bindGroup(bl1, [bakeBuf[i]]);
    gradBG[i] = bindGroup(bl2, [bakeBuf[i], tmpHView]);
    gradDesc[i] = { colorAttachments: [{ view: data.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] };
    cpDstA[i] = { texture: maskA, origin: { x: 0, y: 0, z: i } };
    cpDstB[i] = { texture: maskB, origin: { x: 0, y: 0, z: i } };
    have[i * 2] = 1e30; have[i * 2 + 1] = 1e30;
  }
  cpSrcA = { texture: tmpA, origin: { x: 1, y: 1, z: 0 } };
  cpSrcB = { texture: tmpB, origin: { x: 1, y: 1, z: 0 } };
  cpSize = { width: N, height: N, depthOrArrayLayers: 1 };

  clip.bgl = bgl('aaas', 'clip');
  const samp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  clip.bg = bindGroup(clip.bgl, [
    data.createView({ dimension: '2d-array' }), maskA.createView({ dimension: '2d-array' }), maskB.createView({ dimension: '2d-array' }), samp,
  ]);
}

function bakeLevel(ctx, enc, i) {
  const t = T0 * (1 << i);
  const cx = want[i * 2], cz = want[i * 2 + 1];
  bakeU[0] = cx - 256 * t; bakeU[1] = cz - 256 * t; bakeU[2] = t; bakeU[3] = i;
  G.queue.writeBuffer(bakeBuf[i], 0, bakeU);
  let p = enc.beginRenderPass(bakeDesc);
  p.setPipeline(pBake); p.setBindGroup(0, ctx.views[0].bg0); p.setBindGroup(1, bakeBG[i]);
  p.draw(3); p.end();
  enc.copyTextureToTexture(cpSrcA, cpDstA[i], cpSize);
  enc.copyTextureToTexture(cpSrcB, cpDstB[i], cpSize);
  p = enc.beginRenderPass(gradDesc[i]);
  p.setPipeline(pGrad); p.setBindGroup(0, ctx.views[0].bg0); p.setBindGroup(1, gradBG[i]);
  p.draw(3); p.end();
  have[i * 2] = cx; have[i * 2 + 1] = cz; baked[i] = 1;
  const o = FO.lv + i * 4;
  ctx.frame[o] = cx - 256 * t; ctx.frame[o + 1] = cz - 256 * t; ctx.frame[o + 2] = t; ctx.frame[o + 3] = 1;
}

// Returns the number of levels baked. `all`: bake every stale level now.
export function update(ctx, enc, camX, camZ, all) {
  let best = -1, bestDrift = 0;
  for (let i = 0; i < LEVELS; i++) {
    const t = T0 * (1 << i), s = SNAP * t;
    want[i * 2] = Math.round(camX / s) * s;
    want[i * 2 + 1] = Math.round(camZ / s) * s;
    const drift = Math.max(Math.abs(want[i * 2] - have[i * 2]), Math.abs(want[i * 2 + 1] - have[i * 2 + 1])) / t;
    if (drift > 0.5 && drift > bestDrift) { bestDrift = drift; best = i; }
  }
  if (all) {
    let n = 0;
    for (let i = 0; i < LEVELS; i++) {
      const t = T0 * (1 << i);
      if (Math.max(Math.abs(want[i * 2] - have[i * 2]), Math.abs(want[i * 2 + 1] - have[i * 2 + 1])) / t > 0.5) { bakeLevel(ctx, enc, i); n++; }
    }
    return n;
  }
  if (best >= 0) { bakeLevel(ctx, enc, best); return 1; }
  return 0;
}

// bake level i for a camera at (camX, camZ) regardless of staleness
export function bakeOne(ctx, enc, i, camX, camZ) {
  const t = T0 * (1 << i), s = SNAP * t;
  want[i * 2] = Math.round(camX / s) * s; want[i * 2 + 1] = Math.round(camZ / s) * s;
  bakeLevel(ctx, enc, i);
}

export function allBaked() { for (let i = 0; i < LEVELS; i++) if (!baked[i]) return false; return true; }

// Harness: read back level `i` (rgba32float only) -> Float32Array of N*N*4, plus the texel-0 origin and texel size.
export async function readLevel(ctx, i) {
  const d = G.device;
  const bpr = N * 16;
  const buf = d.createBuffer({ size: bpr * N, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = d.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: data, origin: { x: 0, y: 0, z: i } }, { buffer: buf, bytesPerRow: bpr }, { width: N, height: N, depthOrArrayLayers: 1 });
  d.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const a = new Float32Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const t = T0 * (1 << i);
  return { data: a, x0: have[i * 2] - 256 * t, z0: have[i * 2 + 1] - 256 * t, t };
}
