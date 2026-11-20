// The realm table. One row of vec4 fields per realm, blended by smooth Voronoi weights.
// The same Float32Array is uploaded to the GPU (followed by the 3x3 curated cell table) and read by world.js.
// Colours are sRGB hex here and converted to linear at pack time.

export const CELL = 5500; // m, Voronoi cell pitch
export const BAND = 1400; // m, blend band (in nearest-distance difference)
export const JIT = 0.3; // site jitter as a fraction of the cell
export const NREALM = 6;

// Field order = row layout. Each field is one vec4. Keep in sync with nothing: WGSL constants are generated from this.
export const FIELDS = [
  // terrain
  'T0', // freq (1/m), amp (m), seaBias (m), warp (m)
  'T1', // ridgeW, erosion, detailAmp (m), shapePow
  'T2', // valleyW, valleyWidth, valleyDepth (m), valleyFreqMul
  'T3', // terraceW, terraceStep (m), ledgeW, ledgeStep (m)
  'T4', // pillarW, pillarCell (m), pillarH (m), pillarR (fraction of cell)
  'T5', // flatW, flatH (m), coneW, coneH (m)
  'T6', // duneW, duneH (m), bowlW, bowlDepth (m)
  'T7', // crevW, glacierW, bergW, poolW
  'T8', // crystalW, crystalCell (m), crystalH (m), sea cliff height (m)
  // material
  'M0', // grass rgb, grass amount
  'M1', // rock rgb, rock roughness
  'M2', // high rgb, high line (m)
  'M3', // shore/sand rgb, shore height (m)
  'M4', // strata, hex, canopy, ice
  'M5', // veins, crystal, waterfall, flowers
  'M6', // emission rgb, emission intensity
  // sky + light
  'S0', // sun elevation (deg), sun azimuth (deg, 0 = north/-z, 90 = east/+x), sun intensity, disc size (deg)
  'S1', // sun colour rgb, glow strength
  'S2', // zenith rgb, horizon exponent
  'S3', // horizon rgb, sky intensity
  'S4', // sunward horizon rgb, sunward spread exponent
  'S5', // stars, aurora, giant, moons
  'S6', // ambient scale, shadow softness, afterglow, bounce
  'S7', // afterglow rgb, night light
  // fog
  'F0', // aerial rgb tint, aerial density (1/m at sea level)
  'F1', // mist rgb, mist density (1/m)
  'F2', // mist top (m), mist falloff (1/m), aerial falloff (1/m), sun scatter
  // clouds
  'C0', // cover, base (m), top (m), density
  'C1', // tint rgb, sea layer weight
  'C2', // sea base (m), sea top (m), sea density, wind (m/s)
  'C3', // cell size (0 broad fields .. 1 small cells), type (0 stratus/veil .. 1 towering cumulus), erosion, 0
  'C4', // emission rgb (luminous clouds), emission intensity
  // water
  'W0', // absorption rgb (1/m), wave amplitude
  'W1', // scatter rgb, roughness
  'W2', // emission rgb, mirror (reflectance floor)
  // grade
  'G0', // exposure (EV), saturation, contrast, tonemap (0 neutral .. 1 agx)
  'G1', // lift rgb, vignette
  'G2', // gain rgb, bloom mix
  'G3', // gamma rgb, foam
];
export const ROW = 40; // vec4 slots per realm row (>= FIELDS.length)
export const ROWF = ROW * 4;
export const F = {};
FIELDS.forEach((n, i) => { F[n] = i; });

const COLOUR = new Set(['M0', 'M1', 'M2', 'M3', 'M6', 'S1', 'S2', 'S3', 'S4', 'S7', 'F0', 'F1', 'C1', 'C4', 'W1', 'W2', 'G1', 'G2']);

