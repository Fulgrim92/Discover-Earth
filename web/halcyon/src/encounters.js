// encounters.js: the encounter director (DESIGN 12.2). Deterministic from the seed, the drone's position and time;
// allocation-free; no GPU (fx/lifefx.js uploads the slots, tools/enctest.mjs runs it in node).
//
// Up to 8 slots. Per slot s (all Float32, read by every shader through lifefx.wgsl LifeFx):
//   ENC[s*8 ..]  type, x, y, z, t0, duration, seed, intensity      (type 0 = empty)
//   PH[s*4 ..]   end of cue, end of build-up, end of peak, end of afterimage (seconds after t0; the last = duration)
//   DIR[s*2 ..]  travel direction x, z (unit; actors move along it, CPU and GPU)
// Phases: cue (sound and a first sign), build-up, peak, afterimage (what lingers). lfPhase() in lifefx.wgsl
// returns (phase 0..3, progress 0..1 within it); -1 before t0 or after the end.
//
// Choice: every 40-90 s something common to the drone's realm (by realm weights at the drone); every 5-8 min a rare
// one; never two peaks at once (a new event starts only if its peak would follow every active peak). The event is
// placed ahead of the flight path inside the view cone at a readable distance, over terrain or water that suits it:
// 8 candidate points are tested with one world.heightBatch call (typed arrays, no allocation).
//
// URL (through init(query)): enc=<name|id>&et=<seconds> forces that encounter now, `et` seconds in, ahead of the
// view (captures); enc=off disables the director.
//
// Audio hook: CUE is a small preallocated record the sim's audio may read: [seq, type, x, y, z, intensity, phase,
// seconds into it]. seq increments on every new event and phase changes; audio plays the cue when seq changes.
import { heightBatch } from './world.js';
import { W_IN, W_ID, W_W, W_NEAR, realmWeightsA } from './realms.js';

// ---- types (ids are fixed: shaders and other modules use them) ----
// living world (fx/herd.js, fx/fauna.js, fx/flora.js)
export const E_ORCA = 1, E_MURMURATION = 2, E_FLAMINGO = 3, E_BREACH = 4, E_JELLY = 5, E_GIANTS = 6;
export const E_GANNETS = 7, E_HORSES = 8, E_SWIFTS = 9, E_LIGHTPULSE = 10;
// sky (sky-clouds)
export const E_METEOR = 16, E_AURORA = 17, E_ECLIPSE = 18, E_LUNAR = 19, E_MILKYWAY = 20, E_BROCKEN = 21;
export const E_RAINBOW = 22, E_DRYSTORM = 23, E_RAINSHAFT = 24, E_VEIL = 25;
// water and ground (terrain-art)
export const E_CALVING = 32, E_GEYSER = 33, E_CLOUDFALL = 34, E_FLASHFLOOD = 35, E_WAVESET = 36, E_DUSTDEVIL = 37;
export const NTYPE = 40;
export const TYPES = new Array(NTYPE).fill('');
const T = (id, name) => { TYPES[id] = name; };
T(1, 'orca'); T(2, 'murmuration'); T(3, 'flamingo'); T(4, 'breach'); T(5, 'jelly'); T(6, 'giants');
T(7, 'gannets'); T(8, 'horses'); T(9, 'swifts'); T(10, 'lightpulse');
T(16, 'meteor'); T(17, 'aurora'); T(18, 'eclipse'); T(19, 'lunar'); T(20, 'milkyway'); T(21, 'brocken');
T(22, 'rainbow'); T(23, 'drystorm'); T(24, 'rainshaft'); T(25, 'veil');
T(32, 'calving'); T(33, 'geyser'); T(34, 'cloudfall'); T(35, 'flashflood'); T(36, 'waveset'); T(37, 'dustdevil');

