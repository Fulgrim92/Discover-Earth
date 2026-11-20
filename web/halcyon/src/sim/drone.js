// HALCYON flight model: rigid-body quad, quaternion attitude, per-motor thrust with first-order motor lag,
// quadratic anisotropic drag, gravity, ground effect, wind with gusts, GPS / Angle / Acro controllers.
// Fixed 240 Hz substeps (the accumulator lives in index.js). Nothing here allocates after init: scalars live in
// typed arrays, helpers take arrays (see qmath.js for why), terrain comes in per frame from index.js.
//
// Frames: world metres, Y up, right-handed, yaw 0 looks down -Z. Body: +X right, +Y up (thrust), -Z nose.
// Quaternions [x,y,z,w] rotate body -> world.

import { qmul, qmulConjA, qnorm, qyawA, qrotvec, qfromUp, vrot, vrotInv, vup, qheadingA, hashi, HASH_SCALE, vnoiseA } from './qmath.js';
import * as T from './terrain.js';

export const G = 9.81;
export const RHO = 1.225;
export const HZ = 240;
export const H = 1 / HZ;
const TWO_PI = 6.283185307179586;

export const MODE_GPS = 0, MODE_ANGLE = 1, MODE_ACRO = 2;

// ---------------------------------------------------------------------------------------------------------------
// Airframes. One Float64Array each, indexed by the constants below.
export const A_MASS = 0, A_TW = 1, A_TMAX = 2, A_CURVE = 3, A_TAUM = 4, A_IXX = 5, A_IYY = 6, A_IZZ = 7, A_ARM = 8,
  A_KQ = 9, A_CDX = 10, A_CDY = 11, A_CDZ = 12, A_HB = 13, A_ROTR = 14, A_VPITCH = 15, A_CRASHV = 16, A_CRASHH = 17,
  A_IDLE = 18, A_RKP = 19, A_RKI = 20, A_RKD = 21, A_LIN = 22, A_ROTDAMP = 23, A_HOVER = 24, A_KM = 25, A_N = 26;

function airframe(mass, tw, curve, tauM, ixx, iyy, izz, arm, kq, cdx, cdy, cdz, hb, rotR, vpitch, crashV, crashH,
  idle, rkp, rki, rkd, lin, rotDamp) {
  const a = new Float64Array(A_N);
  a[A_MASS] = mass; a[A_TW] = tw; a[A_TMAX] = mass * G * tw; a[A_CURVE] = curve; a[A_TAUM] = tauM;
  a[A_IXX] = ixx; a[A_IYY] = iyy; a[A_IZZ] = izz; a[A_ARM] = arm; a[A_KQ] = kq;
  a[A_CDX] = cdx; a[A_CDY] = cdy; a[A_CDZ] = cdz; a[A_HB] = hb; a[A_ROTR] = rotR; a[A_VPITCH] = vpitch;
  a[A_CRASHV] = crashV; a[A_CRASHH] = crashH; a[A_IDLE] = idle; a[A_RKP] = rkp; a[A_RKI] = rki; a[A_RKD] = rkd;
  a[A_LIN] = lin; a[A_ROTDAMP] = rotDamp;
  // hover stick: inverse of the thrust curve at 1/TW
  const b = 1 - curve, f = 1 / tw;
  a[A_HOVER] = (-curve + Math.sqrt(curve * curve + 4 * b * f)) / (2 * b);
  a[A_KM] = 1 - Math.exp(-H / tauM);
  return a;
}

// 249 g folding camera drone (DJI Mini class): 6" two-blade props, T/W 3, 60 ms motor lag.
//   drag areas Cd*A (m^2): side 0.0125, top 0.030, front 0.0115
export const CAMERA = airframe(0.249, 3.0, 0.35, 0.060, 6.0e-4, 1.0e-3, 6.0e-4, 0.070, 0.012,
  0.0125, 0.030, 0.0115, 0.05, 0.076, 55, 2.6, 3.0, 0.06, 40, 3, 1.5, 0.010, 2.0e-5);

// 650 g 5-inch freestyle quad with action camera: T/W 5.5, 30 ms motor lag (real 5" ESC+motor ~20-30 ms).
export const FIVE = airframe(0.65, 5.5, 0.35, 0.030, 1.4e-3, 2.4e-3, 1.4e-3, 0.078, 0.014,
  0.0130, 0.034, 0.0110, 0.03, 0.0635, 75, 4.0, 5.0, 0.05, 110, 3, 1.9, 0.015, 4.0e-5);
const HOV_CAM = CAMERA.subarray(A_HOVER, A_HOVER + 1), HOV_FIVE = FIVE.subarray(A_HOVER, A_HOVER + 1); // hover throttle views

