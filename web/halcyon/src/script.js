// script.js: deterministic scripted flights for the harness (?script=<name>), played through the sim's own input
// path (sim.setXRSticks, sim.flightMode / cameraMode / sport / boost, sim.jumpToRealm). The timeline is built once
// into a Float64Array; update() allocates nothing. Run with a fixed dt per frame and the flight is identical every
// time on every machine (the sim is deterministic for a given dt sequence).
//
// A segment holds sticks for `d` seconds: s = [lx, ly, rx, ry] (physical sticks, mode 2: left = throttle/climb +
// yaw, right = roll + pitch, up/right positive). In Angle/Acro, ly is relative to the hover stick (0 = hover).
// Thumbs move at a finite speed (STICK_RATE, or r per segment), so changes are smooth like a real pilot's.
// auto: 1 = GPS autopilot through the light rings, 2 = GPS transit toward the compass target (the nearest
// unvisited realm). Optional per segment: fm (flight mode), cam (camera mode), sport, boost, jump (realm id).
import { CLK, C_DT } from './clock.js';

const STRIDE = 13;
const K_T = 0, K_LX = 1, K_LY = 2, K_RX = 3, K_RY = 4, K_AUTO = 5, K_FM = 6, K_CAM = 7, K_SPORT = 8, K_BOOST = 9, K_JUMP = 10, K_END = 11, K_RATE = 12;
const STICK_RATE = 3.0; // stick units per second

const GPS = 0, ANGLE = 1, ACRO = 2;
const FPV = 0, CHASE = 1, LOS = 2;

// name -> segments. Durations in seconds.
export const SCRIPTS = {
  // GPS (camera drone), chase camera: take off, fly forward, bank into a turn, climb, yaw, brake to a hover
  gps: [
    { d: 1.5, s: [0, 0, 0, 0], fm: GPS, cam: CHASE, sport: 0 },
    { d: 3, s: [0, 0.8, 0, 0] },
    { d: 6, s: [0, 0, 0, 0.8] },
    { d: 5, s: [0.45, 0, 0.6, 0.7] },
    { d: 4, s: [-0.7, 0.7, 0, 0.3] },
    { d: 3, s: [0, 0, 0, 0] },
  ],
  // Angle (self-levelling, manual throttle), chase camera
  angle: [
    { d: 1.5, s: [0, 0, 0, 0], fm: ANGLE, cam: CHASE },
    { d: 2, s: [0, 0.2, 0, 0] },
    { d: 5, s: [0, 0.03, 0, 0.45] },
    { d: 4, s: [0.35, 0.06, 0.45, 0.3] },
    { d: 3, s: [0, 0.08, -0.2, 0.2] },
    { d: 3, s: [-0.8, 0, 0, 0] },
    { d: 3, s: [0, 0, 0, -0.2] },
  ],
  // Acro (5-inch, rate mode, no self-levelling), chase camera: punch out, tilt forward, carve, a roll, level out
  acro: [
    { d: 1.0, s: [0, 0, 0, 0], fm: ACRO, cam: CHASE },
    { d: 0.8, s: [0, 0.35, 0, 0] },
    { d: 0.45, s: [0, 0.12, 0, 0.35] },
    { d: 3.0, s: [0, 0.12, 0, 0] },
    { d: 0.5, s: [0, 0.12, 0.3, 0] },
    { d: 2.0, s: [0.15, 0.2, 0, -0.18] },
    { d: 0.5, s: [0, 0.12, -0.3, 0] },
    { d: 1.2, s: [0, 0.15, 0, 0] },
    { d: 0.56, s: [0, -0.2, 1.0, 0], r: 14 },
    { d: 0.6, s: [0, 0.3, 0, 0], r: 14 },
    { d: 0.45, s: [0, 0.1, 0, -0.35] },
    { d: 2.0, s: [0, 0.02, 0, 0] },
  ],
  // GPS, FPV camera (level gimbal): climb, glide forward, slow pan
  fpv: [
    { d: 1.0, s: [0, 0, 0, 0], fm: GPS, cam: FPV, sport: 0 },
    { d: 3, s: [0, 0.7, 0, 0] },
    { d: 7, s: [0, 0, 0, 0.9] },
    { d: 5, s: [-0.4, 0, 0, 0.6] },
    { d: 4, s: [0.6, 0, 0, 0] },
  ],
  // GPS sport, chase camera, the autopilot flies the light rings (shows next / passed rings)
  chase: [
    { d: 1.0, s: [0, 0, 0, 0], fm: GPS, cam: CHASE, sport: 1 },
    { d: 24, s: [0, 0, 0, 0], auto: 1 },
    { d: 3, s: [0, 0, 0, 0], auto: 0 },
  ],
  // GPS, line-of-sight camera: fly out, turn, come back past the pilot
  los: [
    { d: 1.0, s: [0, 0, 0, 0], fm: GPS, cam: LOS, sport: 0 },
    { d: 2, s: [0, 0.6, 0, 0] },
    { d: 6, s: [0, 0, 0, 1] },
    { d: 3, s: [1, 0, 0, 0.3] },
    { d: 6, s: [0, 0, 0, 1] },
    { d: 3, s: [0, -0.4, 0, 0] },
  ],
  // the benchmark route (?bench=1): three realms, low flying, a boost transit and teleports
  bench: [
    { d: 1.0, s: [0, 0, 0, 0], fm: GPS, cam: CHASE, sport: 1 },
    { d: 2, s: [0, 0.8, 0, 0] },
    { d: 18, s: [0, 0, 0, 0], auto: 1 },
    { d: 16, s: [0, 0, 0, 0], auto: 2, boost: 1 },
    { d: 1, s: [0, 0, 0, 0], auto: 0, boost: 0, jump: 3 },
    { d: 14, s: [0, 0, 0, 0], auto: 1 },
    { d: 1, s: [0, 0, 0, 0], auto: 0, jump: 5 },
    { d: 14, s: [0, 0, 0, 0], auto: 1 },
    { d: 5, s: [0, 0, 0, 0.8], auto: 0, cam: FPV },
  ],
};
// a tour of every camera and mode, used by tools/play.mjs for the overview sheet
SCRIPTS.tour = [].concat(
  SCRIPTS.gps.slice(0, 4),
  [{ d: 4, s: [0, 0, 0, 0], cam: FPV }, { d: 4, s: [0, 0, 0, 0.8], cam: LOS }],
  SCRIPTS.angle.slice(0, 4).map((x, i) => (i === 0 ? Object.assign({}, x, { cam: CHASE }) : x)),
  SCRIPTS.acro.slice(0, 6),
);

