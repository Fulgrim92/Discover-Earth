// fx/clouds.js: half-resolution volumetric clouds (DESIGN section 6 step 3).
// Start: bake tileable Perlin-Worley 3D noise (128^3 + 4 mips) and Worley detail (32^3) once on the GPU.
// Per frame (first view): bake the camera-centred weather window (coverage + realm-blended layer parameters,
// cloudnoise.wgsl csWeather). Per view: march the clouds at half resolution (clouds.wgsl) into three targets
// that composite.wgsl upsamples with depth awareness: front clouds, clouds in the water mirror, march distance.
// Debug views (URL dbg=): 9 no clouds (composite), 10 weather coverage on the ground, 13 no march jitter,
// 16 density probe at the camera realm's mid-layer.
// Zero per-frame allocations: descriptors, bind groups and the uniform block are built here once.
import { G, fail, shader, bgl, bindGroup, tex, buffer, pipeline } from '../gpu.js';
import { clip } from './clipmap.js';
import { TABLE, ROWF, F, NREALM, realmWeights, W_ID, W_W } from '../realms.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import NOISE from '../wgsl/cloudnoise.wgsl';
import CLOUDS from '../wgsl/clouds.wgsl';
import WX from '../wgsl/cloudwx.wgsl';

const BASE_N = 128, BASE_MIPS = 4, DET_N = 64;
export const clouds = { view: null, reflView: null, distView: null, w: 1, h: 1 };

const U = GPUTextureUsage;
let pMarch, blMarch, bgMarch = null, pWeather, bgWeather, cuBuf, wxV, wyV, baseV, detV, marchDesc;
let WN = 512, WTEX = 128;
const CU = new Float32Array(24);

function layout(entries, label) { return G.device.createBindGroupLayout({ entries, label }); }
const CS = () => GPUShaderStage.COMPUTE;
const VF = () => GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

export function init(ctx) {
  const d = G.device;
  const q = ctx.quality;
  WN = q === 0 ? 256 : 512; WTEX = q === 0 ? 220 : 128;
  // march budget: primary steps, light steps, max distance (m), reflection steps
  CU[8] = q === 0 ? 64 : q === 2 ? 128 : 96; CU[9] = q === 0 ? 4 : 6; CU[10] = WN * WTEX * 0.5; CU[11] = q === 0 ? 20 : 28;
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
  cuBuf = buffer(96, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'cloudU');

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

  // ---- march ----
  blMarch = bgl('uFFffnss', 'clouds');
  const mmod = shader(CLIP + SKY + CLOUDS, 'clouds');
  pMarch = pipeline({ label: 'clouds', module: mmod, vs: 'vsC', fs: 'fsC', layouts: [ctx.bgl0, clip.bgl, blMarch],
    targets: [{ format: 'rgba16float' }, { format: 'rgba16float' }, { format: 'r16float' }] });
}

export function bind(ctx, tg) {
  const w = Math.max(1, tg.w >> 1), h = Math.max(1, tg.h >> 1);
  const RT = U.RENDER_ATTACHMENT | U.TEXTURE_BINDING;
  clouds.view = tex(w, h, 'rgba16float', RT, { label: 'clouds' }).createView();
  clouds.reflView = tex(w, h, 'rgba16float', RT, { label: 'cloudsRefl' }).createView();
  clouds.distView = tex(w, h, 'r16float', RT, { label: 'cloudsDist' }).createView();
  clouds.w = w; clouds.h = h;
  CU[12] = w; CU[13] = h; CU[14] = 1 / w; CU[15] = 1 / h;
  const rep = G.device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  bgMarch = bindGroup(blMarch, [cuBuf, baseV, detV, wxV, wyV, tg.distV, rep, ctx.linear]);
  const at = (v) => ({ view: v, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } });
  marchDesc = { colorAttachments: [at(clouds.view), at(clouds.reflView), at(clouds.distView)] };
  return clouds.view;
}

export function draw(ctx, enc, view) {
  if (view === ctx.views[0]) {
    // weather window: snapped to its texels around the camera
    const cx = view.data[32], cz = view.data[34];
    CU[2] = WTEX; CU[3] = WN;
    CU[0] = Math.round(cx / WTEX) * WTEX - WN * 0.5 * WTEX;
    CU[1] = Math.round(cz / WTEX) * WTEX - WN * 0.5 * WTEX;
    // the camera's realm weights: a realm's own clouds are full, its neighbours' are thinned (csWeather)
    realmWeights(cx, cz);
    for (let i = 0; i < 4; i++) { CU[16 + i] = W_ID[i]; CU[20 + i] = W_W[i]; }
    G.queue.writeBuffer(cuBuf, 0, CU);
    const c = enc.beginComputePass();
    c.setPipeline(pWeather); c.setBindGroup(0, view.bg0); c.setBindGroup(1, clip.bg); c.setBindGroup(2, bgWeather);
    c.dispatchWorkgroups(WN / 8, WN / 8); c.end();
  }
  const p = enc.beginRenderPass(marchDesc);
  p.setPipeline(pMarch);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, clip.bg); p.setBindGroup(2, bgMarch);
  p.draw(3); p.end();
}