// motor layout (Betaflight Quad-X order): m0 rear-right CW, m1 front-right CCW, m2 rear-left CCW, m3 front-left CW
const PX = new Float64Array([-1, 1, -1, 1]); // pitch-up torque sign (front motors raise the nose)
const PZ = new Float64Array([1, 1, -1, -1]); // roll-left torque sign (right motors lift the right side)
const PY = new Float64Array([1, -1, -1, 1]); // yaw-left torque sign (CW props react CCW on the body)

// ---------------------------------------------------------------------------------------------------------------
// GPS / Angle limits (camera drone)
export const GPS = {
  vN: 10, vS: 16, vBoost: 120,         // horizontal speed limits m/s (Normal / Sport / transit)
  tiltN: 25 * Math.PI / 180, tiltS: 35 * Math.PI / 180,
  upN: 4, upS: 5, dnN: 3, dnS: 3.5,     // climb / descent m/s
  yawN: 90 * Math.PI / 180, yawS: 150 * Math.PI / 180,
  accN: 4.5, accS: 7.5, accBoost: 12,  // reference acceleration limits m/s^2
  kv: 2.4, kiv: 1.2, kpos: 1.6,
  kz: 3.5, kiz: 2.0, kpz: 1.6,
  att: 9, attYaw: 4, rateMax: 4.5,
};
export const ANGLE = { tilt: 45 * Math.PI / 180, yaw: 180 * Math.PI / 180, att: 9, attYaw: 4, rateMax: 6 };

// ---------------------------------------------------------------------------------------------------------------
// State
export const p = new Float64Array(3), v = new Float64Array(3), q = new Float64Array(4), w = new Float64Array(3);
export const m = new Float64Array(4);     // motor command after lag (rpm proxy), 0..1
export const mc = new Float64Array(4);    // motor command before lag
export const thr = new Float64Array(4);   // per-motor thrust, N
export const alpha = new Float64Array(3); // actual angular acceleration from the motors (body), for the D-term
export const wind = new Float64Array(3);  // wind at the drone (world), m/s
export const air = new Float64Array(3);   // air-relative velocity (world)
export const safeP = new Float64Array(4); // last safe hover point x, y, z, yaw
export const hold = new Float64Array(4);  // GPS holds: x, y (altitude), z, heading target
export const vref = new Float64Array(3);  // shaped GPS velocity reference (world)
export const ivel = new Float64Array(3);  // GPS velocity integrators
export const irate = new Float64Array(3); // rate-loop integrators (body)
export const ch = new Float64Array(4);    // controls from index.js: [throttle, yaw, pitch, roll] (see API.md)
export const assist = new Float64Array(3);// transit assist force (world, N)
export const wbase = new Float64Array(4); // wind: base m/s, direction (yaw convention), gustiness 0..1, seed
export const PH = new Float64Array(4);    // argument slot for placeHover(): x, y, z, yaw
export const S = new Float64Array(48);    // scalar slots
export const S_CRASHT = 0, S_SAFET = 1, S_TIME = 2, S_G0 = 3, S_G1 = 4, S_SUBI = 5, S_SUBN = 6, S_GHERE = 7,
  S_GAHEAD = 8, S_AGL = 9, S_TRANSIT = 10, S_COLL = 11, S_LASTIMPACT = 12, S_WATER = 13, S_INTX = 14, S_INTZ = 15,
  S_PSI = 16, S_KTILT = 17, S_KYAW = 18, S_YAWFF = 19, S_RMAX = 20, S_NOISE = 24 /* ..31 */;

// integer state (Smis in object fields are fine)
export const st = { mode: MODE_GPS, sport: 0, boost: 0, crashed: 0, landed: 0, holdH: 0, holdV: 0, crashes: 0, respawns: 0, sat: 0, satv: 0, af: CAMERA };

// scratch
const t3 = new Float64Array(3), u3 = new Float64Array(3), f3 = new Float64Array(3), d3 = new Float64Array(3);
const qa = new Float64Array(4), qb = new Float64Array(4), qd = new Float64Array(4), qe = new Float64Array(4);
const wc = new Float64Array(3); // commanded body rates

export function init() {
  p.fill(0); v.fill(0); w.fill(0); m.fill(0); mc.fill(0); thr.fill(0); alpha.fill(0); wind.fill(0); air.fill(0);
  safeP.fill(0); hold.fill(0); vref.fill(0); ivel.fill(0); irate.fill(0); ch.fill(0); assist.fill(0); S.fill(0);
  q[0] = q[1] = q[2] = 0; q[3] = 1;
  st.mode = MODE_GPS; st.sport = 0; st.boost = 0; st.crashed = 0; st.landed = 0; st.holdH = 0; st.holdV = 0;
  st.crashes = 0; st.respawns = 0; st.sat = 0; st.satv = 0; st.af = CAMERA;
  wbase[0] = 3; wbase[1] = 0.6; wbase[2] = 0.35; wbase[3] = 7;
  S[S_SUBN] = 1;
}

