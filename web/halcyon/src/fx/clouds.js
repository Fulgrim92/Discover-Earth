// fx/clouds.js: half-resolution volumetric clouds (DESIGN section 6 step 3).
// Start: bake tileable Perlin-Worley 3D noise (128^3 + 4 mips) and Worley detail (32^3) once on the GPU.
// Per frame (first view): bake the camera-centred weather window (coverage + realm-blended layer parameters,
// cloudnoise.wgsl csWeather). Per view: march the clouds at half resolution (clouds.wgsl) into three targets
// that composite.wgsl upsamples with depth awareness: front clouds, clouds in the water mirror, march distance.
// Debug views (URL dbg=): 9 no clouds (composite), 10 weather coverage on the ground, 13 no march jitter,
// 16 density probe at the camera realm's mid-layer.
// Zero per-frame allocations: descriptors, bind groups and the uniform block are built here once.
import { G, fail, shader, bgl, bindGroup, tex, buffer, pipeline, tsBoth, TS_CLOUDS, TS_WEATHER } from '../gpu.js';
import { WX_BOLT } from '../weather.js';
import { clip } from './clipmap.js';
import { TABLE, ROWF, F, NREALM, realmWeightsA, W_IN, W_ID, W_W } from '../realms.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import NOISE from '../wgsl/cloudnoise.wgsl';
import CLOUDS from '../wgsl/clouds.wgsl';
import WX from '../wgsl/cloudwx.wgsl';

const BASE_N = 128, BASE_MIPS = 4, DET_N = 64;
export const clouds = { view: null, reflView: null, distView: null, w: 1, h: 1 };

const U = GPUTextureUsage;
let pMarch, blMarch, bgMarch = null, pWeather, bgWeather, cuBuf, wxV, wyV, baseV, detV, marchDesc, wxDesc;
let WN = 512, WTEX = 128;
const CU = new Float32Array(32);
// march cost instrumentation (URL steps=1): stats buffer (clouds.wgsl CST), read back every 16 frames into STEPS
const NST = 80;
let stBuf = null, stRead = null, stBusy = false, stFrame = 0;
const STEPS = new Float64Array(NST); // summed over all read-back frames

function layout(entries, label) { return G.device.createBindGroupLayout({ entries, label }); }
const CS = () => GPUShaderStage.COMPUTE;
const VF = () => GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

