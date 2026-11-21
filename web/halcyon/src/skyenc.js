// skyenc.js (sky programmer): the sky's encounters (DESIGN 12.2, ids 16-25 in encounters.js). Once a frame, after
// realms.js skyTick, each running sky encounter bends its realm's row (sun, sky light, stars, aurora, moon) and the
// weather (a pinned squall, walking lightning); FR.ske carries what only a shader can draw:
//   FR.ske = (lunar eclipse 0..1, giant eclipse motion 0..1, Milky Way night 0..1, aurora surge 0..1), each times the
//   weight of its realm at the camera. Meteor, Brocken spectre and both-skies are drawn in composite.wgsl from the
//   encounter slots (LFX) themselves.
// Allocation-free: typed arrays only, no double returned across a call.
import { TABLE, F, ROWF, W_ID, W_W, exposeRealm } from './realms.js';
import { ENC, PH, DIR, IN, update, enable, E_METEOR, E_AURORA, E_ECLIPSE, E_LUNAR, E_MILKYWAY, E_BROCKEN, E_RAINBOW, E_DRYSTORM,
  E_RAINSHAFT, E_VEIL } from './encounters.js';
import { WX_PIN, WX_ENC } from './weather.js';
import { CLK, C_TIME } from './clock.js';
import { v as DV } from './sim/drone.js';

for (const id of [E_METEOR, E_AURORA, E_ECLIPSE, E_LUNAR, E_MILKYWAY, E_BROCKEN, E_RAINBOW, E_DRYSTORM, E_RAINSHAFT, E_VEIL]) enable(id);

export const SKE = new Float64Array(4); // FR.ske before the realm weight
const SKR = new Int32Array([4, 5, 2, 4]); // realm of each SKE entry: Ice (lunar), Lumen (eclipse), Mirror, Ice (aurora)
const E = new Float64Array(8); // scratch: [0] envelope, [1] slot, [2] rel, [3] phase, [4..7] geometry
let pinned = 0;

function ss(x) { const t = Math.min(Math.max(x, 0), 1); return t * t * (3 - 2 * t); }
// envelope of slot s at time t into E[0]: 0.1 by the end of the cue, 1 through the peak, back to 0 by the end
function env(s, t) {
  const rel = t - ENC[s * 8 + 4], c = PH[s * 4], b = PH[s * 4 + 1], p = PH[s * 4 + 2], D = PH[s * 4 + 3];
  E[2] = rel;
  if (rel < 0 || rel > D) { E[0] = 0; E[3] = -1; return; }
  if (rel < c) { E[0] = 0.1 * rel / Math.max(c, 1e-3); E[3] = 0; }
  else if (rel < b) { E[0] = 0.1 + 0.9 * ss((rel - c) / Math.max(b - c, 1e-3)); E[3] = 1; }
  else if (rel < p) { E[0] = 1; E[3] = 2; }
  else { E[0] = 1 - ss((rel - p) / Math.max(D - p, 1e-3)); E[3] = 3; }
}
// first running slot of type ty into E[1] (-1 if none), its envelope in E[0]
function find(ty, t) {
  E[1] = -1; E[0] = 0;
  for (let s = 0; s < 8; s++) {
    if (ENC[s * 8] !== ty) continue;
    env(s, t);
    if (E[3] >= 0) { E[1] = s; return; }
  }
}
function scaleSky(o, k) { // sky light (zenith, horizon, sunward) of the row at o times k
  for (let c = 0; c < 3; c++) { TABLE[o + F.S2 * 4 + c] *= k; TABLE[o + F.S3 * 4 + c] *= k; TABLE[o + F.S4 * 4 + c] *= k; }
}

