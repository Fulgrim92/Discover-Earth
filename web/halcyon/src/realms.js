// The realm table. One row of vec4 fields per realm, blended by smooth Voronoi weights.
// The same Float32Array is uploaded to the GPU (followed by the 3x3 curated cell table) and read by world.js.
// Colours are sRGB hex here and converted to linear at pack time.

import { params as atmoParams, derive as atmoDerive, transmittanceA as atmoTransA, TR_IN, RG as ATMO_RG } from './atmo.js';

export const CELL = 5500; // m, Voronoi cell pitch
export const BAND = 2400; // m, blend band (in nearest-distance difference): the Drift, a ~2.4 km zone (DESIGN 11.1)
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
  'S8', // moon elevation (deg), azimuth (deg), irradiance above the air (same units as the sun's S0.z), disc (deg)
  'A0', // air: Rayleigh scale, Mie (haze) scale, Mie g, ozone scale        (atmo.js; S1-S4 are derived from these)
  'A1', // air: Rayleigh scattering rgb (1e-3/km; Earth 5.802, 13.558, 33.1), Mie scale height (km)
  'A2', // air: the star's colour above the air (linear rgb), multiple-scattering strength
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
  // life (fx/flora.js, fx/fauna.js, fx/particles.js); values in LIFE below
  'V0', // flora: grass, wildflowers, heather, dry tussock
  'V1', // flora: reeds, ferns + foliage crowns (+ fireflies), alien garden, ice shards
  'V2', // fauna: flamingos, seabirds, geese, sky jellies
  'V3', // particles: pollen + seed fluff, salt glints, snow / diamond dust, spores
  'V4', // life modes: seabirds circle the cloud sea, seabirds are snow petrels, giant mushrooms, vines on rims
];
export const ROW = Math.max(40, (FIELDS.length + 3) & ~3); // vec4 slots per realm row (>= FIELDS.length)
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
    M0: ['#3d6b29', 1], M1: ['#2a2b2e', 0.6], M2: ['#5e7838', 520], M3: ['#323335', 2.5], // Faroese summer grass, vivid end of the real range (lit Saksun slopes); basalt dark grey ~0.05
    M4: [0, 0, 0, 0], M5: [0, 0, 1, 1], M6: ['#000000', 0],
    S0: [11, 248, 7.0, 0.53], S1: ['#ffb574', 1.0], S2: ['#4d79b8', 2.4], S3: ['#f0c9a4', 1.0],
    S4: ['#ffad6b', 3.0], S5: [0, 0, 0, 0], S6: [0.9, 0.06, 0, 0.35], S7: ['#000000', 0],
    S8: [-15, 22, 0.9, 1.0], A0: [1, 2.0, 0.78, 1], A1: [5.802, 13.558, 33.1, 1.2], A2: [1, 1, 1, 1],
    F0: ['#c9d4e6', 1 / 26000], F1: ['#d4d6dc', 1 / 900], F2: [6, 1 / 45, 1 / 1400, 0.6],
    C0: [0.6, 420, 1450, 1.0], C1: ['#ffffff', 0], C2: [0, 0, 0, 6],
    C3: [0.3, 0.45, 0.8, 0], C4: ['#000000', 0],
    W0: [0.38, 0.06, 0.045, 0.9], W1: ['#16707c', 0.1], W2: ['#000000', 0],
    G0: [-0.3, 1.0, 1.0, 0.6], G1: ['#000000', 0.5], G2: ['#ffffff', 0.04], G3: [1, 1, 1, 0.6],
  },
  { // 1 Painted Range
    T0: [1 / 1700, 700, 10, 420], T1: [0.7, 0.3, 2.5, 1.35], T2: [0.5, 0.3, -15, 0.8], T3: [0.6, 7, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [0, 0, 0, 1], T8: [0, 90, 0, 0],
    M0: ['#7c8a4e', 0.35], M1: ['#b5432a', 0.8], M2: ['#f1e3c0', 9000], M3: ['#e0a43a', 0],
    M4: [1, 0, 0, 0], M5: [0, 0, 0, 0], M6: ['#000000', 0],
    S0: [36, 212, 7.0, 0.53], S1: ['#fff1de', 0.5], S2: ['#2556b8', 2.0], S3: ['#b6d0ea', 1.25],
    S4: ['#e8eef2', 2.0], S5: [0, 0, 0, 0], S6: [1.7, 0.03, 0, 0.6], S7: ['#000000', 0],
    S8: [-15, 22, 0.9, 1.0], A0: [1, 1.2, 0.8, 1], A1: [5.802, 13.558, 33.1, 1.2], A2: [1, 1, 1, 1],
    F0: ['#c4d6ee', 1 / 42000], F1: ['#eef0f2', 1 / 5000], F2: [40, 1 / 25, 1 / 1500, 0.4],
    C0: [0.34, 1900, 3000, 1.0], C1: ['#ffffff', 0], C2: [0, 0, 0, 5],
    C3: [1.0, 0.8, 0.9, 0], C4: ['#000000', 0],
    W0: [0.4, 0.06, 0.03, 0.4], W1: ['#0f5a6a', 0.1], W2: ['#000000', 0],
    G0: [-0.9, 1.0, 1.0, 0.6], G1: ['#000000', 0.5], G2: ['#ffffff', 0.04], G3: [1, 1, 1, 0.3],
  },
  { // 2 Mirror Salt
    T0: [1 / 3000, 30, 0, 300], T1: [0, 0.2, 0.0, 1], T2: [0, 0.2, 0, 1], T3: [0, 12, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [1, -0.035, 1, 300], T6: [0, 0, 0, 0], T7: [0, 0, 0, 0], T8: [0, 90, 0, 0],
    M0: ['#d8d2c8', 0], M1: ['#2e2826', 0.7], M2: ['#ece6dc', 9000], M3: ['#efe9e0', 0],
    M4: [0, 1, 0, 0], M5: [0, 0, 0, 0], M6: ['#000000', 0],
    S0: [6, 96, 7.0, 0.53], S1: ['#ffc59a', 1.2], S2: ['#8a86d0', 3.2], S3: ['#f7c0b0', 1.15],
    S4: ['#ffd0a0', 2.2], S5: [0, 0, 0, 0], S6: [1.05, 0.05, 0, 0.6], S7: ['#000000', 0],
    S8: [-15, 22, 0.9, 1.0], A0: [1, 0.8, 0.8, 1], A1: [5.802, 13.558, 33.1, 1.2], A2: [1, 1, 1, 1],
    F0: ['#e6c8d4', 1 / 30000], F1: ['#f0d8dc', 1 / 6000], F2: [2, 1 / 20, 1 / 1500, 0.7],
    C0: [0.4, 1300, 4400, 1.0], C1: ['#ffffff', 0], C2: [0, 0, 0, 3],
    C3: [0.65, 1.0, 0.9, 0], C4: ['#000000', 0],
    W0: [0.2, 0.05, 0.03, 0.02], W1: ['#c8d8e0', 0.0], W2: ['#000000', 0.55],
    G0: [-0.2, 1.0, 1.0, 0.6], G1: ['#000000', 0.5], G2: ['#ffffff', 0.04], G3: [1, 1, 1, 0.0],
  },
  { // 3 Stone Forest
    T0: [1 / 2000, 50, 14, 300], T1: [0.2, 0.3, 4, 1], T2: [0.85, 0.16, 30, 1.2], T3: [0, 12, 0.25, 7],
    T4: [1, 80, 360, 0.46], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [0, 0, 0, 0], T8: [0, 90, 0, 0],
    M0: ['#3a5530', 1], M1: ['#8a8578', 0.8], M2: ['#3c6a32', 9000], M3: ['#2e2f22', 40],
    M4: [0, 0, 1, 0], M5: [0, 0, 0, 0.2], M6: ['#000000', 0],
    S0: [24, 150, 7.0, 0.53], S1: ['#fff0d0', 0.9], S2: ['#87acb4', 1.4], S3: ['#d6e4dc', 1.0],
    S4: ['#f2ecd0', 2.0], S5: [0, 0, 0, 0], S6: [1.15, 0.08, 0, 0.4], S7: ['#000000', 0],
    S8: [-15, 22, 0.9, 1.0], A0: [1, 7.0, 0.75, 1], A1: [5.802, 13.558, 33.1, 1.0], A2: [1, 1, 1, 1],
    F0: ['#c8dcd6', 1 / 9000], F1: ['#e4ece8', 1 / 1400], F2: [90, 1 / 18, 1 / 1100, 0.8],
    C0: [0.55, 1700, 2300, 0.35], C1: ['#ffffff', 1], C2: [85, 122, 0.85, 2],
    C3: [0.0, 0.1, 1.0, 0], C4: ['#000000', 0],
    W0: [0.4, 0.12, 0.2, 0.05], W1: ['#1f5a32', 0.06], W2: ['#000000', 0.08],
    G0: [-1.2, 1.0, 1.0, 0.6], G1: ['#000000', 0.5], G2: ['#ffffff', 0.04], G3: [1, 1, 1, 0.4],
  },
  { // 4 Aurora Ice
    T0: [1 / 3400, 560, -22, 650], T1: [0.25, 0.45, 2, 2.0], T2: [0.35, 0.3, 30, 0.5], T3: [0, 12, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [0, 0, 0, 0], T7: [1, 1, 1, 0], T8: [0, 90, 0, 0],
    M0: ['#16161a', 0], M1: ['#3a3c40', 0.5], M2: ['#dfeaf4', 140], M3: ['#3a3a3d', 6],
    M4: [0, 0, 0, 1], M5: [0, 0, 0, 0], M6: ['#7fe9ff', 0.5],
    S0: [-14, 248, 7.0, 0.53], S1: ['#b4c8ff', 0.25], S2: ['#06122e', 4.5], S3: ['#1e3866', 0.55],
    S4: ['#2c4878', 5.0], S5: [1, 1, 0, 1], S6: [1.4, 0.1, 0, 0.3], S7: ['#6ae8c0', 0.07],
    S8: [15, 270, 0.12, 1.0], A0: [1, 0.3, 0.8, 1], A1: [5.802, 13.558, 33.1, 1.2], A2: [1, 1, 1, 1],
    F0: ['#3a5480', 1 / 30000], F1: ['#6c84a8', 1 / 2500], F2: [10, 1 / 30, 1 / 1500, 0.3],
    C0: [0.24, 1800, 2200, 0.016], C1: ['#ffffff', 0], C2: [0, 0, 0, 4],
    C3: [0.4, 0.15, 1.0, 0], C4: ['#000000', 0],
    W0: [0.45, 0.09, 0.06, 0.12], W1: ['#2a7a88', 0.04], W2: ['#06303a', 0.32],
    G0: [1.1, 1.0, 1.0, 0.6], G1: ['#000000', 0.6], G2: ['#ffffff', 0.05], G3: [1, 1, 1, 0.3],
  },
  { // 5 Lumen Deep
    T0: [1 / 2300, 170, 22, 700], T1: [0.0, 0.2, 1.5, 1.2], T2: [0.0, 0.2, 0, 1], T3: [0, 12, 0, 8],
    T4: [0, 140, 0, 0.3], T5: [0, 0, 0, 0], T6: [1, 22, 1, 60], T7: [0, 0, 0, 0], T8: [1, 70, 38, 0],
    M0: ['#110e1c', 0.5], M1: ['#0b0913', 0.4], M2: ['#3a2c5a', 9000], M3: ['#151024', 0],
    M4: [0, 0, 0, 0], M5: [1, 1, 0, 0], M6: ['#38f0d8', 2.2],
    S0: [5, 70, 3.0, 0.6], S1: ['#d6a0ff', 1.4], S2: ['#0a0524', 3.6], S3: ['#5a2c7c', 0.9],
    S4: ['#e07ab8', 2.5], S5: [0.6, 0, 1, 1], S6: [1.4, 0.08, 0, 0.35], S7: ['#8a60ff', 0.15],
    S8: [-15, 22, 0.9, 1.0], A0: [0.5, 0.4, 0.7, 0], A1: [8, 5, 15, 2.0], A2: [0.8, 0.45, 1.0, 1.4],
    F0: ['#6a4a9a', 1 / 16000], F1: ['#7a5ab0', 1 / 1800], F2: [15, 1 / 40, 1 / 1300, 0.5],
    C0: [0.55, 3000, 3300, 0.2], C1: ['#ffffff', 0], C2: [0, 0, 0, 3],
    C3: [0.1, 0.0, 1.0, 0], C4: ['#3ee0d0', 1.1],
    W0: [0.6, 0.12, 0.15, 0.2], W1: ['#0a3040', 0.06], W2: ['#30e8d0', 0.12],
    G0: [0.2, 1.05, 1.0, 0.6], G1: ['#000000', 0.6], G2: ['#ffffff', 0.06], G3: [1, 1, 1, 0.5],
  },
];

// Life per realm (appended fields V0..V3, merged into R so the realm rows above stay untouched).
const LIFE = [
  { V0: [1, 1, 1, 0], V1: [0, 0, 0, 0], V2: [0, 1, 1, 0], V3: [1, 0, 0, 0], V4: [0, 0, 0, 0] }, // Home Fjords: meadows, seabirds, geese, pollen
  { V0: [0, 0, 0, 1], V1: [0, 0, 0, 0], V2: [0, 0, 0.5, 0], V3: [0.25, 0, 0, 0], V4: [0, 0, 0, 0] }, // Painted Range: nearly bare
  { V0: [0, 0, 0, 0], V1: [1, 0, 0, 0], V2: [1, 0, 0, 0], V3: [0, 1, 0, 0], V4: [0, 0, 0, 0] }, // Mirror Salt: reeds on islands, flamingos
  { V0: [0, 0, 0, 0], V1: [0, 1, 0, 0], V2: [0, 0.7, 0, 0], V3: [0, 0, 0, 0], V4: [1, 0, 0, 1] }, // Stone Forest: ferns, crowns, vines, fireflies, birds over the cloud sea
  { V0: [0, 0, 0, 0], V1: [0, 0, 0, 1], V2: [0, 1, 0, 0], V3: [0, 0, 1, 0], V4: [0, 1, 0, 0] }, // Aurora Ice: shards, snow petrels, diamond dust
  { V0: [0, 0, 0, 0], V1: [0, 0, 1, 0], V2: [0, 0, 0, 1], V3: [0, 0, 0, 1], V4: [0, 0, 1, 0] }, // Lumen Deep: garden, giant mushrooms, jellies, spores
];
for (let r = 0; r < R.length; r++) Object.assign(R[r], LIFE[r]);

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

// Light and sky colours from the physical atmosphere (atmo.js): the sun at the ground (S1), sky irradiance on a
// horizontal surface (S2), the horizon band (S3) and the sunward horizon (S4), all in the renderer's display units
// for the realm's sun (S0.z) and moon (S8.z). Ambient scale S6.x is 1: S2 already is the sky's irradiance.
{
  const o = {};
  for (let r = 0; r < NREALM; r++) {
    const g = (k) => { const b = r * ROWF + F[k] * 4; return [TABLE[b], TABLE[b + 1], TABLE[b + 2], TABLE[b + 3]]; };
    const put = (k, v, w) => { const b = r * ROWF + F[k] * 4; TABLE[b] = v[0]; TABLE[b + 1] = v[1]; TABLE[b + 2] = v[2]; if (w !== undefined) TABLE[b + 3] = w; };
    const s0 = g('S0'), s8 = g('S8');
    const P = atmoParams(g('A0'), g('A1'), g('A2'));
    const E = s0[2];
    atmoDerive(P, s0[0], s0[1], s8[0], s8[1], s8[2] / E, o);
    put('S1', o.sun);
    put('S2', o.skyE.map((x) => x * E));
    // S3 / S4 keep the horizon's colour at the energy of the sky irradiance: terrain, clouds and water mix them
    // into their ambient light (the dome itself is drawn from the sky-view LUT, wgsl/atmo.wgsl)
    const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const kh = lum(o.skyE) / Math.max(lum(o.hor), 1e-6);
    put('S3', o.hor.map((x) => x * E * kh), 1);
    put('S4', o.sunward.map((x) => x * E * kh));
    TABLE[r * ROWF + F.S6 * 4] = 1;
  }
}

// ---- the sky turns (DESIGN 12.1): each realm's sun and moon swing along a slow arc around its signature light ----
// SKY_ARC per realm: sun elevation and azimuth swing, moon elevation swing (degrees), at s = -1..1 (s = 0 is the
// signature light of section 11). Home: late afternoon to blue hour; Ice: dusk to deep night while the moon climbs.
// skyTick() rewrites S0, S8 and the derived light S1..S4 of every realm in TABLE for the frame's s, so all realm
// blending (per pixel and at the camera) follows; the light comes from tables baked here along each arc (S2..S4,
// log-interpolated) and the sun's own colour from the transmittance, exactly, per frame.
export const SKY_ARC = [[16, 18, 0], [12, 22, 0], [9, 12, 0], [12, 20, 0], [8, 10, -10], [5, 8, 0]];
export const SKY_IN = new Float64Array(1); // s in -1..1 (main.js from the time of day); read by skyTick()
const ARC_K = 7, ARC_V = 9;
const ARC = new Float32Array(NREALM * ARC_K * ARC_V); // log of S2, S3, S4 rgb per arc sample
const BASE = new Float32Array(NREALM * 4);              // signature sun elevation, azimuth, moon elevation, star E
const EXPO = new Float32Array(NREALM * 2);              // signature exposure (G0.x), log2 horizontal illuminance
const ARC_P = [];                                        // atmosphere parameters per realm
const TS1 = new Float64Array(3);
const HE = new Float64Array(4); // horizE result, skyTick scratch (no boxed doubles per frame)
{
  const o = {};
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  for (let r = 0; r < NREALM; r++) {
    const g = (k) => { const b = r * ROWF + F[k] * 4; return [TABLE[b], TABLE[b + 1], TABLE[b + 2], TABLE[b + 3]]; };
    const s0 = g('S0'), s8 = g('S8'), A = SKY_ARC[r];
    const P = atmoParams(g('A0'), g('A1'), g('A2'));
    ARC_P.push(P);
    BASE[r * 4] = s0[0]; BASE[r * 4 + 1] = s0[1]; BASE[r * 4 + 2] = s8[0]; BASE[r * 4 + 3] = s0[2];
    EXPO[r * 2] = g('G0')[0];
    horizE(r); EXPO[r * 2 + 1] = Math.log2(HE[0]);
    const E = s0[2];
    for (let k = 0; k < ARC_K; k++) {
      const s = -1 + (2 * k) / (ARC_K - 1);
      atmoDerive(P, s0[0] + A[0] * s, s0[1] + A[1] * s, s8[0] + A[2] * s, s8[1], s8[2] / E, o, 6, 12);
      const kh = lum(o.skyE) / Math.max(lum(o.hor), 1e-9);
      const b = (r * ARC_K + k) * ARC_V;
      for (let c = 0; c < 3; c++) {
        ARC[b + c] = Math.log(Math.max(o.skyE[c] * E, 1e-12));
        ARC[b + 3 + c] = Math.log(Math.max(o.hor[c] * E * kh, 1e-12));
        ARC[b + 6 + c] = Math.log(Math.max(o.sunward[c] * E * kh, 1e-12));
      }
    }
  }
}
// horizontal illuminance (luma) of a realm's current row: sky irradiance plus the direct sun
function horizE(r) { // into HE[0]
  const o = r * ROWF, a = o + F.S2 * 4, b = o + F.S1 * 4;
  HE[0] = 0.2126 * TABLE[a] + 0.7152 * TABLE[a + 1] + 0.0722 * TABLE[a + 2] + 1e-7 +
    (0.2126 * TABLE[b] + 0.7152 * TABLE[b + 1] + 0.0722 * TABLE[b + 2]) * TABLE[o + F.S0 * 4 + 2] *
    Math.max(Math.sin((TABLE[o + F.S0 * 4] * Math.PI) / 180), 0);
}
export function skyTick() {
  const s = SKY_IN[0];
  let f = ((s + 1) * 0.5) * (ARC_K - 1);
  f = Math.min(Math.max(f, 0), ARC_K - 1);
  const i0 = Math.min(Math.floor(f), ARC_K - 2), u = f - i0;
  for (let r = 0; r < NREALM; r++) {
    const A = SKY_ARC[r], o = r * ROWF;
    const el = BASE[r * 4] + A[0] * s;
    TABLE[o + F.S0 * 4] = el; TABLE[o + F.S0 * 4 + 1] = BASE[r * 4 + 1] + A[1] * s;
    TABLE[o + F.S8 * 4] = BASE[r * 4 + 2] + A[2] * s;
    const P = ARC_P[r];
    TR_IN[0] = ATMO_RG + 0.002; TR_IN[1] = Math.sin((el * Math.PI) / 180); atmoTransA(P, TS1);
    for (let c = 0; c < 3; c++) TABLE[o + F.S1 * 4 + c] = TS1[c] * P.star[c];
    const b0 = (r * ARC_K + i0) * ARC_V, b1 = b0 + ARC_V;
    for (let c = 0; c < 3; c++) {
      TABLE[o + F.S2 * 4 + c] = Math.exp(ARC[b0 + c] + (ARC[b1 + c] - ARC[b0 + c]) * u);
      TABLE[o + F.S3 * 4 + c] = Math.exp(ARC[b0 + 3 + c] + (ARC[b1 + 3 + c] - ARC[b0 + 3 + c]) * u);
      TABLE[o + F.S4 * 4 + c] = Math.exp(ARC[b0 + 6 + c] + (ARC[b1 + 6 + c] - ARC[b0 + 6 + c]) * u);
    }
    // the eye adapts part of the way as the light falls or rises (a real camera would adapt fully; leaving some
    // keeps dusk dusky and noon bright)
    horizE(r);
    TABLE[o + F.G0 * 4] = EXPO[r * 2] + Math.min(Math.max(0.55 * (EXPO[r * 2 + 1] - Math.log2(HE[0])), -1.5), 3.0);
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
// hu(x, y, s) >>> 8: always a small integer, so it is returned unboxed even when V8 does not inline it
// (hot paths use hu8(...) * (1 / 16777216), bit-identical to hf)
export function hu8(x, y, s) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 8;
}

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
  SX[k] = Math.fround((i + (hu8(i, j, 101) * (1 / 16777216) - 0.5) * 2 * JIT) * CELL);
  SZ[k] = Math.fround((j + (hu8(i, j, 102) * (1 / 16777216) - 0.5) * 2 * JIT) * CELL);
  SI[k] = hu(i, j, 103) % NREALM;
}

// Hot-path calling convention (no double crosses a function boundary, so nothing is boxed even when V8 does not
// inline): inputs and results go through small Float64Array scratch slots.
const ZQ = new Float64Array(3); // vnz: x, y in; value out
function vnz(s) {
  const px = ZQ[0], py = ZQ[1];
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hu8(ix, iy, s) * (1 / 16777216) * 2 - 1, b = hu8(ix + 1, iy, s) * (1 / 16777216) * 2 - 1;
  const c = hu8(ix, iy + 1, s) * (1 / 16777216) * 2 - 1, d = hu8(ix + 1, iy + 1, s) * (1 / 16777216) * 2 - 1;
  ZQ[2] = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export const W_IN = new Float64Array(2); // realmWeightsA() input: x, z
export function realmWeights(x0, z0) { W_IN[0] = x0; W_IN[1] = z0; realmWeightsA(); }
export function realmWeightsA() {
  const x0 = W_IN[0], z0 = W_IN[1];
  const ax = x0 / 2600, az = z0 / 2600, bx = x0 / 800, bz = z0 / 800;
  ZQ[0] = ax; ZQ[1] = az; vnz(901); const n1 = ZQ[2];
  ZQ[0] = bx; ZQ[1] = bz; vnz(903); const n2 = ZQ[2];
  ZQ[0] = ax + 3.3; ZQ[1] = az + 8.1; vnz(902); const n3 = ZQ[2];
  ZQ[0] = bx + 1.9; ZQ[1] = bz + 4.4; vnz(904); const n4 = ZQ[2];
  const x = x0 + 650 * n1 + 180 * n2;
  const z = z0 + 650 * n3 + 180 * n4;
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
    const a = 1 - e, w = a * a * a * (a * (a * 6 - 15) + 10); // smootherstep: no kink, no threshold
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
// same, position from W_IN (no boxed arguments)
export function blendAtA(outRow) {
  realmWeightsA();
  blendFields(outRow, 0, 0, ROW);
}

// WGSL constants generated from this table.
export function wgslPreamble() {
  let s = 'const ROW:u32=' + ROW + 'u;const NREALM:u32=' + NREALM + 'u;const CUR_OFF:u32=' + (NREALM * ROW) + 'u;';
  s += 'const CELL:f32=' + CELL.toFixed(1) + ';const BAND:f32=' + BAND.toFixed(1) + ';const JIT:f32=' + JIT + ';';
  FIELDS.forEach((n, i) => { s += 'const ' + n + ':u32=' + i + 'u;'; });
  return s + '\n';
}
