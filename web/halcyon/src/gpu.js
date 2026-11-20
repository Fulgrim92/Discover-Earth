// gpu.js: device, error surfacing, shader modules, layout helpers, uniform block layout.
import { wgslPreamble, ROW } from './realms.js';
import COMMON from './wgsl/common.wgsl';

export const H = (globalThis.__halcyon = globalThis.__halcyon || { ready: false, frame: 0, error: null });

export function fail(msg) {
  const m = String(msg);
  if (!H.error) H.error = m; else if (H.error.length < 20000) H.error += '\n' + m;
  console.error('[halcyon] ' + m);
}

export const G = { device: null, queue: null, adapter: null, f32filter: false, timestamp: false, clipFormat: 'rgba32float', canvasFormat: 'bgra8unorm', p3: false };

export async function initDevice() {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const req = [];
  if (adapter.features.has('float32-filterable')) { req.push('float32-filterable'); G.f32filter = true; }
  if (adapter.features.has('timestamp-query')) { req.push('timestamp-query'); G.timestamp = true; }
  const device = await adapter.requestDevice({ requiredFeatures: req });
  device.addEventListener('uncapturederror', (e) => fail('GPU: ' + e.error.message));
  device.lost.then((i) => { if (i.reason !== 'destroyed') fail('device lost: ' + i.message); });
  G.device = device; G.queue = device.queue; G.adapter = adapter;
  G.clipFormat = G.f32filter ? 'rgba32float' : 'rgba16float';
  return device;
}

// Uniform block sizes (bytes). Offsets in floats, matching common.wgsl Frame/View.
export const FRAME_FLOATS = 4 * 3 + 4 * 12 * 2 + ROW * 4;
export const FO = { time: 0, sun: 4, misc: 8, lv: 12, mc: 12 + 48, row: 12 + 96 };
export const VIEW_FLOATS = 16 * 2 + 4 * 6;
export const VO = { vp: 0, ivp: 16, cam: 32, size: 36, fwd: 40, ofs: 44, right: 48, up: 52 };

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

// render pipeline helper: fullscreen-triangle or custom
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
  G.device.pushErrorScope('validation');
  const p = G.device.createRenderPipeline(d);
  G.device.popErrorScope().then((e) => { if (e) fail('pipeline ' + o.label + ': ' + e.message); });
  return p;
}

export function computePipeline(module, layouts, label) {
  G.device.pushErrorScope('validation');
  const p = G.device.createComputePipeline({ label, layout: G.device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module, entryPoint: 'cs' } });
  G.device.popErrorScope().then((e) => { if (e) fail('pipeline ' + label + ': ' + e.message); });
  return p;
}
