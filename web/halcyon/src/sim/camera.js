// Cameras: FPV (gimbal in GPS, fixed uptilt in Angle/Acro), chase, line-of-sight. Writes sim.cam.
// No allocations per frame: scalar inputs come in the ARG slots, terrain through terrain.js.

import { qmul, qyawA, qlook, vrot, qheadingA } from './qmath.js';
import * as T from './terrain.js';

export const CAM_FPV = 0, CAM_CHASE = 1, CAM_LOS = 2, N_CAM = 3;
const DEG = Math.PI / 180;
const TWO_PI = 6.283185307179586;

export const FOV_GPS = 50 * DEG;    // DJI Mini class: 82 deg diagonal at 16:9 ~ 50 deg vertical
export const FOV_ANGLE = 70 * DEG;
export const FOV_ACRO = 80 * DEG;   // wide FPV look (~112 deg horizontal at 16:9)
export const FOV_CHASE = 65 * DEG;
export const UPTILT_ACRO = 25 * DEG, UPTILT_ANGLE = 10 * DEG;
export const EYE = 1.7;             // pilot eye height in line of sight
export const LOS_REANCHOR = 300;    // m: beyond this the pilot walks up to 40 m behind the drone

export const ARG = new Float64Array(4); // [dt, gimbal pitch (rad)] for update(); [x, z, yaw] for anchorPilot()
export const pilot = new Float64Array(3); // line-of-sight eye position (world)
const chaseOff = new Float64Array(3);
const S = new Float64Array(16);
const S_CHASEYAW = 0, S_INIT = 1, S_LOSFOV = 2, S_PSI = 3, S_ANG = 4;
const qa = new Float64Array(4), qb = new Float64Array(4), qc = new Float64Array(4), t3 = new Float64Array(3);

export function init() { S.fill(0); pilot.fill(0); chaseOff.fill(0); }

// put the line-of-sight pilot on the ground behind and beside the drone (the take-off spot); ARG = [x, z, yaw]
export function anchorPilot() {
  const yaw = ARG[2];
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  pilot[0] = ARG[0] - fx * 9 + rx * 3; pilot[2] = ARG[1] - fz * 9 + rz * 3;
  T.TQ[0] = pilot[0]; T.TQ[1] = pilot[2]; T.query(1);
  pilot[1] = (T.TG[0] > 0 ? T.TG[0] : 0) + EYE;
}

export function snap() { S[S_INIT] = 0; }

