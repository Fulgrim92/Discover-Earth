// fx/clipmap.js: 9 levels of 512x512 height (r32float) + gradient (rgba16float) + 2 mask arrays, baked on the GPU when a level's snapped
// centre moves (at most one level per frame in flight, all at once on start).
import { G, shader, bgl, bindGroup, tex, buffer, pipeline, computePipeline, FO, tsBoth, tsEnd, TS_BAKE, TS_RMAP } from '../gpu.js';
import CLIP from '../wgsl/clip.wgsl';
import TERRFN from '../wgsl/terrfn.wgsl';
import BAKE from '../wgsl/bake.wgsl';
import RMAP from '../wgsl/realmmap.wgsl';

export const LEVELS = 9;
export const N = 512;
export const T0 = 0.5;
const SNAP = 32; // texels

const U = GPUTextureUsage;
let pBake, pGrad, pShade, shadeBG = [], shadeDesc = [], tmpH, tmpA, tmpB, data, hgt, maskA, maskB, shade;
let bakeDesc, gradDesc = [], bakeBG = [], gradBG = [], bakeBuf = [];
const bakeU = new Float32Array(4);
const want = new Float64Array(LEVELS * 2);
const have = new Float64Array(LEVELS * 2);
const baked = new Uint8Array(LEVELS);
// shade layer (terrain-art): sun drift each level's baked sun shadow was made for; a level is rebaked when the
// sun has moved more than SUN_REBAKE degrees of drift since (one level per frame, finest stale first)
const sunAt = new Float32Array(LEVELS);
let sunSrc = null; // view of the frame's sun drift: copied typed-array to typed-array, no double crosses a call
const SUN_REBAKE = 0.3;
let cpSrcA, cpSrcB, cpDstA = [], cpDstB = [], cpSize;
// bake counters since load: [full bakes, shade-only re-bakes] (read by the bench report and __halcyon.bakes)
export const stats = new Float64Array(2);
export const clip = { bgl: null, bg: null, data: null, height: null, format: '' };
// realm map (terrain-art; clip.wgsl realmWeightsMap): skin weights of every realm on 1024^2 texels of 64 m around a
// centre snapped to 1 km, recomputed (one compute dispatch) when the camera is more than RM_MOVE from it
const RM_N = 1024, RM_MOVE = 8000;
let rmap, pRealm, rmBG, rmBuf, rmDesc;
const rmU = new Float32Array(4);
const rmAt = new Float64Array([1e30, 1e30]);

