// Input: Gamepad API (pads and USB RC transmitters), keyboard fallback, XR sticks; stick modes 1-4, deadband, expo,
// Betaflight "actual" rates for Acro. poll() runs once per frame and allocates nothing except the platform's
// navigator.getGamepads() snapshot.
//
// Physical sticks (after calibration): phys = [LX, LY, RX, RY], each -1..1, RIGHT and UP positive.
// Channels: [throttle, yaw, pitch, roll]; yaw + = clockwise (right), pitch + = nose down / forward, roll + = right.

export const LX = 0, LY = 1, RX = 2, RY = 3;

// actions
export const ACT_MODE = 0, ACT_CAMERA = 1, ACT_RESET = 2, ACT_BOOST = 3, ACT_SPORT = 4, ACT_HUD = 5,
  ACT_SETTINGS = 6, ACT_GIMBAL_UP = 7, ACT_GIMBAL_DOWN = 8, ACT_MUTE = 9, ACT_NEXT_REALM = 10, N_ACT = 11;
export const ACT_NAMES = ['flight mode', 'camera', 'reset', 'boost (hold)', 'normal/sport', 'hud', 'settings',
  'gimbal up', 'gimbal down', 'mute', 'next realm'];

// per stick mode: physical axis index carrying [throttle, yaw, pitch, roll]
const MODEMAP = new Int8Array([
  /* mode 1 */ RY, LX, LY, RX,
  /* mode 2 */ LY, LX, RY, RX,
  /* mode 3 */ RY, RX, LY, LX,
  /* mode 4 */ LY, RX, RY, LX,
]);

export const MAX_AXES = 16, MAX_BUTTONS = 32;
export const axes = new Float32Array(MAX_AXES);        // raw gamepad axes this frame
export const buttons = new Float32Array(MAX_BUTTONS);  // raw gamepad button values this frame
export const phys = new Float32Array(4);               // merged physical sticks
export const gp = new Float32Array(4);                 // gamepad sticks after mapping/calibration
export const kb = new Float32Array(4);                 // keyboard sticks after smoothing
export const xr = new Float32Array(4);                 // XR sticks for this frame
export const chan = new Float32Array(4);               // raw channels (after stick mode, before shaping)
export const pressed = new Uint8Array(N_ACT);          // edge counts this frame (consumed by index.js)
export const held = new Uint8Array(N_ACT);             // currently held
export const keys = new Uint8Array(8);                 // W S A D Up Down Left Right
export const kbPress = new Uint8Array(N_ACT);
export const kbHeld = new Uint8Array(N_ACT);
const padHeld = new Uint8Array(N_ACT);
const padPrev = new Uint8Array(N_ACT);
export const realmKey = new Int8Array(1);              // -1 or 0..5 (number keys 1..6)
export const padInfo = new Int32Array(4);              // [connected, index, nAxes, nButtons]

// configuration (persisted)
export const cfgI = new Int32Array(64);
export const cfgF = new Float32Array(64);
export const C_STICKMODE = 0, C_PADINDEX = 1, C_MAP = 2 /* ..5 */, C_INV = 6 /* ..9 */, C_BIND = 10 /* ..20 */;
export const F_DEADBAND = 0, F_EXPO = 1, F_ACRO_C = 2, F_ACRO_M = 3, F_ACRO_E = 4, F_AMIN = 8 /* ..23 */, F_AMAX = 24 /* ..39 */;
// bindings: -1 none; 0..31 button; 100+i axis i above +0.5; 200+i axis i below -0.5

export const calib = { on: 0 };
export const calMin = new Float32Array(MAX_AXES), calMax = new Float32Array(MAX_AXES);
export const learn = { action: -1 }; // action index waiting for a button/switch in the panel

const STORE_KEY = 'halcyon.input.v1';
let hasNav = false;
const pad = { id: '' };
export function padId() { return pad.id; }

