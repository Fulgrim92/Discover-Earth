// fx/herd.js: ground animals as populations by habitat (herd.wgsl draws them). The CPU keeps a small table of herds
// on a 320 m grid around the camera (7 x 7 cells) plus up to 4 Lumen giants on a 4 km grid: home, species and size
// are picked once per cell (by the dominant realm and a habitat test on the terrain height), and each herd's
// reaction to the drone (alarm, flee offset, gait distance) is integrated per frame in preallocated typed arrays.
// Everything else (walking, grazing, legs) is closed-form on the GPU. No per-frame allocations.
//
// Species (by realm): Home Fjords sheep on slopes, seals hauled out on the shore; Painted Range wild horses;
// Mirror Salt flamingos standing in the shallows; Aurora Ice arctic foxes, seals on the ice edge; Lumen Deep
// light-eaters grazing, and the slow giant far off.
// Caps: 49 herds x 16 animals + 4 giants, 2496 vertices per animal (13 ellipsoids); only herds that exist are drawn.
import { G, shader, pipeline, bgl, bindGroup, buffer, FO } from '../gpu.js';
import { W_IN, W_ID, W_W, realmWeightsA } from '../realms.js';
import { heightBatch, heightAt } from '../world.js';
import { p as DP, v as DV } from '../sim/drone.js';
import { clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import LIFE from '../wgsl/life.wgsl';
import FLORA from '../wgsl/flora.wgsl';
import HERD from '../wgsl/herd.wgsl';
import HERDM from '../wgsl/herdm.wgsl';
import HERDSKIN from '../wgsl/herdskin.wgsl';
import { ENC, DIR } from './lifefx.js';

const CELL = 320, NS = 7, NH = NS * NS, NGI = 4, NG = NH + NGI, GCELL = 4000;
const H_VERTS = 2880, NE = 8, E_BASE = 848, MURM_N = 16000;
// encounter type -> actor species count (herd.wgsl actor(): 1 orca pod, 3 flamingo take-off, 4 whale breach, 6 giants)
const E_N = new Uint8Array(40); E_N[1] = 6; E_N[3] = 48; E_N[4] = 1; E_N[6] = 5;
const ecount = new Uint8Array(NE);
let murmOn = 0;
// species: 0 sheep, 1 horse, 2 flamingo, 3 fox, 4 seal, 5 light-eater, 6 giant
const SENS = new Float32Array([1.0, 1.2, 1.3, 1.0, 0.8, 0.3, 0]);   // how easily startled
const RUN = new Float32Array([3.0, 8.0, 1.6, 5.0, 0.0, 0.8, 0]);     // flee speed, m/s
const NMIN = new Uint8Array([6, 5, 10, 1, 3, 3]), NRNG = new Uint8Array([7, 5, 7, 3, 6, 4]); // herd size
const TAB = new Float32Array(196 * 4);                                 // uniform image (HG)
const key = new Int32Array(NG * 2), okey = new Int32Array(NG * 2);
const st = new Float32Array(NG * 6), ost = new Float32Array(NG * 6);  // fleeX, fleeZ, alarm, gait, fdX, fdZ
const home = new Float32Array(NG * 4);                                 // x, z, species (-1 none), count
const CAND = new Float64Array(NH * 4 * 2 * 3), CH = new Float64Array(NH * 4 * 3);
const CAMS = new Float64Array(2);
const GIV = new Uint8Array(4); // giant cell i has been filled
const S = new Float64Array(4); // [0] last time, [1] cell x, [2] cell z, [3] giant cell key
S[0] = -1; S[1] = 1e9; S[2] = 1e9;
let pipe, pNear, pMirror, pMurm, bg, ubuf;
const H_NEAR = 8640, LOD_NEAR = 100; // near herds (< 100 m): 12 x 8 quads per part instead of 8 x 4
const DBG = typeof location !== 'undefined' && /[?&]fstat=1/.test(location.search); // debug: log herd homes


// ---- skinned quadrupeds (herdskin.wgsl): the shape tables, generated once at startup ----
// Per species, in metres for an adult (scaled per animal). The spine is a tube swept along s (0 tail root, 1 croup,
// 2 girth, 3 neck base, 5 poll, 6 muzzle); every key ring is [s, half width, top radius, bottom radius, egg (wider
// low than high), ridge (spine, withers, crest), side bump (eyes), section exponent (<1 boxier)], so sections are
// not circles. Legs are fore and hind key rings [u, radius across, radius in front, radius behind] along
// u (0 top inside the body, 1 knee or hock, 2 fetlock, 3 hoof). The rig: spine control points (x forward, y up from
// the ground), [neck, head, tail, ear] lengths, per leg pair [x, top height, half track, hoof x offset] and
// [upper bone, lower bone, fetlock height, pastern slope], [tail radius, tail depth ratio, poll half width, neck lift],
// [dock height, head drop, fleece lump, 0].
//
// Horse proportions follow the conformation fractions of a 1.5 m wither height H: body (point of shoulder to buttock)
// 1.0 H, chest 0.45 H deep at the girth and 0.36 H at the flank, barrel 0.3 H wide, croup a little below the withers,
// neck 0.6 H, head 0.4 H with a 0.2 H jaw and a 0.1 H muzzle, ears 0.1 H, a strong gaskin and a hock set behind.
const SKIN = [
  { // Faroese sheep: a lumpy fleece barrel 1.4 times longer than tall, a short neck and a real head out of the wool
    q: [-0.6, 0.5, -0.3, 0.5, 0.14, 0.5, 0.34, 0.52], len: [0.24, 0.25, 0.15, 0.09],
    fa: [0.16, 0.4, 0.1, 0.02], fb: [0.2, 0.15, 0.06, 0.4], ha: [-0.26, 0.42, 0.1, -0.06], hb: [0.2, 0.21, 0.06, 0.4],
    tail: [0.04, 0.8, 0.055, 0.45], ext: [0.14, 1.2, 0.024, 0.1],
    ring: [[0, 0, 0, 0, 0, 0, 0, 1], [0.05, 0.07, 0.08, 0.08, 0, 0, 0, 1], [0.2, 0.14, 0.15, 0.15, 0.03, 0, 0, 1],
      [0.45, 0.19, 0.2, 0.2, 0.05, 0, 0, 0.95], [0.85, 0.22, 0.23, 0.22, 0.05, 0, 0, 0.9], [1.6, 0.225, 0.23, 0.22, 0.06, 0, 0, 0.9],
      [2.2, 0.22, 0.23, 0.22, 0.05, 0, 0, 0.9], [2.6, 0.19, 0.21, 0.2, 0.03, 0, 0, 0.95], [2.85, 0.155, 0.17, 0.14, 0, 0, 0, 1],
      [3.05, 0.12, 0.13, 0.1, 0, 0, 0, 1], [3.3, 0.088, 0.095, 0.08, 0, 0, 0, 1], [3.8, 0.07, 0.075, 0.068, 0, 0, 0, 1],
      [4.5, 0.06, 0.064, 0.06, 0, 0, 0, 1], [4.95, 0.055, 0.056, 0.068, 0.1, 0, 0, 1], [5.15, 0.062, 0.056, 0.078, 0.2, 0, 0, 0.95],
      [5.4, 0.056, 0.052, 0.066, 0.12, 0, 0.012, 0.95], [5.7, 0.044, 0.046, 0.05, 0.05, 0, 0, 1], [5.9, 0.036, 0.038, 0.042, 0, 0, 0, 1],
      [5.97, 0.026, 0.028, 0.03, 0, 0, 0, 1], [6, 0, 0, 0, 0, 0, 0, 1]],
    fleg: [[0, 0.06, 0.07, 0.07], [0.4, 0.03, 0.03, 0.032], [0.8, 0.021, 0.021, 0.022], [1, 0.026, 0.028, 0.026], [1.2, 0.018, 0.017, 0.019],
      [1.6, 0.016, 0.015, 0.018], [1.95, 0.02, 0.02, 0.022], [2.1, 0.019, 0.019, 0.02], [2.5, 0.015, 0.015, 0.015],
      [2.75, 0.018, 0.019, 0.016], [2.97, 0.022, 0.024, 0.02], [3, 0, 0, 0]],
    hleg: [[0, 0.07, 0.08, 0.09], [0.4, 0.04, 0.035, 0.05], [0.85, 0.022, 0.02, 0.026], [1, 0.024, 0.02, 0.034], [1.2, 0.018, 0.016, 0.022],
      [1.6, 0.016, 0.015, 0.018], [1.95, 0.02, 0.02, 0.022], [2.1, 0.019, 0.019, 0.02], [2.5, 0.015, 0.015, 0.015],
      [2.75, 0.018, 0.019, 0.016], [2.97, 0.022, 0.024, 0.02], [3, 0, 0, 0]],
  },
  { // wild horse (Przewalski-like), H = 1.5 m at the withers
    q: [-0.8, 1.12, -0.45, 1.14, 0.28, 1.12, 0.62, 1.18], len: [0.85, 0.6, 0.85, 0.15],
    fa: [0.38, 1.0, 0.14, 0.02], fb: [0.56, 0.28, 0.17, 0.6], ha: [-0.55, 1.0, 0.13, -0.125], hb: [0.505, 0.38, 0.17, 0.5],
    tail: [0.085, 0.7, 0.1, 0.35], ext: [0.24, 1.6, 0, 0.04],
    ring: [[0, 0, 0, 0, 0, 0, 0, 1], [0.05, 0.07, 0.1, 0.12, 0, 0, 0, 1], [0.15, 0.14, 0.18, 0.21, 0.03, 0, 0, 0.95],
      [0.3, 0.19, 0.23, 0.26, 0.06, 0.005, 0, 0.9], [0.55, 0.22, 0.28, 0.29, 0.08, 0.01, 0, 0.85], [1, 0.23, 0.3, 0.28, 0.1, 0.015, 0, 0.85],
      [1.5, 0.215, 0.29, 0.25, 0.12, 0.015, 0, 0.85], [2, 0.225, 0.33, 0.31, 0.12, 0.015, 0, 0.85], [2.4, 0.19, 0.37, 0.32, 0.1, 0.02, 0, 0.85],
      [2.75, 0.17, 0.35, 0.33, 0.06, 0.02, 0, 0.9], [3, 0.15, 0.28, 0.29, 0, 0.015, 0, 0.95], [3.5, 0.12, 0.22, 0.19, -0.04, 0.015, 0, 1],
      [4, 0.095, 0.17, 0.13, 0, 0.012, 0, 1], [4.6, 0.075, 0.12, 0.1, 0, 0.008, 0, 1], [4.95, 0.08, 0.1, 0.14, 0.1, 0, 0, 1],
      [5.15, 0.1, 0.085, 0.19, 0.25, 0, 0, 0.95], [5.35, 0.095, 0.085, 0.165, 0.2, 0, 0.03, 0.95], [5.6, 0.072, 0.075, 0.1, 0.05, 0, 0, 1],
      [5.85, 0.065, 0.07, 0.085, 0, 0, 0, 1], [5.96, 0.055, 0.055, 0.065, 0, 0, 0, 1], [6, 0, 0, 0, 0, 0, 0, 1]],
    fleg: [[0, 0.09, 0.11, 0.1], [0.35, 0.07, 0.08, 0.07], [0.75, 0.045, 0.05, 0.045], [1, 0.05, 0.055, 0.05], [1.15, 0.038, 0.035, 0.04],
      [1.5, 0.032, 0.03, 0.04], [1.9, 0.04, 0.04, 0.05], [2.05, 0.042, 0.042, 0.055], [2.4, 0.033, 0.033, 0.033],
      [2.65, 0.04, 0.042, 0.035], [2.97, 0.055, 0.06, 0.045], [3, 0, 0, 0]],
    hleg: [[0, 0.11, 0.15, 0.15], [0.3, 0.085, 0.1, 0.1], [0.65, 0.06, 0.055, 0.07], [0.85, 0.045, 0.04, 0.055], [1, 0.05, 0.04, 0.075], [1.15, 0.04, 0.035, 0.05],
      [1.5, 0.033, 0.03, 0.042], [1.9, 0.04, 0.04, 0.05], [2.05, 0.042, 0.042, 0.055], [2.4, 0.033, 0.033, 0.033],
      [2.65, 0.04, 0.042, 0.035], [2.97, 0.055, 0.06, 0.045], [3, 0, 0, 0]],
  },
  { // arctic fox: low and long, a ruff at the neck, a pointed muzzle, a full brush
    q: [-0.3, 0.3, -0.2, 0.27, 0.12, 0.27, 0.22, 0.31], len: [0.14, 0.17, 0.33, 0.06],
    fa: [0.15, 0.22, 0.06, 0], fb: [0.1, 0.1, 0.03, 0.15], ha: [-0.18, 0.22, 0.06, -0.02], hb: [0.11, 0.1, 0.03, 0.2],
    tail: [0.06, 1.0, 0.05, 0.75], ext: [0, 0.85, 0, 0],
    ring: [[0, 0, 0, 0, 0, 0, 0, 0.95], [0.1, 0.07, 0.08, 0.08, 0, 0, 0, 0.95], [0.6, 0.1, 0.11, 0.11, 0.03, 0, 0, 0.9],
      [1.5, 0.092, 0.095, 0.105, 0.05, 0, 0, 0.9], [2.3, 0.1, 0.105, 0.125, 0.05, 0, 0, 0.9], [2.8, 0.09, 0.11, 0.11, 0.03, 0, 0, 0.95],
      [3.1, 0.088, 0.11, 0.09, 0, 0, 0, 1], [4, 0.075, 0.09, 0.08, 0, 0, 0, 1], [4.8, 0.062, 0.068, 0.068, 0, 0, 0, 1],
      [5.1, 0.058, 0.053, 0.063, 0.1, 0, 0.006, 1], [5.5, 0.034, 0.024, 0.044, 0, 0, 0, 1], [5.85, 0.014, 0.006, 0.022, 0, 0, 0, 1],
      [6, 0, 0, 0, 0, 0, 0, 1]],
    fleg: [[0, 0.04, 0.05, 0.05], [0.5, 0.025, 0.03, 0.03], [1, 0.017, 0.02, 0.02], [1.5, 0.013, 0.015, 0.015], [2, 0.015, 0.017, 0.017],
      [2.97, 0.019, 0.023, 0.023], [3, 0, 0, 0]],
    hleg: [[0, 0.045, 0.05, 0.055], [0.5, 0.027, 0.028, 0.034], [1, 0.017, 0.016, 0.024], [1.5, 0.013, 0.015, 0.015], [2, 0.015, 0.017, 0.017],
      [2.97, 0.019, 0.023, 0.023], [3, 0, 0, 0]],
  },
];
// Catmull-Rom through key rows by key index, sampled at parameter x (column 0, increasing); radii never go negative
function keyAt(rows, x, col, pos) {
  let i = 0;
  while (i < rows.length - 2 && rows[i + 1][0] <= x) i++;
  const a = rows[Math.max(i - 1, 0)][col], b = rows[i][col], c = rows[i + 1][col], d = rows[Math.min(i + 2, rows.length - 1)][col];
  const t = Math.min(Math.max((x - rows[i][0]) / Math.max(rows[i + 1][0] - rows[i][0], 1e-6), 0), 1);
  const v = 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  return pos ? Math.max(v, 0) : v;
}
const f4 = (a, b, c, d) => 'vec4f(' + [a, b, c, d].map((x) => (+x).toFixed(4)).join(',') + ')';
// leg ring positions per resolution: the knee, fetlock bulge, pastern, coronet and hoof each get a ring
const LEG_U = { 8: [0, 0.45, 1, 1.5, 1.95, 2.45, 2.97, 3], 12: [0, 0.3, 0.65, 1, 1.2, 1.55, 1.9, 2.05, 2.4, 2.65, 2.97, 3] };
// res: rings in torso / neck / head, sides around the spine, leg rings and sides, tail rings/sides, mane rings, ear sides
export function skinTables(res) {
  const { nT, nN, nH, NS, NL, LS, NT, TS, NM, ES } = res;
  const ss = [0];
  for (let i = 1; i <= nT; i++) ss.push(3 * Math.pow(i / nT, 1.3));   // denser at the rump, which is rounded
  for (let i = 1; i <= nN; i++) ss.push(3 + 2 * i / nN);
  for (let i = 1; i < nH; i++) ss.push(5 + 0.97 * i / (nH - 1));
  ss.push(6);
  const NR = ss.length;
  const us = LEG_U[NL];
  const R = [], D = [], L = [], Q = [];
  for (const sp of SKIN) {
    for (const x of ss) {
      const end = x <= 0 || x >= 6;
      const k = (c, p) => (end ? 0 : keyAt(sp.ring, x, c, p));
      R.push(f4(x, k(1, 1), k(2, 1), k(3, 1)));
      D.push(f4(k(4), k(5, 1), k(6, 1), end ? 1 : keyAt(sp.ring, x, 7, 1)));
    }
    for (const lg of [sp.fleg, sp.hleg]) for (const u of us) L.push(u >= 3 ? f4(u, 0, 0, 0) : f4(u, keyAt(lg, u, 1, 1), keyAt(lg, u, 2, 1), keyAt(lg, u, 3, 1)));
    const q = sp.q;
    Q.push(f4(q[0], q[1], q[2], q[3]), f4(q[4], q[5], q[6], q[7]), f4(...sp.len), f4(...sp.fa), f4(...sp.fb), f4(...sp.ha), f4(...sp.hb),
      f4(...sp.tail), f4(...sp.ext));
  }
  const verts = (NR - 1) * NS * 6 + 4 * (NL - 1) * LS * 6 + (NT - 1) * TS * 6 + (NM - 1) * 4 * 6 + 2 * 2 * ES * 6 + SK_FL;
  const src = 'const SK_NR=' + NR + 'u;const SK_NS=' + NS + 'u;const SK_NL=' + NL + 'u;const SK_LS=' + LS + 'u;const SK_NT=' + NT +
    'u;const SK_TS=' + TS + 'u;const SK_NM=' + NM + 'u;const SK_ES=' + ES + 'u;\n' +
    'const SKR=array<vec4f,' + R.length + '>(' + R.join(',') + ');\n' +
    'const SKD=array<vec4f,' + D.length + '>(' + D.join(',') + ');\n' +
    'const SKL=array<vec4f,' + L.length + '>(' + L.join(',') + ');\n' +
    'const SKQ=array<vec4f,' + Q.length + '>(' + Q.join(',') + ');\n';
  return { src, verts };
}
const SK_FL = 2 * 4 * 6;   // the forelock: two quad rings of four sides
const SKIN_FAR = { nT: 9, nN: 4, nH: 5, NS: 12, NL: 8, LS: 6, NT: 6, TS: 6, NM: 7, ES: 6 };
const SKIN_NEAR = { nT: 16, nN: 7, nH: 8, NS: 20, NL: 12, LS: 10, NT: 9, TS: 10, NM: 12, ES: 8 };

export function init(ctx) {
  ubuf = buffer(TAB.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'herd table');
  const lay = bgl('u', 'herd');
  bg = bindGroup(lay, [ubuf], 'herd');
  // module variants: far (8 x 4 quads per part), near (12 x 8), and the mirror pass (sceneDist at group 2, HG at 3)
  const base = HERD;
  // (whitespace-tolerant: the build minifies WGSL)
  const near = base.replace(/const\s*HP_SEG\s*=\s*8u;/, 'const HP_SEG=12u;').replace(/const\s*HP_RING\s*=\s*4u;/, 'const HP_RING=8u;')
    .replace(/const\s*HP_VERTS\s*=\s*192u;/, 'const HP_VERTS=576u;').replace(/const\s*H_VERTS\s*=\s*2880u;/, 'const H_VERTS=8640u;');
  if (near === base) throw new Error('herd: near LOD constants not found');
  const mirror = '@group(2) @binding(0) var sceneDist: texture_2d<f32>;\n' + HERD.replace(/@group\(2\)\s*@binding\(0\)\s*var<uniform>\s*HG/, '@group(3) @binding(0) var<uniform> HG') + HERDM;
  const skF = skinTables(SKIN_FAR), skN = skinTables(SKIN_NEAR);
  if (skF.verts > H_VERTS || skN.verts > H_NEAR) throw new Error('herd: skinned mesh exceeds the vertex budget');
  const mod = shader(CLIP + SKY + LIFE + FLORA + skF.src + HERDSKIN + base, 'herd');
  const modN = shader(CLIP + SKY + LIFE + FLORA + skN.src + HERDSKIN + near, 'herd near');
  const modM = shader(CLIP + SKY + LIFE + FLORA + skF.src + HERDSKIN + mirror, 'herd mirror');
  const opaque = { targets: [{ format: 'rgba16float' }, { format: 'rg16float' }], samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } };
  pipe = pipeline({ label: 'herd', module: mod, vs: 'vsHerd', fs: 'fsHerd', layouts: [ctx.bgl0, clip.bgl, lay], ...opaque });
  pNear = pipeline({ label: 'herd near', module: modN, vs: 'vsHerd', fs: 'fsHerd', layouts: [ctx.bgl0, clip.bgl, lay], ...opaque });
  const over = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  pMirror = pipeline({ label: 'herd mirror', module: modM, vs: 'vsHerdMirror', fs: 'fsHerdMirror',
    layouts: [ctx.bgl0, clip.bgl, bgl('f', 'herdT'), lay], targets: [{ format: 'rgba16float', blend: over }] });
  pMurm = pipeline({ label: 'murmuration', module: mod, vs: 'vsMurm', fs: 'fsMurm', layouts: [ctx.bgl0, clip.bgl, lay],
    targets: [{ format: 'rgba16float' }, { format: 'rg16float' }], samples: ctx.msaa, cull: 'none',
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, });
}