export function setMode(mode) {
  st.mode = mode;
  st.af = mode === MODE_ACRO ? FIVE : CAMERA;
  resetControllers();
  // typed-array copies, not JS doubles: mode switches run cold (interpreted), where every double load boxes
  if (st.landed) m.fill(0);
  else { const h = mode === MODE_ACRO ? HOV_FIVE : HOV_CAM; m.set(h, 0); m.set(h, 1); m.set(h, 2); m.set(h, 3); }
  mc.set(m);
}

export function resetControllers() {
  ivel.fill(0); irate.fill(0); alpha.fill(0);
  vref.set(v);
  st.holdH = 0; st.holdV = 0;
  hold.set(p);
  qheadingA(q, hold, 3);
}

// place a level, stationary drone hovering at PH = [x, y, z, yaw]
export function placeHover() {
  p[0] = PH[0]; p[1] = PH[1]; p[2] = PH[2]; v[0] = v[1] = v[2] = 0; w[0] = w[1] = w[2] = 0;
  qyawA(q, PH, 3);
  st.crashed = 0; st.landed = 0; S[S_CRASHT] = 0; S[S_TRANSIT] = 0;
  const u = st.af[A_HOVER];
  for (let i = 0; i < 4; i++) { m[i] = u; mc[i] = u; }
  resetControllers();
  st.holdH = 1; st.holdV = 1;
  safeP[0] = PH[0]; safeP[1] = PH[1]; safeP[2] = PH[2]; safeP[3] = PH[3];
  S[S_SAFET] = 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Wind, once per frame: realm base vector, log height profile, gusts from seeded integer-hash value noise
// advected with the mean wind.
export function frameWind() {
  const base = wbase[0], dir = wbase[1], gust = wbase[2], seed = wbase[3] | 0;
  const along = -(p[0] * Math.sin(dir) + p[2] * Math.cos(dir)) / (base + 1);
  const tt = S[S_TIME] - along;
  const N = S_NOISE;
  S[N] = tt * 0.17; S[N + 1] = tt * 0.53; S[N + 2] = tt * 1.7; S[N + 3] = tt * 0.11; S[N + 4] = tt * 0.6;
  S[N + 5] = tt * 0.31; S[N + 6] = tt * 1.3;
  vnoiseA(S, N, seed); vnoiseA(S, N + 1, seed + 1); vnoiseA(S, N + 2, seed + 2); vnoiseA(S, N + 3, seed + 3);
  vnoiseA(S, N + 4, seed + 4); vnoiseA(S, N + 5, seed + 5); vnoiseA(S, N + 6, seed + 6);
  const n1 = 0.6 * S[N] + 0.3 * S[N + 1] + 0.15 * S[N + 2];
  const n2 = 0.7 * S[N + 3] + 0.3 * S[N + 4];
  const n3 = 0.6 * S[N + 5] + 0.4 * S[N + 6];
  const agl = S[S_AGL] > 0.05 ? S[S_AGL] : 0.05;
  const prof = Math.min(1.5, Math.max(0.25, Math.log(agl / 0.03) * 0.17200)); // 1/ln(10/0.03): 1 at 10 m
  const sp = base * prof * (1 + gust * 0.9 * n1);
  const d = dir + gust * 0.5 * n2;
  wind[0] = -Math.sin(d) * sp; // dir uses the yaw convention: 0 blows toward -Z, +pi/2 toward -X
  wind[2] = -Math.cos(d) * sp;
  wind[1] = base * gust * 0.18 * n3 * prof;
}

// ---------------------------------------------------------------------------------------------------------------
// controllers. Each writes wc (commanded body rates) and S[S_COLL] (collective, fraction of max total thrust).
function attitudeRates() {
  qmulConjA(qe, q, qd); // body-frame error rotation
  const sgn = qe[3] < 0 ? -2 : 2, kt = S[S_KTILT], rmax = S[S_RMAX];
  wc[0] = Math.min(rmax, Math.max(-rmax, kt * sgn * qe[0]));
  wc[1] = S[S_KYAW] * sgn * qe[1];
  wc[2] = Math.min(rmax, Math.max(-rmax, kt * sgn * qe[2]));
  t3[0] = 0; t3[1] = S[S_YAWFF]; t3[2] = 0; // yaw-rate feed-forward, world Y rate in body axes
  vrotInv(t3, q, t3);
  wc[0] += t3[0]; wc[1] += t3[1]; wc[2] += t3[2];
}

// yaw rate command comes in S[S_YAWFF]
function headingHold() {
  const yawRate = S[S_YAWFF];
  qheadingA(q, S, S_PSI);
  const psi = S[S_PSI];
  if (st.landed) { hold[3] = psi; return; }
  let hd = hold[3] + yawRate * H;
  hd -= TWO_PI * Math.round(hd / TWO_PI);
  let e = hd - psi; e -= TWO_PI * Math.round(e / TWO_PI);
  if (e > 0.5) hd = psi + 0.5; else if (e < -0.5) hd = psi - 0.5;
  hold[3] = hd - TWO_PI * Math.round(hd / TWO_PI);
}

// GPS: velocity command, braking hover with position hold, altitude hold, tilt limits, clearance assist, transit
function gpsControl() {
  const af = st.af, mass = af[A_MASS], h = H;
  const sport = st.sport, boost = st.boost;
  const climb = ch[0], yawIn = ch[1], fwdIn = ch[2], rightIn = ch[3];
  const vmax = boost ? GPS.vBoost : sport ? GPS.vS : GPS.vN;
  const tilt = sport || boost ? GPS.tiltS : GPS.tiltN;
  const yawMax = sport ? GPS.yawS : GPS.yawN;
  const acc = boost ? GPS.accBoost : sport ? GPS.accS : GPS.accN;
  const vh = Math.sqrt(v[0] * v[0] + v[2] * v[2]);

  // transit: while boost is held, and until back under the sport limit after it
  const transit = boost || (S[S_TRANSIT] > 0 && vh > GPS.vS + 0.5) ? 1 : 0;
  S[S_TRANSIT] = transit;

  const yawRate = -yawIn * yawMax; // stick right -> clockwise -> negative about +Y
  S[S_YAWFF] = yawRate;
  headingHold();
  const psi = S[S_PSI];
  const sp = Math.sin(psi), cp = Math.cos(psi);
  // stick -> world velocity target: forward = (-sin, 0, -cos), right = (cos, 0, -sin)
  let tx = -sp * fwdIn + cp * rightIn, tz = -cp * fwdIn - sp * rightIn;
  const tl = Math.sqrt(tx * tx + tz * tz);
  if (tl > 1) { tx /= tl; tz /= tl; }
  tx *= vmax; tz *= vmax;
  S[S_INTX] = tx; S[S_INTZ] = tz; // intent, for the terrain look-ahead
  const centred = tl < 0.02;

  // clearance assist: slow down when the terrain ahead is far above us (climb assist below)
  const yMin = S[S_GAHEAD] + (transit ? 6 + 0.12 * vh : 2.0);
  const deficit = yMin - p[1];
  if (deficit > 1) {
    const k = Math.min(1, Math.max(0, 1 - (deficit - 1) / 8));
    tx *= k; tz *= k;
  }

  if (centred && !transit) {
    if (!st.holdH && vh < 0.35) { st.holdH = 1; hold[0] = p[0]; hold[2] = p[2]; }
  } else st.holdH = 0;

  if (st.holdH) {
    let hx = (hold[0] - p[0]) * GPS.kpos, hz = (hold[2] - p[2]) * GPS.kpos;
    const hl = Math.sqrt(hx * hx + hz * hz);
    if (hl > 2) { hx *= 2 / hl; hz *= 2 / hl; }
    vref[0] = hx; vref[2] = hz;
  } else {
    // slew the reference; braking may use twice the acceleration (camera drones brake hard)
    let dx = tx - vref[0], dz = tz - vref[2];
    const dl = Math.sqrt(dx * dx + dz * dz);
    const braking = tx * vref[0] + tz * vref[2] < vref[0] * vref[0] + vref[2] * vref[2];
    const lim = (braking ? 2 * acc : acc) * h;
    if (dl > lim) { dx *= lim / dl; dz *= lim / dl; }
    vref[0] += dx; vref[2] += dz;
    // never ask for much more than we are doing (keeps the reference honest when tilt-limited)
    const rx = vref[0] - v[0], rz = vref[2] - v[2], rl = Math.sqrt(rx * rx + rz * rz), cap = transit ? 40 : 6;
    if (rl > cap) { vref[0] = v[0] + rx * cap / rl; vref[2] = v[2] + rz * cap / rl; }
  }

  // vertical
  const up = sport || boost ? GPS.upS : GPS.upN, dn = sport || boost ? GPS.dnS : GPS.dnN;
  const upMax = transit ? 15 : up;
  let vz = climb > 0 ? climb * up : climb * dn;
  if (climb < 0.03 && climb > -0.03) {
    if (!st.holdV && v[1] < 0.3 && v[1] > -0.3) { st.holdV = 1; hold[1] = p[1]; }
  } else st.holdV = 0;
  if (st.holdV) vz = Math.min(2, Math.max(-2, (hold[1] - p[1]) * GPS.kpz));
  if (deficit > 0 && (vh > 0.8 || !centred)) {
    const c = Math.min(upMax, 1.5 * deficit);
    if (vz < c) { vz = c; if (st.holdV && hold[1] < yMin) hold[1] = p[1] < yMin ? p[1] : yMin; }
  }
  // landing: the descent slows near the surface so touchdown is gentle (~0.5 m/s)
  if (vz < 0) { const lim = 0.45 + 0.7 * (S[S_AGL] - 0.1); if (vz < -lim) vz = -lim; }
  vref[1] = vz;

  // velocity loop -> desired acceleration (world)
  const ex = vref[0] - v[0], ey = vref[1] - v[1], ez = vref[2] - v[2];
  if (st.landed) { ivel[0] = ivel[1] = ivel[2] = 0; }
  else if (transit) { ivel[0] = 0; ivel[2] = 0; ivel[1] = Math.min(3, Math.max(-3, ivel[1] + ey * h)); }
  else {
    // horizontal integrator frozen while the tilt limit is active (anti-windup: no overshoot after accelerating)
    if (!st.satv) {
      ivel[0] = Math.min(4, Math.max(-4, ivel[0] + ex * h));
      ivel[2] = Math.min(4, Math.max(-4, ivel[2] + ez * h));
    }
    ivel[1] = Math.min(3, Math.max(-3, ivel[1] + ey * h));
  }
  // drag feed-forward on the reference (still-air model; the integrator learns the wind)
  const kff = 0.5 * RHO * af[A_CDZ] * 1.03 / mass; // effective horizontal Cd*A at cruise tilt
  const vrl = Math.sqrt(vref[0] * vref[0] + vref[2] * vref[2]);
  // in transit the drag is capped (see substep), so is its feed-forward
  let ffk = kff * vrl;
  if (transit && ffk * vrl > G * 0.7002075382097097) ffk = G * 0.7002075382097097 / vrl;
  let ax = GPS.kv * ex + GPS.kiv * ivel[0] + ffk * vref[0];
  let az = GPS.kv * ez + GPS.kiv * ivel[2] + ffk * vref[2];
  const ay = GPS.kz * ey + GPS.kiz * ivel[1];

  // desired force per unit mass, tilt-limited
  let fy = ay + G;
  if (fy < 0.3 * G) fy = 0.3 * G;
  const fl = Math.sqrt(ax * ax + az * az), fmax = fy * Math.tan(tilt);
  st.satv = fl > fmax ? 1 : 0;
  if (fl > fmax) { ax *= fmax / fl; az *= fmax / fl; }

  // transit assist (fictional, documented): extra horizontal push / brake so 120 m/s is reachable and leavable
  if (transit) {
    let bx = (vref[0] - v[0]) * 1.5, bz = (vref[2] - v[2]) * 1.5;
    const bl = Math.sqrt(bx * bx + bz * bz);
    if (bl > 10) { bx *= 10 / bl; bz *= 10 / bl; }
    assist[0] = bx * mass; assist[2] = bz * mass;
  } else { assist[0] = 0; assist[2] = 0; }

  // thrust limit: keep vertical, shrink horizontal
  const tavail = af[A_TMAX] * 0.95 / mass;
  if (fy > tavail) fy = tavail;
  const hl2 = tavail * tavail - fy * fy;
  const hmax = hl2 > 0 ? Math.sqrt(hl2) : 0;
  const fl2 = Math.sqrt(ax * ax + az * az);
  if (fl2 > hmax) { ax *= hmax / fl2; az *= hmax / fl2; }

  const fn = Math.sqrt(ax * ax + fy * fy + az * az);
  f3[0] = ax / fn; f3[1] = fy / fn; f3[2] = az / fn;
  qfromUp(qa, f3);
  qyawA(qb, hold, 3);
  qmul(qd, qa, qb);
  S[S_KTILT] = GPS.att; S[S_KYAW] = GPS.attYaw; S[S_YAWFF] = yawRate; S[S_RMAX] = GPS.rateMax;
  attitudeRates();

  // collective: desired force projected on the current body up
  vup(u3, q);
  let c = (ax * u3[0] + fy * u3[1] + az * u3[2]) * mass / af[A_TMAX];
  if (st.landed && vref[1] <= 0.05) c = 0; // motors idle down on the ground
  S[S_COLL] = c;
}

function angleControl() {
  const af = st.af, a = af[A_CURVE];
  const yawRate = -ch[1] * ANGLE.yaw;
  S[S_YAWFF] = yawRate;
  headingHold();
  // rotation vector in the heading frame: pitch forward = -X, roll right = -Z
  t3[0] = -ch[2] * ANGLE.tilt; t3[1] = 0; t3[2] = -ch[3] * ANGLE.tilt;
  qrotvec(qa, t3);
  qyawA(qb, hold, 3);
  qmul(qd, qb, qa);
  S[S_KTILT] = ANGLE.att; S[S_KYAW] = ANGLE.attYaw; S[S_YAWFF] = yawRate; S[S_RMAX] = ANGLE.rateMax;
  attitudeRates();
  const u = ch[0];
  S[S_COLL] = a * u + (1 - a) * u * u;
}

function acroControl() {
  // ch[1..3] are already rates in rad/s (Betaflight actual rates applied in input.js)
  wc[0] = -ch[2]; wc[1] = -ch[1]; wc[2] = -ch[3];
  const a = st.af[A_CURVE], u = ch[0];
  S[S_COLL] = a * u + (1 - a) * u * u;
}

// rate loop + mixer: wc, S_COLL -> motor commands mc
function mix() {
  const af = st.af, h = H;
  let c = S[S_COLL];
  c = c < 0 ? 0 : c > 1 ? 1 : c;
  S[S_COLL] = c;
  // P on rate error, I with anti-windup, D on the measured angular acceleration
  const kp = af[A_RKP], ki = af[A_RKI] * kp, kd = af[A_RKD];
  const ex = wc[0] - w[0], ey = wc[1] - w[1], ez = wc[2] - w[2];
  if (st.landed) { irate[0] = irate[1] = irate[2] = 0; }
  else if (!st.sat) {
    irate[0] = Math.min(0.3, Math.max(-0.3, irate[0] + ex * h));
    irate[1] = Math.min(0.3, Math.max(-0.3, irate[1] + ey * h));
    irate[2] = Math.min(0.3, Math.max(-0.3, irate[2] + ez * h));
  }
  const axd = kp * ex + ki * irate[0] - kd * alpha[0];
  const ayd = 0.6 * (kp * ey + ki * irate[1]) - kd * alpha[1];
  const azd = kp * ez + ki * irate[2] - kd * alpha[2];
  // to per-motor thrust fractions
  const tm = af[A_TMAX] * 0.25, arm = af[A_ARM];
  let dx = axd * af[A_IXX] / (4 * arm * tm), dy = ayd * af[A_IYY] / (4 * af[A_KQ] * tm), dz = azd * af[A_IZZ] / (4 * arm * tm);
  let sat = 0;
  if (dx > 0.5) { dx = 0.5; sat = 1; } else if (dx < -0.5) { dx = -0.5; sat = 1; }
  if (dz > 0.5) { dz = 0.5; sat = 1; } else if (dz < -0.5) { dz = -0.5; sat = 1; }
  // yaw gets what roll and pitch leave
  const rp = (dx < 0 ? -dx : dx) + (dz < 0 ? -dz : dz);
  const ylim = (rp < 0.5 ? 0.5 - rp : 0) + 0.1;
  if (dy > ylim) dy = ylim; else if (dy < -ylim) dy = -ylim;
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < 4; i++) {
    const t = PX[i] * dx + PZ[i] * dz + PY[i] * dy;
    mc[i] = t; if (t < lo) lo = t; if (t > hi) hi = t;
  }
  let sc = 1;
  if (hi - lo > 1) { sc = 1 / (hi - lo); sat = 1; }
  lo *= sc; hi *= sc;
  // airmode: keep authority at low collective once flying
  const airmode = !st.landed && (st.mode === MODE_ACRO || c > 0.03);
  let shift = 0;
  if (c + hi > 1) shift = 1 - (c + hi);
  else if (airmode && c + lo < 0) shift = -(c + lo);
  const idle = af[A_IDLE], a = af[A_CURVE], b = 1 - a;
  for (let i = 0; i < 4; i++) {
    let f = c + shift + mc[i] * sc;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    let u = (-a + Math.sqrt(a * a + 4 * b * f)) / (2 * b);
    if (u < idle && (c > 0.01 || !st.landed)) u = idle; // armed motors never stop in the air
    mc[i] = u;
  }
  st.sat = sat;
}