// per type: realm (-1 = any / the Drift), rare (0/1), distance m, duration s, phase ends (cue, build, peak),
// site (0 anywhere / sky, 1 water deeper than 8 m, 2 shallows -0.6..0.05, 3 land above 1 m, 4 water deeper than 12 m,
// 5 steep slope or cliff), enabled (a type is chosen only once its owner has built it: enable(id))
const REALM = new Int8Array(NTYPE).fill(-2), RARE = new Uint8Array(NTYPE), DISTM = new Float32Array(NTYPE);
const DUR = new Float32Array(NTYPE), PC = new Float32Array(NTYPE * 3), SITE = new Uint8Array(NTYPE);
export const ENABLED = new Uint8Array(NTYPE);
function def(id, realm, rare, dist, dur, cue, build, peak, site) {
  REALM[id] = realm; RARE[id] = rare; DISTM[id] = dist; DUR[id] = dur; SITE[id] = site;
  PC[id * 3] = cue; PC[id * 3 + 1] = build; PC[id * 3 + 2] = peak;
}
//   id            realm rare dist  dur   cue  build peak site
def(E_ORCA,          0, 1,  120,  110,   8,   30,  80, 1);
def(E_MURMURATION,   0, 1,  260,   70,   5,   30,  62, 0);
def(E_GANNETS,       0, 0,   80,   45,   4,   12,  35, 1);
def(E_WAVESET,       0, 0,  220,   40,   5,   15,  30, 5);
def(E_RAINBOW,       0, 0,  900,   60,   8,   20,  45, 0);
def(E_HORSES,        1, 0,  160,   40,   4,   10,  30, 3);
def(E_DUSTDEVIL,     1, 0,  400,   50,   6,   15,  40, 3);
def(E_GEYSER,        1, 0,  180,   35,   4,   10,  22, 3);
def(E_DRYSTORM,      1, 1, 3000,  120,  10,   40, 100, 0);
def(E_FLAMINGO,      2, 0,   70,   40,   3,    6,  14, 2);
def(E_RAINSHAFT,     2, 0, 2500,   70,   8,   25,  55, 0);
def(E_MILKYWAY,      2, 1,    0,   75,   6,   15,  60, 0);
def(E_SWIFTS,        3, 0,   40,   30,   2,    6,  20, 0);
def(E_CLOUDFALL,     3, 0,  300,   60,   6,   20,  45, 0);
def(E_BROCKEN,       3, 1,    0,   40,   4,   10,  30, 0);
def(E_CALVING,       4, 0,  500,   50,   3,    8,  25, 1);
def(E_METEOR,        4, 0, 5000,   12,   1,    2,   5, 0);
def(E_AURORA,        4, 0,    0,   60,   6,   20,  45, 0);
def(E_BREACH,        4, 1,   95,   45,   6,   19,  24, 4);
def(E_LUNAR,         4, 1,    0,  120,  10,   40, 100, 0);
def(E_LIGHTPULSE,    5, 0,  150,   20,   2,    5,  12, 3);
def(E_JELLY,         5, 0,  110,   60,   4,   25,  45, 0);
def(E_ECLIPSE,       5, 1,    0,  100,  10,   35,  70, 0);
def(E_GIANTS,        5, 1, 1400,  240,  15,   60, 180, 3);
def(E_VEIL,         -1, 1,    0,   60,   6,   20,  45, 0);
def(E_FLASHFLOOD,    7, 1,  250,   60,   6,   20,  40, 3);   // Slot Canyons (section 13), reserved
for (const id of [E_ORCA, E_MURMURATION, E_FLAMINGO, E_BREACH, E_JELLY, E_GIANTS]) ENABLED[id] = 1;
export function enable(id, on = 1) { ENABLED[id] = on; }

