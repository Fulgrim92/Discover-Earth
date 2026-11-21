// HALCYON sim: public entry. See API.md for the contract and conventions.
// One sim per page (module-level state; createSim() resets it). sim.step() allocates nothing (see qmath.js for
// the rules that makes that true under V8).

import * as D from './drone.js';
import * as IN from './input.js';
import * as CAM from './camera.js';
import * as R from './rings.js';
import * as AU from './audio.js';
import * as HUD from './hud.js';
import * as PANEL from './panel.js';
import * as T from './terrain.js';
import { qnlerpA, qheadingA } from './qmath.js';

export { MODE_GPS, MODE_ANGLE, MODE_ACRO } from './drone.js';
export { CAM_FPV, CAM_CHASE, CAM_LOS } from './camera.js';
export {
  ACT_MODE, ACT_CAMERA, ACT_RESET, ACT_BOOST, ACT_SPORT, ACT_HUD, ACT_SETTINGS, ACT_GIMBAL_UP, ACT_GIMBAL_DOWN,
  ACT_MUTE, ACT_NEXT_REALM,
} from './input.js';

const DEG = Math.PI / 180;
const TWO_PI = 6.283185307179586;
const SPAWN_BACK = 40, SPAWN_SIDE = 7; // m before / beside the first ring of a realm (spawnAtRing)

// realm wind: [base m/s, direction (yaw convention: 0 blows toward -Z), gustiness 0..1]
const REALM_WIND = new Float64Array([
  5.0, 0.8, 0.45,   // 0 Home Fjords: fresh sea breeze, gusty off the cliffs
  3.5, 2.2, 0.35,   // 1 Painted Range
  1.5, 1.0, 0.20,   // 2 Mirror Salt: near calm (it is a mirror)
  2.0, 4.0, 0.30,   // 3 Stone Forest
  6.5, 5.5, 0.50,   // 4 Aurora Ice: katabatic
  2.5, 3.0, 0.25,   // 5 Lumen Deep
  4.0, 1.5, 0.35,   // default (beyond the curated cells)
]);

// sim.info slots
export const INFO_AGL = 0, INFO_AIRSPEED = 1, INFO_GROUNDSPEED = 2, INFO_VZ = 3, INFO_TRANSIT = 4, INFO_LANDED = 5,
  INFO_HEADING = 6, INFO_GIMBAL = 7, INFO_WINDX = 8, INFO_WINDY = 9, INFO_WINDZ = 10, INFO_REALM = 11,
  INFO_RINGS = 12, INFO_CRASHES = 13, INFO_HOVER = 14, INFO_STICKMODE = 15, INFO_TELEPORTS = 16, INFO_TARGET = 17,
  INFO_COMPASS = 18, INFO_COMPASS_KM = 19, INFO_N = 20;

