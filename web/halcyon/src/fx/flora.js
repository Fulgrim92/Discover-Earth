// fx/flora.js: grass, flowers, heather, tussocks, reeds, ferns, alien stalks and tendrils, mushroom trees, foliage
// crowns, crystal clusters, ice shards and far impostor tufts. No vertex buffers. Two steps per view:
//   prepare(): a compute prepass (floracs.wgsl) runs place() once per cell of every layer's world-snapped hashed
//     grid around the camera (so nothing swims), and appends one 64-byte record per accepted instance (root, ground
//     slope, sun shadow, albedo, kind, hash) to that layer's sub-range of the record buffer, counting them into the
//     layer's indirect draw args.
//   draw(): one drawIndirect per layer in the opaque pass (4x MSAA); the vertex shaders (florar.wgsl) only build
//     geometry from the records. Tuft layers use opaque blades without alpha-to-coverage (fsBlade: early depth, no
//     noise) unless ferns or tussock cards are about; flowers, ferns, cards and crowns keep alpha-to-coverage.
// So the masks and the 10-step sun-shadow march run once per instance instead of once per vertex, and the vertex
// shader runs only for accepted instances. The prepass runs once per frame: the second eye of a stereo pair reuses
// the first eye's records. A layer is skipped (no draw; the prepass rejects its threads after one test) when the
// realm row gives its kinds zero weight or the camera is higher above the ground than the layer reaches.
//
// Instance caps (grid N^2; quality=low doubles the cell and halves N, a quarter of the count):
//   0 tuft near    128^2 = 16384 x 54 verts      1 tuft mid  112^2 = 12544 x 45     2 tuft far   112^2 = 12544 x 27
//   3 flower near   96^2 =  9216 x 14            4 flower far 96^2 =  9216 x 14     5 alien      96^2 =  9216 x 27
//   6 crowns/mush   64^2 =  4096 x 672/1440      7 crystals   48^2 =  2304 x 288    8 impostor  168^2 = 28224 x 27
//   9 giant mush    14^2 =   196 x 1440
// Prepass: 103872 threads per view, most rejected after one hash. Accepted per view in the shots: 0.3-3k per layer.
// Ablation (integration's off= bits, ctx.off): OFF_FLORA here; OFF_FSHADOW (common.wgsl) in floracs.wgsl.
import { G, shader, pipeline, computePipeline, bgl, bindGroup, buffer, FO, VO } from '../gpu.js';
import { F, TABLE, ROWF, NREALM, W_IN, W_ID, W_W, realmWeightsA } from '../realms.js';
import { heightBatch } from '../world.js';
import { clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import LIFE from '../wgsl/life.wgsl';
import FLORA from '../wgsl/flora.wgsl';
import FLORACS from '../wgsl/floracs.wgsl';
import FLORAR from '../wgsl/florar.wgsl';
import FLORAP from '../wgsl/florap.wgsl';

// cell, N, verts per instance, class, fade-out end (mirror of flora.wgsl LA / LB / LV)
const LAYERS = [
  [0.2, 128, 54, 0, 12], [0.55, 112, 45, 0, 30], [1.4, 112, 27, 0, 77],
  [0.4, 96, 14, 1, 17], [1.0, 96, 14, 1, 46],
  [1.1, 96, 27, 2, 52],
  [7.0, 64, 672, 3, 220],
  [4.0, 48, 288, 4, 94],
  [3.0, 168, 27, 5, 250],
  [90, 14, 1440, 6, 900],
];
const NLAYER = LAYERS.length;
const REC = 64; // bytes per instance record
const verts = new Uint32Array(NLAYER), cls = new Uint8Array(NLAYER), reach = new Float32Array(NLAYER);
const wCls = new Float32Array(7);
const mask = new Uint32Array(4); // x: layers enabled this frame, y: ablation bits (both read by the prepass)
// ablation bits (integration's off= URL parameter, read from ctx.off; mirror of common.wgsl): flora skips prepare
// and draw here; fshadow is handled in floracs.wgsl (OFF_FSHADOW)
const OFF_FLORA = 1;
let pPool, bgPool, poolN = 0, pStrip, pBlade, pLathe, pPlace, statBuf = null, statState = 0, bgC, bgR = [], args, maskBuf, groups = 0;
// camera height above ground, in typed arrays: a double in a module `let` or passed to heightAt is boxed per frame
const AQ = new Float64Array(2), AH = new Float64Array(1), AGL = new Float64Array(2); // AGL[1]: frame it was computed for
AGL[1] = -1;
const PREP = new Float64Array(1); PREP[0] = -1; // frame the prepass last ran for (typed: no boxed double)
const CDESC = { label: 'flora place' };
// ?fstat=1: log the accepted instances per layer and the vertex invocations once (debug; allocates once)
const STAT = typeof location !== 'undefined' && /[?&]fstat=1/.test(location.search);

export function init(ctx) {
  let threads = 0, recs = 0;
  const base = new Uint32Array(NLAYER), cap = new Uint32Array(NLAYER);
  for (let i = 0; i < NLAYER; i++) {
    const n = LAYERS[i][1];
    verts[i] = LAYERS[i][2]; cls[i] = LAYERS[i][3]; reach[i] = LAYERS[i][4];
    base[i] = recs; cap[i] = n * n;
    threads += n * n; recs += (n * n + 3) & ~3; // record sub-ranges 256-byte aligned for the per-layer bindings
  }
  groups = Math.ceil(threads / 64);
  if (STAT) statBuf = buffer(NLAYER * 16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'flora stats');
  const recBuf = buffer(recs * REC, GPUBufferUsage.STORAGE, 'flora records');
  args = buffer(NLAYER * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, 'flora args');
  maskBuf = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'flora mask');
  const C = GPUShaderStage.COMPUTE;
  const bglC = G.device.createBindGroupLayout({ label: 'flora place', entries: [
    { binding: 0, visibility: C, buffer: { type: 'storage' } },
    { binding: 1, visibility: C, buffer: { type: 'storage' } },
    { binding: 2, visibility: C, buffer: { type: 'uniform' } },
  ] });
  bgC = bindGroup(bglC, [recBuf, args, maskBuf], 'flora place');
  const bglR = bgl('r', 'flora records');
  for (let i = 0; i < NLAYER; i++) bgR.push(bindGroup(bglR, [{ buffer: recBuf, offset: base[i] * REC, size: cap[i] * REC }], 'flora layer ' + i));
  const head = CLIP + SKY + LIFE + FLORA;
  pPlace = computePipeline(shader(head + FLORACS, 'flora place'), [ctx.bgl0, clip.bgl, bglC], 'flora place');
  const mod = shader(head + FLORAR, 'flora');
  const targets = [{ format: 'rgba16float' }, { format: 'r16float' }];
  const depth = { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' };
  const layouts = [ctx.bgl0, clip.bgl, bglR];
  pStrip = pipeline({ label: 'flora strips', module: mod, vs: 'vsStrip', fs: 'fsFlora', layouts, targets, samples: ctx.msaa, a2c: ctx.msaa > 1, depth, topology: 'triangle-strip' });
  // light pools under the mushrooms, additive in the blended pass after the composite (particles.js calls drawPools)
  const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  const bglP = bgl('rr', 'flora pools');
  bgPool = bindGroup(bglP, [recBuf, args], 'flora pools');
  poolN = cap[6] + cap[9];
  pPool = pipeline({ label: 'flora pools', module: shader(head + FLORAP, 'flora pools'), vs: 'vsPool', fs: 'fsPool',
    layouts: [ctx.bgl0, clip.bgl, bgl('f', 'lifeT') /* group-equivalent to fauna.faunaT.bgl */, bglP], targets: [{ format: 'rgba16float', blend: add }], topology: 'triangle-strip' });
  pBlade = pipeline({ label: 'flora blades', module: mod, vs: 'vsStrip', fs: 'fsBlade', layouts, targets, samples: ctx.msaa, depth, topology: 'triangle-strip' });
  pLathe = pipeline({ label: 'flora lathe', module: mod, vs: 'vsLathe', fs: 'fsFlora', layouts, targets, samples: ctx.msaa, a2c: ctx.msaa > 1, depth });
}

// layers to draw this frame, from the realm row and the camera's height above the ground (cached per frame)
// Realms whose life can be in reach: the realm weights at the camera and at 8 points 250 m and 900 m around it
// (bit per realm). Layers and fauna groups are enabled from the life fields of every present realm, so life that
// belongs to a neighbouring realm is already being placed (thinned by its own weight) before the camera arrives.
const RING = new Float64Array([0, 0, 250, 0, -250, 0, 0, 250, 0, -250, 900, 0, -900, 0, 0, 900, 0, -900]);
export const LIFE_PRESENT = new Uint32Array(2); // [0]: realm bits, [1]: frame they were computed for
LIFE_PRESENT[1] = 0xffffffff;
// largest value of every row entry over the present realms (read LMAX[field * 4 + component]; a typed array, so
// no double crosses a function boundary)
export const LMAX = new Float32Array(ROWF);
export function lifePresent(ctx, view) {
  const fno = ctx.frame[FO.time + 2];
  if (fno === LIFE_PRESENT[1]) return;
  const d = view.data;
  let bits = 0;
  for (let i = 0; i < RING.length; i += 2) {
    W_IN[0] = d[VO.cam] + RING[i]; W_IN[1] = d[VO.cam + 2] + RING[i + 1];
    realmWeightsA();
    for (let s = 0; s < 4; s++) if (W_ID[s] >= 0 && W_W[s] > 1e-4) bits |= 1 << W_ID[s];
  }
  LIFE_PRESENT[0] = bits; LIFE_PRESENT[1] = fno;
  LMAX.fill(0);
  for (let r = 0; r < NREALM; r++) {
    if (!(bits & (1 << r))) continue;
    for (let c = 0; c < ROWF; c++) if (TABLE[r * ROWF + c] > LMAX[c]) LMAX[c] = TABLE[r * ROWF + c];
  }
}

function layers(ctx, view) {
  const fr = ctx.frame, fno = fr[FO.time + 2];
  if (fno === AGL[1]) return mask[0];
  const V0 = F.V0, V1 = F.V1, V4 = F.V4;
  wCls[0] = LMAX[V0 * 4 + 0] + LMAX[V0 * 4 + 3] + LMAX[V1 * 4 + 0] + LMAX[V1 * 4 + 1];
  wCls[1] = LMAX[V0 * 4 + 1];
  wCls[2] = LMAX[V1 * 4 + 2];
  wCls[3] = LMAX[V1 * 4 + 2] + LMAX[V1 * 4 + 1];
  wCls[4] = LMAX[V1 * 4 + 2] + LMAX[V1 * 4 + 3];
  wCls[5] = LMAX[V0 * 4 + 0] + LMAX[V0 * 4 + 3] + LMAX[V1 * 4 + 1] * LMAX[V4 * 4 + 3];
  wCls[6] = LMAX[V4 * 4 + 2];
  const d = view.data;
  AQ[0] = d[VO.cam]; AQ[1] = d[VO.cam + 2]; heightBatch(AQ, 1, AH);
  AGL[0] = d[VO.cam + 1] - Math.max(0, AH[0]);
  AGL[1] = fno;
  let m = 0;
  for (let i = 0; i < NLAYER; i++) if (wCls[cls[i]] >= 0.002 && AGL[0] <= reach[i] + 10) m |= 1 << i;
  mask[0] = m; mask[1] = ctx.off | 0;
  // no ferns or tussock cards in any present realm: the tuft layers use the opaque blades (JS only)
  mask[2] = LMAX[V1 * 4 + 1] < 0.002 && LMAX[V0 * 4 + 3] < 0.002 ? 1 : 0;
  G.queue.writeBuffer(maskBuf, 0, mask);
  return m;
}

// once per frame: the second eye of a stereo pair reuses the first eye's records (its frustum differs by the eye
// offset, inside the cull margin)
export function prepare(ctx, enc, view) {
  lifePresent(ctx, view); // page code, kept out of the platform-registered prepass below
  placePass(ctx, enc, view);
}
function placePass(ctx, enc, view) {
  if ((ctx.off | 0) & OFF_FLORA) { mask[0] = 0; return; }
  const fno = ctx.frame[FO.time + 2];
  if (fno === PREP[0]) return;
  PREP[0] = fno;
  if (!layers(ctx, view)) return;
  enc.clearBuffer(args);
  const c = enc.beginComputePass(CDESC);
  c.setPipeline(pPlace);
  c.setBindGroup(0, view.bg0); c.setBindGroup(1, clip.bg); c.setBindGroup(2, bgC);
  c.dispatchWorkgroups(groups);
  c.end();
  if (statState === 0 && STAT) {
    enc.copyBufferToBuffer(args, 0, statBuf, 0, NLAYER * 16); statState = 1;
    setTimeout(() => statBuf.mapAsync(GPUMapMode.READ).then(() => { // well after this frame is submitted (debug only)
      const a = new Uint32Array(statBuf.getMappedRange()); let inv = 0, line = '';
      for (let i = 0; i < NLAYER; i++) { inv += a[i * 4] * a[i * 4 + 1]; line += ' L' + i + ':' + a[i * 4 + 1]; }
      console.log('flora instances' + line + ' | vertex invocations ' + inv + ' | prepass threads ' + groups * 64);
      statBuf.unmap();
    }), 300);
  }
}

export function draw(ctx, pass, view) {
  const m = mask[0];
  if (!m) return;
  pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg);
  for (let i = 0; i < NLAYER; i++) {
    if (!(m & (1 << i))) continue;
    pass.setPipeline(cls[i] === 3 || cls[i] === 4 || cls[i] === 6 ? pLathe : cls[i] === 0 && mask[2] ? pBlade : pStrip);
    pass.setBindGroup(2, bgR[i]);
    pass.drawIndirect(args, i * 16);
  }
}

// in the blended pass (groups 0-2 bound by particles.js): 1 when drawn
export function drawPools(ctx, pass) {
  if (!(mask[0] & ((1 << 6) | (1 << 9))) || LMAX[F.V1 * 4 + 2] < 0.002) return 0;
  pass.setPipeline(pPool); pass.setBindGroup(3, bgPool);
  pass.draw(4, poolN);
  return 1;
}

// draws anything in the blended pass
export function anyPools(ctx) { return (mask[0] & ((1 << 6) | (1 << 9))) && LMAX[F.V1 * 4 + 2] >= 0.002; }