export const NSLOT = 8;
// one hidden slot past the end (index NSLOT): the next event is prepared there every frame and copied into a free
// slot when it starts, so the start path is always compiled code and nothing is boxed when an event begins
const ENCA = new Float32Array((NSLOT + 1) * 8), PHA = new Float32Array((NSLOT + 1) * 4), DIRA = new Float32Array((NSLOT + 1) * 2);
export const ENC = ENCA.subarray(0, NSLOT * 8);
export const PH = PHA.subarray(0, NSLOT * 4);
export const DIR = DIRA.subarray(0, NSLOT * 2);
export const CUE = new Float32Array(8);
// input record (filled by the caller each frame): t, cam x, y, z, view fwd x, z, drone velocity x, z, tan(half fov)
export const IN = new Float64Array(9);
// director state: [0] next common, [1] next rare, [2] events started, [3] forced type, [4] forced et, [5] disabled,
// [6] seed, [7] forced placed, [8] latest active peak end, [9] free slot
const ST = new Float64Array(16); // [10] start time scratch, [11] weight scratch, [12..15] prepared next times
// realm-weight scratch is shared (realms.js): the director saves and restores it around its own query
const SV_ID = new Int32Array(4), SV_W = new Float64Array(4), SV_N = new Float64Array(4), SV_IN = new Float64Array(2);
ST[0] = -1; ST[1] = -1; ST[6] = 1;
const CAND = new Float64Array(16), CH = new Float64Array(8), CDIR = new Float64Array(16);
let lastSig = 0;

// small integer hash (results stay small integers: nothing is boxed across calls)
function ih(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2f0f3c4d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 9;
}

// query: a URLSearchParams-like object or null; seed: world seed (integer)
export function init(query, seed) {
  ST.fill(0); ST[0] = -1; ST[1] = -1; ST[6] = (seed & 0x3fffffff) || 1; ENCA.fill(0); PHA.fill(0); DIRA.fill(0); CUE.fill(0);
  lastSig = 0;
  const e = query && query.get ? query.get('enc') : null;
  if (e === 'off') ST[5] = 1;
  else if (e) {
    const i = TYPES.indexOf(e);
    ST[3] = i > 0 ? i : (+e | 0);
    ST[4] = +(query.get('et') || 0);
  }
}

function sitesOk(site, i) {
  const h = CH[i];
  switch (site) {
    case 1: return h < -8;
    case 2: return h > -0.6 && h < 0.05;
    case 3: return h > 1;
    case 4: return h < -12;
    default: return true;
  }
}

// write slot s for type ty at (x, y, z) with direction (dx, dz), starting at t0
function place(s, ty, sd) { // start time in ST[10]
  const t0 = ST[10];
  const o = s * 8;
  ENCA[o] = ty; ENCA[o + 1] = CAND[14]; ENCA[o + 2] = CH[7]; ENCA[o + 3] = CAND[15];
  ENCA[o + 4] = t0; ENCA[o + 5] = DUR[ty]; ENCA[o + 6] = sd; ENCA[o + 7] = 1;
  PHA[s * 4] = PC[ty * 3]; PHA[s * 4 + 1] = PC[ty * 3 + 1]; PHA[s * 4 + 2] = PC[ty * 3 + 2]; PHA[s * 4 + 3] = DUR[ty];
  DIRA[s * 2] = CDIR[14]; DIRA[s * 2 + 1] = CDIR[15];
}