export function createSim(world, opts) {
  opts = opts || {};
  T.init(world);
  D.init();
  CAM.init();
  IN.init();
  R.build(world);

  const CUR = world.CURATED || new Float32Array(0);
  const NCELL = (CUR.length / 3) | 0;
  const visited = new Uint8Array(NCELL);
  const M = new Int32Array(16);  // integer frame state
  const M_MODE = 0, M_CELL = 1, M_TELEPORTS = 2, M_TARGET = 3, M_WINDFIX = 4;
  const F = new Float64Array(32); // float frame state
  const F_ACC = 0, F_GIMBAL = 1, F_REACQ = 2, F_P0X = 3, F_P0Y = 4, F_P0Z = 5, F_CELLD = 6, F_ALPHA = 7, F_TD = 8,
    F_TX = 9, F_TZ = 10, F_DT = 11, F_TMP = 12;
  const prevP = new Float64Array(3), prevQ = new Float64Array(4);
  const rp = new Float64Array(3), rq = new Float64Array(4);
  const camQ = new Float64Array(4);
  const windFix = new Float64Array(3);

  if (opts.wind && opts.wind.length >= 2) {
    windFix[0] = +opts.wind[0]; windFix[1] = +opts.wind[1]; windFix[2] = opts.wind.length > 2 ? +opts.wind[2] : 0.35;
    M[M_WINDFIX] = 1;
  }
  if (typeof opts.seed === 'number') D.wbase[3] = opts.seed | 0;
  F[F_GIMBAL] = -5 * DEG;

  const sim = {
    cam: new Float32Array(8),
    drone: new Float32Array(16),
    rings: R.ringWin,
    ringCount: 0,
    ringNextSlot: -1,
    ringMax: R.WIN,
    info: new Float32Array(INFO_N),
    pilot: new Float32Array(3),
    headPose: new Float32Array(7),
    hasHeadPose: 0,
    flightMode: D.MODE_GPS,
    cameraMode: typeof opts.cameraMode === 'number' ? opts.cameraMode : 1,
    sport: 0,
    boost: 0,
    dtIn: new Float64Array(1), // step() with no argument reads dt from here (no boxed double per frame)
    step, teleport, setXRSticks, setHeadPose, startAudio, pauseAudio: AU.pause, attach, press, jumpToRealm,
    setStickMode: IN.setStickMode,
    _dbg: { D, IN, R, CAM, M, F },
  };
  M[M_MODE] = -1;

  function applyMode(mode) {
    if (mode !== 0 && mode !== 1 && mode !== 2) mode = 0;
    sim.flightMode = mode;
    M[M_MODE] = mode;
    D.setMode(mode);
    if (D.st.landed) IN.setKbThrottleLow(); else IN.setKbThrottleFrom(D.st.af, D.A_HOVER);
  }

  // nearest curated cell to (F_TX, F_TZ); distance into F_CELLD
  function nearestCell() {
    const x = F[F_TX], z = F[F_TZ];
    let bi = -1, bd = 1e30;
    for (let i = 0; i < NCELL; i++) {
      const dx = CUR[i * 3] - x, dz = CUR[i * 3 + 1] - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    F[F_CELLD] = Math.sqrt(bd);
    return bi;
  }

  function teleport(x, z) {
    F[F_TX] = +x; F[F_TZ] = +z;
    teleportF();
  }
  // arrive at ring i of the course: SPAWN_BACK m before it along its normal and SPAWN_SIDE m to the side (a ring
  // centred on, or sitting on, the camera blows out the middle of the first frame), facing it, with it as next
  let pinNext = -1;
  function spawnAtRing(i) {
    const cnt = R.info[R.I_COUNT];
    if (cnt === 0) { teleportF(); return; }
    const o = (i < 0 ? 0 : i >= cnt ? cnt - 1 : i) * R.STRIDE;
    let nx = R.course[o + 3], nz = R.course[o + 5];
    const l = Math.sqrt(nx * nx + nz * nz);
    if (l > 1e-3) { nx /= l; nz /= l; } else { nx = 0; nz = -1; }
    F[F_TX] = R.course[o] - nx * SPAWN_BACK - nz * SPAWN_SIDE;
    F[F_TZ] = R.course[o + 2] - nz * SPAWN_BACK + nx * SPAWN_SIDE;
    pinNext = o / R.STRIDE;
    teleportF();
    pinNext = -1;
  }
  // teleport to (F_TX, F_TZ): highest surface within 20 m, then 12 m of clearance, facing the next ring
  function teleportF() {
    const x = F[F_TX], z = F[F_TZ];
    T.TQ[0] = x; T.TQ[1] = z;
    for (let k = 0; k < 8; k++) { const a = k * 0.785398; T.TQ[2 + 2 * k] = x + Math.cos(a) * 20; T.TQ[3 + 2 * k] = z + Math.sin(a) * 20; }
    T.query(9);
    let g = 0;
    for (let k = 0; k < 9; k++) if (T.TG[k] > g) g = T.TG[k];
    const g0 = T.TG[0];
    if (pinNext >= 0) R.setNext(pinNext);
    else { R.ARG[0] = x; R.ARG[1] = z; R.reacquire(); }
    qheadingA(D.q, D.PH, 3);
    const nx = R.info[R.I_NEXT];
    if (nx < R.info[R.I_COUNT]) {
      const o = nx * R.STRIDE, dx = R.course[o] - x, dz = R.course[o + 2] - z;
      if (dx * dx + dz * dz > 1) D.PH[3] = Math.atan2(-dx, -dz);
    }
    D.PH[0] = x; D.PH[1] = g + 12; D.PH[2] = z;
    D.placeHover();
    D.S[D.S_G0] = g0; D.S[D.S_G1] = g0; D.S[D.S_GHERE] = g0 > 0 ? g0 : 0;
    D.S[D.S_AGL] = D.p[1] - D.S[D.S_GHERE];
    prevP[0] = D.p[0]; prevP[1] = D.p[1]; prevP[2] = D.p[2];
    prevQ[0] = D.q[0]; prevQ[1] = D.q[1]; prevQ[2] = D.q[2]; prevQ[3] = D.q[3];
    F[F_P0X] = D.p[0]; F[F_P0Y] = D.p[1]; F[F_P0Z] = D.p[2];
    CAM.ARG[0] = x; CAM.ARG[1] = z; CAM.ARG[2] = D.PH[3]; CAM.anchorPilot();
    CAM.snap();
    if (M[M_MODE] >= 0) IN.setKbThrottleFrom(D.st.af, D.A_HOVER);
    M[M_TELEPORTS]++;
    F[F_REACQ] = 0;
  }

  function jumpToRealm(realmId) {
    for (let i = 0; i < NCELL; i++) {
      if ((CUR[i * 3 + 2] | 0) === realmId) {
        F[F_TX] = CUR[i * 3]; F[F_TZ] = CUR[i * 3 + 1];
        spawnAtRing(R.startOfCell(i));
        return true;
      }
    }
    return false;
  }

  function nextRealm() {
    F[F_TX] = D.p[0]; F[F_TZ] = D.p[2];
    const c = nearestCell();
    const t = R.tour;
    if (t.length === 0) return;
    let k = 0;
    for (let i = 0; i < t.length; i++) if (t[i] === c) k = i;
    const n = t[(k + 1) % t.length];
    F[F_TX] = CUR[n * 3]; F[F_TZ] = CUR[n * 3 + 1];
    spawnAtRing(R.startOfCell(n));
  }

  // physical sticks, up/right positive; overrides gamepad and keyboard for the next step only
  function setXRSticks(lx, ly, rx, ry) {
    IN.xr[0] = lx; IN.xr[1] = ly; IN.xr[2] = rx; IN.xr[3] = ry; IN.xrFlag[0] = 1;
  }
  function setHeadPose(a) {
    if (!a) { sim.hasHeadPose = 0; return; }
    for (let i = 0; i < 7; i++) sim.headPose[i] = a[i];
    sim.hasHeadPose = 1;
  }
  function startAudio() { AU.start(); }
  function press(action) { if (action >= 0 && action < IN.N_ACT) IN.kbPress[action]++; }

  function attach(canvas) {
    if (typeof window === 'undefined') return;
    IN.attachKeyboard(window);
    let show = opts.hud !== false;
    try { if (new URLSearchParams(location.search).get('hud') === '0') show = false; } catch (e) { /* no location */ }
    HUD.attach(canvas, show, opts.help);
    PANEL.attach();
    const first = () => { AU.start(); window.removeEventListener('pointerdown', first); window.removeEventListener('keydown', first); };
    window.addEventListener('pointerdown', first);
    window.addEventListener('keydown', first);
  }

  function handleActions() {
    const pr = IN.pressed, dt = F[F_DT];
    if (pr[IN.ACT_MODE]) applyMode((M[M_MODE] + 1) % 3);
    if (pr[IN.ACT_CAMERA]) sim.cameraMode = (sim.cameraMode + 1) % CAM.N_CAM;
    if (pr[IN.ACT_RESET]) { D.respawn(); CAM.snap(); IN.setKbThrottleFrom(D.st.af, D.A_HOVER); }
    if (pr[IN.ACT_SPORT]) sim.sport = sim.sport ? 0 : 1;
    if (pr[IN.ACT_HUD]) HUD.toggle();
    if (pr[IN.ACT_SETTINGS]) PANEL.toggle();
    if (pr[IN.ACT_MUTE]) AU.setMuted(!AU.muted());
    if (pr[IN.ACT_NEXT_REALM]) nextRealm();
    if (IN.realmKey[0] >= 0) { const r = IN.realmKey[0]; IN.realmKey[0] = -1; jumpToRealm(r); }
    const g = (IN.held[IN.ACT_GIMBAL_UP] ? 1 : 0) - (IN.held[IN.ACT_GIMBAL_DOWN] ? 1 : 0);
    F[F_GIMBAL] = Math.min(20 * DEG, Math.max(-90 * DEG, F[F_GIMBAL] + g * 60 * DEG * dt));
  }

  // smooth wind blend over cells (~1.4 km band), toward the default far from the curated cells
  function updateWind() {
    if (M[M_WINDFIX]) { D.wbase[0] = windFix[0]; D.wbase[1] = windFix[1]; D.wbase[2] = windFix[2]; return; }
    const x = D.p[0], z = D.p[2], dmin = F[F_CELLD];
    let sx = 0, sz = 0, gs = 0, ws = 0;
    for (let i = 0; i <= NCELL; i++) {
      let wgt, r;
      if (i < NCELL) {
        const dx = CUR[i * 3] - x, dz = CUR[i * 3 + 1] - z;
        wgt = Math.exp(-(Math.sqrt(dx * dx + dz * dz) - dmin) / 700);
        r = CUR[i * 3 + 2] | 0; if (r < 0 || r > 5) r = 6;
      } else { wgt = dmin > 3500 ? (dmin - 3500) / 1500 : 0; r = 6; }
      const sp = REALM_WIND[r * 3], dir = REALM_WIND[r * 3 + 1];
      sx += -Math.sin(dir) * sp * wgt; sz += -Math.cos(dir) * sp * wgt; gs += REALM_WIND[r * 3 + 2] * wgt; ws += wgt;
    }
    if (ws <= 0) return;
    sx /= ws; sz /= ws;
    D.wbase[0] = Math.sqrt(sx * sx + sz * sz); D.wbase[1] = Math.atan2(-sx, -sz); D.wbase[2] = gs / ws;
  }

  // terrain for this frame: under the drone now and where it will be at the end of the frame, plus the GPS look-ahead
  function frameTerrain(nsub) {
    const px = D.p[0], pz = D.p[2], vx = D.v[0], vz = D.v[2];
    const tf = nsub * D.H;
    T.TQ[0] = px; T.TQ[1] = pz; T.TQ[2] = px + vx * tf; T.TQ[3] = pz + vz * tf;
    let n = 2;
    if (M[M_MODE] === 0) {
      // along the velocity, or along the stick intent when (nearly) stopped
      let ax = vx, az = vz;
      const vh = Math.sqrt(vx * vx + vz * vz);
      if (vh < 1) {
        const ix = D.S[D.S_INTX], iz = D.S[D.S_INTZ], il = Math.sqrt(ix * ix + iz * iz);
        if (il > 0.1) { ax = ix / il * 4; az = iz / il * 4; } else { ax = 0; az = 0; }
      }
      const tk = D.S[D.S_TRANSIT] > 0 ? 2.5 : 1;
      for (let k = 1; k <= 5; k++) { const t = k * 0.5 * tk; T.TQ[2 * n] = px + ax * t; T.TQ[2 * n + 1] = pz + az * t; n++; }
    }
    T.query(n);
    D.S[D.S_G0] = T.TG[0]; D.S[D.S_G1] = T.TG[1];
    let ga = T.TG[0] > 0 ? T.TG[0] : 0;
    for (let k = 1; k < n; k++) if (T.TG[k] > ga) ga = T.TG[k];
    D.S[D.S_GAHEAD] = ga;
    D.S[D.S_SUBI] = 0; D.S[D.S_SUBN] = nsub;
  }

  function step(dt) {
    // dt goes straight into the typed array: reassigning the parameter (undefined | double) would make V8's
    // mid tier (Maglev) keep it tagged and box a fresh number every frame
    if (dt === undefined) F[F_DT] = sim.dtIn[0]; else F[F_DT] = dt;
    const d0 = F[F_DT];
    F[F_DT] = d0 > 0.1 ? 0.1 : d0 > 0 ? d0 : 0;
    if (sim.flightMode !== M[M_MODE]) applyMode(sim.flightMode);

    IN.ARG[0] = F[F_DT];
    IN.poll(M[M_MODE] !== 0);
    handleActions();
    IN.shape(D.ch, M[M_MODE]);
    D.st.sport = sim.sport ? 1 : 0;
    D.st.boost = M[M_MODE] === 0 && (IN.held[IN.ACT_BOOST] || sim.boost) ? 1 : 0;

    // fixed substeps this frame
    F[F_ACC] += F[F_DT];
    const nsub = (F[F_ACC] / D.H) | 0;
    frameTerrain(nsub);
    F[F_TX] = D.p[0]; F[F_TZ] = D.p[2];
    const cell = nearestCell();
    M[M_CELL] = cell;
    updateWind();
    D.frameWind();

    F[F_P0X] = D.p[0]; F[F_P0Y] = D.p[1]; F[F_P0Z] = D.p[2];
    for (let i = 0; i < nsub; i++) {
      prevP[0] = D.p[0]; prevP[1] = D.p[1]; prevP[2] = D.p[2];
      prevQ[0] = D.q[0]; prevQ[1] = D.q[1]; prevQ[2] = D.q[2]; prevQ[3] = D.q[3];
      D.substep();
    }
    F[F_ACC] -= nsub * D.H;
    F[F_ALPHA] = F[F_ACC] / D.H;
    rp[0] = prevP[0] + (D.p[0] - prevP[0]) * F[F_ALPHA];
    rp[1] = prevP[1] + (D.p[1] - prevP[1]) * F[F_ALPHA];
    rp[2] = prevP[2] + (D.p[2] - prevP[2]) * F[F_ALPHA];
    qnlerpA(rq, prevQ, D.q, F, F_ALPHA);

    const o = sim.drone;
    o[0] = rp[0]; o[1] = rp[1]; o[2] = rp[2];
    o[3] = rq[0]; o[4] = rq[1]; o[5] = rq[2]; o[6] = rq[3];
    o[7] = D.v[0]; o[8] = D.v[1]; o[9] = D.v[2];
    o[10] = D.m[0]; o[11] = D.m[1]; o[12] = D.m[2]; o[13] = D.m[3];
    o[14] = (D.m[0] + D.m[1] + D.m[2] + D.m[3]) * 0.25;
    o[15] = D.st.crashed;

    // rings
    if (!D.st.crashed) {
      R.ARG[0] = F[F_P0X]; R.ARG[1] = F[F_P0Y]; R.ARG[2] = F[F_P0Z]; R.ARG[3] = D.p[0]; R.ARG[4] = D.p[1]; R.ARG[5] = D.p[2];
      if (R.update() >= 0) AU.chime();
    }
    // lost the line (far from the next ring for a second): the nearest ring becomes the next one.
    // (distToNext runs every frame on purpose: a function V8 sees only rarely stays in its baseline tiers,
    // which box every double.)
    R.ARG[0] = D.p[0]; R.ARG[1] = D.p[1]; R.ARG[2] = D.p[2];
    R.distToNext();
    F[F_REACQ] = R.ARG[7] > 900 ? F[F_REACQ] + F[F_DT] : 0;
    if (F[F_REACQ] > 1) { F[F_REACQ] = 0; R.ARG[0] = D.p[0]; R.ARG[1] = D.p[2]; R.reacquire(); }
    sim.ringCount = R.info[R.I_WCOUNT];
    sim.ringNextSlot = R.info[R.I_SLOT];

    // realms visited + compass target (nearest unvisited curated cell)
    if (cell >= 0 && F[F_CELLD] < 1500) visited[cell] = 1;
    let tgt = -1;
    F[F_TD] = 1e30;
    for (let i = 0; i < NCELL; i++) {
      if (visited[i]) continue;
      const dx = CUR[i * 3] - D.p[0], dz = CUR[i * 3 + 1] - D.p[2], d = Math.sqrt(dx * dx + dz * dz);
      if (d < F[F_TD]) { F[F_TD] = d; tgt = i; }
    }
    M[M_TARGET] = tgt;

    // camera
    CAM.ARG[0] = F[F_DT]; CAM.ARG[1] = F[F_GIMBAL];
    CAM.update(sim.cam, sim.cameraMode, M[M_MODE], rp, rq, D.v, D.st.crashed);
    sim.pilot[0] = CAM.pilot[0]; sim.pilot[1] = CAM.pilot[1]; sim.pilot[2] = CAM.pilot[2];

    // info
    const inf = sim.info;
    const gh = D.S[D.S_GHERE];
    inf[INFO_AGL] = D.p[1] - D.st.af[D.A_HB] - gh;
    inf[INFO_AIRSPEED] = Math.sqrt(D.air[0] * D.air[0] + D.air[1] * D.air[1] + D.air[2] * D.air[2]);
    inf[INFO_GROUNDSPEED] = Math.sqrt(D.v[0] * D.v[0] + D.v[2] * D.v[2]);
    inf[INFO_VZ] = D.v[1];
    inf[INFO_TRANSIT] = D.S[D.S_TRANSIT];
    inf[INFO_LANDED] = D.st.landed;
    qheadingA(D.q, inf, INFO_HEADING);
    inf[INFO_GIMBAL] = F[F_GIMBAL];
    inf[INFO_WINDX] = D.wind[0]; inf[INFO_WINDY] = D.wind[1]; inf[INFO_WINDZ] = D.wind[2];
    inf[INFO_REALM] = cell >= 0 ? CUR[cell * 3 + 2] : -1;
    inf[INFO_RINGS] = R.info[R.I_PASSED];
    inf[INFO_CRASHES] = D.st.crashes;
    inf[INFO_HOVER] = D.st.af[D.A_HOVER];
    inf[INFO_STICKMODE] = IN.stickMode();
    inf[INFO_TELEPORTS] = M[M_TELEPORTS];
    inf[INFO_TARGET] = tgt;
    camQ[0] = sim.cam[3]; camQ[1] = sim.cam[4]; camQ[2] = sim.cam[5]; camQ[3] = sim.cam[6];
    qheadingA(camQ, F, F_TMP);
    let rel = 0;
    if (tgt >= 0) {
      rel = Math.atan2(-(CUR[tgt * 3] - D.p[0]), -(CUR[tgt * 3 + 1] - D.p[2])) - F[F_TMP];
      rel -= TWO_PI * Math.round(rel / TWO_PI);
    }
    inf[INFO_COMPASS] = rel;
    inf[INFO_COMPASS_KM] = tgt >= 0 ? F[F_TD] / 1000 : 0;

    // sound + hud
    AU.ARG[0] = F[F_DT]; AU.ARG[1] = inf[INFO_AIRSPEED];
    AU.update(D.m, D.st.crashed, cell >= 0 ? CUR[cell * 3 + 2] | 0 : 0, M[M_MODE] === 2 ? 1 : 0);
    const status = D.st.crashed ? 1 : D.S[D.S_TRANSIT] > 0 ? 2 : D.st.landed ? 3 : tgt < 0 && NCELL > 0 ? 4 : 0;
    HUD.ARG[0] = F[F_DT]; HUD.ARG[1] = inf[INFO_GROUNDSPEED]; HUD.ARG[2] = inf[INFO_AGL];
    HUD.ARG[3] = inf[INFO_COMPASS_KM]; HUD.ARG[4] = rel;
    HUD.update(IN.phys, M[M_MODE], sim.sport, sim.cameraMode, status, tgt >= 0 ? CUR[tgt * 3 + 2] | 0 : -1, R.info[R.I_PASSED]);
  }

  // start: hover over the first stop of the tour (Home), or the origin
  applyMode(typeof opts.flightMode === 'number' ? opts.flightMode : D.MODE_GPS);
  if (opts.spawn && opts.spawn.length >= 2) teleport(+opts.spawn[0], +opts.spawn[1]);
  else if (R.tour.length > 0) spawnAtRing(0);
  else teleport(0, 0);
  M[M_TELEPORTS] = 0;
  return sim;
}