// ringed giant (sky.wgsl giantDir): home at az 38, el 26, radius 12.5 deg. During an eclipse it swings in front of the
// sun so that at m = 1 its centre sits 0.6 radii from the sun (toward its home): the sun is hidden 0.4 radii deep.
// Returns the fraction of the sun's disc hidden in E[4] (m in E[5]); mirrors sky.wgsl giantDir exactly.
const GR = 12.5 * Math.PI / 180;
function giantOcc(o, m) {
  const R = Math.PI / 180;
  const se = TABLE[o + F.S0 * 4] * R, sa = TABLE[o + F.S0 * 4 + 1] * R;
  const lx = Math.sin(sa) * Math.cos(se), ly = Math.sin(se), lz = -Math.cos(sa) * Math.cos(se);
  const ge = 26 * R, ga = 38 * R;
  const hx = Math.sin(ga) * Math.cos(ge), hy = Math.sin(ge), hz = -Math.cos(ga) * Math.cos(ge);
  // tangent from the sun toward home
  const dh = hx * lx + hy * ly + hz * lz;
  let tx = hx - lx * dh, ty = hy - ly * dh, tz = hz - lz * dh;
  let l = Math.sqrt(tx * tx + ty * ty + tz * tz) + 1e-9; tx /= l; ty /= l; tz /= l;
  const k = Math.tan(0.6 * GR);
  let Tx = lx + tx * k, Ty = ly + ty * k, Tz = lz + tz * k;
  l = Math.sqrt(Tx * Tx + Ty * Ty + Tz * Tz); Tx /= l; Ty /= l; Tz /= l;
  let Gx = hx + (Tx - hx) * m, Gy = hy + (Ty - hy) * m, Gz = hz + (Tz - hz) * m;
  l = Math.sqrt(Gx * Gx + Gy * Gy + Gz * Gz); Gx /= l; Gy /= l; Gz /= l;
  const ang = Math.acos(Math.min(Math.max(Gx * lx + Gy * ly + Gz * lz, -1), 1));
  const rs = TABLE[o + F.S0 * 4 + 3] * 0.5 * R;
  E[4] = Math.min(Math.max((GR + rs - ang) / (2 * rs), 0), 1);
}

// main.js, before skyTime: the director with the camera (cam xyz) and its forward vector (fwd xyz), so an event placed
// this frame bends this frame's rows (fx/lifefx.js runs it again with the view; at the same t that changes nothing)
export function skyEncDirector(cam, fwd) {
  IN[0] = CLK[C_TIME]; IN[1] = cam[0]; IN[2] = cam[1]; IN[3] = cam[2]; IN[4] = fwd[0]; IN[5] = fwd[2];
  IN[6] = DV[0]; IN[7] = DV[2]; if (!(IN[8] > 0)) IN[8] = 0.7;
  update();
}