// find a site for type ty ahead in the view: returns 1 and leaves x, z in CAND[14..15], y in CH[7], direction in
// CDIR[14..15]; forced = 1 skips the terrain test (captures put the event straight ahead)
function site(ty, k, forced) {
  const D = DISTM[ty], px = IN[1], pz = IN[3];
  let fx = IN[4], fz = IN[5];
  let l = Math.sqrt(fx * fx + fz * fz) + 1e-9; fx /= l; fz /= l;
  const vx = IN[6], vz = IN[7], sp = Math.sqrt(vx * vx + vz * vz);
  const cone = Math.atan(Math.min(IN[8], 1.2) * 0.55); // half-angle kept inside the view (horizontal), with margin
  // lean toward the flight path (its angle from the view, clamped into the cone), never outside the view
  let ha = 0;
  if (sp > 2) ha = Math.max(-cone, Math.min(cone, Math.atan2(fx * vz - fz * vx, fx * vx + fz * vz)));
  for (let i = 0; i < 7; i++) {
    const r = ih(ST[6] | 0, k * 16 + i, ty);
    const a = forced ? 0 : 0.5 * ha + 0.5 * ((r & 1023) / 1023 * 2 - 1) * cone;
    const dd = D * (forced ? 1 : 0.8 + 0.4 * ((r >>> 10) & 1023) / 1023);
    const ca = Math.cos(a), sa = Math.sin(a);
    const dx = fx * ca - fz * sa, dz = fz * ca + fx * sa;
    CAND[i * 2] = px + dx * dd; CAND[i * 2 + 1] = pz + dz * dd;
    CDIR[i * 2] = dx; CDIR[i * 2 + 1] = dz;
  }
  heightBatch(CAND, 7, CH);
  for (let i = 0; i < 7; i++) {
    if (!forced && !sitesOk(SITE[ty], i)) continue;
    CAND[14] = CAND[i * 2]; CAND[15] = CAND[i * 2 + 1];
    // travel direction: orcas come toward and under the drone; the rest cross the view
    const dx = CDIR[i * 2], dz = CDIR[i * 2 + 1];
    if (ty === E_ORCA) { CDIR[14] = -dx; CDIR[15] = -dz; } else { CDIR[14] = -dz; CDIR[15] = dx; }
    CH[7] = SITE[ty] === 0 ? IN[2] : Math.max(CH[i], 0);
    if (ty === E_MURMURATION || ty === E_JELLY || ty === E_SWIFTS) CH[7] = IN[2];
    return 1;
  }
  return 0;
}

// the latest peak end among active slots (absolute time), and a free slot (or -1) into ST[9]
function scan() {
  const t = IN[0];
  let pe = -1e9; ST[9] = -1;
  for (let s = 0; s < NSLOT; s++) {
    const o = s * 8;
    if (ENC[o] && t > ENC[o + 4] + ENC[o + 5]) ENC[o] = 0;
    if (!ENC[o]) { if (ST[9] < 0) ST[9] = s; continue; }
    const p = ENC[o + 4] + PH[s * 4 + 2];
    if (p > pe) pe = p;
  }
  ST[8] = pe;
}

// pick a type for the drone's realm: rare or common; returns 0 if none fits
function pick(rare, k) {
  SV_ID.set(W_ID); SV_W.set(W_W); SV_N.set(W_NEAR); SV_IN.set(W_IN);
  W_IN[0] = IN[1]; W_IN[1] = IN[3]; realmWeightsA();
  const ty = pickW(rare, k);
  W_ID.set(SV_ID); W_W.set(SV_W); W_NEAR.set(SV_N); W_IN.set(SV_IN);
  return ty;
}
function pickW(rare, k) {
  let tot = 0;
  for (let ty = 1; ty < NTYPE; ty++) {
    if (!ENABLED[ty] || RARE[ty] !== rare || REALM[ty] < -1) continue;
    wOf(ty); tot += ST[11];
  }
  if (tot <= 0) return 0;
  let u = (ih(ST[6] | 0, k, 0x7177 + rare) & 65535) / 65536 * tot;
  for (let ty = 1; ty < NTYPE; ty++) {
    if (!ENABLED[ty] || RARE[ty] !== rare || REALM[ty] < -1) continue;
    wOf(ty); u -= ST[11];
    if (u < 0) return ty;
  }
  return 0;
}
function wOf(ty) { // weight of type ty at the drone into ST[11]
  const r = REALM[ty];
  ST[11] = 0;
  if (r === -1) { // the Drift: only between realms
    let m = 0; for (let s = 0; s < 4; s++) if (W_ID[s] >= 0 && W_W[s] > m) m = W_W[s];
    if (m < 0.75) ST[11] = 0.5;
    return;
  }
  for (let s = 0; s < 4; s++) if (W_ID[s] === r && W_W[s] > 0.3) ST[11] = W_W[s];
}