function hex(s) {
  const n = parseInt(s.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
}

// Each realm: field -> [a,b,c,d]; a colour field may give '#hex' as its first element followed by the w value.
const R = [
  { // 0 Home Fjords
    T0: [1 / 3200, 1150, -170, 700], T1: [0.6, 0.6, 5, 1.15], T2: [0.92, 0.32, 220, 0.85], T3: [0, 12, 0.12, 21],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [0, 0, 0, 0], T8: [0, 90, 0, 110],
    M0: ['#30582a', 1], M1: ['#2a2826', 0.6], M2: ['#7d8448', 520], M3: ['#3a3633', 2.5],
    M4: [0, 0, 0, 0], M5: [0, 0, 1, 1], M6: ['#000000', 0],
    S0: [11, 248, 5.2, 0.6], S1: ['#ffb574', 1.0], S2: ['#4d79b8', 2.4], S3: ['#f0c9a4', 1.0],
    S4: ['#ffad6b', 3.0], S5: [0, 0, 0, 0], S6: [0.9, 0.06, 0, 0.35], S7: ['#000000', 0],
    F0: ['#c9d4e6', 1 / 26000], F1: ['#d4d6dc', 1 / 900], F2: [6, 1 / 45, 1 / 1400, 0.6],
    C0: [0.7, 420, 1450, 1.0], C1: ['#fff0e6', 0], C2: [0, 0, 0, 6],
    C3: [0.3, 0.45, 0.8, 0], C4: ['#000000', 0],
    W0: [0.45, 0.075, 0.05, 1.0], W1: ['#0d3b44', 0.18], W2: ['#000000', 0],
    G0: [0.0, 1.0, 1.06, 0.3], G1: ['#060a12', 1.0], G2: ['#fff6ec', 0.045], G3: [1, 1, 1, 0.6],
  },
  { // 1 Painted Range
    T0: [1 / 1700, 700, 10, 420], T1: [0.7, 0.3, 2.5, 1.35], T2: [0.5, 0.3, -15, 0.8], T3: [0.6, 9, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [0, 0, 0, 1], T8: [0, 90, 0, 0],
    M0: ['#7c8a4e', 0.35], M1: ['#b5432a', 0.8], M2: ['#f1e3c0', 9000], M3: ['#e0a43a', 0],
    M4: [1, 0, 0, 0], M5: [0, 0, 0, 0], M6: ['#000000', 0],
    S0: [36, 212, 7.0, 0.5], S1: ['#fff1de', 0.5], S2: ['#2556b8', 2.0], S3: ['#b6d0ea', 1.25],
    S4: ['#e8eef2', 2.0], S5: [0, 0, 0, 0], S6: [1.7, 0.03, 0, 0.6], S7: ['#000000', 0],
    F0: ['#c4d6ee', 1 / 42000], F1: ['#eef0f2', 1 / 5000], F2: [40, 1 / 25, 1 / 1500, 0.4],
    C0: [0.34, 1900, 3000, 1.0], C1: ['#ffffff', 0], C2: [0, 0, 0, 5],
    C3: [1.0, 0.8, 0.9, 0], C4: ['#000000', 0],
    W0: [0.4, 0.06, 0.03, 0.4], W1: ['#0f5a6a', 0.1], W2: ['#000000', 0],
    G0: [-0.7, 0.95, 1.05, 0.5], G1: ['#08070c', 0.9], G2: ['#fffaf2', 0.04], G3: [1, 1, 1, 0.3],
  },
  { // 2 Mirror Salt
    T0: [1 / 3000, 30, 0, 300], T1: [0, 0.2, 0.0, 1], T2: [0, 0.2, 0, 1], T3: [0, 12, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [1, -0.035, 1, 300], T6: [0, 0, 0, 0], T7: [0, 0, 0, 0], T8: [0, 90, 0, 0],
    M0: ['#d8d2c8', 0], M1: ['#3f3236', 0.7], M2: ['#ece6dc', 9000], M3: ['#efe9e0', 0],
    M4: [0, 1, 0, 0], M5: [0, 0, 0, 0], M6: ['#000000', 0],
    S0: [6, 96, 4.2, 0.7], S1: ['#ffc59a', 1.2], S2: ['#8a86d0', 3.2], S3: ['#f7c0b0', 1.15],
    S4: ['#ffd0a0', 2.2], S5: [0, 0, 0, 0], S6: [1.05, 0.05, 0, 0.6], S7: ['#000000', 0],
    F0: ['#e6c8d4', 1 / 30000], F1: ['#f0d8dc', 1 / 6000], F2: [2, 1 / 20, 1 / 1500, 0.7],
    C0: [0.4, 1300, 4400, 1.0], C1: ['#ffe8e4', 0], C2: [0, 0, 0, 3],
    C3: [0.65, 1.0, 0.9, 0], C4: ['#000000', 0],
    W0: [0.2, 0.05, 0.03, 0.02], W1: ['#c8d8e0', 0.0], W2: ['#000000', 0.55],
    G0: [-0.1, 1.08, 1.0, 0.2], G1: ['#0a0812', 0.8], G2: ['#fff2f0', 0.05], G3: [1, 1, 1, 0.0],
  },
  { // 3 Stone Forest
    T0: [1 / 2000, 50, 14, 300], T1: [0.2, 0.3, 4, 1], T2: [0.4, 0.25, 6, 1.2], T3: [0, 12, 0.25, 7],
    T4: [1, 150, 330, 0.29], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [0, 0, 0, 0], T8: [0, 90, 0, 0],
    M0: ['#2f5a2a', 1], M1: ['#857a68', 0.8], M2: ['#3c6a32', 9000], M3: ['#4a4a3a', 1.5],
    M4: [0, 0, 1, 0], M5: [0, 0, 0, 0.2], M6: ['#000000', 0],
    S0: [24, 150, 4.0, 0.5], S1: ['#fff0d0', 0.9], S2: ['#87acb4', 1.4], S3: ['#d6e4dc', 1.0],
    S4: ['#f2ecd0', 2.0], S5: [0, 0, 0, 0], S6: [1.15, 0.08, 0, 0.4], S7: ['#000000', 0],
    F0: ['#c8dcd6', 1 / 9000], F1: ['#e4ece8', 1 / 1400], F2: [90, 1 / 18, 1 / 1100, 0.8],
    C0: [0.55, 1700, 2300, 0.35], C1: ['#f4fff8', 1], C2: [85, 122, 0.85, 2],
    C3: [0.0, 0.1, 1.0, 0], C4: ['#000000', 0],
    W0: [0.35, 0.1, 0.12, 0.3], W1: ['#123c2a', 0.2], W2: ['#000000', 0],
    G0: [-0.1, 1.05, 1.0, 0.3], G1: ['#060c0a', 0.9], G2: ['#f6fff4', 0.05], G3: [1, 1, 1, 0.4],
  },
  { // 4 Aurora Ice
    T0: [1 / 3400, 560, -22, 650], T1: [0.25, 0.45, 2, 2.0], T2: [0.35, 0.3, 30, 0.5], T3: [0, 12, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [1, 1, 1, 0], T8: [0, 90, 0, 0],
    M0: ['#16161a', 0], M1: ['#24262c', 0.5], M2: ['#dfeaf4', 140], M3: ['#141418', 6],
    M4: [0, 0, 0, 1], M5: [0, 0, 0, 0], M6: ['#7fe9ff', 0.5],
    S0: [-8, 318, 2.0, 0.5], S1: ['#ff9a6a', 0.6], S2: ['#06122e', 4.5], S3: ['#1e3866', 0.55],
    S4: ['#d07060', 4.0], S5: [1, 1, 0, 0], S6: [1.4, 0.06, 0.5, 0.3], S7: ['#9fe8c8', 0.12],
    F0: ['#3a5480', 1 / 30000], F1: ['#6c84a8', 1 / 2500], F2: [10, 1 / 30, 1 / 1500, 0.3],
    C0: [0.24, 1800, 2200, 0.016], C1: ['#56607e', 0], C2: [0, 0, 0, 4],
    C3: [0.4, 0.15, 1.0, 0], C4: ['#000000', 0],
    W0: [0.5, 0.1, 0.05, 0.25], W1: ['#0a2a40', 0.05], W2: ['#000000', 0.15],
    G0: [1.1, 1.1, 1.05, 0.3], G1: ['#030510', 1.0], G2: ['#eef6ff', 0.06], G3: [1, 1, 1, 0.3],
  },
  { // 5 Lumen Deep
    T0: [1 / 2300, 170, 22, 700], T1: [0.0, 0.2, 1.5, 1.2], T2: [0.0, 0.2, 0, 1], T3: [0, 12, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [1, 22, 1, 60], T7: [0, 0, 0, 0], T8: [1, 70, 38, 0],
    M0: ['#241a3c', 0.5], M1: ['#1a1428', 0.4], M2: ['#3a2c5a', 9000], M3: ['#2a2040', 0],
    M4: [0, 0, 0, 0], M5: [1, 1, 0, 0], M6: ['#38f0d8', 2.2],
    S0: [5, 70, 1.6, 0.6], S1: ['#d6a0ff', 1.4], S2: ['#0a0524', 3.6], S3: ['#5a2c7c', 0.9],
    S4: ['#e07ab8', 2.5], S5: [0.6, 0, 1, 1], S6: [1.4, 0.08, 0, 0.35], S7: ['#8a60ff', 0.15],
    F0: ['#6a4a9a', 1 / 16000], F1: ['#7a5ab0', 1 / 1800], F2: [15, 1 / 40, 1 / 1300, 0.5],
    C0: [0.72, 3000, 3300, 0.3], C1: ['#a888ff', 0], C2: [0, 0, 0, 3],
    C3: [0.1, 0.0, 1.0, 0], C4: ['#3ee0d0', 1.1],
    W0: [0.6, 0.15, 0.2, 0.3], W1: ['#0a3040', 0.08], W2: ['#20d0c0', 0.1],
    G0: [0.9, 1.15, 1.08, 0.5], G1: ['#08041a', 1.0], G2: ['#f4ecff', 0.08], G3: [1, 1, 1, 0.5],
  },
];

export const REALM_NAMES = ['Home Fjords', 'Painted Range', 'Mirror Salt', 'Stone Forest', 'Aurora Ice', 'Lumen Deep'];

// 3x3 curated cells around the origin, index (i+1) + (j+1)*3; -z is north, +x is east.
// [jitterX, jitterZ, realm]; null realm = hashed like every other cell.
const CUR = [
  [-0.05, 0.1, 2], [0.0, -0.12, 4], [0.22, -0.22, 5], //  j=-1 (north): NW Mirror repeat, N Ice, NE Lumen
  [0.08, -0.05, 2], [0, 0, 0], [-0.06, 0.08, 1], //        j= 0: W Mirror, Home, E Painted
  [0.0, 0.0, -1], [0.05, 0.1, 3], [0.0, 0.0, -1], //       j=+1 (south): SW hashed, S Stone, SE hashed
];

// GPU buffer: NREALM rows then 9 curated vec4 (x, z, realm, curated flag).
export const TABLE = new Float32Array(NREALM * ROWF + 9 * 4);
for (let r = 0; r < NREALM; r++) {
  for (const k of FIELDS) {
    let v = R[r][k];
    if (!v) throw new Error('realm ' + r + ' missing ' + k);
    if (COLOUR.has(k) && typeof v[0] === 'string') v = hex(v[0]).concat([v[1]]);
    for (let c = 0; c < 4; c++) TABLE[r * ROWF + F[k] * 4 + c] = v[c];
  }
}

// integer hash shared with WGSL (common.wgsl: hu)
export function hu(x, y, s) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
export function hf(x, y, s) { return (hu(x, y, s) >>> 8) * (1 / 16777216); }

const CUR_OFF = NREALM * ROWF;
for (let k = 0; k < 9; k++) {
  const i = (k % 3) - 1, j = ((k / 3) | 0) - 1;
  const c = CUR[k];
  let jx = c[0], jz = c[1], id = c[2], cur = 1;
  if (id < 0) { jx = (hf(i, j, 101) - 0.5) * 2 * JIT; jz = (hf(i, j, 102) - 0.5) * 2 * JIT; id = hu(i, j, 103) % NREALM; cur = 0; }
  TABLE[CUR_OFF + k * 4] = Math.fround((i + jx) * CELL);
  TABLE[CUR_OFF + k * 4 + 1] = Math.fround((j + jz) * CELL);
  TABLE[CUR_OFF + k * 4 + 2] = id;
  TABLE[CUR_OFF + k * 4 + 3] = cur;
}

// CURATED: [x, z, realmId] per curated cell (7 cells).
let nc = 0;
for (let k = 0; k < 9; k++) if (TABLE[CUR_OFF + k * 4 + 3] > 0) nc++;
export const CURATED = new Float32Array(nc * 3);
for (let k = 0, o = 0; k < 9; k++) {
  if (TABLE[CUR_OFF + k * 4 + 3] > 0) {
    CURATED[o++] = TABLE[CUR_OFF + k * 4]; CURATED[o++] = TABLE[CUR_OFF + k * 4 + 1]; CURATED[o++] = TABLE[CUR_OFF + k * 4 + 2];
  }
}
// centre of a curated realm by id (first match), for URL/realm jumps
export function realmCentre(id, out) {
  for (let k = 0; k < CURATED.length; k += 3) if (CURATED[k + 2] === id) { out[0] = CURATED[k]; out[1] = CURATED[k + 1]; return out; }
  out[0] = 0; out[1] = 0; return out;
}

// ---- smooth Voronoi weights (mirror of WGSL realmWeights) ----
// Results in module scratch: W_ID[0..3], W_W[0..3], W_N, plus nearest site.
export const W_ID = new Int32Array(4);
export const W_W = new Float64Array(4);
export const W_NEAR = new Float64Array(4); // x, z, realm, dmin
const SD = new Float64Array(9), SX = new Float64Array(9), SZ = new Float64Array(9), SI = new Int32Array(9);

function site(i, j, k) {
  if (i >= -1 && i <= 1 && j >= -1 && j <= 1) {
    const o = CUR_OFF + ((i + 1) + (j + 1) * 3) * 4;
    SX[k] = TABLE[o]; SZ[k] = TABLE[o + 1]; SI[k] = TABLE[o + 2];
    return;
  }
  SX[k] = Math.fround((i + (hf(i, j, 101) - 0.5) * 2 * JIT) * CELL);
  SZ[k] = Math.fround((j + (hf(i, j, 102) - 0.5) * 2 * JIT) * CELL);
  SI[k] = hu(i, j, 103) % NREALM;
}

function vnz(px, py, s) {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hf(ix, iy, s) * 2 - 1, b = hf(ix + 1, iy, s) * 2 - 1, c = hf(ix, iy + 1, s) * 2 - 1, d = hf(ix + 1, iy + 1, s) * 2 - 1;
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function realmWeights(x0, z0) {
  const ax = x0 / 2600, az = z0 / 2600, bx = x0 / 800, bz = z0 / 800;
  const x = x0 + 650 * vnz(ax, az, 901) + 180 * vnz(bx, bz, 903);
  const z = z0 + 650 * vnz(ax + 3.3, az + 8.1, 902) + 180 * vnz(bx + 1.9, bz + 4.4, 904);
  const bi = Math.floor(x / CELL + 0.5), bj = Math.floor(z / CELL + 0.5);
  let dmin = 1e30, kmin = 0;
  for (let j = -1, k = 0; j <= 1; j++) {
    for (let i = -1; i <= 1; i++, k++) {
      site(bi + i, bj + j, k);
      const dx = x - SX[k], dz = z - SZ[k];
      const d = Math.sqrt(dx * dx + dz * dz);
      SD[k] = d;
      if (d < dmin) { dmin = d; kmin = k; }
    }
  }
  W_ID[0] = -1; W_ID[1] = -1; W_ID[2] = -1; W_ID[3] = -1;
  W_W[0] = 0; W_W[1] = 0; W_W[2] = 0; W_W[3] = 0;
  let sum = 0;
  for (let k = 0; k < 9; k++) {
    const e = (SD[k] - dmin) / BAND;
    if (e >= 1) continue;
    const a = 1 - e, w = a * a * a;
    const id = SI[k];
    let s = 0;
    while (s < 4 && W_ID[s] !== id && W_ID[s] !== -1) s++;
    if (s === 4) continue;
    W_ID[s] = id; W_W[s] += w; sum += w;
  }
  for (let s = 0; s < 4; s++) W_W[s] /= sum;
  W_NEAR[0] = SX[kmin]; W_NEAR[1] = SZ[kmin]; W_NEAR[2] = SI[kmin]; W_NEAR[3] = dmin;
}

// blend fields [f0, f0+n) of the current weights into out (at out offset o)
export function blendFields(out, o, f0, n) {
  const a = f0 * 4, b = (f0 + n) * 4;
  for (let c = a; c < b; c++) out[o + c - a] = 0;
  for (let s = 0; s < 4; s++) {
    const id = W_ID[s];
    if (id < 0) continue;
    const w = W_W[s], base = id * ROWF;
    for (let c = a; c < b; c++) out[o + c - a] += w * TABLE[base + c];
  }
}

// Full blended row at (x, z) into outRow (ROWF floats). Alloc-free.
export function blendAt(x, z, outRow) {
  realmWeights(x, z);
  blendFields(outRow, 0, 0, ROW);
  return outRow;
}

// WGSL constants generated from this table.
export function wgslPreamble() {
  let s = 'const ROW:u32=' + ROW + 'u;const NREALM:u32=' + NREALM + 'u;const CUR_OFF:u32=' + (NREALM * ROW) + 'u;';
  s += 'const CELL:f32=' + CELL.toFixed(1) + ';const BAND:f32=' + BAND.toFixed(1) + ';const JIT:f32=' + JIT + ';';
  FIELDS.forEach((n, i) => { s += 'const ' + n + ':u32=' + i + 'u;'; });
  return s + '\n';
}