// small integer hashes (results stay small integers, so nothing is boxed across calls)
function ih(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2f0f3c4d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 9;
}
function rq(h, k) { return ih(h, k, 0x51) & 65535; } // 0..65535; divide by 65536 at the use

// dominant realm at (x, z) into S-free int: returns id via W_ID scan
function domRealm() { // reads W_IN (x, z)
  realmWeightsA();
  let id = -1, best = 0;
  for (let s = 0; s < 4; s++) if (W_ID[s] >= 0 && W_W[s] > best) { best = W_W[s]; id = W_ID[s]; }
  return best > 0.6 ? id : -1;
}

// pick homes for the 7 x 7 cells around (cx, cz) (cell indices), keeping the state of cells that stay
function rebuild(cx, cz) {
  okey.set(key); ost.set(st);
  const c0x = cx - (NS >> 1), c0z = cz - (NS >> 1);
  for (let g = 0; g < NH; g++) {
    const ix = c0x + (g % NS), iz = c0z + Math.floor(g / NS);
    key[g * 2] = ix; key[g * 2 + 1] = iz;
    for (let c = 0; c < 4; c++) {
      const h = ih(ix, iz, 7700 + c);
      const x = (ix + 0.1 + 0.8 * (rq(h, 1) / 65536)) * CELL, z = (iz + 0.1 + 0.8 * (rq(h, 2) / 65536)) * CELL;
      const o = (g * 4 + c) * 6;
      CAND[o] = x; CAND[o + 1] = z; CAND[o + 2] = x + 6; CAND[o + 3] = z; CAND[o + 4] = x; CAND[o + 5] = z + 6;
    }
  }
  heightBatch(CAND, NH * 4 * 3, CH);
  for (let g = 0; g < NH; g++) {
    const ix = key[g * 2], iz = key[g * 2 + 1], hc = ih(ix, iz, 7799);
    home[g * 4 + 2] = -1; home[g * 4 + 3] = 0;
    if ((rq(hc, 1) / 65536) > 0.62) continue;
    for (let c = 0; c < 4; c++) {
      const o = (g * 4 + c) * 3, x = CAND[o * 2], z = CAND[o * 2 + 1];
      const y = CH[o], sl = Math.max(Math.abs(CH[o + 1] - y), Math.abs(CH[o + 2] - y)) / 6;
      W_IN[0] = x; W_IN[1] = z;
      const r = domRealm();
      let sp = -1;
      const shore = y > 0.3 && y < 2.5 && sl < 0.25;
      if (r === 0) sp = shore ? 4 : y > 8 && y < 350 && sl < 0.7 ? 0 : -1;
      else if (r === 1) sp = y > 2 && sl < 0.6 ? 1 : -1;
      else if (r === 2) sp = y > -0.5 && y < 0.02 ? 2 : -1;
      else if (r === 4) sp = shore ? 4 : y > 1 && sl < 0.5 ? 3 : -1;
      else if (r === 5) sp = y > 1 && sl < 0.5 ? 5 : -1;
      if (sp < 0) continue;
      const n = NMIN[sp], m = NRNG[sp];
      home[g * 4] = x; home[g * 4 + 1] = z; home[g * 4 + 2] = sp; home[g * 4 + 3] = n + Math.floor((rq(hc, 2) / 65536) * m);
      break;
    }
  }
  if (DBG) for (let g = 0; g < NH; g++) if (home[g * 4 + 2] >= 0) console.log('herd sp' + home[g * 4 + 2] + ' n' + home[g * 4 + 3] + ' at ' + home[g * 4].toFixed(0) + ',' + home[g * 4 + 1].toFixed(0));
  // carry the reaction state of herds whose cell stays in the window
  for (let g = 0; g < NH; g++) {
    let found = -1;
    for (let q = 0; q < NH; q++) if (okey[q * 2] === key[g * 2] && okey[q * 2 + 1] === key[g * 2 + 1]) { found = q; break; }
    for (let k = 0; k < 6; k++) st[g * 6 + k] = found >= 0 ? ost[found * 6 + k] : 0;
  }
}

