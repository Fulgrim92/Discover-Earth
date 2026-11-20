// fx/composite.js: full-screen composite (water, fog, cloud sea, high clouds) over the resolved opaque scene.
import { lifeFx, init as lifeInit } from './lifefx.js';
import LFXW from '../wgsl/lifefx.wgsl';
import { G, shader, bgl, bindGroup, pipeline, tsBoth, TS_COMPOSITE } from '../gpu.js';
import { clip } from './clipmap.js';
import { clouds } from './clouds.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import COMP from '../wgsl/composite.wgsl';

let pComp, bl2, bg2, desc;

// Life ripples on the water (living-world's fx/lifefx.js + wgsl/lifefx.wgsl). Until those files land this stays false
// and the water calls a zero stub. To wire it: import { lifeFx } from './lifefx.js' and LFXW from '../wgsl/lifefx.wgsl',
// set LIFEFX = true, use LFX_SRC below, add lifeFx.bgl as layout 3 and setBindGroup(3, lifeFx.bg) in draw().
const LIFEFX = true;
const LFX_STUB = 'fn lfWater(p: vec2f, t: f32) -> vec3f { return vec3f(0.0); }\n';
const LFX_SRC = '@group(3) @binding(0) var<uniform> LFX: LifeFx;\n' + LFXW + 'fn lfWater(p: vec2f, t: f32) -> vec3f { return lfRipple(p, t); }\n';

export function init(ctx) {
  lifeInit(); // idempotent: the ripple uniform may be made here before flora.init
  bl2 = bgl('fffsff', 'comp2'); // + clouds in the mirror, cloud march distance
  const mod = shader(CLIP + SKY + (LIFEFX ? LFX_SRC : LFX_STUB) + COMP, 'composite');
  pComp = pipeline({ label: 'composite', module: mod, layouts: [ctx.bgl0, clip.bgl, bl2, lifeFx.bgl], targets: [{ format: 'rgba16float' }] });
}

// (re)bind to the view targets
export function bind(ctx, tg) {
  bg2 = bindGroup(bl2, [tg.sceneV, tg.distV, tg.cloudV, ctx.linear, clouds.reflView, clouds.distView]);
  desc = { colorAttachments: [{ view: tg.compV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }], timestampWrites: tsBoth(TS_COMPOSITE) };
}

export function draw(ctx, enc, view) {
  const p = enc.beginRenderPass(desc);
  p.setPipeline(pComp);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, clip.bg); p.setBindGroup(2, bg2); p.setBindGroup(3, lifeFx.bg);
  p.draw(3); p.end();
}