// once per frame, after IN is filled
export function update() {
  const t = IN[0];
  if (ST[5]) return;
  scan();
  if (ST[3] > 0 && !ST[7]) {
    // forced (captures): slot 0, straight ahead in the view, et seconds in
    const ty = ST[3] | 0;
    site(ty, 0, 1);
    ST[10] = t - ST[4]; place(0, ty, 1); ST[2]++;
    ST[7] = 1; ST[0] = t + 40; ST[1] = t + 300;
    cueOut();
    return;
  }
  if (ST[3] > 0) { cueOut(); return; } // a forced capture keeps the director quiet
  const n = ST[2] | 0;
  if (ST[0] < 0) { ST[0] = t + 25 + 30 * (ih(ST[6] | 0, 1, 3) & 1023) / 1023; ST[1] = t + 240 + 180 * (ih(ST[6] | 0, 2, 3) & 1023) / 1023; }
  const s = ST[9] | 0;
  // The next event is prepared every frame (rare first when one is due) and committed with integer selects and
  // typed-array copies: no branch of the start path is ever cold, so starting an event costs nothing on the heap.
  const rare = t >= ST[1] ? 1 : 0;
  const due = s >= 0 && (rare === 1 || t >= ST[0]) ? 1 : 0;
  const ok = prepare(rare, n);
  const go = due & ok, fail = due & (1 - ok);
  const d = NSLOT + go * (s - NSLOT);                 // slot to fill, or the hidden slot onto itself
  ENCA.copyWithin(d * 8, NSLOT * 8, NSLOT * 8 + 8);
  PHA.copyWithin(d * 4, NSLOT * 4, NSLOT * 4 + 4);
  DIRA.copyWithin(d * 2, NSLOT * 2, NSLOT * 2 + 2);
  // next common: after a start [12]; a common that found no site retries in 5 s [14]; else unchanged
  const s0 = go * 12 + fail * (1 - rare) * 14;
  // next rare: after a rare start [13]; a rare that found no site retries in 8 s [15]; else unchanged
  const s1 = 1 + go * rare * 12 + fail * rare * 14;
  ST.copyWithin(0, s0, s0 + 1); ST.copyWithin(1, s1, s1 + 1);
  ST[2] += go;
  cueOut();
}

// prepare a rare (1) or common (0) event in the hidden slot, with the times that follow it in ST[12..15];
// 1 if it may start now (a type fits, a site was found, and its peak follows every active peak)
function prepare(rare, n) {
  const t = IN[0], sd = ST[6] | 0;
  const ty = pick(rare, n * 2 + rare);
  const sok = site(ty, n, 0);
  ST[10] = t; place(NSLOT, ty, ih(sd, n, 0x5eed) & 65535);
  ST[12] = t + 40 + 50 * (ih(sd, n + 1, 0xc0) & 1023) / 1023;
  ST[13] = t + 300 + 180 * (ih(sd, n + 1, 0xa7) & 1023) / 1023;
  ST[14] = t + 5; ST[15] = t + 8;
  return ty > 0 && sok === 1 && t + PC[ty * 3 + 1] > ST[8] ? 1 : 0;
}

// CUE: the most recent active slot's type, place and phase; seq bumps on a new event or a new phase
function cueOut() {
  const t = IN[0];
  let best = -1, bt = -1e9;
  for (let s = 0; s < NSLOT; s++) { const o = s * 8; if (ENC[o] && ENC[o + 4] <= t && ENC[o + 4] > bt) { bt = ENC[o + 4]; best = s; } }
  if (best < 0) { CUE[6] = -1; return; }
  const o = best * 8, rel = t - ENC[o + 4];
  let ph = 3;
  if (rel < PH[best * 4]) ph = 0; else if (rel < PH[best * 4 + 1]) ph = 1; else if (rel < PH[best * 4 + 2]) ph = 2;
  const sig = ((ST[2] | 0) * 4 + ph) | 0;
  if (sig !== lastSig) { lastSig = sig; CUE[0]++; }
  CUE[1] = ENC[o]; CUE[2] = ENC[o + 1]; CUE[3] = ENC[o + 2]; CUE[4] = ENC[o + 3]; CUE[5] = ENC[o + 7]; CUE[6] = ph;
  CUE[7] = rel;
}