export function init(ctx) {
  const d = G.device;
  const q = ctx.quality;
  WN = q === 0 ? 256 : 512; WTEX = q === 0 ? 220 : 128;
  // march budget: dense samples per ray (shared by both layers; iterations are capped at twice that), light steps,
  // max distance (m), reflection steps
  CU[8] = q === 0 ? 56 : q === 2 ? 112 : 80; CU[9] = q === 0 ? 4 : 6; CU[10] = WN * WTEX * 0.5; CU[11] = q === 0 ? 20 : 28;
  // planet-wide layer bounds from the realm table
  let lo = 1e9, hi = 0, slo = 1e9, shi = 0;
  for (let r = 0; r < NREALM; r++) {
    const o = r * ROWF;
    if (TABLE[o + F.C0 * 4] > 0.001) { lo = Math.min(lo, TABLE[o + F.C0 * 4 + 1]); hi = Math.max(hi, TABLE[o + F.C0 * 4 + 2]); }
    if (TABLE[o + F.C1 * 4 + 3] > 0.001) { slo = Math.min(slo, TABLE[o + F.C2 * 4]); shi = Math.max(shi, TABLE[o + F.C2 * 4 + 1] + 45); }
  }
  if (hi <= lo) { lo = 0; hi = 0; }
  if (shi <= slo) { slo = 0; shi = 0; }
  CU[4] = lo; CU[5] = hi; CU[6] = slo; CU[7] = shi;
  cuBuf = buffer(128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'cloudU');
  CU[28] = new URLSearchParams(location.search).get('steps') === '1' ? 1 : 0;
  stBuf = buffer(NST * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, 'cloudSteps');
  if (CU[28] > 0) stRead = buffer(NST * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'cloudStepsRead');

  // ---- noise textures, baked once ----
  const base = tex(BASE_N, BASE_N, 'rgba8unorm', U.STORAGE_BINDING | U.TEXTURE_BINDING, { layers: BASE_N, dim: '3d', mips: BASE_MIPS, label: 'cloudBase' });
  const det = tex(DET_N, DET_N, 'rgba8unorm', U.STORAGE_BINDING | U.TEXTURE_BINDING, { layers: DET_N, dim: '3d', label: 'cloudDetail' });
  baseV = base.createView(); detV = det.createView();
  const nmod = shader(NOISE, 'cloudnoise');
  const st3 = { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' };
  const lBase = layout([{ binding: 0, visibility: CS(), storageTexture: st3 }], 'cnBase');
  const lDet = layout([{ binding: 1, visibility: CS(), storageTexture: st3 }], 'cnDet');
  const lMip = layout([{ binding: 2, visibility: CS(), texture: { sampleType: 'float', viewDimension: '3d' } }, { binding: 3, visibility: CS(), storageTexture: st3 }], 'cnMip');
  const lWx = layout([
    { binding: 0, visibility: CS(), storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
    { binding: 1, visibility: CS(), storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } },
    { binding: 2, visibility: CS(), buffer: { type: 'uniform' } }], 'cnWx');
  const cp = (l, entry, mod = nmod) => {
    d.pushErrorScope('validation');
    const lays = mod === nmod ? [ctx.bgl0, l] : [ctx.bgl0, clip.bgl, l];
    const p = d.createComputePipeline({ label: entry, layout: d.createPipelineLayout({ bindGroupLayouts: lays }), compute: { module: mod, entryPoint: entry } });
    d.popErrorScope().then((e) => { if (e) fail('pipeline ' + entry + ': ' + e.message); });
    return p;
  };
  const pBase = cp(lBase, 'csBase'), pDet = cp(lDet, 'csDetail'), pMip = cp(lMip, 'csMip');
  pWeather = cp(lWx, 'csWeather', shader(CLIP + WX, 'cloudwx'));
  const bgOf = (l, list) => d.createBindGroup({ layout: l, entries: list });
  const enc = d.createCommandEncoder();
  const view0 = ctx.views.length ? ctx.views[0].bg0 : null;
  const run = (p, bg, n) => {
    const c = enc.beginComputePass();
    c.setPipeline(p); if (view0) c.setBindGroup(0, view0); c.setBindGroup(1, bg);
    const g = Math.ceil(n / 4); c.dispatchWorkgroups(g, g, g); c.end();
  };
  run(pBase, bgOf(lBase, [{ binding: 0, resource: base.createView({ baseMipLevel: 0, mipLevelCount: 1 }) }]), BASE_N);
  run(pDet, bgOf(lDet, [{ binding: 1, resource: detV }]), DET_N);
  for (let m = 1; m < BASE_MIPS; m++) {
    run(pMip, bgOf(lMip, [
      { binding: 2, resource: base.createView({ baseMipLevel: m - 1, mipLevelCount: 1 }) },
      { binding: 3, resource: base.createView({ baseMipLevel: m, mipLevelCount: 1 }) }]), BASE_N >> m);
  }
  G.queue.submit([enc.finish()]);

  // ---- weather window ----
  const wx = tex(WN, WN, 'rgba16float', U.STORAGE_BINDING | U.TEXTURE_BINDING, { label: 'cloudWx' });
  const wy = tex(WN, WN, 'rgba16float', U.STORAGE_BINDING | U.TEXTURE_BINDING, { label: 'cloudWy' });
  wxV = wx.createView(); wyV = wy.createView();
  bgWeather = bgOf(lWx, [{ binding: 0, resource: wxV }, { binding: 1, resource: wyV }, { binding: 2, resource: { buffer: cuBuf } }]);
  wxDesc = { label: 'cloud weather', timestampWrites: tsBoth(TS_WEATHER) };

  // ---- march ----
  blMarch = bgl('uFFffnssB', 'clouds');
  const mmod = shader(CLIP + SKY + CLOUDS, 'clouds');
  pMarch = pipeline({ label: 'clouds', module: mmod, vs: 'vsC', fs: 'fsC', layouts: [ctx.bgl0, clip.bgl, blMarch],
    targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'r16float' }] });
}

export function bind(ctx, tg) {
  // half resolution; quarter on quality=low (the march is ~4x cheaper, the upsample hides most of it); a third in VR
  // (ctx.cloudDiv from main.js: every eye is large and the frame short)
  const k = ctx.cloudDiv || (ctx.quality === 0 ? 4 : 2);
  const w = Math.max(1, Math.ceil(tg.w / k)), h = Math.max(1, Math.ceil(tg.h / k));
  const RT = U.RENDER_ATTACHMENT | U.TEXTURE_BINDING;
  clouds.view = tex(w, h, 'rgba16float', RT, { label: 'clouds' }).createView();
  clouds.reflView = tex(w, h, 'rgba16float', RT, { label: 'cloudsRefl' }).createView();
  clouds.distView = tex(w, h, 'r16float', RT, { label: 'cloudsDist' }).createView();
  clouds.w = w; clouds.h = h;
  CU[12] = w; CU[13] = h; CU[14] = 1 / w; CU[15] = 1 / h;
  const rep = G.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  bgMarch = bindGroup(blMarch, [cuBuf, baseV, detV, wxV, wyV, tg.distV, rep, ctx.linear, stBuf]);
  const at = (v) => ({ view: v, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } });
  marchDesc = { colorAttachments: [at(clouds.view), at(clouds.reflView), at(clouds.distView)], timestampWrites: tsBoth(TS_CLOUDS) };
  return clouds.view;
}