function giants() {
  const camx = CAMS[0], camz = CAMS[1];
  const gx = Math.floor(camx / GCELL), gz = Math.floor(camz / GCELL);
  for (let i = 0; i < NGI; i++) {
    const g = NH + i, ix = gx + (i & 1) - (camx - gx * GCELL < GCELL / 2 ? 1 : 0), iz = gz + (i >> 1) - (camz - gz * GCELL < GCELL / 2 ? 1 : 0);
    if (key[g * 2] === ix && key[g * 2 + 1] === iz && GIV[i]) continue; // same cell: keep (realm lookup only on change)
    GIV[i] = 1;
    const h = ih(ix, iz, 7901);
    const x = (ix + 0.3 + 0.4 * (rq(h, 1) / 65536)) * GCELL, z = (iz + 0.3 + 0.4 * (rq(h, 2) / 65536)) * GCELL;
    key[g * 2] = ix; key[g * 2 + 1] = iz;
    W_IN[0] = x; W_IN[1] = z;
    const r = domRealm();
    home[g * 4] = x; home[g * 4 + 1] = z; home[g * 4 + 2] = r === 5 ? 6 : -1; home[g * 4 + 3] = r === 5 ? 1 : 0;
  }
}

// encounter slots into actor groups and the murmuration parameters (time from S[0])
function encounters() {
  // encounter slots (lifefx.js ENC: type, x, y, z, t0, duration, seed, intensity) -> actor groups 53..60
  murmOn = 0;
  for (let s = 4 * 193; s < 4 * 195; s++) TAB[s] = 0;
  for (let s = 0; s < NE; s++) {
    const e = s * 8, ty = ENC[e] | 0, b = (NG + s) * 12, rel = S[0] - ENC[e + 4];
    const live = ty > 0 && rel >= 0 && rel <= ENC[e + 5];
    ecount[s] = live ? E_N[ty] : 0;
    TAB[b] = ENC[e + 1]; TAB[b + 1] = ENC[e + 3]; TAB[b + 2] = 0; TAB[b + 3] = ecount[s];
    TAB[b + 4] = DIR[s * 2]; TAB[b + 5] = DIR[s * 2 + 1]; TAB[b + 6] = ENC[e + 4]; TAB[b + 7] = ENC[e + 5];
    TAB[b + 8] = ty; TAB[b + 9] = ENC[e + 7]; TAB[b + 10] = 1; TAB[b + 11] = ENC[e + 6];
    if (live && ty === 2 && !murmOn) {
      murmOn = 1;
      TAB[193 * 4] = rel; TAB[193 * 4 + 1] = ENC[e + 5]; TAB[193 * 4 + 2] = ENC[e + 7]; TAB[193 * 4 + 3] = 1;
      TAB[194 * 4] = ENC[e + 1]; TAB[194 * 4 + 1] = ENC[e + 2]; TAB[194 * 4 + 2] = ENC[e + 3];
    }
  }
}