export function init(ctx) {
  const d = G.device;
  tmpH = tex(N + 2, N + 2, 'r32float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING, { label: 'tmpH' });
  tmpA = tex(N + 2, N + 2, 'rgba8unorm', U.RENDER_ATTACHMENT | U.COPY_SRC, { label: 'tmpA' });
  tmpB = tex(N + 2, N + 2, 'rgba8unorm', U.RENDER_ATTACHMENT | U.COPY_SRC, { label: 'tmpB' });
  // Same formats with and without float32-filterable: heights in r32float (gathered, never filtered by the
  // sampler), derivatives and concavity in rgba16float (filtered). See bake.wgsl fsGrad.
  hgt = tex(N, N, 'r32float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC, { layers: LEVELS, label: 'clipH' });
  data = tex(N, N, 'rgba16float', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING, { layers: LEVELS, label: 'clip' });
  maskA = tex(N, N, 'rgba8unorm', U.COPY_DST | U.TEXTURE_BINDING, { layers: LEVELS, label: 'maskA' });
  maskB = tex(N, N, 'rgba8unorm', U.COPY_DST | U.TEXTURE_BINDING, { layers: LEVELS, label: 'maskB' });
  sunSrc = ctx.frame.subarray(FO.sky + 2, FO.sky + 3); // accumulated sun motion (deg, main.js skyTime)
  shade = tex(N, N, 'rgba8unorm', U.RENDER_ATTACHMENT | U.TEXTURE_BINDING, { layers: LEVELS, label: 'clipShade' });
  clip.data = data; clip.height = hgt; clip.format = 'r32float+rgba16float';

  const mod = shader(CLIP + TERRFN + BAKE, 'bake');
  const bl1 = bgl('u', 'bake1'), bl2 = bgl('un', 'bake2');
  pBake = pipeline({ label: 'bake', module: mod, fs: 'fsBake', layouts: [ctx.bgl0, bl1],
    targets: [{ format: 'r32float' }, { format: 'rgba8unorm' }, { format: 'rgba8unorm' }] });
  pGrad = pipeline({ label: 'grad', module: mod, fs: 'fsGrad', layouts: [ctx.bgl0, bl2], targets: [{ format: 'r32float' }, { format: 'rgba16float' }] });
  pShade = pipeline({ label: 'shade', module: mod, fs: 'fsShade', layouts: [ctx.bgl0, bl2], targets: [{ format: 'rgba8unorm' }] });

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
    shadeBG[i] = bindGroup(bl2, [bakeBuf[i], hgt.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 })]);
    gradDesc[i] = { colorAttachments: [
      { view: hgt.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      { view: data.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] };
    shadeDesc[i] = { colorAttachments: [{ view: shade.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store', clearValue: { r: 1, g: 1, b: 0.5, a: 0.5 } }] };
    cpDstA[i] = { texture: maskA, origin: { x: 0, y: 0, z: i } };
    cpDstB[i] = { texture: maskB, origin: { x: 0, y: 0, z: i } };
    have[i * 2] = 1e30; have[i * 2 + 1] = 1e30;
  }
  cpSrcA = { texture: tmpA, origin: { x: 1, y: 1, z: 0 } };
  cpSrcB = { texture: tmpB, origin: { x: 1, y: 1, z: 0 } };
  cpSize = { width: N, height: N, depthOrArrayLayers: 1 };

  rmap = tex(RM_N, RM_N, 'rgba8unorm', U.STORAGE_BINDING | U.TEXTURE_BINDING, { layers: 2, label: 'realmMap' });
  rmBuf = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'realmMapU');
  const rbl = d.createBindGroupLayout({ label: 'realm map', entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' } }] });
  pRealm = d.createComputePipeline({ label: 'realm map', layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.bgl0, rbl] }),
    compute: { module: shader(RMAP, 'realm map'), entryPoint: 'csRealm' } });
  rmDesc = { label: 'realm map', timestampWrites: tsBoth(TS_RMAP) };
  rmBG = bindGroup(rbl, [rmBuf, rmap.createView({ dimension: '2d-array' })]);
  clip.bgl = bgl('aaasaNSa', 'clip');
  const samp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  clip.bg = bindGroup(clip.bgl, [
    data.createView({ dimension: '2d-array' }), maskA.createView({ dimension: '2d-array' }), maskB.createView({ dimension: '2d-array' }), samp,
    shade.createView({ dimension: '2d-array' }), hgt.createView({ dimension: '2d-array' }),
    d.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
    rmap.createView({ dimension: '2d-array' }),
  ]);
}

// shadeOnly: rerun only the shade pass (sun shadow, sky visibility, macro noise) from the level's baked heights
// (cheap, no terrain eval), when the sun has drifted. One function, so its pass encoders stay the platform's.
function bakeLevel(ctx, enc, i, shadeOnly) {
  const t = T0 * (1 << i);
  const cx = want[i * 2], cz = want[i * 2 + 1];
  if (!shadeOnly) {
  bakeU[0] = cx - 256 * t; bakeU[1] = cz - 256 * t; bakeU[2] = t; bakeU[3] = i;
  G.queue.writeBuffer(bakeBuf[i], 0, bakeU);
  bakeDesc.timestampWrites = bakeTs();
  let p = enc.beginRenderPass(bakeDesc);
  p.setPipeline(pBake); p.setBindGroup(0, ctx.views[0].bg0); p.setBindGroup(1, bakeBG[i]);
  p.draw(3); p.end();
  enc.copyTextureToTexture(cpSrcA, cpDstA[i], cpSize);
  enc.copyTextureToTexture(cpSrcB, cpDstB[i], cpSize);
  gradDesc[i].timestampWrites = bakeTs();
  p = enc.beginRenderPass(gradDesc[i]);
  p.setPipeline(pGrad); p.setBindGroup(0, ctx.views[0].bg0); p.setBindGroup(1, gradBG[i]);
  p.draw(3); p.end();
  }
  shadeDesc[i].timestampWrites = bakeTs();
  const q = enc.beginRenderPass(shadeDesc[i]);
  q.setPipeline(pShade); q.setBindGroup(0, ctx.views[0].bg0); q.setBindGroup(1, shadeBG[i]);
  q.draw(3); q.end();
  sunAt.set(sunSrc, i);
  stats[shadeOnly ? 1 : 0]++;
  if (shadeOnly) return;
  have[i * 2] = cx; have[i * 2 + 1] = cz; baked[i] = 1;
  const o = FO.lv + i * 4;
  ctx.frame[o] = cx - 256 * t; ctx.frame[o + 1] = cz - 256 * t; ctx.frame[o + 2] = t; ctx.frame[o + 3] = ctx.frame[FO.time]; // .w: bake time (dbg=22)
}

// realm map recentre: one compute pass (its encoder is the platform's)
function bakeRealm(ctx, enc, camX, camZ) {
  rmAt[0] = Math.round(camX / 1024) * 1024; rmAt[1] = Math.round(camZ / 1024) * 1024;
  rmU[0] = rmAt[0]; rmU[1] = rmAt[1];
  G.queue.writeBuffer(rmBuf, 0, rmU);
  const c = enc.beginComputePass(rmDesc);
  c.setPipeline(pRealm); c.setBindGroup(0, ctx.views[0].bg0); c.setBindGroup(1, rmBG);
  c.dispatchWorkgroups(RM_N / 8, RM_N / 8); c.end();
  ctx.frame[FO.mc + 11] = rmAt[0]; ctx.frame[FO.mc + 15] = rmAt[1]; // FR.mc[2].w, mc[3].w (clip.wgsl RM_ORIGIN)
}

// Returns the number of levels baked. `all`: bake every stale level now. ran[0]: any clip pass was encoded (full or
// shade-only), ran[1]: the realm map was rebaked (TS_RMAP); main.js marks them for perf.
// Timer: all clip passes of a frame are one TS_BAKE span. The first writes the begin and end stamps, every later one
// the end stamp again (the last write wins), so the span runs from the first bake pass to the last; no extra passes.
export const ran = new Uint8Array(2);
function bakeTs() { const first = !ran[0]; ran[0] = 1; return first ? tsBoth(TS_BAKE) : tsEnd(TS_BAKE); }
export function update(ctx, enc, camX, camZ, all) {
  ran[0] = 0; ran[1] = 0;
  if (Math.abs(camX - rmAt[0]) > RM_MOVE || Math.abs(camZ - rmAt[1]) > RM_MOVE) { bakeRealm(ctx, enc, camX, camZ); ran[1] = 1; }
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
  const sd = ctx.frame[FO.sky + 2];
  for (let i = 0; i < LEVELS; i++) if (baked[i] && Math.abs(sd - sunAt[i]) > SUN_REBAKE) { bakeLevel(ctx, enc, i, true); return 0; }
  return 0;
}

// bake level i for a camera at (camX, camZ) regardless of staleness
export function bakeOne(ctx, enc, i, camX, camZ) {
  const t = T0 * (1 << i), s = SNAP * t;
  want[i * 2] = Math.round(camX / s) * s; want[i * 2 + 1] = Math.round(camZ / s) * s;
  bakeLevel(ctx, enc, i);
}

export function allBaked() { for (let i = 0; i < LEVELS; i++) if (!baked[i]) return false; return true; }

// Harness: read back level `i`'s heights -> Float32Array of N*N, plus the texel-0 origin and texel size.
export async function readLevel(ctx, i) {
  const d = G.device;
  const bpr = N * 4;
  const buf = d.createBuffer({ size: bpr * N, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = d.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: hgt, origin: { x: 0, y: 0, z: i } }, { buffer: buf, bytesPerRow: bpr }, { width: N, height: N, depthOrArrayLayers: 1 });
  d.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const a = new Float32Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  const t = T0 * (1 << i);
  return { data: a, x0: have[i * 2] - 256 * t, z0: have[i * 2 + 1] - 256 * t, t };
}

// Harness: the heights the shaders see. Runs clip.wgsl clipH (the gather + bilinear every consumer uses) at points
// pts = [x, z, level, 0, ...] and returns the heights, so heightcheck can compare them with the read-back texels.
const PROBE = `
@group(2) @binding(0) var<storage, read_write> PB: array<vec4f>;
@compute @workgroup_size(64) fn cs(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&PB)) { return; }
  let q = PB[id.x];
  PB[id.x].w = clipH(u32(q.z), q.xy);
}`;
export async function probe(ctx, pts) {
  const d = G.device;
  const bl = bgl('b', 'probe');
  const pp = computePipeline(shader(CLIP + PROBE, 'clip probe'), [ctx.bgl0, clip.bgl, bl], 'clip probe');
  const sb = d.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const rb = d.createBuffer({ size: pts.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  d.queue.writeBuffer(sb, 0, pts);
  const enc = d.createCommandEncoder();
  const c = enc.beginComputePass();
  c.setPipeline(pp); c.setBindGroup(0, ctx.views[0].bg0); c.setBindGroup(1, clip.bg); c.setBindGroup(2, bindGroup(bl, [sb]));
  c.dispatchWorkgroups(Math.ceil(pts.length / 4 / 64)); c.end();
  enc.copyBufferToBuffer(sb, 0, rb, 0, pts.byteLength);
  d.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy(); sb.destroy();
  return out;
}
