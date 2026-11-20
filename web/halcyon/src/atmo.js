// atmo.js: the physical atmosphere (Rayleigh + Mie + ozone, single scattering plus an isotropic multiple-scattering
// term), CPU side. The same model runs on the GPU in wgsl/atmo.wgsl (the per-frame sky-view LUT); keep them in step.
// Used once at start (realms.js) to derive each realm's light and sky colours from its sun elevation and air, so
// terrain ambient, water, fog and clouds all see the light the sky dome shows (no hand-picked gradient colours).
//
// Units: km for the planet, display radiance = pi * physical radiance (the renderer lights surfaces as albedo * E),
// so a surface of albedo a under sky irradiance E_sky shows a * E_sky and the sky shows pi * L.
// Parameters (realm fields): A0 = Rayleigh scale, Mie (haze) scale, Mie g, ozone scale;
// A1 = Rayleigh scattering rgb (1e-3 / km; Earth 5.802, 13.558, 33.1), Mie scale height (km);
// A2 = the star's colour above the atmosphere (linear rgb), multiple-scattering strength.

export const RG = 6360, RT = 6460;
const OZ = [0.65, 1.881, 0.085]; // ozone absorption, 1e-3 / km at peak density
const MS_K = 1.0;                 // multiple scattering scale (times A2.w)

// scratch (no allocation in loops)
const tA = new Float64Array(3), tB = new Float64Array(3), acc = new Float64Array(3);

function dens(h, hm, o) {
  // o[0] rayleigh, o[1] mie, o[2] ozone
  o[0] = Math.exp(-h / 8); o[1] = Math.exp(-h / hm); o[2] = Math.max(0, 1 - Math.abs(h - 25) / 15);
}
// distance to the top of the atmosphere from radius r along cosine mu
function toTop(r, mu) { const b = r * mu, c = r * r - RT * RT; return -b + Math.sqrt(Math.max(b * b - c, 0)); }
// distance to the ground or -1
function toGround(r, mu) {
  const b = r * mu, c = r * r - RG * RG, d = b * b - c;
  if (mu >= 0 || d < 0) return -1;
  return -b - Math.sqrt(d);
}

// transmittance from (r, mu) to the top of the atmosphere into out (0 if the planet is in the way, with a soft edge)
const DN = new Float64Array(3), DT = new Float64Array(3);
export function transmittance(P, r, mu, out) {
  const g = toGround(r, mu);
  const L = toTop(r, mu);
  const n = 12;
  let tr = 0, tm = 0, to = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n * L;
    const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    dens(rr - RG, P.hm, DT);
    tr += DT[0]; tm += DT[1]; to += DT[2];
  }
  const ds = L / n;
  for (let c = 0; c < 3; c++) {
    const tau = (P.br[c] * tr + P.bme * tm + P.bo[c] * to) * ds;
    out[c] = Math.exp(-tau);
  }
  if (g > 0) { // below the horizon: the planet's shadow, softened over ~0.5 degree
    const hor = -Math.sqrt(Math.max(1 - (RG / r) * (RG / r), 0));
    const k = Math.min(Math.max((mu - hor) / 0.009 + 1, 0), 1);
    out[0] *= k; out[1] *= k; out[2] *= k;
  }
}

export function params(a0, a1, a2) {
  return {
    br: [a1[0] * 1e-3 * a0[0], a1[1] * 1e-3 * a0[0], a1[2] * 1e-3 * a0[0]],
    bms: 3.996e-3 * a0[1], bme: 3.996e-3 * a0[1] / 0.9, g: a0[2],
    bo: [OZ[0] * 1e-3 * a0[3], OZ[1] * 1e-3 * a0[3], OZ[2] * 1e-3 * a0[3]],
    hm: a1[3] || 1.2, star: [a2[0], a2[1], a2[2]], ms: a2[3] * MS_K,
  };
}

function phaseR(mu) { return 3 / (16 * Math.PI) * (1 + mu * mu); }
function phaseM(mu, g) {
  const g2 = g * g;
  return 3 / (8 * Math.PI) * (1 - g2) * (1 + mu * mu) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * mu, 1e-4), 1.5));
}

