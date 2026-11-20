// Light-ring practice ribbon. A deterministic course is generated once from world.CURATED and world.heightAt:
// from each curated realm centre it follows the lowest line it can find (valleys, gaps between pillars, low passes
// over flats and sea) on a gentle curve, then links on to the next realm. A window of at most WIN rings around the
// next ring is exposed in sim.rings; passes are detected as segment-plane crossings inside the radius.

import { wrapPi, hashi, HASH_SCALE } from './qmath.js';

// (init-time only)
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

export const MAX_COURSE = 4096;
export const WIN = 64;
export const STRIDE = 8; // x,y,z, nx,ny,nz, radius, state

export const course = new Float32Array(MAX_COURSE * STRIDE); // state slot unused here; cell index in slot 7
export const cstate = new Uint8Array(MAX_COURSE);
export const ringWin = new Float32Array(WIN * STRIDE);
export const info = new Int32Array(8); // [count, next, winStart, winCount, passedTotal, lastPassed, nextSlot, version]
export const I_COUNT = 0, I_NEXT = 1, I_WSTART = 2, I_WCOUNT = 3, I_PASSED = 4, I_LAST = 5, I_SLOT = 6, I_VER = 7;
export let tour = new Int16Array(0);       // curated cell indices in course order (built at init)
export let cellStart = new Int32Array(0);  // first course index of each tour stop

const DEG = Math.PI / 180;
const MIN_CLR = 8, MAX_CLR = 40;

let world = null;
function surface(x, z) { const h = world.heightAt(x, z); return h > 0 ? h : 0; }

// --------------------------------------------------------------------------------------------- generation (init)
export function build(w) {
  world = w;
  const cur = w.CURATED || new Float32Array(0);
  const n = (cur.length / 3) | 0;
  info[I_COUNT] = 0; info[I_NEXT] = 0; info[I_PASSED] = 0; info[I_LAST] = -1;
  tour = new Int16Array(n); cellStart = new Int32Array(n);
  if (n === 0) { fillWindow(); return; }
  // tour: nearest to origin, then greedy nearest unvisited
  const used = new Uint8Array(n);
  let best = 0, bd = Infinity;
  for (let i = 0; i < n; i++) { const d = Math.sqrt(cur[i * 3] ** 2 + cur[i * 3 + 1] ** 2); if (d < bd) { bd = d; best = i; } }
  tour[0] = best; used[best] = 1;
  for (let k = 1; k < n; k++) {
    const a = tour[k - 1];
    let bi = -1; bd = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const d = Math.sqrt((cur[i * 3] - cur[a * 3]) ** 2 + (cur[i * 3 + 1] - cur[a * 3 + 1]) ** 2);
      if (d < bd) { bd = d; bi = i; }
    }
    tour[k] = bi; used[bi] = 1;
  }

  const st = { x: 0, z: 0, y: 0, hd: 0, count: 0 };
  for (let k = 0; k < n; k++) {
    const c = tour[k];
    const cx = cur[c * 3], cz = cur[c * 3 + 1];
    cellStart[k] = st.count;
    // direction on toward the next realm (or onward, away from the previous one, for the last)
    let nx, nz;
    if (k + 1 < n) { nx = cur[tour[k + 1] * 3]; nz = cur[tour[k + 1] * 3 + 1]; }
    else if (n > 1) { const p = tour[k - 1]; nx = cx + (cx - cur[p * 3]) * 0.6; nz = cz + (cz - cur[p * 3 + 1]) * 0.6; }
    else { nx = cx; nz = cz - 3000; }
    const bearN = Math.atan2(-(nx - cx), -(nz - cz)); // yaw convention

    // realm line: pick the lowest of several 1.5 km spokes that do not point backwards
    let bestA = bearN, bestCost = Infinity;
    for (let j = 0; j < 9; j++) {
      const a = bearN + (j - 4) * 22 * DEG;
      let sum = 0;
      for (let s = 1; s <= 8; s++) sum += surface(cx - Math.sin(a) * s * 190, cz - Math.cos(a) * s * 190);
      const cost = sum / 8 + Math.abs(j - 4) * 6;
      if (cost < bestCost) { bestCost = cost; bestA = a; }
    }
    const wx = cx - Math.sin(bestA) * 1500, wz = cz - Math.cos(bestA) * 1500;

    if (k === 0) {
      st.x = cx; st.z = cz; st.hd = bestA;
      st.y = surface(cx, cz) + 14;
      push(st, cx, cz, 4, c);
    }
    // (later stops continue from the arriving link, so heading and height stay continuous)
    march(st, wx, wz, 55, 4, c, 10, 22, 160, 60);
    if (k + 1 < n) march(st, nx, nz, 100, 5, c, 18, 30, 120, 120);
    else march(st, nx, nz, 90, 5, c, 14, 26, 200, 40);
  }
  // normals: centred tangent
  const cnt = info[I_COUNT];
  for (let i = 0; i < cnt; i++) {
    const a = i > 0 ? i - 1 : i, b = i + 1 < cnt ? i + 1 : i;
    let tx = course[b * STRIDE] - course[a * STRIDE], ty = course[b * STRIDE + 1] - course[a * STRIDE + 1], tz = course[b * STRIDE + 2] - course[a * STRIDE + 2];
    // a jump between realms (new realm centre) uses the forward difference only
    if (i + 1 < cnt && distH(i, i + 1) > 400 && i > 0) { tx = course[i * STRIDE] - course[a * STRIDE]; ty = course[i * STRIDE + 1] - course[a * STRIDE + 1]; tz = course[i * STRIDE + 2] - course[a * STRIDE + 2]; }
    if (i > 0 && distH(i - 1, i) > 400 && i + 1 < cnt) { tx = course[b * STRIDE] - course[i * STRIDE]; ty = course[b * STRIDE + 1] - course[i * STRIDE + 1]; tz = course[b * STRIDE + 2] - course[i * STRIDE + 2]; }
    const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    course[i * STRIDE + 3] = tx / l; course[i * STRIDE + 4] = ty / l; course[i * STRIDE + 5] = tz / l;
  }
  for (let i = 0; i < cnt; i++) cstate[i] = 0;
  if (cnt > 0) cstate[0] = 1;
  fillWindow();
}