// once per frame (from flora.prepare): homes when the camera changes cell, drone reaction, uniform upload
export function update(ctx, view) {
  const fr = ctx.frame, t = fr[FO.time];
  const d = view.data, camx = d[32], camz = d[34];
  const cx = Math.floor(camx / CELL), cz = Math.floor(camz / CELL);
  if (cx !== S[1] || cz !== S[2]) { S[1] = cx; S[2] = cz; rebuild(cx, cz); }
  CAMS[0] = camx; CAMS[1] = camz; giants(); // every frame (4 cells): cheap, and stays optimised (no boxed doubles)
  const dt = S[0] < 0 ? 0 : Math.min(Math.max(t - S[0], 0), 0.1);
  S[0] = t;
  const spd = Math.sqrt(DV[0] * DV[0] + DV[1] * DV[1] + DV[2] * DV[2]);
  for (let g = 0; g < NG; g++) {
    const sp = home[g * 4 + 2], o = g * 6;
    if (sp < 0) continue;
    const hx = home[g * 4] + st[o], hz = home[g * 4 + 1] + st[o + 1];
    const dx = hx - DP[0], dz = hz - DP[2], dy = DP[1] - 0;
    const dist = Math.sqrt(dx * dx + dz * dz + Math.max(dy - 30, 0) * Math.max(dy - 30, 0) * 0.2);
    const threat = SENS[sp] * (Math.min(Math.max((45 - dist) / 30, 0), 1) + Math.min(Math.max((120 - dist) / 75, 0), 1) * Math.min(Math.max((spd - 5) / 8, 0), 1));
    let a = st[o + 2];
    a = threat > a ? a + (threat - a) * Math.min(1, dt * 3) : Math.max(0, a - dt / 25);
    st[o + 2] = Math.min(a, 1);
    const run = RUN[sp] * Math.min(Math.max((a - 0.3) / 0.5, 0), 1);
    if (run > 0) {
      const l = Math.sqrt(dx * dx + dz * dz) + 1e-3;
      st[o + 4] = dx / l * run; st[o + 5] = dz / l * run;
    } else if (a < 0.05 && (st[o] !== 0 || st[o + 1] !== 0)) {
      const l = Math.sqrt(st[o] * st[o] + st[o + 1] * st[o + 1]);
      const back = Math.min(0.4, l / Math.max(dt, 1e-3));
      st[o + 4] = -st[o] / (l + 1e-6) * back; st[o + 5] = -st[o + 1] / (l + 1e-6) * back;
    } else { st[o + 4] = 0; st[o + 5] = 0; }
    st[o] += st[o + 4] * dt; st[o + 1] += st[o + 5] * dt;
    st[o + 3] += Math.sqrt(st[o + 4] * st[o + 4] + st[o + 5] * st[o + 5]) * dt;
  }
  for (let g = 0; g < NG; g++) {
    const b = g * 12, o = g * 6;
    TAB[b] = home[g * 4]; TAB[b + 1] = home[g * 4 + 1]; TAB[b + 2] = Math.max(home[g * 4 + 2], 0); TAB[b + 3] = home[g * 4 + 2] < 0 ? 0 : home[g * 4 + 3];
    TAB[b + 4] = st[o]; TAB[b + 5] = st[o + 1]; TAB[b + 6] = st[o + 2]; TAB[b + 7] = st[o + 3];
    TAB[b + 8] = st[o + 4]; TAB[b + 9] = st[o + 5]; TAB[b + 10] = home[g * 4 + 2] === 6 ? 30 : 1; TAB[b + 11] = (key[g * 2] * 73856093) ^ (key[g * 2 + 1] * 19349663);
  }
  encounters();
  TAB[192 * 4] = DP[0]; TAB[192 * 4 + 1] = DP[1]; TAB[192 * 4 + 2] = DP[2]; TAB[192 * 4 + 3] = spd;
  G.queue.writeBuffer(ubuf, 0, TAB);
}

