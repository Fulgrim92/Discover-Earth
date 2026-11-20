// gpu.js: device, error surfacing, shader modules, layout helpers, uniform block layout.
import { wgslPreamble, ROW } from './realms.js';
import COMMON from './wgsl/common.wgsl';

export const H = (globalThis.__halcyon = globalThis.__halcyon || { ready: false, frame: 0, error: null });

export function fail(msg) {
  const m = String(msg);
  if (!H.error) H.error = m; else if (H.error.length < 20000) H.error += '\n' + m;
  console.error('[halcyon] ' + m);
}

export const G = { device: null, queue: null, adapter: null, f32filter: false, timestamp: false, clipFormat: 'rgba32float', canvasFormat: 'bgra8unorm', p3: false, hdr: false, lost: null, xrCompatible: false };

// Errors that mean "this machine cannot run HALCYON" (shown as a friendly message, not a stack trace)
export class Unsupported extends Error {}

export async function initDevice(opts) {
  if (!navigator.gpu) throw new Unsupported('nogpu');
  let adapter = null;
  // VR (xr.js): an XR-compatible adapter (WebXR/WebGPU binding: GPURequestAdapterOptions.xrCompatible; there is no
  // makeXRCompatible for WebGPU, so it must be asked for up front). Falls back to a plain adapter if refused.
  if (opts && opts.xrCompatible) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance', xrCompatible: true }); } catch (e) { adapter = null; }
    G.xrCompatible = !!adapter;
  }
  if (!adapter) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch (e) { adapter = null; }
  }
  if (!adapter) throw new Unsupported('noadapter');
  const req = [];
  if (adapter.features.has('float32-filterable')) { req.push('float32-filterable'); G.f32filter = true; }
  if (adapter.features.has('timestamp-query') && !(opts && opts.noTimer)) { req.push('timestamp-query'); G.timestamp = true; }
  const device = await adapter.requestDevice({ requiredFeatures: req });
  device.addEventListener('uncapturederror', (e) => fail('GPU: ' + e.error.message));
  device.lost.then((i) => {
    if (i.reason === 'destroyed') return;
    fail('device lost: ' + i.message);
    if (G.lost) G.lost(i);
  });
  G.device = device; G.queue = device.queue; G.adapter = adapter;
  PIPES.async = !(opts && opts.syncPipelines);
  G.clipFormat = G.f32filter ? 'rgba32float' : 'rgba16float';
  if (G.timestamp) initTimestamps();
  return device;
}

// ---------- GPU pass timer (timestamp-query) ----------
// Each timed pass names a slot in TS_PASSES. Modules put tsBoth/tsBegin/tsEnd(slot) into their pass descriptors
// at init (undefined when the feature is missing, which WebGPU treats as absent). The objects are mutated in place
// by setTimerBase() before each view, so no descriptor is rebuilt per frame. perf.js resolves and reads them back.
// TS_FLORA / TS_FAUNA only run with ?split=1, which splits the opaque pass into terrain (+ sky, drone) / flora / fauna.
export const TS_BAKE = 0, TS_OPAQUE = 1, TS_CLOUDS = 2, TS_COMPOSITE = 3, TS_FX = 4, TS_BLOOM = 5, TS_FINAL = 6, TS_LIFE = 7,
  TS_WEATHER = 8, TS_FLORA = 9, TS_FAUNA = 10, TS_N = 11;
export const TS_PASSES = ['bake', 'opaque', 'clouds', 'composite', 'fx', 'bloom', 'final', 'life', 'weather', 'flora', 'fauna'];
// passes encoded once per frame (in the first view's timer block), not once per view
export const TS_ONCE = (1 << TS_BAKE) | (1 << TS_WEATHER);
export const TS_SLOTS = 32;                 // frames in the query ring
export const TS_PER_FRAME = 64;             // >= passes x (begin, end) x 2 views = 44, in 32-query (256-byte) steps: resolve offsets must be 256-byte aligned
export const TS = { set: null, both: [], begin: [], end: [] };