// ---------------------------------------------------------------------------------------------------------------
// one 240 Hz substep
export function substep() {
  const af = st.af, mass = af[A_MASS], h = H;
  S[S_TIME] += h;

  // ground under the drone: interpolated between the frame's start and predicted end samples
  const sn = S[S_SUBN] > 1 ? S[S_SUBN] : 1;
  const fr = Math.min(1, (S[S_SUBI] + 1) / sn);
  S[S_SUBI] += 1;
  const graw = S[S_G0] + (S[S_G1] - S[S_G0]) * fr;
  S[S_WATER] = graw < 0 ? 1 : 0;
  const g = graw > 0 ? graw : 0;
  S[S_GHERE] = g;
  S[S_AGL] = p[1] - af[A_HB] - g;

  // ---- control ----
  if (st.crashed) {
    for (let i = 0; i < 4; i++) mc[i] = 0;
    S[S_COLL] = 0;
  } else {
    if (st.mode === MODE_GPS) gpsControl();
    else if (st.mode === MODE_ANGLE) angleControl();
    else acroControl();
    mix();
  }

  // ---- motors: first-order lag ----
  const km = st.crashed ? af[A_KM] * 0.5 : af[A_KM];
  for (let i = 0; i < 4; i++) m[i] += (mc[i] - m[i]) * km;

  // air-relative velocity, prop inflow and ground effect
  air[0] = v[0] - wind[0]; air[1] = v[1] - wind[1]; air[2] = v[2] - wind[2];
  vup(u3, q);
  const vax = air[0] * u3[0] + air[1] * u3[1] + air[2] * u3[2];
  const kin = Math.min(1.15, Math.max(0.55, 1 - vax / af[A_VPITCH]));
  let kge = 1;
  const z = S[S_AGL] + af[A_HB];
  if (z < 0.5 && u3[1] > 0.5) {
    const R = af[A_ROTR], zz = z > R * 0.6 ? z : R * 0.6;
    const r = R / (4 * zz);
    kge = 1 / (1 - r * r);
    if (z > 0.3) kge = 1 + (kge - 1) * (0.5 - z) / 0.2;
  }
  const tm = af[A_TMAX] * 0.25 * kin * kge, a = af[A_CURVE];
  let Tt = 0, tx = 0, ty = 0, tz = 0;
  for (let i = 0; i < 4; i++) {
    const u = m[i];
    const ti = tm * (a * u + (1 - a) * u * u);
    thr[i] = ti; Tt += ti;
    tx += PX[i] * ti; tz += PZ[i] * ti; ty += PY[i] * ti;
  }
  tx *= af[A_ARM]; tz *= af[A_ARM]; ty *= af[A_KQ];

  // ---- rotational dynamics: I w' = tau - w x I w - damping ----
  const ixx = af[A_IXX], iyy = af[A_IYY], izz = af[A_IZZ];
  const wx = w[0], wy = w[1], wz = w[2];
  const gx = wy * izz * wz - wz * iyy * wy, gy = wz * ixx * wx - wx * izz * wz, gz = wx * iyy * wy - wy * ixx * wx;
  alpha[0] = tx / ixx; alpha[1] = ty / iyy; alpha[2] = tz / izz;
  const rd = af[A_ROTDAMP];
  w[0] += (alpha[0] - (gx + rd * wx) / ixx) * h;
  w[1] += (alpha[1] - (gy + rd * wy) / iyy) * h;
  w[2] += (alpha[2] - (gz + rd * wz) / izz) * h;
  // q' = 0.5 q (w, 0)
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3], hw = 0.5 * h, nx = w[0], ny = w[1], nz = w[2];
  q[0] = qx + hw * (qw * nx + qy * nz - qz * ny);
  q[1] = qy + hw * (qw * ny - qx * nz + qz * nx);
  q[2] = qz + hw * (qw * nz + qx * ny - qy * nx);
  q[3] = qw + hw * (-qx * nx - qy * ny - qz * nz);
  qnorm(q);

  // ---- forces: anisotropic quadratic drag in body axes (plus a small linear term), thrust, gravity ----
  vrotInv(d3, q, air);
  const k = 0.5 * RHO, lin = af[A_LIN];
  d3[0] = -(k * af[A_CDX] * (d3[0] < 0 ? -d3[0] : d3[0]) + lin) * d3[0];
  d3[1] = -(k * af[A_CDY] * (d3[1] < 0 ? -d3[1] : d3[1]) + lin) * d3[1];
  d3[2] = -(k * af[A_CDZ] * (d3[2] < 0 ? -d3[2] : d3[2]) + lin) * d3[2];
  vrot(f3, q, d3);
  let fx = f3[0], fy = f3[1], fz = f3[2];
  if (S[S_TRANSIT] > 0 && st.mode === MODE_GPS && !st.crashed) {
    // transit (fictional): drag capped at its sport-top-speed value, plus the assist
    const dl = Math.sqrt(fx * fx + fy * fy + fz * fz), cap = mass * G * 0.7002075382097097; // tan 35 deg
    if (dl > cap) { const s = cap / dl; fx *= s; fy *= s; fz *= s; }
    fx += assist[0]; fz += assist[2];
  }
  vup(u3, q);
  fx += u3[0] * Tt; fy += u3[1] * Tt - mass * G; fz += u3[2] * Tt;
  v[0] += fx / mass * h; v[1] += fy / mass * h; v[2] += fz / mass * h;
  p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;

  collide();
  safeTrack();
}