// shot cameras (main.js track=<species>,<distance>,<height>): the centre of the nearest herd of a species, the same
// closed form as herd.wgsl animal() (home + slow wander + flee offset); the first herd found stays chosen
export const AIM = new Float64Array(4); // x, ground y, z, found
const SPREAD = new Float32Array([14, 10, 9, 26, 7, 22, 0]);
const AIMK = new Int32Array([0x7fffffff, 0]);
export function aim(sp, t, x, z) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  if (S[1] > 1e8) { S[1] = cx; S[2] = cz; rebuild(cx, cz); CAMS[0] = x; CAMS[1] = z; } // a shot's first frame
  let best = -1, bd = 1e30;
  for (let g = 0; g < NH; g++) {
    if (home[g * 4 + 2] !== sp || home[g * 4 + 3] < 1) continue;
    if (key[g * 2] === AIMK[0] && key[g * 2 + 1] === AIMK[1]) { best = g; break; }
    const dx = home[g * 4] - CAMS[0], dz = home[g * 4 + 1] - CAMS[1], d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = g; }
  }
  if (best < 0) { AIM[3] = 0; return 0; }
  AIMK[0] = key[best * 2]; AIMK[1] = key[best * 2 + 1];
  const ph = Math.fround((key[best * 2] * 73856093) ^ (key[best * 2 + 1] * 19349663)) * 0.001, sz = SPREAD[sp] * 0.8;
  AIM[0] = home[best * 4] + Math.sin(t * 0.0021 + ph) * sz + st[best * 6];
  AIM[2] = home[best * 4 + 1] + Math.cos(t * 0.0017 + ph * 1.3) * sz + st[best * 6 + 1];
  AIM[1] = heightAt(AIM[0], AIM[2]); AIM[3] = 1;
  return 1;
}

