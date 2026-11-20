// fx/atmo.js: the physical sky, baked per frame (wgsl/atmo.wgsl) from the camera's blended realm row: a
// transmittance LUT and the sky-view LUT every shader reads through group 0 (common.wgsl atmoT / atmoS).
// Cost: 64x32x16 + 256x128x24 samples, two small dispatches (well under 0.1 ms on the reference GPU).
// Zero per-frame allocations: descriptors and bind groups are built once.
import { G, fail, shader, tex, buffer } from '../gpu.js';
import ATMO from '../wgsl/atmo.wgsl';

export const atmo = { view: null, sampler: null, csm: null };
// cloud-shadow map: CSM_N^2 texels of CSM_T m, top-down, centred on the camera (common.wgsl cloudShadowF)
const CSM_N = 512, CSM_T = 48;
let pC, bgF2, bgC;
const TW = 64, TH = 32, SW = 256, SH = 129;
let pT, pS, bgF, bgT, bgS, auBuf;
const AU = new Float32Array(4);

let CTX = null, SO = 0, FL = 0, OFFB = 0, baked = false;
// sunOfs: FO.sun in the frame uniforms (FR.sun.w is the drift); flagsOfs: FO.flags (yzw: the cloud-shadow map's
// origin and texel size); offBit: OFF_ATMO; realmBuf: the realm table (the shadow map blends realms)
export function init(ctx, sunOfs, flagsOfs, offBit, realmBuf) {
  CTX = ctx; SO = sunOfs; FL = flagsOfs; OFFB = offBit;
  const d = G.device;
  const U = GPUTextureUsage;
  const trans = tex(TW, TH, 'rgba16float', U.STORAGE_BINDING | U.TEXTURE_BINDING, { label: 'atmoTrans' });
  const sky = tex(SW, SH, 'rgba16float', U.STORAGE_BINDING | U.TEXTURE_BINDING, { label: 'atmoSky' });
  atmo.view = sky.createView();
  atmo.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
  const clampS = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  auBuf = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'atmoU');
  const C = GPUShaderStage.COMPUTE;
  const st = (b) => ({ binding: b, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' } });
  const lF = d.createBindGroupLayout({ label: 'atmoF', entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }] });
  const lT = d.createBindGroupLayout({ label: 'atmoT', entries: [st(0), { binding: 3, visibility: C, buffer: { type: 'uniform' } }] });
  const lS = d.createBindGroupLayout({ label: 'atmoS', entries: [st(1),
    { binding: 2, visibility: C, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 3, visibility: C, buffer: { type: 'uniform' } },
    { binding: 4, visibility: C, sampler: { type: 'filtering' } }] });
  bgF = d.createBindGroup({ layout: lF, entries: [{ binding: 0, resource: { buffer: ctx.frameBuf } }] });
  bgT = d.createBindGroup({ layout: lT, entries: [{ binding: 0, resource: trans.createView() }, { binding: 3, resource: { buffer: auBuf } }] });
  bgS = d.createBindGroup({ layout: lS, entries: [{ binding: 1, resource: atmo.view }, { binding: 2, resource: trans.createView() },
    { binding: 3, resource: { buffer: auBuf } }, { binding: 4, resource: clampS }] });
  const mod = shader(ATMO, 'atmo');
  const cp = (l, entry) => {
    d.pushErrorScope('validation');
    const p = d.createComputePipeline({ label: entry, layout: d.createPipelineLayout({ bindGroupLayouts: [lF, l] }), compute: { module: mod, entryPoint: entry } });
    d.popErrorScope().then((e) => { if (e) fail('pipeline ' + entry + ': ' + e.message); });
    return p;
  };
  pT = cp(lT, 'csTrans'); pS = cp(lS, 'csSky');
  // cloud-shadow map: needs the realm table too
  const csm = tex(CSM_N, CSM_N, 'rgba16float', U.STORAGE_BINDING | U.TEXTURE_BINDING, { label: 'cloudShadowMap' });
  atmo.csm = csm.createView();
  const lF2 = d.createBindGroupLayout({ label: 'atmoF2', entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } },
    { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } }] });
  const lC = d.createBindGroupLayout({ label: 'atmoC', entries: [st(5)] });
  bgF2 = d.createBindGroup({ layout: lF2, entries: [{ binding: 0, resource: { buffer: ctx.frameBuf } }, { binding: 2, resource: { buffer: realmBuf } }] });
  bgC = d.createBindGroup({ layout: lC, entries: [{ binding: 5, resource: atmo.csm }] });
  d.pushErrorScope('validation');
  pC = d.createComputePipeline({ label: 'csCloudShadow', layout: d.createPipelineLayout({ bindGroupLayouts: [lF2, lC] }), compute: { module: mod, entryPoint: 'csCloudShadow' } });
  d.popErrorScope().then((e) => { if (e) fail('pipeline csCloudShadow: ' + e.message); });
}

// once per frame (all views and both XR eyes share it), before the frame uniforms are uploaded (it sets the
// shadow map's window in them) and before any view draws. cam: main.js cam (x, y, z in m); arrays only, a double
// argument would be boxed every frame. off=atmo: bake the LUTs once, then keep them (bench ablation)
export function bake(enc, cam) {
  const fr = CTX.frame;
  fr[FL + 1] = Math.round(cam[0] / CSM_T) * CSM_T - CSM_N * 0.5 * CSM_T;
  fr[FL + 2] = Math.round(cam[2] / CSM_T) * CSM_T - CSM_N * 0.5 * CSM_T;
  fr[FL + 3] = CSM_T;
  const c = enc.beginComputePass();
  // cloud shadows move with the wind: every frame (0.26 M texels, one coverage lookup each)
  c.setBindGroup(0, bgF2); c.setPipeline(pC); c.setBindGroup(1, bgC); c.dispatchWorkgroups(CSM_N / 8, CSM_N / 8);
  if (baked && (CTX.off & OFFB)) { c.end(); return; }
  baked = true;
  AU[0] = cam[1]; AU[1] = fr[SO + 3];
  G.queue.writeBuffer(auBuf, 0, AU);
  c.setBindGroup(0, bgF);
  c.setPipeline(pT); c.setBindGroup(1, bgT); c.dispatchWorkgroups(TW / 8, TH / 8);
  c.setPipeline(pS); c.setBindGroup(1, bgS); c.dispatchWorkgroups(SW / 8, Math.ceil(SH / 8));
  c.end();
}