export function createPlayer(sim, name) {
  const segs = SCRIPTS[name];
  if (!segs) return null;
  const n = segs.length;
  const K = new Float64Array((n + 1) * STRIDE);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const g = segs[i], o = i * STRIDE;
    K[o + K_T] = t;
    for (let j = 0; j < 4; j++) K[o + K_LX + j] = g.s ? g.s[j] : 0;
    K[o + K_AUTO] = g.auto === undefined ? (i > 0 ? K[o - STRIDE + K_AUTO] : 0) : g.auto;
    K[o + K_FM] = g.fm === undefined ? -1 : g.fm;
    K[o + K_CAM] = g.cam === undefined ? -1 : g.cam;
    K[o + K_SPORT] = g.sport === undefined ? -1 : g.sport;
    K[o + K_BOOST] = g.boost === undefined ? -1 : g.boost;
    K[o + K_JUMP] = g.jump === undefined ? -1 : g.jump;
    K[o + K_RATE] = g.r || STICK_RATE;
    t += g.d;
    K[o + K_END] = t;
  }
  K[n * STRIDE + K_T] = t;
  const R = sim._dbg.R, XR = sim._dbg.IN.xr, XRF = sim._dbg.IN.xrFlag;
  const S = new Float64Array(8); // time, current key, stick state x4, dt of this update
  const tgt = new Float64Array(4);
  const P = {
    name, duration: t, keys: n, done: 0, S,
    time() { return S[0]; },
    // call before sim.step(dt) with the same dt (no argument: dt from the frame clock)
    update(dt) {
      // dt via a typed array: reassigning the parameter (undefined | double) would box it in V8's Maglev tier
      if (dt === undefined) S[6] = CLK[C_DT]; else S[6] = dt;
      let k = S[1] | 0;
      const now = S[0];
      // fire the events of every key we enter (k = -1 before the first frame)
      while (k + 1 < n && K[(k + 1) * STRIDE + K_T] <= now) {
        k++;
        const o = k * STRIDE;
        if (K[o + K_JUMP] >= 0) sim.jumpToRealm(K[o + K_JUMP] | 0);
        if (K[o + K_FM] >= 0) sim.flightMode = K[o + K_FM] | 0;
        if (K[o + K_CAM] >= 0) sim.cameraMode = K[o + K_CAM] | 0;
        if (K[o + K_SPORT] >= 0) sim.sport = K[o + K_SPORT] | 0;
        if (K[o + K_BOOST] >= 0) sim.boost = K[o + K_BOOST] | 0;
      }
      S[1] = k;
      if (now >= t) P.done = 1;
      const o = (k < 0 ? 0 : k) * STRIDE;
      const auto = P.done ? 0 : K[o + K_AUTO];
      tgt[0] = K[o + K_LX]; tgt[1] = K[o + K_LY]; tgt[2] = K[o + K_RX]; tgt[3] = K[o + K_RY];
      if (P.done) { tgt[0] = 0; tgt[1] = 0; tgt[2] = 0; tgt[3] = 0; }
      if (auto === 1) autoRings(sim, R, tgt);
      else if (auto === 2) autoTransit(sim, tgt);
      // thumbs move at a finite rate (the autopilot is a pilot too)
      const st = S[6] * K[o + K_RATE] * (auto > 0 ? 2 : 1);
      for (let j = 0; j < 4; j++) {
        const d = tgt[j] - S[2 + j];
        S[2 + j] += d > st ? st : d < -st ? -st : d;
      }
      // manual-throttle modes: ly is relative to the hover stick
      let ly = S[3];
      if (sim.flightMode !== 0) { ly += sim.info[14] * 2 - 1; ly = ly < -1 ? -1 : ly > 1 ? 1 : ly; }
      // = sim.setXRSticks(S[2], ly, S[4], S[5]), written straight into its input slots: four doubles passed to a
      // non-inlined call would be boxed every frame
      XR[0] = S[2]; XR[1] = ly; XR[2] = S[4]; XR[3] = S[5]; XRF[0] = 1;
      S[0] = now + S[6];
    },
    // rewind: also put the drone back at the start realm (looping a script, e.g. the alloc gate's steady state)
    reset(rewind) {
      S.fill(0); S[1] = -1; P.done = 0;
      if (rewind) sim.jumpToRealm(K[K_JUMP] >= 0 ? K[K_JUMP] | 0 : 0);
    },
  };
  P.reset();
  return P;
}

