// fx/post.js: bloom chain (6 levels down, tent up), then tone map / grade / vignette / dither into the canvas.
import { G, shader, bgl, bindGroup, tex, pipeline } from '../gpu.js';
import POST from '../wgsl/post.wgsl';

const NB = 6;
let pDown, pUp, pFinal, bl1;
const down = [], up = [], downBG = [], upBG = [], downDesc = [], upDesc = [];
let finalBG;
export const finalDesc = [null, null]; // [clear, load]

export function init(ctx) {
  bl1 = bgl('fsf', 'post1');
  const mod = shader(POST, 'post');
  const lay = [ctx.bgl0, bl1];
  pDown = pipeline({ label: 'bloomDown', module: mod, fs: 'fsDown', layouts: lay, targets: [{ format: 'rgba16float' }] });
  pUp = pipeline({ label: 'bloomUp', module: mod, fs: 'fsUp', layouts: lay, targets: [{ format: 'rgba16float' }] });
  pFinal = pipeline({ label: 'final', module: mod, fs: 'fsFinal', layouts: lay, targets: [{ format: G.canvasFormat }] });
  finalDesc[0] = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] };
  finalDesc[1] = { colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }] };
}

export function bind(ctx, tg) {
  const U = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  let w = tg.w, h = tg.h;
  for (let i = 0; i < NB; i++) {
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    down[i] = tex(w, h, 'rgba16float', U, { label: 'bd' + i }).createView();
    up[i] = i < NB - 1 ? tex(w, h, 'rgba16float', U, { label: 'bu' + i }).createView() : down[i];
  }
  for (let i = 0; i < NB; i++) {
    const src = i === 0 ? tg.compV : down[i - 1];
    downBG[i] = bindGroup(bl1, [src, ctx.linear, tg.sceneV]);
    downDesc[i] = { colorAttachments: [{ view: down[i], loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] };
  }
  for (let i = NB - 2; i >= 0; i--) {
    upBG[i] = bindGroup(bl1, [up[i + 1], ctx.linear, down[i]]);
    upDesc[i] = { colorAttachments: [{ view: up[i], loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] };
  }
  finalBG = bindGroup(bl1, [tg.compV, ctx.linear, up[0]]);
}

export function draw(ctx, enc, view, canvasView, first) {
  for (let i = 0; i < NB; i++) {
    const p = enc.beginRenderPass(downDesc[i]);
    p.setPipeline(pDown); p.setBindGroup(0, view.bg0); p.setBindGroup(1, downBG[i]); p.draw(3); p.end();
  }
  for (let i = NB - 2; i >= 0; i--) {
    const p = enc.beginRenderPass(upDesc[i]);
    p.setPipeline(pUp); p.setBindGroup(0, view.bg0); p.setBindGroup(1, upBG[i]); p.draw(3); p.end();
  }
  const fd = finalDesc[first ? 0 : 1];
  fd.colorAttachments[0].view = canvasView;
  const p = enc.beginRenderPass(fd);
  p.setPipeline(pFinal); p.setBindGroup(0, view.bg0); p.setBindGroup(1, finalBG);
  p.setViewport(view.vx, view.vy, view.vw, view.vh, 0, 1);
  p.setScissorRect(view.vx, view.vy, view.vw, view.vh);
  p.draw(3); p.end();
}