export function defaults() {
  cfgI[C_STICKMODE] = 2; cfgI[C_PADINDEX] = -1;
  cfgI[C_MAP + 0] = 0; cfgI[C_MAP + 1] = 1; cfgI[C_MAP + 2] = 2; cfgI[C_MAP + 3] = 3;
  cfgI[C_INV + 0] = 0; cfgI[C_INV + 1] = 1; cfgI[C_INV + 2] = 0; cfgI[C_INV + 3] = 1; // standard pads: up is -1
  for (let i = 0; i < N_ACT; i++) cfgI[C_BIND + i] = -1;
  cfgI[C_BIND + ACT_MODE] = 3;        // Y / triangle
  cfgI[C_BIND + ACT_CAMERA] = 2;      // X / square
  cfgI[C_BIND + ACT_RESET] = 1;       // B / circle
  cfgI[C_BIND + ACT_BOOST] = 7;       // RT
  cfgI[C_BIND + ACT_SPORT] = 5;       // RB
  cfgI[C_BIND + ACT_HUD] = 8;         // back / select
  cfgI[C_BIND + ACT_SETTINGS] = 9;    // start
  cfgI[C_BIND + ACT_GIMBAL_UP] = 12;  // d-pad up
  cfgI[C_BIND + ACT_GIMBAL_DOWN] = 13;// d-pad down
  cfgI[C_BIND + ACT_NEXT_REALM] = 15; // d-pad right
  cfgF[F_DEADBAND] = 0.04; cfgF[F_EXPO] = 0.25;
  cfgF[F_ACRO_C] = 70; cfgF[F_ACRO_M] = 670; cfgF[F_ACRO_E] = 0.3;
  for (let i = 0; i < MAX_AXES; i++) { cfgF[F_AMIN + i] = -1; cfgF[F_AMAX + i] = 1; }
}

export function save() {
  try {
    const o = {
      stickMode: cfgI[C_STICKMODE], padIndex: cfgI[C_PADINDEX],
      map: Array.from(cfgI.subarray(C_MAP, C_MAP + 4)), inv: Array.from(cfgI.subarray(C_INV, C_INV + 4)),
      bind: Array.from(cfgI.subarray(C_BIND, C_BIND + N_ACT)),
      deadband: cfgF[F_DEADBAND], expo: cfgF[F_EXPO], acro: [cfgF[F_ACRO_C], cfgF[F_ACRO_M], cfgF[F_ACRO_E]],
      amin: Array.from(cfgF.subarray(F_AMIN, F_AMIN + MAX_AXES)), amax: Array.from(cfgF.subarray(F_AMAX, F_AMAX + MAX_AXES)),
    };
    globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch (e) { /* storage unavailable */ }
}

export function load() {
  defaults();
  try {
    const s = globalThis.localStorage && globalThis.localStorage.getItem(STORE_KEY);
    if (!s) return;
    const o = JSON.parse(s);
    const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : d);
    cfgI[C_STICKMODE] = Math.min(4, Math.max(1, num(o.stickMode, 2) | 0));
    cfgI[C_PADINDEX] = num(o.padIndex, -1) | 0;
    for (let i = 0; i < 4; i++) {
      cfgI[C_MAP + i] = num(o.map && o.map[i], cfgI[C_MAP + i]) | 0;
      cfgI[C_INV + i] = num(o.inv && o.inv[i], cfgI[C_INV + i]) ? 1 : 0;
    }
    for (let i = 0; i < N_ACT; i++) cfgI[C_BIND + i] = num(o.bind && o.bind[i], cfgI[C_BIND + i]) | 0;
    cfgF[F_DEADBAND] = num(o.deadband, cfgF[F_DEADBAND]);
    cfgF[F_EXPO] = num(o.expo, cfgF[F_EXPO]);
    if (o.acro) { cfgF[F_ACRO_C] = num(o.acro[0], 70); cfgF[F_ACRO_M] = num(o.acro[1], 670); cfgF[F_ACRO_E] = num(o.acro[2], 0.3); }
    for (let i = 0; i < MAX_AXES; i++) {
      cfgF[F_AMIN + i] = num(o.amin && o.amin[i], -1);
      cfgF[F_AMAX + i] = num(o.amax && o.amax[i], 1);
    }
  } catch (e) { defaults(); }
}

