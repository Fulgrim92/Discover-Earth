// fx/fauna.js: flamingo skeins over Mirror Salt, seabirds wheeling at the fjord cliffs, a high V of geese, and sky
// jellies over Lumen Deep. Motion is a closed-form function of time and instance index (fauna.wgsl); no CPU
// simulation and no buffers. Birds draw in the opaque pass; jellies and the flamingos' mirror images draw in the
// blended pass after the composite (called from particles.js, which owns that pass).
//
// Instance caps: flamingos 9 flocks x 24 = 216, seabirds 9 x 12 = 108, geese 9 x 13 = 117 (384 vertices each),
// jellies 25 (1488 vertices each). A group is skipped from JS when its realm weight at the camera is zero.
import { shader, bgl, pipeline, FO } from '../gpu.js';
import { F } from '../realms.js';
import { clip } from './clipmap.js';
import { LMAX } from './flora.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import LIFE from '../wgsl/life.wgsl';
import FAUNA from '../wgsl/fauna.wgsl';

const BIRD_VERTS = 384, JELLY_VERTS = 1488;
const BIRDS = new Uint16Array([216, 108, 117]);
let pBird, pMirror, pJelly;
export const faunaT = { bgl: null };

export function init(ctx) {
  const mod = shader(CLIP + SKY + LIFE + FAUNA, 'fauna');
  faunaT.bgl = bgl('f', 'lifeT');
  const targets = [{ format: 'rgba16float' }, { format: 'r16float' }];
  pBird = pipeline({ label: 'birds', module: mod, vs: 'vsBird', fs: 'fsBird', layouts: [ctx.bgl0, clip.bgl], targets, samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
  const lay = [ctx.bgl0, clip.bgl, faunaT.bgl];
  const over = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  const pre = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  pMirror = pipeline({ label: 'bird mirror', module: mod, vs: 'vsBirdMirror', fs: 'fsBirdMirror', layouts: lay, targets: [{ format: 'rgba16float', blend: over }] });
  pJelly = pipeline({ label: 'jellies', module: mod, vs: 'vsJelly', fs: 'fsJelly', layouts: lay, targets: [{ format: 'rgba16float', blend: pre }] });
}

// opaque pass: birds
// ablation (integration's off= bits, read from ctx.off): fauna
const OFF_FAUNA = 2;

export function draw(ctx, pass, view) {
  if ((ctx.off | 0) & OFF_FAUNA) return;
  // groups are enabled by every realm in reach (flora.prepare computes LMAX each frame); each flock thins by the
  // weights at its home
  const v2 = F.V2 * 4;
  let bound = 0;
  for (let g = 0; g < 3; g++) {
    if (LMAX[v2 + g] < 0.002) continue;
    if (!bound) { pass.setPipeline(pBird); pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); bound = 1; }
    pass.draw(BIRD_VERTS, BIRDS[g], 0, g << 16);
  }
}

// blended pass (groups 0, 1, 2 already bound by the caller): flamingo reflections, then jellies
export function drawTransparent(ctx, pass, view) {
  const fr = ctx.frame, v2 = F.V2 * 4;
  if (LMAX[v2] > 0.002 && fr[FO.row + F.M4 * 4 + 1] > 0.2) { pass.setPipeline(pMirror); pass.draw(BIRD_VERTS, BIRDS[0], 0, 0); }
  if (LMAX[v2 + 3] > 0.002) { pass.setPipeline(pJelly); pass.draw(JELLY_VERTS, 25, 0, 3 << 16); }
}

export function anyTransparent(ctx) {
  if ((ctx.off | 0) & OFF_FAUNA) return false;
  const v2 = F.V2 * 4;
  return LMAX[v2] > 0.002 || LMAX[v2 + 3] > 0.002;
}