function distH(i, j) { return Math.sqrt((course[i * STRIDE] - course[j * STRIDE]) ** 2 + (course[i * STRIDE + 2] - course[j * STRIDE + 2]) ** 2); }

function push(st, x, z, r, cell) {
  const i = info[I_COUNT];
  if (i >= MAX_COURSE) return false;
  course[i * STRIDE] = x; course[i * STRIDE + 1] = st.y; course[i * STRIDE + 2] = z;
  course[i * STRIDE + 6] = r; course[i * STRIDE + 7] = cell;
  info[I_COUNT] = i + 1; st.count = i + 1;
  return true;
}

// march from st toward (tx, tz) with spacing s, choosing the lowest-ground heading within a turn limit
function march(st, tx, tz, s, r, cell, clrLo, clrHi, arrive, maxSteps) {
  const turn = s < 70 ? 13 * DEG : 9 * DEG; // radius ~ 245 m in realm, ~640 m on links
  for (let step = 0; step < maxSteps; step++) {
    const dx = tx - st.x, dz = tz - st.z, dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < arrive) break;
    const bear = Math.atan2(-dx, -dz);
    // bearing pull grows with the steps taken so the line always arrives
    const wb = 40 + step * 4 + (dist < 600 ? 200 : 0);
    let bestH = st.hd, bestC = Infinity;
    for (let j = -4; j <= 4; j++) {
      const a = st.hd + j * 7 * DEG;
      let sum = 0;
      for (let t = 1; t <= 3; t++) sum += surface(st.x - Math.sin(a) * s * t, st.z - Math.cos(a) * s * t);
      const dev = Math.abs(wrapPi(a - bear));
      const cost = sum / 3 + wb * dev * dev;
      if (cost < bestC) { bestC = cost; bestH = a; }
    }
    const dh = clamp(wrapPi(bestH - st.hd), -turn, turn);
    st.hd = wrapPi(st.hd + dh);
    const nx = st.x - Math.sin(st.hd) * s, nz = st.z - Math.cos(st.hd) * s;
    const g = surface(nx, nz);
    const hsh = hashi(info[I_COUNT], 977) * HASH_SCALE;
    let y = g + clrLo + (clrHi - clrLo) * hsh;
    // clear the terrain between the previous ring and this one by 6 m along the straight line
    for (let t = 1; t <= 4; t++) {
      const f = t / 5;
      const gs = surface(st.x + (nx - st.x) * f, st.z + (nz - st.z) * f) + 6;
      const need = st.y + (gs - st.y) / f;
      if (y < need) y = need;
    }
    // gentle climb / descent (<= ~12 deg, so a GPS-mode pilot at sport speed can follow it within 3.5 m/s descent)
    // where the terrain allows; terrain clearance wins over the slope
    const dyMax = 0.21 * s;
    if (y > st.y + dyMax && y - (st.y + dyMax) < 12) y = st.y + dyMax;
    if (y < st.y - dyMax) y = st.y - dyMax;
    y = clamp(y, g + MIN_CLR, g + MAX_CLR);
    st.x = nx; st.z = nz; st.y = y;
    if (!push(st, nx, nz, r, cell)) return;
  }
}