// harness only (allocates): a plain summary of the sim for state lines
export function simState(sim, p) {
  const d = sim.drone, i = sim.info;
  const up = 1 - 2 * (d[3] * d[3] + d[5] * d[5]); // body up . world up
  return {
    t: p ? p.time() : 0, fm: sim.flightMode, cam: sim.cameraMode, pos: [d[0], d[1], d[2]], agl: i[0], spd: i[2], vz: i[3],
    tilt: Math.acos(Math.max(-1, Math.min(1, up))) * 180 / Math.PI, thr: d[14], rings: i[12], crashes: i[13], realm: i[11],
  };
}

// GPS autopilot through the rings (the simtest one): aim at the next ring, then 6 m past it along its normal
function autoRings(sim, R, out) {
  const d = sim.drone;
  const i = R.info[1];
  if (i >= R.info[0]) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return; }
  const o = i * 8;
  const cx = R.course[o], cy = R.course[o + 1], cz = R.course[o + 2];
  const nx = R.course[o + 3], ny = R.course[o + 4], nz = R.course[o + 5];
  const ex = cx - d[0], ez = cz - d[2];
  // signed distance along the ring normal: rings count only when crossed along +n, so come round to the -n side
  const sd = (d[0] - cx) * nx + (d[1] - cy) * ny + (d[2] - cz) * nz;
  const near = Math.sqrt(ex * ex + ez * ez) < 15 && Math.abs(cy - d[1]) < 2.5;
  const k = sd > -0.5 ? -10 : near ? 6 : -4;
  const ax = cx + nx * k, az = cz + nz * k;
  const dx = ax - d[0], dz = az - d[2];
  const bear = Math.atan2(-dx, -dz);
  let e = bear - sim.info[6];
  e -= 6.283185307179586 * Math.round(e / 6.283185307179586);
  const dist = Math.sqrt(dx * dx + dz * dz);
  const ce = Math.cos(e) > 0 ? Math.cos(e) : 0;
  const dy = cy - d[1], ady = dy < 0 ? -dy : dy;
  // glide toward the ring height over the remaining distance (GPS climbs 5 m/s, sinks 3.5 m/s at full stick)
  let climb = dy * 12 / (dist > 6 ? dist : 6) / (dy > 0 ? 5 : 3.5);
  if (sim.info[0] < 5 && climb < 0.3) climb = 0.3;
  const yaw = -e * 2.5, right = Math.sin(-e) * dist * 0.1;
  const f0 = dist / 25 > 0.5 ? dist / 25 : 0.5, f1 = ady > 6 && dist < 20 ? 0.3 : 1;
  out[0] = yaw < -1 ? -1 : yaw > 1 ? 1 : yaw;
  out[1] = climb < -1 ? -1 : climb > 1 ? 1 : climb;
  out[2] = right < -1 ? -1 : right > 1 ? 1 : right;
  out[3] = (f0 > 1 ? 1 : f0) * ce * f1;
}

// GPS transit: head for the compass target, full forward, hold 60-90 m above the ground
function autoTransit(sim, out) {
  const rel = sim.info[18], agl = sim.info[0];
  const yaw = -rel * 2;
  out[0] = yaw < -1 ? -1 : yaw > 1 ? 1 : yaw;
  out[1] = agl < 60 ? 0.8 : agl > 90 ? -0.3 : 0;
  out[2] = 0;
  const c = Math.cos(rel);
  out[3] = c > 0 ? c : 0;
}
