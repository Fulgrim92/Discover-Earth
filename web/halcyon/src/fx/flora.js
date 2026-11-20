// fx/flora.js: grass, flowers, heather, tussocks, reeds, ferns, alien stalks and tendrils, mushroom trees, foliage
// crowns, crystal clusters and ice shards. No vertex or instance buffers: every instance is placed in the vertex
// shader (flora.wgsl) from its instance index on a world-snapped hashed grid per layer, so nothing swims.
// Drawn in the opaque pass (4x MSAA, alpha-to-coverage). A layer is skipped from JS (no draw at all) when the
// camera realm row gives its kinds zero weight or when the camera is higher above the ground than the layer reaches.
//
// Instance caps (normal / quality=low, low = double cell, quarter count):
//   0 tuft near   128^2 = 16384 x 45 verts      4096 low
//   1 tuft mid    112^2 = 12544 x 45            3136
//   2 tuft far    112^2 = 12544 x 27            3136
//   3 flower near  96^2 =  9216 x 14            2304
//   4 flower far   96^2 =  9216 x 14            2304
//   5 alien strip  96^2 =  9216 x 27            2304
//   6 lathe props  36^2 =  1296 x 672            324
//   7 crystals     48^2 =  2304 x 288            576
// Home Fjords (layers 0-4) = 1.90 M vertex invocations per view; Lumen Deep (5-7) = 1.78 M. Most are rejected in
// the vertex shader after one hash (zero weight, outside the fade ring) or one height fetch (frustum), costing a few
// dozen ALU ops; only accepted instances fetch masks, march the 10-step sun shadow and build geometry.
import { G, shader, pipeline, FO, VO } from '../gpu.js';
import { F } from '../realms.js';
import { heightBatch } from '../world.js';
import { clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import LIFE from '../wgsl/life.wgsl';
import FLORA from '../wgsl/flora.wgsl';

// cell, N, verts per instance, class, fade-out end (mirror of flora.wgsl LA / LB)
const LAYERS = [
  [0.2, 128, 45, 0, 12], [0.55, 112, 45, 0, 30], [1.4, 112, 27, 0, 77],
  [0.4, 96, 14, 1, 17], [1.0, 96, 14, 1, 46],
  [1.1, 96, 27, 2, 52],
  [7.0, 36, 672, 3, 122],
  [4.0, 48, 288, 4, 94],
];
const NLAYER = LAYERS.length;
const count = new Uint32Array(NLAYER), verts = new Uint32Array(NLAYER), cls = new Uint8Array(NLAYER), reach = new Float32Array(NLAYER);
const wCls = new Float32Array(5);
let pStrip, pLathe;
// camera height above ground, in typed arrays: a double in a module `let` or passed to heightAt is boxed per frame
const AQ = new Float64Array(2), AH = new Float64Array(1), AGL = new Float64Array(2); // AGL[1]: frame it was computed for
AGL[1] = -1;

export function init(ctx) {
  const low = ctx.quality === 0;
  for (let i = 0; i < NLAYER; i++) {
    const n = low ? LAYERS[i][1] >> 1 : LAYERS[i][1];
    count[i] = n * n; verts[i] = LAYERS[i][2]; cls[i] = LAYERS[i][3]; reach[i] = LAYERS[i][4];
  }
  const mod = shader(CLIP + SKY + LIFE + FLORA, 'flora');
  const targets = [{ format: 'rgba16float' }, { format: 'r16float' }];
  const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' };
  const layouts = [ctx.bgl0, clip.bgl];
  pStrip = pipeline({ label: 'flora strips', module: mod, vs: 'vsStrip', fs: 'fsFlora', layouts, targets, samples: ctx.msaa, a2c: ctx.msaa > 1, depth, topology: 'triangle-strip' });
  pLathe = pipeline({ label: 'flora lathe', module: mod, vs: 'vsLathe', fs: 'fsFlora', layouts, targets, samples: ctx.msaa, a2c: ctx.msaa > 1, depth });
}

export function draw(ctx, pass, view) {
  const fr = ctx.frame, o = FO.row;
  const v0 = o + F.V0 * 4, v1 = o + F.V1 * 4;
  wCls[0] = fr[v0] + fr[v0 + 3] + fr[v1] + fr[v1 + 1];
  wCls[1] = fr[v0 + 1];
  wCls[2] = fr[v1 + 2];
  wCls[3] = fr[v1 + 2] + fr[v1 + 1];
  wCls[4] = fr[v1 + 2] + fr[v1 + 3];
  if (wCls[0] + wCls[1] + wCls[2] + wCls[3] + wCls[4] < 0.002) return;
  const fno = fr[FO.time + 2];
  if (fno !== AGL[1]) {
    const d = view.data;
    AQ[0] = d[VO.cam]; AQ[1] = d[VO.cam + 2]; heightBatch(AQ, 1, AH);
    AGL[0] = d[VO.cam + 1] - Math.max(0, AH[0]);
    AGL[1] = fno;
  }
  let bound = 0;
  for (let i = 0; i < NLAYER; i++) {
    if (wCls[cls[i]] < 0.002 || AGL[0] > reach[i] + 10) continue;
    if (!bound) { pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); bound = 1; }
    pass.setPipeline(cls[i] >= 3 ? pLathe : pStrip);
    pass.draw(verts[i], count[i], 0, i << 20);
  }
}