// (each branch writes out[7] itself: a variable fed by a constant in one branch and a typed-array read in
// another can make the optimiser box the double)
// rp, rq: interpolated drone pose; vel: velocity; out: sim.cam (Float32Array 8). ARG[0] = dt, ARG[1] = gimbal
export function update(out, camMode, flightMode, rp, rq, vel, crashed) {
  const dt = ARG[0];
  const k6 = 1 - Math.exp(-6 * dt), k4 = 1 - Math.exp(-4 * dt), k3 = 1 - Math.exp(-3 * dt);
  qheadingA(rq, S, S_PSI);
  const psi = S[S_PSI];
  if (S[S_INIT] === 0) {
    S[S_CHASEYAW] = psi; S[S_LOSFOV] = 50 * DEG;
    chaseOff[0] = Math.sin(psi) * 3.2; chaseOff[1] = 1.0; chaseOff[2] = Math.cos(psi) * 3.2;
    S[S_INIT] = 1;
  }
  let e = psi - S[S_CHASEYAW]; e -= TWO_PI * Math.round(e / TWO_PI);
  let cy = S[S_CHASEYAW] + e * k4; cy -= TWO_PI * Math.round(cy / TWO_PI);
  S[S_CHASEYAW] = cy;

  let px = 0, py = 0, pz = 0;
  if (camMode === CAM_FPV) {
    if (flightMode === 0 && !crashed) {
      // 3-axis gimbal: level, follows heading, pitch from the gimbal control
      // = qaxisA(qb, 1, 0, 0, ARG, 1), written out: reached only in FPV, qaxisA was compiled by V8's mid tier with
      // generic Math.sin/cos calls that boxed both results every frame (here the Math calls are inlined)
      const h = 0.5 * ARG[1], s = Math.sin(h);
      qyawA(qa, S, S_PSI); qb[0] = s; qb[1] = 0 * s; qb[2] = 0 * s; qb[3] = Math.cos(h); qmul(qc, qa, qb);
      out[7] = FOV_GPS;
    } else {
      S[S_ANG] = flightMode === 2 ? UPTILT_ACRO : UPTILT_ANGLE;
      const h = 0.5 * S[S_ANG], s = Math.sin(h); // = qaxisA(qb, 1, 0, 0, S, S_ANG)
      qb[0] = s; qb[1] = 0 * s; qb[2] = 0 * s; qb[3] = Math.cos(h);
      qmul(qc, rq, qb);
      out[7] = flightMode === 2 ? FOV_ACRO : FOV_ANGLE;
    }
    t3[0] = 0; t3[1] = -0.03; t3[2] = -0.07;
    vrot(t3, rq, t3);
    px = rp[0] + t3[0]; py = rp[1] + t3[1]; pz = rp[2] + t3[2];
  } else if (camMode === CAM_CHASE) {
    const dist = flightMode === 2 ? 2.8 : 3.2;
    // the offset lives in the drone's frame of reference, so it never lags behind at speed
    chaseOff[0] += (Math.sin(cy) * dist - chaseOff[0]) * k6;
    chaseOff[1] += ((flightMode === 2 ? 0.8 : 1.0) - chaseOff[1]) * k6;
    chaseOff[2] += (Math.cos(cy) * dist - chaseOff[2]) * k6;
    px = rp[0] + chaseOff[0]; py = rp[1] + chaseOff[1]; pz = rp[2] + chaseOff[2];
    T.TQ[0] = px; T.TQ[1] = pz; T.query(1);
    const g = (T.TG[0] > 0 ? T.TG[0] : 0) + 0.6;
    if (py < g) py = g;
    // look a little ahead of the drone along its velocity
    t3[0] = rp[0] + vel[0] * 0.08 - px; t3[1] = rp[1] + 0.25 + vel[1] * 0.04 - py; t3[2] = rp[2] + vel[2] * 0.08 - pz;
    qlook(qc, t3);
    out[7] = FOV_CHASE;
  } else {
    // line of sight: re-anchor when the drone is too far to read
    const dx = rp[0] - pilot[0], dz = rp[2] - pilot[2];
    const dh = Math.sqrt(dx * dx + dz * dz);
    if (dh > LOS_REANCHOR) {
      pilot[0] = rp[0] - dx / dh * 40; pilot[2] = rp[2] - dz / dh * 40;
      T.TQ[0] = pilot[0]; T.TQ[1] = pilot[2]; T.query(1);
      pilot[1] = (T.TG[0] > 0 ? T.TG[0] : 0) + EYE;
    }
    px = pilot[0]; py = pilot[1]; pz = pilot[2];
    t3[0] = rp[0] - px; t3[1] = rp[1] - py; t3[2] = rp[2] - pz;
    const d = Math.sqrt(t3[0] * t3[0] + t3[1] * t3[1] + t3[2] * t3[2]);
    qlook(qc, t3);
    // keep the 0.3 m drone readable: ~24 m of scene height at the drone's distance, clamped 8-55 deg
    const want = Math.min(55 * DEG, Math.max(8 * DEG, 2 * Math.atan(12 / (d > 0.1 ? d : 0.1))));
    S[S_LOSFOV] += (want - S[S_LOSFOV]) * k3;
    out[7] = S[S_LOSFOV];
  }
  out[0] = px; out[1] = py; out[2] = pz;
  out[3] = qc[0]; out[4] = qc[1]; out[5] = qc[2]; out[6] = qc[3];
}