// first view only: place the weather window around the camera and upload the cloud uniforms
export function prepare(view) {
  // weather window: snapped to its texels around the camera
  const d = view.data;
  CU[2] = WTEX; CU[3] = WN;
  // round via an int (|0) rather than Math.round: a builtin call returns a boxed double where the caller is not
  // fully optimised (the VR loop caught it); +2^20 keeps the truncation a floor for any position on the planet
  CU[0] = (((d[32] / WTEX + 1048576.5) | 0) - 1048576) * WTEX - WN * 0.5 * WTEX;
  CU[1] = (((d[34] / WTEX + 1048576.5) | 0) - 1048576) * WTEX - WN * 0.5 * WTEX;
  // the camera's realm weights: a realm's own clouds are full, its neighbours' are thinned (csWeather).
  // W_IN + realmWeightsA: passing the doubles as arguments would box them every frame
  W_IN[0] = d[32]; W_IN[1] = d[34]; realmWeightsA();
  for (let i = 0; i < 4; i++) { CU[16 + i] = W_ID[i]; CU[20 + i] = W_W[i]; }
  CU.set(WX_BOLT, 24); // lightning (weather.js, set in prepareFrame)
  G.queue.writeBuffer(cuBuf, 0, CU);
}

// returns 1 when this view also baked the weather window (timer slot TS_WEATHER)
export function draw(ctx, enc, view) {
  let wx = 0;
  if (view === ctx.views[0]) {
    prepare(view);
    const c = enc.beginComputePass(wxDesc);
    wx = 1;
    c.setPipeline(pWeather); c.setBindGroup(0, view.bg0); c.setBindGroup(1, clip.bg); c.setBindGroup(2, bgWeather);
    c.dispatchWorkgroups(WN / 8, WN / 8); c.end();
  }
  const counting = CU[28] > 0 && view === ctx.views[0];
  if (counting) enc.clearBuffer(stBuf);
  const p = enc.beginRenderPass(marchDesc);
  p.setPipeline(pMarch);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, clip.bg); p.setBindGroup(2, bgMarch);
  p.draw(3); p.end();
  if (counting && !stBusy && (++stFrame & 3) === 0) { enc.copyBufferToBuffer(stBuf, 0, stRead, 0, NST * 4); stBusy = true; pendingRead = 1; }
  return wx;
}

// after the frame's submit (main.js): map the copy made this frame; instrumentation only (it allocates)
let pendingRead = 0;
export function afterSubmit() {
  if (!pendingRead) return;
  pendingRead = 0;
  stRead.mapAsync(GPUMapMode.READ).then(() => {
    const a = new Uint32Array(stRead.getMappedRange());
    for (let i = 0; i < NST; i++) STEPS[i] += a[i];
    stRead.unmap(); stBusy = false;
  }, () => { stBusy = false; });
}

// bench JSON: average evaluations per ray by kind and the percentiles of the per-ray total (steps=1 only)
export function stepReport() {
  if (!(CU[28] > 0) || STEPS[0] === 0) return null;
  const n = STEPS[0], r = (i) => Math.round(STEPS[i] / n * 10) / 10;
  const pct = (q) => { let c = 0; for (let b = 0; b < 64; b++) { c += STEPS[8 + b]; if (c >= q * n) return b * 16 + 16; } return 1024; };
  return { rays: n, perRay: { mainIter: r(1), dense: r(2), light: r(3), veil: r(4), precip: r(5), mirror: r(6), total: r(7) },
    byClass: { sky: [STEPS[72], STEPS[73] / Math.max(STEPS[72], 1)], ground: [STEPS[74], STEPS[75] / Math.max(STEPS[74], 1)],
      horizon: [STEPS[76], STEPS[77] / Math.max(STEPS[76], 1)], mirror: [STEPS[78], STEPS[79] / Math.max(STEPS[78], 1)] },
    totalP50: pct(0.5), totalP90: pct(0.9), totalP99: pct(0.99), hist16: Array.from(STEPS.subarray(8, 72)) };
}
