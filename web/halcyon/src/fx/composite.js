// fx/composite.js: full-screen composite (water, fog, cloud sea, high clouds) over the resolved opaque scene.
import { G, shader, bgl, bindGroup, pipeline, tsBoth, TS_COMPOSITE } from '../gpu.js';
import { clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import COMP from '../wgsl/composite.wgsl';

let pComp, bl2, bg2, desc;

export function init(ctx) {
  bl2 = bgl('fffs', 'comp2');
  const mod = shader(CLIP + SKY + COMP, 'composite');
  pComp = pipeline({ label: 'composite', module: mod, layouts: [ctx.bgl0, clip.bgl, bl2], targets: [{ format: 'rgba16float' }] });
}

// (re)bind to the view targets
export function bind(ctx, tg) {
  bg2 = bindGroup(bl2, [tg.sceneV, tg.distV, tg.cloudV, ctx.linear]);
  desc = { colorAttachments: [{ view: tg.compV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }], timestampWrites: tsBoth(TS_COMPOSITE) };
}

export function draw(ctx, enc, view) {
  const p = enc.beginRenderPass(desc);
  p.setPipeline(pComp);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, clip.bg); p.setBindGroup(2, bg2);
  p.draw(3); p.end();
}
