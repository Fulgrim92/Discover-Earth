// Procedural WebAudio (DESIGN section 8). Every node is created once in start(); update() only sets AudioParams.
// Motor: two detuned saws (one per diagonal motor pair, so differential thrust is audible as beating) plus a
// sub square, through a low-pass that opens with thrust. Wind: looped hash noise through a band-pass, level from
// airspeed. Pad: four slow voices that wander over the current realm's scale. Chimes: a pool of four bell voices.

import { hashi, HASH_SCALE } from './qmath.js';
const hash1 = (i, s) => hashi(i, s) * HASH_SCALE; // (pad changes every few seconds; not a hot path)

const A = {
  ctx: null, master: null, comp: null,
  oscA: null, oscB: null, sub: null, motorF: null, motorG: null,
  windSrc: null, windF: null, windG: null,
  padO: null, padG: null, padF: null, padM: null,
  chO: null, chO2: null, chG: null,
};
const S = new Float64Array(8);
const S_MUTED = 0, S_PADT = 1, S_PADV = 2, S_CHV = 3, S_NOTE = 4, S_CHSTEP = 5, S_REALM = 6, S_TICK = 7;

// realm scales (semitones from root), DESIGN section 8; realms without a named mode get one that fits their light
const SC = new Int8Array([
  0, 2, 3, 5, 7, 9, 10, -1,   // 0 Home Fjords: D dorian
  0, 2, 4, 7, 9, 12, 14, -1,  // 1 Painted Range: G major pentatonic (bright afternoon)
  0, 2, 4, 6, 7, 9, 11, -1,   // 2 Mirror Salt: A lydian
  0, 3, 5, 7, 10, 12, 15, -1, // 3 Stone Forest: E minor pentatonic (misty)
  0, 7, 12, 19, 24, -1, -1, -1, // 4 Aurora Ice: sparse fifths
  0, 2, 4, 6, 8, 10, -1, -1,  // 5 Lumen Deep: whole-tone
]);
const ROOT = new Float32Array([146.83, 98.0, 110.0, 82.41, 130.81, 92.5]); // D3 G2 A2 E2 C3 F#2
const NV = 4, NC = 4;

export function started() { return A.ctx !== null; }

export function start() {
  if (A.ctx) { if (A.ctx.state === 'suspended') A.ctx.resume(); return; }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  A.ctx = ctx;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4;
  const master = ctx.createGain(); master.gain.value = S[S_MUTED] ? 0 : 0.7;
  master.connect(comp); comp.connect(ctx.destination);
  A.master = master; A.comp = comp;

  // motor
  const mf = ctx.createBiquadFilter(); mf.type = 'lowpass'; mf.Q.value = 1.2; mf.frequency.value = 800;
  const mg = ctx.createGain(); mg.gain.value = 0;
  const oa = ctx.createOscillator(); oa.type = 'sawtooth'; oa.frequency.value = 120;
  const ob = ctx.createOscillator(); ob.type = 'sawtooth'; ob.frequency.value = 120; ob.detune.value = 9;
  const sub = ctx.createOscillator(); sub.type = 'square'; sub.frequency.value = 60;
  const sg = ctx.createGain(); sg.gain.value = 0.25;
  oa.connect(mf); ob.connect(mf); sub.connect(sg); sg.connect(mf); mf.connect(mg); mg.connect(master);
  oa.start(); ob.start(); sub.start();
  A.oscA = oa; A.oscB = ob; A.sub = sub; A.motorF = mf; A.motorG = mg;

  // wind: 2 s of seeded hash noise, looped
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < len; i++) { lp = lp * 0.6 + (hash1(i, 4242) * 2 - 1) * 0.4; d[i] = lp; }
  const ws = ctx.createBufferSource(); ws.buffer = buf; ws.loop = true;
  const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 0.6; wf.frequency.value = 400;
  const wg = ctx.createGain(); wg.gain.value = 0;
  ws.connect(wf); wf.connect(wg); wg.connect(master); ws.start();
  A.windSrc = ws; A.windF = wf; A.windG = wg;

  // pad
  const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 900; pf.Q.value = 0.5;
  const pm = ctx.createGain(); pm.gain.value = 0.5;
  pf.connect(pm); pm.connect(master);
  A.padO = []; A.padG = [];
  for (let i = 0; i < NV; i++) {
    const o = ctx.createOscillator(); o.type = i & 1 ? 'triangle' : 'sine'; o.frequency.value = ROOT[0];
    o.detune.value = (i - 1.5) * 4;
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(g); g.connect(pf); o.start();
    A.padO.push(o); A.padG.push(g);
  }
  A.padF = pf; A.padM = pm;

  // chime pool
  A.chO = []; A.chO2 = []; A.chG = [];
  for (let i = 0; i < NC; i++) {
    const o = ctx.createOscillator(); o.type = 'sine';
    const o2 = ctx.createOscillator(); o2.type = 'sine';
    const g2 = ctx.createGain(); g2.gain.value = 0.18;
    const g = ctx.createGain(); g.gain.value = 0;
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(master);
    o.start(); o2.start();
    A.chO.push(o); A.chO2.push(o2); A.chG.push(g);
  }
}