// display radiance seen from altitude h (km) along unit dir d, lit by light dir L with irradiance E (rgb, above
// the atmosphere); adds into out
const PS = new Float64Array(3), TV = new Float64Array(3), TS = new Float64Array(3);
export function skyRadiance(P, h, d, L, E, out) {
  const r = RG + h;
  const mu = d[1];
  const gnd = toGround(r, mu);
  const tmax = gnd > 0 ? gnd : toTop(r, mu);
  const n = 24;
  const nu = d[0] * L[0] + d[1] * L[1] + d[2] * L[2];
  const pr = phaseR(nu), pm = phaseM(nu, P.g);
  let tr = 0, tm = 0, to = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = tmax * ((i + 0.5) / n) * ((i + 0.5) / n);
    const ds = t - prev; prev = t;
    // sample point
    const px = d[0] * t, py = r + d[1] * t, pz = d[2] * t;
    const rr = Math.sqrt(px * px + py * py + pz * pz);
    dens(rr - RG, P.hm, DN);
    tr += DN[0] * ds; tm += DN[1] * ds; to += DN[2] * ds;
    for (let c = 0; c < 3; c++) TV[c] = Math.exp(-(P.br[c] * tr + P.bme * tm + P.bo[c] * to));
    const muS = (px * L[0] + py * L[1] + pz * L[2]) / rr;
    transmittance(P, rr, muS, TS);
    // the multiple-scattering source: light that has scattered at least once reaches p from all over the sky;
    // it follows the sun's transmittance from a point higher up (so twilight keeps a blue hour)
    transmittance(P, rr + 6, muS + 0.06, PS);
    for (let c = 0; c < 3; c++) {
      const sR = P.br[c] * DN[0], sM = P.bms * DN[1];
      const ss = (sR * pr + sM * pm) * TS[c];
      const ms = (sR + sM) * P.ms * 0.08 * PS[c];
      out[c] += TV[c] * (ss + ms) * ds * E[c] * Math.PI;
    }
  }
}

// derived colours for a realm: sun at ground (transmittance x star), sky irradiance on a horizontal surface,
// horizon radiance (mean over azimuth, 2 degrees up) and the sunward horizon radiance; E is per unit irradiance
const D = new Float64Array(3), LL = new Float64Array(3), EE = new Float64Array(3);
export function derive(P, sunEl, sunAz, moonEl, moonAz, moonE, out) {
  const rad = Math.PI / 180;
  const sunL = [Math.sin(sunAz * rad) * Math.cos(sunEl * rad), Math.sin(sunEl * rad), -Math.cos(sunAz * rad) * Math.cos(sunEl * rad)];
  const moonL = [Math.sin(moonAz * rad) * Math.cos(moonEl * rad), Math.sin(moonEl * rad), -Math.cos(moonAz * rad) * Math.cos(moonEl * rad)];
  transmittance(P, RG + 0.002, sunL[1], tA);
  out.sun = [tA[0] * P.star[0], tA[1] * P.star[1], tA[2] * P.star[2]];
  transmittance(P, RG + 0.002, moonL[1], tB);
  out.moonT = (tB[0] + tB[1] + tB[2]) / 3;
  const light = (dd, o) => {
    o[0] = o[1] = o[2] = 0;
    EE[0] = P.star[0]; EE[1] = P.star[1]; EE[2] = P.star[2];
    skyRadiance(P, 0.002, dd, sunL, EE, o);
    if (moonE > 0) {
      EE[0] = EE[1] = EE[2] = moonE;
      skyRadiance(P, 0.002, dd, moonL, EE, o);
    }
  };
  // irradiance from the upper hemisphere (cosine weighted), per unit sun irradiance
  let e0 = 0, e1 = 0, e2 = 0;
  const NE = 8, NA = 16;
  for (let i = 0; i < NE; i++) {
    const el = (i + 0.5) / NE * Math.PI / 2;
    for (let j = 0; j < NA; j++) {
      const az = (j + 0.5) / NA * Math.PI * 2;
      D[0] = Math.sin(az) * Math.cos(el); D[1] = Math.sin(el); D[2] = -Math.cos(az) * Math.cos(el);
      light(D, LL);
      const w = Math.sin(el) * Math.cos(el) * (Math.PI / 2 / NE) * (Math.PI * 2 / NA);
      // display radiance is pi * L, irradiance = integral L cos dw: divide the pi back out
      e0 += LL[0] * w / Math.PI; e1 += LL[1] * w / Math.PI; e2 += LL[2] * w / Math.PI;
    }
  }
  out.skyE = [e0, e1, e2];
  // horizon band radiance (2 degrees up), averaged over azimuth, and toward the sun
  let h0 = 0, h1 = 0, h2 = 0;
  for (let j = 0; j < NA; j++) {
    const az = (j + 0.5) / NA * Math.PI * 2;
    D[0] = Math.sin(az) * Math.cos(2 * rad); D[1] = Math.sin(2 * rad); D[2] = -Math.cos(az) * Math.cos(2 * rad);
    light(D, LL);
    h0 += LL[0] / NA; h1 += LL[1] / NA; h2 += LL[2] / NA;
  }
  out.hor = [h0, h1, h2];
  D[0] = Math.sin(sunAz * rad) * Math.cos(3 * rad); D[1] = Math.sin(3 * rad); D[2] = -Math.cos(sunAz * rad) * Math.cos(3 * rad);
  light(D, LL);
  out.sunward = [LL[0], LL[1], LL[2]];
  return out;
}
