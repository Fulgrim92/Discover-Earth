// fx/particles.js: motes around the camera (pollen and seed fluff, salt glints, snow / diamond dust, spores,
// fireflies), additive into the composited HDR image, depth-tested against the resolved linear depth. Also owns the
// blended pass after the composite, where fauna.js draws the jellies and the flamingos' reflections.
// Instance cap: 8192 motes (2048 at quality=low), 4 vertices each; the pass is skipped when nothing in it has
// weight at the camera.
import { bindGroup, pipeline, shader, FO, tsBoth, TS_LIFE } from '../gpu.js';
import { F } from '../realms.js';
import { clip } from './clipmap.js';
import * as fauna from './fauna.js';
import * as flora from './flora.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import LIFE from '../wgsl/life.wgsl';
import PART from '../wgsl/particles.wgsl';

let pPart, bgT, desc, nPart = 8192;

export function init(ctx) {
  if (ctx.quality === 0) nPart = 2048;
  const mod = shader(CLIP + SKY + LIFE + PART, 'particles');
  const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  pPart = pipeline({ label: 'particles', module: mod, vs: 'vsPart', fs: 'fsPart', layouts: [ctx.bgl0, clip.bgl, fauna.faunaT.bgl],
    targets: [{ format: 'rgba16float', blend: add }], topology: 'triangle-strip' });
}

// (re)bind to the view targets: draws into the composite output, reads the resolved linear depth
export function bind(ctx, tg) {
  bgT = bindGroup(fauna.faunaT.bgl, [tg.distV]);
  desc = { colorAttachments: [{ view: tg.compV, loadOp: 'load', storeOp: 'store' }], timestampWrites: tsBoth(TS_LIFE) };
}

// returns 1 when the pass ran (for the GPU timer)
// ablation (integration's off= bits, read from ctx.off): particles (motes only; pools and jellies follow flora/fauna)
const OFF_PARTICLES = 4;

export function draw(ctx, enc, view) {
  const fr = ctx.frame, v3 = FO.row + F.V3 * 4;
  const wp = (ctx.off | 0) & OFF_PARTICLES ? 0 : fr[v3] + fr[v3 + 1] + fr[v3 + 2] + fr[v3 + 3] + fr[FO.row + F.V1 * 4 + 1];
  const ft = fauna.anyTransparent(ctx);
  const fp = flora.anyPools(ctx);
  if (wp < 0.002 && !ft && !fp) return 0;
  const p = enc.beginRenderPass(desc);
  p.setBindGroup(0, view.bg0); p.setBindGroup(1, clip.bg); p.setBindGroup(2, bgT);
  if (fp) flora.drawPools(ctx, p);
  if (ft) fauna.drawTransparent(ctx, p, view);
  if (wp >= 0.002) { p.setPipeline(pPart); p.draw(4, nPart); }
  p.end();
  return 1;
}