// ---------------------------------------------------------------------------------------------------------------
// keyboard (event handlers run outside the frame loop)
function keySlot(code) {
  switch (code) {
    case 'KeyW': return 0; case 'KeyS': return 1; case 'KeyA': return 2; case 'KeyD': return 3;
    case 'ArrowUp': return 4; case 'ArrowDown': return 5; case 'ArrowLeft': return 6; case 'ArrowRight': return 7;
  }
  return -1;
}
function keyAction(code) {
  switch (code) {
    case 'KeyF': return ACT_MODE; case 'KeyC': return ACT_CAMERA; case 'KeyR': return ACT_RESET;
    case 'Space': case 'ShiftLeft': case 'ShiftRight': return ACT_BOOST;
    case 'KeyX': return ACT_SPORT; case 'KeyH': return ACT_HUD; case 'KeyP': return ACT_SETTINGS;
    case 'KeyQ': return ACT_GIMBAL_UP; case 'KeyE': return ACT_GIMBAL_DOWN; case 'KeyM': return ACT_MUTE;
    case 'KeyN': return ACT_NEXT_REALM;
  }
  return -1;
}

export function attachKeyboard(target) {
  realmKey[0] = -1;
  const isField = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'); };
  target.addEventListener('keydown', (e) => {
    if (isField(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const s = keySlot(e.code);
    if (s >= 0) { keys[s] = 1; e.preventDefault(); return; }
    if (e.code.length === 6 && e.code.startsWith('Digit')) {
      const n = e.code.charCodeAt(5) - 49;
      if (n >= 0 && n < 6 && !e.repeat) realmKey[0] = n;
      return;
    }
    const a = keyAction(e.code);
    if (a >= 0) {
      if (!e.repeat) kbPress[a]++;
      kbHeld[a] = 1;
      if (e.code === 'Space') e.preventDefault();
    }
  });
  target.addEventListener('keyup', (e) => {
    const s = keySlot(e.code);
    if (s >= 0) { keys[s] = 0; return; }
    const a = keyAction(e.code);
    if (a >= 0) kbHeld[a] = 0;
  });
  target.addEventListener('blur', () => { keys.fill(0); kbHeld.fill(0); });
}

export function init() {
  load();
  hasNav = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  realmKey[0] = -1;
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('gamepadconnected', (e) => { pad.id = e.gamepad ? e.gamepad.id : ''; });
    window.addEventListener('gamepaddisconnected', () => { pad.id = ''; });
  }
}

// set the keyboard throttle from A[i] (0..1), used when switching to a manual-throttle mode so the drone does not drop
const kbThr = new Float32Array(1);
// The value is read at the next poll(): mode switches run cold (interpreted), where any double maths boxes.
let kbSrc = null, kbIdx = 0;
export function setKbThrottleFrom(A, i) { kbSrc = A; kbIdx = i; }
export function setKbThrottleLow() { kbSrc = null; kbThr[0] = -1; } // the throttle at zero (landed)

export const xrFlag = new Uint8Array(1);
export function setXR(lx, ly, rx, ry) { xr[0] = lx; xr[1] = ly; xr[2] = rx; xr[3] = ry; xrFlag[0] = 1; }

export const ARG = new Float64Array(2); // [dt] for poll()

function bindActive(b) {
  if (b < 0) return 0;
  if (b < 100) return b < MAX_BUTTONS && buttons[b] > 0.5 ? 1 : 0;
  if (b < 200) { const i = b - 100; return i < MAX_AXES && axes[i] > 0.5 ? 1 : 0; }
  const i = b - 200; return i < MAX_AXES && axes[i] < -0.5 ? 1 : 0;
}

function pollPad() {
  padInfo[0] = 0;
  if (!hasNav) return;
  const pads = navigator.getGamepads(); // platform snapshot (the one allowed allocation)
  if (!pads) return;
  let g = null;
  const want = cfgI[C_PADINDEX];
  if (want >= 0 && want < pads.length && pads[want]) g = pads[want];
  else for (let i = 0; i < pads.length; i++) { const c = pads[i]; if (c && c.connected && c.axes.length >= 2) { g = c; break; } }
  if (!g) return;
  const ga = g.axes, gb = g.buttons;
  const na = ga.length < MAX_AXES ? ga.length : MAX_AXES, nb = gb.length < MAX_BUTTONS ? gb.length : MAX_BUTTONS;
  for (let i = 0; i < na; i++) axes[i] = ga[i];
  for (let i = na; i < MAX_AXES; i++) axes[i] = 0;
  for (let i = 0; i < nb; i++) buttons[i] = gb[i].value;
  for (let i = nb; i < MAX_BUTTONS; i++) buttons[i] = 0;
  padInfo[0] = 1; padInfo[1] = g.index; padInfo[2] = na; padInfo[3] = nb;
}

// read everything once per frame. manualThrottle: throttle stick is absolute (Angle/Acro), so the keyboard
// throttle key ratchets instead of springing back.
export function poll(manualThrottle) {
  const dt = ARG[0];
  if (kbSrc !== null) { kbThr[0] = kbSrc[kbIdx] * 2 - 1; kbSrc = null; }
  pollPad();
  const connected = padInfo[0];
  if (calib.on && connected) {
    for (let i = 0; i < MAX_AXES; i++) {
      if (axes[i] < calMin[i]) calMin[i] = axes[i];
      if (axes[i] > calMax[i]) calMax[i] = axes[i];
    }
  }
  for (let s = 0; s < 4; s++) {
    if (!connected) { gp[s] = 0; continue; }
    const ai = cfgI[C_MAP + s];
    let x = 0;
    if (ai >= 0 && ai < MAX_AXES) {
      // calibrated range, centre = its midpoint
      const lo = cfgF[F_AMIN + ai], hi = cfgF[F_AMAX + ai], half = (hi - lo) * 0.5;
      x = half < 1e-3 ? 0 : (axes[ai] - (lo + hi) * 0.5) / half;
      x = x < -1 ? -1 : x > 1 ? 1 : x;
    }
    if (cfgI[C_INV + s]) x = -x;
    gp[s] = x;
  }

  // keyboard sticks: taps give small deflections, holding ramps to full; release springs back
  const mode = cfgI[C_STICKMODE] - 1;
  const thrAxis = MODEMAP[mode * 4];
  for (let s = 0; s < 4; s++) {
    const pos = s === LX ? keys[3] : s === LY ? keys[0] : s === RX ? keys[7] : keys[4];
    const neg = s === LX ? keys[2] : s === LY ? keys[1] : s === RX ? keys[6] : keys[5];
    const t = pos - neg;
    if (s === thrAxis && manualThrottle) {
      kbThr[0] = kbThr[0] + t * 0.7 * dt;
      if (kbThr[0] > 1) kbThr[0] = 1; else if (kbThr[0] < -1) kbThr[0] = -1;
      kb[s] = kbThr[0];
    } else {
      // approach the key target: 2.6/s out (a 0.1 s tap gives ~0.26), 8/s when reversing, 5/s spring back
      const tg = t, rate = t === 0 ? 5 : kb[s] * t < 0 ? 8 : 2.6, d = tg - kb[s], st = rate * dt;
      kb[s] = d > st ? kb[s] + st : d < -st ? kb[s] - st : tg;
    }
  }

  for (let s = 0; s < 4; s++) {
    let x;
    if (xrFlag[0]) x = xr[s];
    else {
      x = gp[s];
      // keyboard adds on top (a connected pad at rest contributes ~0); manual keyboard throttle replaces it
      if (s === thrAxis && manualThrottle && !connected) x = kb[s];
      else x += kb[s];
    }
    phys[s] = x < -1 ? -1 : x > 1 ? 1 : x;
  }
  xrFlag[0] = 0;

  chan[0] = phys[MODEMAP[mode * 4]];
  chan[1] = phys[MODEMAP[mode * 4 + 1]];
  chan[2] = phys[MODEMAP[mode * 4 + 2]];
  chan[3] = phys[MODEMAP[mode * 4 + 3]];

  // actions
  for (let a = 0; a < N_ACT; a++) {
    const b = connected && learn.action < 0 ? bindActive(cfgI[C_BIND + a]) : 0;
    padHeld[a] = b;
    pressed[a] = kbPress[a] + (b && !padPrev[a] ? 1 : 0);
    padPrev[a] = b;
    held[a] = b | kbHeld[a];
    kbPress[a] = 0;
  }
  // learn mode: first button / switch that becomes active binds to the waiting action
  if (learn.action >= 0 && connected) {
    for (let i = 0; i < MAX_BUTTONS; i++) if (buttons[i] > 0.5) { cfgI[C_BIND + learn.action] = i; learn.action = -1; return; }
    for (let i = 0; i < MAX_AXES; i++) {
      // ignore the four stick axes
      if (i === cfgI[C_MAP] || i === cfgI[C_MAP + 1] || i === cfgI[C_MAP + 2] || i === cfgI[C_MAP + 3]) continue;
      if (axes[i] > 0.5) { cfgI[C_BIND + learn.action] = 100 + i; learn.action = -1; return; }
      if (axes[i] < -0.5) { cfgI[C_BIND + learn.action] = 200 + i; learn.action = -1; return; }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// shaping into the drone's channel array (inline: no helper calls with doubles on the frame path)
// Betaflight "actual" rates, x in -1..1 -> deg/s (used by tests and the panel; shape() inlines the same formula)
export function actualRate(x, center, max, ex) {
  const ax = x < 0 ? -x : x, x5 = x * x * x * x * x;
  const stick = max - center > 0 ? max - center : 0;
  return x * center + stick * ax * (x5 * ex + x * (1 - ex));
}

const DEG = Math.PI / 180;
// flightMode: 0 GPS, 1 Angle, 2 Acro. out = drone.ch
export function shape(out, flightMode) {
  const db = cfgF[F_DEADBAND], ex = cfgF[F_EXPO];
  if (flightMode === 0) {
    const d0 = db > 0.06 ? db : 0.06, x = chan[0];
    out[0] = x > d0 ? (x - d0) / (1 - d0) : x < -d0 ? (x + d0) / (1 - d0) : 0;
  } else { const t = (chan[0] + 1) * 0.5; out[0] = t < 0 ? 0 : t > 1 ? 1 : t; }
  const c = cfgF[F_ACRO_C], m = cfgF[F_ACRO_M], e = cfgF[F_ACRO_E], stick = m - c > 0 ? m - c : 0;
  for (let k = 1; k < 4; k++) {
    const r = chan[k];
    const x = r > db ? (r - db) / (1 - db) : r < -db ? (r + db) / (1 - db) : 0;
    if (flightMode === 2) {
      const ax = x < 0 ? -x : x, x5 = x * x * x * x * x;
      out[k] = (x * c + stick * ax * (x5 * e + x * (1 - e))) * DEG;
    } else out[k] = x * (1 - ex) + x * x * x * ex;
  }
}

export function stickMode() { return cfgI[C_STICKMODE]; }
export function setStickMode(m) { cfgI[C_STICKMODE] = m < 1 ? 1 : m > 4 ? 4 : m | 0; }