// tab hidden: suspend the context (no CPU, no sound); visible again: resume (only if it was started)
export function pause(on) {
  if (!A.ctx) return;
  if (on && A.ctx.state === 'running') A.ctx.suspend();
  else if (!on && A.ctx.state === 'suspended') A.ctx.resume();
}

export function setMuted(on) {
  S[S_MUTED] = on ? 1 : 0;
  if (A.ctx) A.master.gain.setTargetAtTime(on ? 0 : 0.7, A.ctx.currentTime, 0.05);
}
export function muted() { return S[S_MUTED] !== 0; }

function noteFreq(realm, idx, octave) {
  let n = 0;
  while (n < 8 && SC[realm * 8 + n] >= 0) n++;
  const i = idx % n;
  return ROOT[realm] * Math.pow(2, SC[realm * 8 + i] / 12 + octave);
}

export const ARG = new Float64Array(2); // [dt, airspeed]

// m: motor levels 0..1 (Float64Array 4, Betaflight order RR FR RL FL); five: 1 for the 5-inch airframe.
// AudioParam calls take doubles, so the browser boxes them: that is a platform cost we keep small by
// updating at 30 Hz.
export function update(m, crashed, realm, five) {
  const ctx = A.ctx;
  if (!ctx) return;
  const dt = ARG[0], airspeed = ARG[1];
  S[S_TICK] += dt;
  if (S[S_TICK] < 1 / 30) return;
  S[S_TICK] = 0;
  const now = ctx.currentTime;
  // pair the diagonals that spin the same way: (RR, FL) and (FR, RL)
  const a = (m[0] + m[3]) * 0.5, b = (m[1] + m[2]) * 0.5, mean = (a + b) * 0.5;
  const f0 = five ? 110 : 95, f1 = five ? 560 : 330; // rpm/60 range: idle .. full
  A.oscA.frequency.setTargetAtTime(f0 + (f1 - f0) * a, now, 0.02);
  A.oscB.frequency.setTargetAtTime(f0 + (f1 - f0) * b, now, 0.02);
  A.sub.frequency.setTargetAtTime((f0 + (f1 - f0) * mean) * 0.5, now, 0.02);
  A.motorF.frequency.setTargetAtTime(350 + 4200 * mean * mean + 600 * mean, now, 0.03);
  A.motorG.gain.setTargetAtTime(mean < 0.02 ? 0 : (five ? 0.05 : 0.035) + 0.2 * mean, now, 0.03);

  const as = airspeed < 60 ? airspeed : 60;
  A.windF.frequency.setTargetAtTime(220 + 28 * as, now, 0.1);
  A.windG.gain.setTargetAtTime(0.004 + 0.3 * (as / 30) * (as / 30) * (crashed ? 0.3 : 1), now, 0.12);

  // pad: one voice moves every few seconds to a note of the realm's mode
  if (realm < 0 || realm > 5) realm = 0;
  S[S_REALM] = realm;
  S[S_PADT] -= 1 / 30;
  if (S[S_PADT] <= 0) {
    const nt = S[S_NOTE] = S[S_NOTE] + 1;
    const v = S[S_PADV] = (S[S_PADV] + 1) % NV;
    S[S_PADT] = 2.5 + 3.5 * hash1(nt, 71);
    const idx = (hash1(nt, 72) * 8) | 0;
    const oct = v === 0 ? -1 : v === 3 ? 1 : 0;
    A.padO[v].frequency.setTargetAtTime(noteFreq(realm, v === 0 ? 0 : idx, oct), now, 1.2);
    A.padG[v].gain.setTargetAtTime(0.06 + 0.05 * hash1(nt, 73), now, 1.8);
    const vo = (v + 2) % NV; // let the opposite voice breathe out
    A.padG[vo].gain.setTargetAtTime(0.015, now, 3.0);
  }
}

// a ring chime: the next note of the current mode, climbing with each ring
export function chime() {
  const ctx = A.ctx;
  if (!ctx) return;
  const now = ctx.currentTime;
  const v = S[S_CHV] = (S[S_CHV] + 1) % NC;
  const step = S[S_CHSTEP] = (S[S_CHSTEP] + 1) % 10;
  const realm = S[S_REALM] | 0;
  const f = noteFreq(realm, step, 1 + (step >= 5 ? 1 : 0));
  A.chO[v].frequency.setValueAtTime(f, now);
  A.chO2[v].frequency.setValueAtTime(f * 2.76, now);
  const g = A.chG[v].gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(0.0001, now);
  g.linearRampToValueAtTime(0.2, now + 0.006);
  g.setTargetAtTime(0, now + 0.01, 0.55);
}