// ---------------------------------------------------------------------------------------------------------------
function crash() {
  if (st.crashed) return;
  st.crashed = 1; st.landed = 0; st.crashes++;
  S[S_CRASHT] = 1.5;
  const n = st.crashes;
  // tumble from the seeded hash, scaled by the impact
  const e = Math.min(14, Math.max(3, Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) * 0.6));
  w[0] = (hashi(n, 11) * 2 * HASH_SCALE - 1) * e;
  w[1] = (hashi(n, 12) * 2 * HASH_SCALE - 1) * e * 0.6;
  w[2] = (hashi(n, 13) * 2 * HASH_SCALE - 1) * e;
}
export function crashNow() { crash(); }

function collide() {
  const af = st.af, hb = af[A_HB], h = H;
  const g = S[S_GHERE];
  if (p[1] - hb >= g) { st.landed = 0; return; }
  const water = S[S_WATER] > 0;
  vup(u3, q);
  const vy = v[1], vh = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
  if (!st.crashed) {
    S[S_LASTIMPACT] = -vy;
    if (water || -vy > af[A_CRASHV] || vh > af[A_CRASHH] || u3[1] < 0.75) crash();
  }
  p[1] = g + hb;
  if (st.crashed) {
    if (water) { // in the water: motion dies
      v[0] *= 0.9; v[2] *= 0.9; if (v[1] < 0) v[1] = 0;
      w[0] *= 0.9; w[1] *= 0.9; w[2] *= 0.9;
    } else {
      if (v[1] < 0) v[1] = -v[1] * 0.3;
      const f = 1 - Math.min(1, 4 * h);
      v[0] *= f; v[2] *= f;
      w[0] *= 0.97; w[1] *= 0.97; w[2] *= 0.97;
    }
    return;
  }
  // gentle contact: landed, settles level, sliding stops
  if (v[1] < 0) v[1] = 0;
  const f = 1 - Math.min(1, 10 * h);
  v[0] *= f; v[2] *= f;
  w[0] = 0; w[2] = 0; w[1] *= 0.5;
  qheadingA(q, S, S_PSI);
  qyawA(qa, S, S_PSI);
  const d = q[0] * qa[0] + q[1] * qa[1] + q[2] * qa[2] + q[3] * qa[3];
  const s = d < 0 ? -0.2 : 0.2;
  q[0] = q[0] * 0.8 + qa[0] * s; q[1] = q[1] * 0.8 + qa[1] * s; q[2] = q[2] * 0.8 + qa[2] * s; q[3] = q[3] * 0.8 + qa[3] * s;
  qnorm(q);
  st.landed = 1;
}

function safeTrack() {
  if (st.crashed) {
    S[S_CRASHT] -= H;
    if (S[S_CRASHT] <= 0) respawn();
    return;
  }
  const sp2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  vup(u3, q);
  if (!st.landed && S[S_AGL] > 2 && sp2 < 36 && u3[1] > 0.85) {
    S[S_SAFET] += H;
    if (S[S_SAFET] > 0.5) {
      S[S_SAFET] = 0;
      safeP[0] = p[0]; safeP[1] = p[1]; safeP[2] = p[2];
      qheadingA(q, safeP, 3);
    }
  } else S[S_SAFET] = 0;
}

// back to the last safe hover point (at least 3 m above the surface there)
export function respawn() {
  st.respawns++;
  T.TQ[0] = safeP[0]; T.TQ[1] = safeP[2];
  T.query(1);
  const g = T.TG[0] > 0 ? T.TG[0] : 0;
  PH[0] = safeP[0]; PH[1] = safeP[1] > g + 3 ? safeP[1] : g + 3; PH[2] = safeP[2]; PH[3] = safeP[3];
  placeHover();
  S[S_G0] = T.TG[0]; S[S_G1] = T.TG[0]; S[S_GHERE] = g;
}
