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
import { heightBatch } from '../world.js';
import { p as DP, v as DV } from '../sim/drone.js';
import { clip } from './clipmap.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import LIFE from '../wgsl/life.wgsl';
import FLORA from '../wgsl/flora.wgsl';
import HERD from '../wgsl/herd.wgsl';
import { ENC, DIR } from './lifefx.js';

const CELL = 320, NS = 7, NH = NS * NS, NGI = 4, NG = NH + NGI, GCELL = 4000;
const H_VERTS = 2496, NE = 8, E_BASE = 848, MURM_N = 16000;
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
const S = new Float64Array(4); // [0] last time, [1] cell x, [2] cell z, [3] giant cell key
S[0] = -1; S[1] = 1e9; S[2] = 1e9;
let pipe, pMurm, bg, ubuf;
const DBG = typeof location !== 'undefined' && /[?&]fstat=1/.test(location.search); // debug: log herd homes

export function init(ctx) {
  ubuf = buffer(TAB.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'herd table');
  const lay = bgl('u', 'herd');
  bg = bindGroup(lay, [ubuf], 'herd');
  const mod = shader(CLIP + SKY + LIFE + FLORA + HERD, 'herd');
  pipe = pipeline({ label: 'herd', module: mod, vs: 'vsHerd', fs: 'fsHerd', layouts: [ctx.bgl0, clip.bgl, lay],
    targets: [{ format: 'rgba16float' }, { format: 'rg16float' }], samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' }, });
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

export function draw(ctx, pass, view) {
  let bound = 0;
  for (let g = 0; g < NG; g++) {
    if (home[g * 4 + 2] < 0 || home[g * 4 + 3] < 1) continue;
    if (!bound) { pass.setPipeline(pipe); pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); pass.setBindGroup(2, bg); bound = 1; }
    pass.draw(H_VERTS, home[g * 4 + 3], 0, g * 16);
  }
  for (let s = 0; s < NE; s++) {
    if (!ecount[s]) continue;
    if (!bound) { pass.setPipeline(pipe); pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); pass.setBindGroup(2, bg); bound = 1; }
    pass.draw(H_VERTS, ecount[s], 0, E_BASE + s * 64);
  }
  if (murmOn) {
    pass.setPipeline(pMurm); pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); pass.setBindGroup(2, bg);
    pass.draw(6, MURM_N, 0, 0);
  }
}
