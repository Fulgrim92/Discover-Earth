// fx/terrain.js: one grid mesh per clip level, ring-shaped (hole where the finer level sits), CDLOD geomorph in
// the vertex shader, skirts on the outer edge. No vertex buffers: grid coordinates come from the vertex index.
import { G, shader, pipeline, FO } from '../gpu.js';
import { LEVELS, T0, clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import TERRAIN from '../wgsl/terrain.wgsl';
import SKY from '../wgsl/sky.wgsl';

let pTerrain, pSky;
const ib = [], ibCount = new Uint32Array(10);
const variant = new Uint8Array(LEVELS);
let GQ = 224, K = 2;

function buildIndices(Gq, hole, dx, dz) {
  const W = Gq + 3;
  const lo = Gq / 4, hi = (3 * Gq) / 4;
  const out = [];
  for (let qz = -1; qz <= Gq; qz++) {
    for (let qx = -1; qx <= Gq; qx++) {
      if (hole && qx >= lo + dx && qx < hi + dx && qz >= lo + dz && qz < hi + dz) continue;
      const a = (qz + 1) * W + (qx + 1), b = a + 1, c = a + W, d = c + 1;
      if (((qx + qz) & 1) === 0) out.push(a, c, b, b, c, d); else out.push(a, c, d, a, d, b);
    }
  }
  return new Uint32Array(out);
}

export function init(ctx) {
  const d = G.device;
  if (ctx.quality === 0) { GQ = 112; K = 4; }
  ctx.frame[FO.misc] = LEVELS; ctx.frame[FO.misc + 1] = GQ; ctx.frame[FO.misc + 2] = K;
  for (let v = 0; v < 10; v++) {
    const arr = v === 9 ? buildIndices(GQ, false, 0, 0) : buildIndices(GQ, true, (v % 3) - 1, ((v / 3) | 0) - 1);
    const b = d.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint32Array(b.getMappedRange()).set(arr); b.unmap();
    ib[v] = b; ibCount[v] = arr.length;
  }
  const targets = [{ format: 'rgba16float' }, { format: 'r16float' }];
  const mod = shader(CLIP + TERRAIN, 'terrain');
  pTerrain = pipeline({ label: 'terrain', module: mod, layouts: [ctx.bgl0, clip.bgl], targets, samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
  const smod = shader(SKY, 'sky');
  pSky = pipeline({ label: 'sky', module: smod, vs: 'vsSky', fs: 'fsSky', layouts: [ctx.bgl0], targets, samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' } });
}

// Weather for the ground and water (DESIGN 12): [0] rain intensity 0..1 (set by the weather system; a stub fed from
// the rain= URL parameter until sky-clouds' rain field arrives), [1] ground wetness 0..1, integrated here: soaks in
// over about a minute of rain and dries over about ten minutes. Shaders read them as FR.mc[0].w and FR.mc[1].w.
export const weather = new Float32Array(2);
const WET_IN = 1 / 60, WET_OUT = 1 / 600;

// per frame: snap mesh centres, pick the ring variant for each level
export function setup(ctx, camX, camZ) {
  const dt = Math.min(ctx.frame[FO.time + 1], 0.1);
  weather[1] += dt * (weather[0] * (1 - weather[1]) * WET_IN - (1 - weather[0]) * weather[1] * WET_OUT);
  weather[1] = weather[1] < 0 ? 0 : weather[1] > 1 ? 1 : weather[1];
  for (let i = 0; i < LEVELS; i++) {
    const s = K * T0 * (1 << i);
    const o = FO.mc + i * 4;
    ctx.frame[o] = Math.round(camX / (2 * s)) * 2 * s;
    ctx.frame[o + 1] = Math.round(camZ / (2 * s)) * 2 * s;
    ctx.frame[o + 2] = s;
  }
  ctx.frame[FO.mc + 3] = weather[0]; ctx.frame[FO.mc + 7] = weather[1];
  variant[0] = 9;
  for (let i = 1; i < LEVELS; i++) {
    const s = K * T0 * (1 << i);
    const a = FO.mc + (i - 1) * 4, b = FO.mc + i * 4;
    let dx = Math.round((ctx.frame[a] - ctx.frame[b]) / s), dz = Math.round((ctx.frame[a + 1] - ctx.frame[b + 1]) / s);
    dx = dx < -1 ? -1 : dx > 1 ? 1 : dx; dz = dz < -1 ? -1 : dz > 1 ? 1 : dz;
    variant[i] = (dx + 1) + (dz + 1) * 3;
  }
}

export function draw(ctx, pass, view) {
  pass.setPipeline(pTerrain);
  pass.setBindGroup(0, view.bg0);
  pass.setBindGroup(1, clip.bg);
  for (let i = 0; i < LEVELS; i++) {
    const v = variant[i];
    pass.setIndexBuffer(ib[v], 'uint32');
    pass.drawIndexed(ibCount[v], 1, 0, 0, i);
  }
  pass.setPipeline(pSky);
  pass.draw(3);
}