// after skyTick, before the camera's row is blended (main.js skyTime)
export function skyEncRows() {
  const t = CLK[C_TIME];
  SKE.fill(0);
  // 19 total lunar eclipse (Ice): the moon dims to a quarter and turns copper; the ice under it reddens
  find(E_LUNAR, t);
  if (E[1] >= 0) {
    const o = 4 * ROWF, a = E[0];
    SKE[0] = a;
    TABLE[o + F.S8 * 4 + 2] *= 1 - 0.72 * a;
    TABLE[o + F.S5 * 4 + 1] *= 1 - 0.6 * a; // the aurora quiets (the red moon is the event)
    exposeRealm(4);
  }
  // 17 aurora surge to a corona (Ice): the curtains brighten threefold and a corona opens overhead
  find(E_AURORA, t);
  if (E[1] >= 0) {
    const o = 4 * ROWF, a = E[0];
    SKE[3] = a;
    TABLE[o + F.S5 * 4 + 1] *= 1 + 2.0 * a;
    // more aurora light on the snow (the night floor in skyTick scales with S5.y but ran before this)
    TABLE[o + F.S2 * 4 + 1] += 0.012 * a; TABLE[o + F.S2 * 4 + 2] += 0.008 * a;
    TABLE[o + F.S3 * 4 + 1] += 0.014 * a; TABLE[o + F.S3 * 4 + 2] += 0.009 * a;
    exposeRealm(4);
  }
  // 18 the ringed giant eclipses the sun (Lumen): it swings across, the sun goes behind it (diamond ring on the
  // limb, the giant's air lit as a ring), daylight goes and the land lights itself
  find(E_ECLIPSE, t);
  if (E[1] >= 0) {
    const o = 5 * ROWF, m = E[0];
    SKE[1] = m;
    giantOcc(o, m);
    const oc = E[4];
    TABLE[o + F.S0 * 4 + 2] *= 1 - 0.995 * oc;
    scaleSky(o, 1 - 0.93 * oc);
    TABLE[o + F.S7 * 4 + 3] += 0.55 * oc; // the land's own glow (night light)
    exposeRealm(5);
  }
  // 20 night falls for a minute (Mirror): the sun's light goes, the stars and the Milky Way come out, above and in
  // the mirror below
  find(E_MILKYWAY, t);
  if (E[1] >= 0) {
    const o = 2 * ROWF, a = E[0];
    SKE[2] = a;
    TABLE[o + F.S0 * 4 + 2] *= 1 - 0.998 * a;
    scaleSky(o, 1 - 0.997 * a);
    const st = 0.0015 * a; // starlight and airglow
    TABLE[o + F.S2 * 4] += st; TABLE[o + F.S2 * 4 + 1] += st * 1.1; TABLE[o + F.S2 * 4 + 2] += st * 1.8;
    TABLE[o + F.S3 * 4] += st; TABLE[o + F.S3 * 4 + 1] += st * 1.1; TABLE[o + F.S3 * 4 + 2] += st * 1.6;
    TABLE[o + F.S5 * 4] = Math.max(TABLE[o + F.S5 * 4], a);
    exposeRealm(2);
  }
  // 21 Brocken spectre (Stone Forest): the cloud sea rises out of the valleys to just under the pillar tops, so there
  // is cloud below in the antisolar direction for the glory (composite.wgsl encGlory)
  find(E_BROCKEN, t);
  if (E[1] >= 0) {
    const o = 3 * ROWF;
    TABLE[o + F.C2 * 4 + 1] += 260 * E[0];
  }
  // weather encounters: a squall pinned where the event is (the view direction is DIR turned back: encounters.js
  // site() sets DIR = (-fz, fx)), lightning walking along the cell
  WX_ENC[0] = 0;
  let pin = 0;
  find(E_RAINBOW, t); // 22: a squall rolls in ahead; its bow stands in the rain against the dark cell
  if (E[1] >= 0 && E[0] > 0.01) {
    const s = E[1], fx = DIR[s * 2 + 1], fz = -DIR[s * 2];
    const r = 3500 * (0.45 + 0.55 * E[0]);
    WX_PIN[0] = ENC[s * 8 + 1] + fx * 3500; WX_PIN[1] = ENC[s * 8 + 3] + fz * 3500; WX_PIN[2] = r; pin = 1;
  }
  find(E_RAINSHAFT, t); // 24: a lone shaft far out over the salt, doubled in the mirror
  if (!pin && E[1] >= 0 && E[0] > 0.01) {
    const s = E[1];
    WX_PIN[0] = ENC[s * 8 + 1]; WX_PIN[1] = ENC[s * 8 + 3]; WX_PIN[2] = 900 + 900 * E[0]; pin = 1;
  }
  find(E_DRYSTORM, t); // 23: a dry storm on the horizon; its strikes walk along it, the virga under it
  if (!pin && E[1] >= 0 && E[0] > 0.01) {
    const s = E[1], fx = DIR[s * 2 + 1], fz = -DIR[s * 2];
    WX_PIN[0] = ENC[s * 8 + 1] + fx * 1500; WX_PIN[1] = ENC[s * 8 + 3] + fz * 1500; WX_PIN[2] = 3000 * (0.5 + 0.5 * E[0]); pin = 1;
    if (E[3] >= 1 && E[3] <= 2) {
      // every 1.4 s, stepping 900 m along the line of the storm (DIR), back and forth over 8 km
      WX_ENC[0] = 1.4; WX_ENC[1] = WX_PIN[0]; WX_ENC[2] = WX_PIN[1]; WX_ENC[3] = DIR[s * 2]; WX_ENC[4] = DIR[s * 2 + 1];
    }
  }
  if (pin) pinned = 1;
  else if (pinned) { WX_PIN[2] = 0; pinned = 0; }
}

// after the camera's realm weights are known (main.js prepareFrame, after blendAtA): FR.ske
export function skyEncFrame(fr, o) {
  for (let i = 0; i < 4; i++) {
    let w = 0;
    if (SKE[i] > 0) for (let k = 0; k < 4; k++) if (W_ID[k] === SKR[i]) w = W_W[k];
    fr[o + i] = SKE[i] * w;
  }
}