function initTimestamps() {
  TS.set = G.device.createQuerySet({ type: 'timestamp', count: TS_SLOTS * TS_PER_FRAME, label: 'timer' });
  for (let i = 0; i < TS_N; i++) {
    TS.both[i] = { querySet: TS.set, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
    TS.begin[i] = { querySet: TS.set, beginningOfPassWriteIndex: i * 2 };
    TS.end[i] = { querySet: TS.set, endOfPassWriteIndex: i * 2 + 1 };
  }
}
export function tsBoth(i) { return TS.set ? TS.both[i] : undefined; }
export function tsBegin(i) { return TS.set ? TS.begin[i] : undefined; }
export function tsEnd(i) { return TS.set ? TS.end[i] : undefined; }
// point every timed pass at frame slot `slot`, view `view` (called before each view is encoded)
export function setTimerBase(slot, view) {
  if (!TS.set) return;
  const base = slot * TS_PER_FRAME + view * TS_N * 2;
  for (let i = 0; i < TS_N; i++) {
    const b = base + i * 2;
    TS.both[i].beginningOfPassWriteIndex = b; TS.both[i].endOfPassWriteIndex = b + 1;
    TS.begin[i].beginningOfPassWriteIndex = b; TS.end[i].endOfPassWriteIndex = b + 1;
  }
}

// Uniform block sizes (bytes). Offsets in floats, matching common.wgsl Frame/View.
export const FRAME_FLOATS = 4 * 3 + 4 * 12 * 2 + ROW * 4 + 4 + 4;
export const FO = { time: 0, sun: 4, misc: 8, lv: 12, mc: 12 + 48, row: 12 + 96, flags: 12 + 96 + ROW * 4, sky: 12 + 96 + ROW * 4 + 4 };
export const VIEW_FLOATS = 16 * 2 + 4 * 8;
export const VO = { vp: 0, ivp: 16, cam: 32, size: 36, fwd: 40, ofs: 44, right: 48, up: 52, skew: 56, anc: 60 };

const PRE = wgslPreamble() + COMMON;

export function shader(code, label) {
  const src = PRE + '\n' + code;
  const m = G.device.createShaderModule({ code: src, label });
  m.getCompilationInfo().then((info) => {
    for (const msg of info.messages) {
      if (msg.type === 'error') {
        const lines = src.split('\n');
        fail('WGSL ' + label + ':' + msg.lineNum + ':' + msg.linePos + ' ' + msg.message + '  >> ' + (lines[msg.lineNum - 1] || '').trim());
      }
    }
  });
  return m;
}

// bind group layout from a compact list: 'u' uniform, 'r' read-only storage, 'f' float texture 2d, 'a' float 2d-array,
// 'n' unfilterable-float 2d, 'd' depth 2d, 'F' float 3d, 's' filtering sampler, 'S' non-filtering sampler
export function bgl(spec, label) {
  const entries = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    const e = { binding: i, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE };
    if (c === 'u') e.buffer = { type: 'uniform' };
    else if (c === 'r') e.buffer = { type: 'read-only-storage' };
    else if (c === 'f') e.texture = { sampleType: 'float', viewDimension: '2d' };
    else if (c === 'a') e.texture = { sampleType: 'float', viewDimension: '2d-array' };
    else if (c === 'n') e.texture = { sampleType: 'unfilterable-float', viewDimension: '2d' };
    else if (c === 'F') e.texture = { sampleType: 'float', viewDimension: '3d' };
    else if (c === 's') e.sampler = { type: 'filtering' };
    else if (c === 'S') e.sampler = { type: 'non-filtering' };
    else if (c === 'w') e.storageTexture = { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' };
    if (c === 'w') e.visibility = GPUShaderStage.COMPUTE;
    entries.push(e);
  }
  return G.device.createBindGroupLayout({ entries, label });
}

export function bindGroup(layout, resources, label) {
  const entries = [];
  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    entries.push({ binding: i, resource: r instanceof GPUBuffer ? { buffer: r } : r });
  }
  return G.device.createBindGroup({ layout, entries, label });
}

export function tex(w, h, format, usage, opts) {
  const d = { size: [w, h, (opts && opts.layers) || 1], format, usage, label: opts && opts.label };
  if (opts && opts.samples) d.sampleCount = opts.samples;
  if (opts && opts.dim) d.dimension = opts.dim;
  if (opts && opts.mips) d.mipLevelCount = opts.mips;
  return G.device.createTexture(d);
}

export function buffer(size, usage, label) {
  return G.device.createBuffer({ size: (size + 15) & ~15, usage, label });
}

// render pipeline helper: fullscreen-triangle or custom.
// Start-up: the first batch of pipelines compiles in parallel off the main thread. While PIPES.async is set (from
// initDevice until pipelinesReady() resolves) pipeline() starts createRenderPipelineAsync and returns a stand-in
// { real } that GPURenderPassEncoder.setPipeline unwraps (patched once below), so no module has to change how it
// keeps its pipelines. Pipelines made later (HDR toggle, XR format) are created synchronously as before.
export const PIPES = { async: false, list: [], done: 0, failed: 0 };
let patched = false;
function patchSetPipeline() {
  if (patched) return;
  patched = true;
  const proto = GPURenderPassEncoder.prototype, orig = proto.setPipeline;
  proto.setPipeline = function (p) { orig.call(this, p.real !== undefined ? p.real : p); };
}
export function pipeline(o) {
  const d = {
    label: o.label,
    layout: G.device.createPipelineLayout({ bindGroupLayouts: o.layouts }),
    vertex: { module: o.module, entryPoint: o.vs || 'vs' },
    fragment: { module: o.module, entryPoint: o.fs || 'fs', targets: o.targets },
    primitive: { topology: o.topology || 'triangle-list', cullMode: o.cull || 'none' },
  };
  if (o.depth) d.depthStencil = o.depth;
  if (o.samples) d.multisample = { count: o.samples, alphaToCoverageEnabled: !!o.a2c };
  if (PIPES.async && G.device.createRenderPipelineAsync) {
    patchSetPipeline();
    const stand = { real: null, label: o.label };
    PIPES.list.push(G.device.createRenderPipelineAsync(d).then(
      (p) => { stand.real = p; PIPES.done++; },
      (e) => { PIPES.failed++; PIPES.done++; fail('pipeline ' + o.label + ': ' + (e && e.message)); }));
    return stand;
  }
  G.device.pushErrorScope('validation');
  const p = G.device.createRenderPipeline(d);
  G.device.popErrorScope().then((e) => { if (e) fail('pipeline ' + o.label + ': ' + e.message); });
  return p;
}
// resolves when every pipeline started by pipeline() so far has compiled; progress(done, total) after each one
export async function pipelinesReady(progress) {
  const n = PIPES.list.length;
  if (progress) {
    progress(PIPES.done, n);
    for (const pr of PIPES.list) pr.then(() => progress(PIPES.done, n));
  }
  await Promise.all(PIPES.list);
  PIPES.async = false; PIPES.list.length = 0;
  if (PIPES.failed) throw new Error(PIPES.failed + ' pipeline(s) failed to compile (see the errors above)');
}

export function computePipeline(module, layouts, label) {
  G.device.pushErrorScope('validation');
  const p = G.device.createComputePipeline({ label, layout: G.device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module, entryPoint: 'cs' } });
  G.device.popErrorScope().then((e) => { if (e) fail('pipeline ' + label + ': ' + e.message); });
  return p;
}