// --------------------------------------------------------------------------------------------- runtime
export function fillWindow() {
  const cnt = info[I_COUNT], next = info[I_NEXT];
  let start = next - 3; if (start < 0) start = 0;
  let wc = cnt - start; if (wc > WIN) wc = WIN; if (wc < 0) wc = 0;
  info[I_WSTART] = start; info[I_WCOUNT] = wc;
  for (let k = 0; k < wc; k++) {
    const i = start + k;
    for (let j = 0; j < 7; j++) ringWin[k * STRIDE + j] = course[i * STRIDE + j];
    ringWin[k * STRIDE + 7] = cstate[i];
  }
  for (let k = wc; k < WIN; k++) ringWin[k * STRIDE + 6] = 0;
  info[I_SLOT] = next < cnt ? next - start : -1;
  info[I_VER]++;
}

export const ARG = new Float64Array(8); // update(): p0 xyz, p1 xyz ; reacquire(): x, z ; distToNext() result in ARG[7]

// segment ARG[0..2] -> ARG[3..5] this frame; returns the course index passed (or -1)
export function update() {
  const cnt = info[I_COUNT];
  const next = info[I_NEXT];
  const p0x = ARG[0], p0y = ARG[1], p0z = ARG[2], p1x = ARG[3], p1y = ARG[4], p1z = ARG[5];
  let hit = -1;
  for (let j = next; j < next + 3 && j < cnt; j++) {
    const o = j * STRIDE;
    const cx = course[o], cy = course[o + 1], cz = course[o + 2], nx = course[o + 3], ny = course[o + 4], nz = course[o + 5];
    const d0 = (p0x - cx) * nx + (p0y - cy) * ny + (p0z - cz) * nz;
    const d1 = (p1x - cx) * nx + (p1y - cy) * ny + (p1z - cz) * nz;
    if (!(d0 < 0 && d1 >= 0)) continue;
    const t = d0 / (d0 - d1);
    const ix = p0x + (p1x - p0x) * t - cx, iy = p0y + (p1y - p0y) * t - cy, iz = p0z + (p1z - p0z) * t - cz;
    const r = course[o + 6];
    if (ix * ix + iy * iy + iz * iz <= r * r) { hit = j; break; }
  }
  if (hit < 0) return -1;
  for (let k = next; k <= hit; k++) cstate[k] = 2;
  info[I_NEXT] = hit + 1;
  if (hit + 1 < cnt) cstate[hit + 1] = 1;
  info[I_PASSED]++; info[I_LAST] = hit;
  fillWindow();
  return hit;
}

// make the course ring nearest to (ARG[0], ARG[1]) = (x, z) the next one
export function reacquire() {
  const cnt = info[I_COUNT];
  if (cnt === 0) return;
  const x = ARG[0], z = ARG[1];
  let bi = 0, bd = 1e30;
  for (let i = 0; i < cnt; i++) {
    const dx = course[i * STRIDE] - x, dz = course[i * STRIDE + 2] - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  const old = info[I_NEXT];
  if (old < cnt && cstate[old] === 1) cstate[old] = 0;
  info[I_NEXT] = bi; cstate[bi] = 1;
  fillWindow();
}

// first ring of the tour stop holding curated cell c
export function startOfCell(c) {
  for (let k = 0; k < tour.length; k++) if (tour[k] === c) return cellStart[k];
  return 0;
}

export function setNext(i) {
  const cnt = info[I_COUNT];
  if (cnt === 0) return;
  const old = info[I_NEXT];
  if (old < cnt && cstate[old] === 1) cstate[old] = 0;
  info[I_NEXT] = i < 0 ? 0 : i >= cnt ? cnt - 1 : i;
  cstate[info[I_NEXT]] = 1;
  fillWindow();
}

// distance from ARG[0..2] to the next ring, into ARG[7]
export function distToNext() {
  const i = info[I_NEXT];
  if (i >= info[I_COUNT]) { ARG[7] = 1e9; return; }
  const o = i * STRIDE, dx = course[o] - ARG[0], dy = course[o + 1] - ARG[1], dz = course[o + 2] - ARG[2];
  ARG[7] = Math.sqrt(dx * dx + dy * dy + dz * dz);
}