export function draw(ctx, pass, view) {
  const d = view.data, cx = d[32], cz = d[34];
  pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); pass.setBindGroup(2, bg);
  for (let lod = 0; lod < 2; lod++) {
    let bound = 0;
    for (let g = 0; g < NG; g++) {
      if (home[g * 4 + 2] < 0 || home[g * 4 + 3] < 1) continue;
      const gx = home[g * 4] + st[g * 6] - cx, gz = home[g * 4 + 1] + st[g * 6 + 1] - cz; // near groups: finer mesh
      if ((gx * gx + gz * gz < LOD_NEAR * LOD_NEAR) !== (lod === 1)) continue;
      if (!bound) { pass.setPipeline(lod ? pNear : pipe); bound = 1; }
      pass.draw(lod ? H_NEAR : H_VERTS, home[g * 4 + 3], 0, g * 16);
    }
    for (let s = 0; s < NE; s++) {
      if (!ecount[s]) continue;
      const ex = ENC[s * 8 + 1] - cx, ez = ENC[s * 8 + 3] - cz;
      if ((ex * ex + ez * ez < LOD_NEAR * LOD_NEAR * 4) !== (lod === 1)) continue;   // actors spread wider: 200 m
      if (!bound) { pass.setPipeline(lod ? pNear : pipe); bound = 1; }
      pass.draw(lod ? H_NEAR : H_VERTS, ecount[s], 0, E_BASE + s * 64);
    }
  }
  if (murmOn) {
    pass.setPipeline(pMurm);
    pass.draw(6, MURM_N, 0, 0);
  }
}

// flamingos doubled in the Mirror Salt water (blended pass; groups 0-2 already bound by the caller)
export function anyMirror() {
  for (let g = 0; g < NG; g++) if (home[g * 4 + 2] === 2 && home[g * 4 + 3] > 0) return true;
  for (let s = 0; s < NE; s++) if (ecount[s] && ENC[s * 8] === 3) return true;
  return false;
}
export function drawMirror(ctx, pass) {
  pass.setPipeline(pMirror); pass.setBindGroup(3, bg);
  for (let g = 0; g < NG; g++) if (home[g * 4 + 2] === 2 && home[g * 4 + 3] > 0) pass.draw(H_VERTS, home[g * 4 + 3], 0, g * 16);
  for (let s = 0; s < NE; s++) if (ecount[s] && ENC[s * 8] === 3) pass.draw(H_VERTS, ecount[s], 0, E_BASE + s * 64);
}
