// fx/terrain.js: one grid mesh per clip level, ring-shaped (hole where the finer level sits), CDLOD geomorph in
// the vertex shader, skirts on the outer edge. No vertex buffers: grid coordinates come from the vertex index.
import { G, shader, pipeline, bindGroup, FO, tsBoth, TS_TSHADE } from '../gpu.js';
import { LEVELS, T0, clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import TERRAIN from '../wgsl/terrain.wgsl';
import SKY from '../wgsl/sky.wgsl';

let pTerrain, pSky, pShade, bglShade, bgShade, shadeDesc;
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
  if (ctx.quality === 0 || (ctx.off & 524288)) { GQ = 112; K = 4; } // low quality, or off=tgrid
  ctx.frame[FO.misc] = LEVELS; ctx.frame[FO.misc + 1] = GQ; ctx.frame[FO.misc + 2] = K;
  for (let v = 0; v < 10; v++) {
    const arr = v === 9 ? buildIndices(GQ, false, 0, 0) : buildIndices(GQ, true, (v % 3) - 1, ((v / 3) | 0) - 1);
    const b = d.createBuffer({ size: arr.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint32Array(b.getMappedRange()).set(arr); b.unmap();
    ib[v] = b; ibCount[v] = arr.length;
  }
  const targets = [{ format: 'rgba16float' }, { format: 'rg16float' }];
  const ms = ctx.msaa > 1;
  const src = ms ? TERRAIN : TERRAIN.replace('texture_multisampled_2d<f32>', 'texture_2d<f32>')
    .replace('texture_depth_multisampled_2d', 'texture_depth_2d').replace('const TNS: i32 = 4;', 'const TNS: i32 = 1;');
  const mod = shader(CLIP + src, 'terrain');
  pTerrain = pipeline({ label: 'terrain', module: mod, layouts: [ctx.bgl0, clip.bgl], targets, samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
  // deferred terrain shading (terrain.wgsl fsShade): adds terrain colour x coverage into the resolved scene
  const vis = GPUShaderStage.FRAGMENT;
  bglShade = d.createBindGroupLayout({ label: 'terrain shade', entries: [
    { binding: 0, visibility: vis, texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: ms } },
    { binding: 1, visibility: vis, texture: { sampleType: 'depth', viewDimension: '2d', multisampled: ms } },
    // the baked macro material (clipmap.js, terrain.wgsl matFetch)
    ...[2, 3, 4, 5].map((b) => ({ binding: b, visibility: vis, texture: { sampleType: 'float', viewDimension: '2d-array' } }))] });
  const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  pShade = pipeline({ label: 'terrain shade', module: mod, vs: 'vsFull', fs: 'fsShade', layouts: [ctx.bgl0, clip.bgl, bglShade],
    targets: [{ format: 'rgba16float', blend: add }] });
  // the material bake (terrain.wgsl fsMatBake, encoded by clipmap.js bakeLevel): the same source with matFetch
  // stubbed out, since that pass writes the textures matFetch reads
  const a = src.indexOf(';', src.indexOf('MAT_FETCH_BEGIN')) + 1, b = src.lastIndexOf('const', src.indexOf('MAT_FETCH_END'));
  if (a <= 0 || b < a) throw new Error('terrain.wgsl: MAT_FETCH markers missing');
  const bsrc = src.slice(0, a) + 'fn matFetch(l: u32, e: f32, xz: vec2f) -> MatS { var m: MatS; return m; }\n' + src.slice(b);
  const bmod = shader(CLIP + bsrc, 'terrain material bake');
  const empty = d.createBindGroupLayout({ label: 'empty', entries: [] });
  const bglMat = d.createBindGroupLayout({ label: 'material bake', entries: [{ binding: 0, visibility: vis, buffer: { type: 'uniform' } }] });
  clip.pMat = pipeline({ label: 'material bake', module: bmod, vs: 'vsMat', fs: 'fsMatBake', layouts: [ctx.bgl0, clip.bgl, empty, bglMat],
    targets: clip.matFormats.map((format) => ({ format })) });
  clip.matEmpty = d.createBindGroup({ layout: empty, entries: [] });
  for (let i = 0; i < LEVELS; i++) clip.matBG[i] = bindGroup(bglMat, [clip.bakeBuf[i]]);
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

// (re)bind to the view targets: the opaque pass's dist target (MSAA when on) and depth, and the resolved scene
export function bind(ctx, t) {
  bgShade = bindGroup(bglShade, [t.distSV, t.depthSV, ...clip.matViews]);
  shadeDesc = { colorAttachments: [{ view: t.sceneV, loadOp: 'load', storeOp: 'store' }], timestampWrites: tsBoth(TS_TSHADE) };
}

// the deferred terrain shading pass, right after the opaque pass
export function shade(ctx, enc, view) {
  const p = enc.beginRenderPass(shadeDesc);
  p.setPipeline(pShade);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, clip.bg); p.setBindGroup(2, bgShade);
  p.draw(3); p.end();
}

export function draw(ctx, pass, view) {
  pass.setPipeline(pTerrain);
  pass.setBindGroup(0, view.bg0);
  pass.setBindGroup(1, clip.bg);
  const nl = ctx.off & 65536 ? 5 : LEVELS; // off=tgeo
  for (let i = 0; i < nl; i++) {
    const v = variant[i];
    pass.setIndexBuffer(ib[v], 'uint32');
    pass.drawIndexed(ibCount[v], 1, 0, 0, i);
  }
  pass.setPipeline(pSky);
  pass.draw(3);
}
