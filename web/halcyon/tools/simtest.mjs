// HALCYON flight-model tests. No dependencies.
//   node --expose-gc tools/simtest.mjs            (all tests; the zero-allocation gate needs --expose-gc)
//   node --expose-gc tools/simtest.mjs acro gps   (only tests whose name contains one of the words)
// Every assertion is a realistic band for the modelled aircraft; fix the sim, never widen a band past reality.

import { createSim } from '../src/sim/index.js';
import { PerformanceObserver } from 'node:perf_hooks';

const DEG = Math.PI / 180;
const DT = 1 / 240;

// ---- stub worlds -----------------------------------------------------------------------------------------------
const CURATED = new Float32Array([0, 0, 0, 5200, -1800, 1, 2600, -5600, 2]);
const flat = { heightAt: () => 20, CURATED };
// a ramp rising to the east with a shallow valley along z = 0 (gives the ring generator something to follow)
const ramp = {
  heightAt: (x, z) => 20 + (x > 300 ? (x - 300) * 0.12 : 0) + Math.min(60, Math.abs(z) * 0.05) - (x > 2000 ? (x - 2000) * 0.1 : 0),
  CURATED,
};

// ---- harness ---------------------------------------------------------------------------------------------------
const results = [];
const filter = process.argv.slice(2);
async function test(name, fn) {
  if (filter.length && !filter.some((f) => name.includes(f))) return;
  const t0 = Date.now();
  try {
    const notes = await fn();
    results.push([true, name]);
    console.log(`ok    ${name}${notes ? '  —  ' + notes : ''}  (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
function within(label, x, lo, hi, unit = '') {
  if (!(x >= lo && x <= hi)) throw new Error(`${label} = ${x.toFixed(3)}${unit}, expected ${lo}..${hi}${unit}`);
  return `${label} ${x.toFixed(2)}${unit}`;
}
function check(cond, msg) { if (!cond) throw new Error(msg); }

// sticks are physical (mode 2 default): lx yaw, ly throttle/climb, rx roll, ry pitch; up/right positive
function run(sim, seconds, lx = 0, ly = 0, rx = 0, ry = 0, each) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { sim.setXRSticks(lx, ly, rx, ry); sim.step(DT); if (each) each(i * DT); }
}
const D = (sim) => sim._dbg.D;
const speedH = (d) => Math.hypot(d.v[0], d.v[2]);
const calm = { wind: [0, 0, 0] };

function place(sim, x, y, z, yaw) {
  const d = D(sim);
  d.PH[0] = x; d.PH[1] = y; d.PH[2] = z; d.PH[3] = yaw;
  d.placeHover();
}
function hoverAt(sim, y) { place(sim, D(sim).p[0], y, D(sim).p[2], 0); }


// throttle stick (0..1) that holds altitude, found by bisection on the mean climb rate
function findHover(mode) {
  let lo = 0, hi = 1;
  for (let it = 0; it < 18; it++) {
    const u = (lo + hi) / 2;
    const sim = createSim(flat, { ...calm, flightMode: mode });
    hoverAt(sim, 300);
    run(sim, 1.0, 0, 2 * u - 1);
    const y0 = D(sim).p[1];
    run(sim, 1.0, 0, 2 * u - 1);
    if (D(sim).p[1] - y0 > 0) hi = u; else lo = u;
  }
  return (lo + hi) / 2;
}

// ---- tests -----------------------------------------------------------------------------------------------------
await test('angle: hover throttle of the 249 g camera drone', () => {
  const u = findHover(1);
  return within('hover stick', u, 0.42, 0.6);
});

await test('acro: hover throttle of the 650 g 5-inch', () => {
  const u = findHover(2);
  return within('hover stick', u, 0.22, 0.38);
});

await test('gps: holds position within 0.3 m for 10 s in gusty wind', () => {
  const sim = createSim(flat, { wind: [6, 0.7, 0.5], seed: 3 });
  hoverAt(sim, 40);
  run(sim, 6);
  const d = D(sim);
  const x0 = d.p[0], y0 = d.p[1], z0 = d.p[2];
  let maxH = 0, maxV = 0, maxW = 0;
  run(sim, 10, 0, 0, 0, 0, () => {
    maxH = Math.max(maxH, Math.hypot(d.p[0] - x0, d.p[2] - z0));
    maxV = Math.max(maxV, Math.abs(d.p[1] - y0));
    maxW = Math.max(maxW, Math.hypot(d.wind[0], d.wind[2]));
  });
  check(maxW > 6, `wind never gusted above its base (max ${maxW.toFixed(1)})`);
  return [within('horizontal drift', maxH, 0, 0.3, ' m'), within('vertical', maxV, 0, 0.3, ' m'), `gusts to ${maxW.toFixed(1)} m/s`].join(', ');
});

await test('gps: normal and sport top speeds', () => {
  const out = [];
  for (const sport of [0, 1]) {
    const sim = createSim(flat, calm);
    hoverAt(sim, 60);
    sim.sport = sport;
    let peak = 0;
    run(sim, 14, 0, 0, 0, 1, () => { peak = Math.max(peak, speedH(D(sim))); });
    const v = speedH(D(sim));
    out.push(within('overshoot', peak - v, 0, 0.4, ' m/s'));
    out.push(within(sport ? 'sport' : 'normal', v, sport ? 15.3 : 9.5, sport ? 16.5 : 10.4, ' m/s'));
    const a = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (D(sim).q[0] ** 2 + D(sim).q[2] ** 2)))) / DEG;
    out.push(within('tilt', a, 0, sport ? 35.5 : 25.5, ' deg'));
  }
  return out.join(', ');
});

await test('gps: brakes from sport top speed in a realistic distance', () => {
  const sim = createSim(flat, calm);
  hoverAt(sim, 60);
  sim.sport = 1;
  run(sim, 14, 0, 0, 0, 1);
  const d = D(sim);
  const v0 = speedH(d), x0 = d.p[0], z0 = d.p[2];
  let t = 0;
  while (speedH(d) > 0.3 && t < 15) { run(sim, DT); t += DT; }
  const dist = Math.hypot(d.p[0] - x0, d.p[2] - z0);
  return [within('from', v0, 15, 17, ' m/s'), within('stopping distance', dist, 9, 24, ' m'), within('time', t, 1.5, 5, ' s')].join(', ');
});

await test('gps: boost/transit reaches 120 m/s and comes back to sport speed', () => {
  const sim = createSim(flat, calm);
  hoverAt(sim, 120);
  sim.sport = 1; sim.boost = 1;
  run(sim, 25, 0, 0, 0, 1);
  const v = speedH(D(sim));
  sim.boost = 0;
  run(sim, 10, 0, 0, 0, 0);
  const v2 = speedH(D(sim));
  return [within('transit', v, 110, 121, ' m/s'), within('10 s after release', v2, 0, 1, ' m/s'), within('crashes', D(sim).st.crashes, 0, 0)].join(', ');
});

await test('gps: stick directions (mode 2): forward is -Z at yaw 0, right is +X, yaw right turns clockwise', () => {
  let sim = createSim(flat, calm); hoverAt(sim, 50); run(sim, 2, 0, 0, 0, 0.6);
  check(D(sim).v[2] < -2 && Math.abs(D(sim).v[0]) < 0.3, `forward stick gave v=${D(sim).v[0].toFixed(2)},${D(sim).v[2].toFixed(2)}`);
  sim = createSim(flat, calm); hoverAt(sim, 50); run(sim, 2, 0, 0, 0.6, 0);
  check(D(sim).v[0] > 2 && Math.abs(D(sim).v[2]) < 0.3, `right stick gave v=${D(sim).v[0].toFixed(2)},${D(sim).v[2].toFixed(2)}`);
  sim = createSim(flat, calm); hoverAt(sim, 50); run(sim, 1, 0.5, 0, 0, 0);
  check(sim.info[6] < -0.3, `yaw right gave heading ${sim.info[6].toFixed(2)} (expected negative = clockwise from above)`);
  sim = createSim(flat, calm); hoverAt(sim, 50); run(sim, 2, 0, 0.8, 0, 0);
  check(D(sim).v[1] > 2.5, `climb stick gave vy=${D(sim).v[1].toFixed(2)}`);
  return 'ok';
});

await test('acro: full-stick roll rate reaches 670 deg/s', () => {
  const sim = createSim(flat, { ...calm, flightMode: 2 });
  hoverAt(sim, 200);
  const hs = D(sim).FIVE[D(sim).A_HOVER];
  let maxW = 0, t90 = -1;
  run(sim, 0.6, 0, 2 * hs - 1, 1, 0, (t) => {
    const w = Math.abs(D(sim).w[2]) / DEG;
    if (w > maxW) maxW = w;
    if (t90 < 0 && w > 0.9 * 670) t90 = t;
  });
  const wEnd = Math.abs(D(sim).w[2]) / DEG;
  return [within('steady roll rate', wEnd, 655, 685, ' deg/s'), within('peak', maxW, 655, 720, ' deg/s'), within('time to 90%', t90, 0.04, 0.2, ' s')].join(', ');
});

await test('acro: a full roll at hover throttle loses a plausible amount of altitude', () => {
  const sim = createSim(flat, { ...calm, flightMode: 2 });
  hoverAt(sim, 200);
  const d = D(sim);
  const hs = d.FIVE[d.A_HOVER];
  const y0 = d.p[1];
  let ang = 0, t = 0;
  while (ang < 2 * Math.PI - 0.15 && t < 3) { run(sim, DT, 0, 2 * hs - 1, 1, 0); ang += Math.abs(d.w[2]) * DT; t += DT; }
  const lossAtEnd = y0 - d.p[1];
  run(sim, 0.4, 0, 2 * hs - 1, 0, 0);
  const up = 1 - 2 * (d.q[0] ** 2 + d.q[2] ** 2);
  return [within('roll time', t, 0.5, 0.9, ' s'), within('altitude lost', lossAtEnd, 0.6, 3.5, ' m'), within('level after', up, 0.9, 1)].join(', ');
});

await test('acro: level full-throttle top speed of the 5-inch', () => {
  // full throttle; a simple outer loop pitches the nose down further when climbing (holds altitude with pitch)
  const sim = createSim(flat, { ...calm, flightMode: 2 });
  hoverAt(sim, 400);
  const d = D(sim);
  let vmax = 0, ymin = 1e9, ymax = -1e9;
  for (let i = 0; i < 240 * 20; i++) {
    const fy = -2 * (d.q[1] * d.q[2] - d.q[3] * d.q[0]);
    const pitch = Math.asin(Math.max(-1, Math.min(1, fy))); // nose up +
    const want = Math.max(-88, Math.min(-45, -70 - (d.p[1] - 400) * 2 - d.v[1] * 3)) * DEG;
    const rate = Math.max(-1, Math.min(1, (want - pitch) * 2.0));
    sim.setXRSticks(0, 1, 0, -rate); sim.step(DT);
    if (i > 240 * 12) { vmax = Math.max(vmax, speedH(d)); ymin = Math.min(ymin, d.p[1]); ymax = Math.max(ymax, d.p[1]); }
  }
  check(ymax - ymin < 40, `altitude not held (${ymin.toFixed(0)}..${ymax.toFixed(0)})`);
  return within('top speed', vmax, 33, 48, ' m/s') + ` (${(vmax * 3.6).toFixed(0)} km/h)`;
});

await test('physics: free fall and terminal velocity', () => {
  const sim = createSim(flat, { ...calm, flightMode: 1 });
  hoverAt(sim, 3000);
  const d = D(sim);
  for (let i = 0; i < 4; i++) d.m[i] = 0;
  const y0 = d.p[1];
  run(sim, 1, 0, -1);
  const drop = y0 - d.p[1];
  run(sim, 30, 0, -1);
  const vt = -d.v[1];
  const v1 = vt; run(sim, 1, 0, -1); const acc = Math.abs(-d.v[1] - v1);
  return [within('drop in 1 s', drop, 3.9, 4.95, ' m'), within('terminal', vt, 10, 30, ' m/s'), within('accel at terminal', acc, 0, 0.3, ' m/s^2')].join(', ');
});

await test('crash on hard impact, tumble 1.5 s, respawn at last safe hover', () => {
  const sim = createSim(flat, { ...calm, flightMode: 1 });
  hoverAt(sim, 45);
  const d = D(sim);
  run(sim, 1.0, 0, 2 * d.CAMERA[d.A_HOVER] - 1); // a safe hover is recorded
  const sx = d.safeP[0], sy = d.safeP[1];
  let crashedAt = -1;
  run(sim, 6, 0, -1, 0, 0, (t) => { if (crashedAt < 0 && d.st.crashed) crashedAt = t; });
  check(crashedAt > 0, 'never crashed');
  check(d.st.crashes === 1, `crashes = ${d.st.crashes}`);
  check(d.st.respawns === 1, `respawns = ${d.st.respawns}`);
  check(!d.st.crashed, 'still crashed');
  check(Math.abs(d.safeP[0] - sx) < 1 && d.safeP[1] > 20 + 2.9, 'respawn point is not the safe hover');
  return `impact ${d.S[d.S_LASTIMPACT].toFixed(1)} m/s at t=${crashedAt.toFixed(2)} s; respawned at y=${sy.toFixed(1)}`;
});

await test('gps: gentle landing from full descent, then take off again', () => {
  const sim = createSim(flat, calm);
  hoverAt(sim, 40);
  const d = D(sim);
  let maxImpact = 0;
  run(sim, 15, 0, -1, 0, 0, () => { if (d.st.landed) maxImpact = Math.max(maxImpact, d.S[d.S_LASTIMPACT]); });
  check(d.st.landed === 1, 'not landed');
  check(d.st.crashes === 0, 'crashed while landing');
  run(sim, 3, 0, 0.7);
  check(d.p[1] > 25, `did not take off (y=${d.p[1].toFixed(1)})`);
  return within('touchdown speed', maxImpact, 0, 1.0, ' m/s');
});

await test('gps: clearance assist climbs over rising ground', () => {
  const wall = { heightAt: (x) => (x > 100 ? Math.min(80, (x - 100) * 0.7) : 0) + 20, CURATED };
  const sim = createSim(wall, calm);
  const d = D(sim);
  place(sim, 0, 25, 0, -Math.PI / 2); // facing +X
  let minClr = 1e9;
  run(sim, 40, 0, 0, 0, 1, () => { minClr = Math.min(minClr, d.p[1] - wall.heightAt(d.p[0])); });
  return [within('crashes', d.st.crashes, 0, 0), within('x reached', d.p[0], 300, 1e9, ' m'), within('min clearance', minClr, 1.0, 1e9, ' m')].join(', ');
});

await test('angle: gentle landing allowed, hard landing crashes', () => {
  // gentle: from 1.5 m with the stick a little under hover
  let sim = createSim(flat, { ...calm, flightMode: 1 });
  hoverAt(sim, 21.5);
  let d = D(sim);
  const hs = d.CAMERA[d.A_HOVER];
  let impact = 0;
  run(sim, 5, 0, 2 * (hs - 0.06) - 1, 0, 0, () => { if (d.st.landed && !impact) impact = d.S[d.S_LASTIMPACT]; });
  check(d.st.landed === 1 && d.st.crashes === 0, `gentle: landed=${d.st.landed} crashes=${d.st.crashes}`);
  // hard: throttle cut at 8 m
  sim = createSim(flat, { ...calm, flightMode: 1 });
  hoverAt(sim, 28);
  d = D(sim);
  run(sim, 3, 0, -1);
  check(d.st.crashes === 1, `hard: crashes=${d.st.crashes}`);
  return `gentle touchdown at ${impact.toFixed(2)} m/s, hard impact ${d.S[d.S_LASTIMPACT].toFixed(1)} m/s crashed`;
});

await test('stick modes 1-4 route physical sticks to the right channels', () => {
  const sim = createSim(flat, calm);
  const IN = sim._dbg.IN;
  // physical LX, LY, RX, RY
  const vals = [0.1, 0.2, 0.3, 0.4];
  const expect = { 1: [0.4, 0.1, 0.2, 0.3], 2: [0.2, 0.1, 0.4, 0.3], 3: [0.4, 0.3, 0.2, 0.1], 4: [0.2, 0.3, 0.4, 0.1] }; // [thr, yaw, pitch, roll]
  for (let m = 1; m <= 4; m++) {
    IN.setStickMode(m);
    IN.setXR(...vals);
    IN.ARG[0] = 1 / 60;
    IN.poll(false);
    for (let c = 0; c < 4; c++) check(Math.abs(IN.chan[c] - expect[m][c]) < 1e-6, `mode ${m} channel ${c}: ${IN.chan[c]} != ${expect[m][c]}`);
  }
  // behavioural: in mode 1 the right stick vertical is throttle/climb
  IN.setStickMode(1);
  const s2 = createSim(flat, calm);
  hoverAt(s2, 50);
  s2._dbg.IN.setStickMode(1);
  run(s2, 2, 0, 0, 0, 0.8);
  check(D(s2).v[1] > 2.5 && Math.hypot(D(s2).v[0], D(s2).v[2]) < 0.5, 'mode 1: right stick up did not climb');
  s2._dbg.IN.setStickMode(2);
  return 'modes 1-4 ok';
});

await test('acro: Betaflight actual rates curve (70 / 670 / 0.3)', () => {
  const sim = createSim(flat, calm);
  const IN = sim._dbg.IN;
  const r1 = IN.actualRate(1, 70, 670, 0.3), r0 = IN.actualRate(0.001, 70, 670, 0.3) / 0.001, rh = IN.actualRate(0.5, 70, 670, 0.3);
  return [within('full', r1, 669.9, 670.1, ' deg/s'), within('centre sensitivity', r0, 69.5, 70.5, ' deg/s per unit'), within('half stick', rh, 140, 146, ' deg/s')].join(', ');
});

await test('rings: course is deterministic, 8-40 m above ground, gentle', () => {
  const a = createSim(ramp, calm);
  const R = a._dbg.R;
  const n = R.info[0];
  const copy = Float32Array.from(R.course.subarray(0, n * 8));
  createSim(ramp, calm);
  check(R.info[0] === n, 'ring count differs between builds');
  for (let i = 0; i < n * 8; i++) check(R.course[i] === copy[i], 'course differs between builds');
  let minC = 1e9, maxC = -1e9, maxTurn = 0;
  for (let i = 0; i < n; i++) {
    const x = R.course[i * 8], y = R.course[i * 8 + 1], z = R.course[i * 8 + 2];
    const c = y - Math.max(0, ramp.heightAt(x, z));
    minC = Math.min(minC, c); maxC = Math.max(maxC, c);
    if (i > 1 && Math.hypot(x - R.course[(i - 1) * 8], z - R.course[(i - 1) * 8 + 2]) < 400 && Math.hypot(R.course[(i - 1) * 8] - R.course[(i - 2) * 8], R.course[(i - 1) * 8 + 2] - R.course[(i - 2) * 8 + 2]) < 400) {
      const h1 = Math.atan2(x - R.course[(i - 1) * 8], z - R.course[(i - 1) * 8 + 2]);
      const h0 = Math.atan2(R.course[(i - 1) * 8] - R.course[(i - 2) * 8], R.course[(i - 1) * 8 + 2] - R.course[(i - 2) * 8 + 2]);
      let dh = Math.abs(h1 - h0); if (dh > Math.PI) dh = 2 * Math.PI - dh;
      maxTurn = Math.max(maxTurn, dh / DEG);
    }
  }
  check(n > 60, `only ${n} rings`);
  return [`${n} rings`, within('min clearance', minC, 8, 40, ' m'), within('max clearance', maxC, 8, 40, ' m'), within('max turn per ring', maxTurn, 0, 14, ' deg')].join(', ');
});

await test('rings: a GPS-mode autopilot flies through them and they advance', () => {
  const sim = createSim(ramp, calm);
  const R = sim._dbg.R, d = D(sim);
  sim.sport = 1;
  const start = R.info[4];
  let t = 0;
  while (R.info[4] - start < 15 && t < 240) {
    const i = R.info[1], o = i * 8;
    const cx = R.course[o], cy = R.course[o + 1], cz = R.course[o + 2];
    // aim at the ring, then (once lined up) at a point 6 m past it along its normal so we cross it square
    const near = Math.hypot(cx - d.p[0], cz - d.p[2]) < 15 && Math.abs(cy - d.p[1]) < 2;
    const ax = cx + R.course[o + 3] * (near ? 6 : -4), az = cz + R.course[o + 5] * (near ? 6 : -4);
    const dx = ax - d.p[0], dz = az - d.p[2];
    const bear = Math.atan2(-dx, -dz), psi = sim.info[6];
    let e = bear - psi; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
    const yaw = Math.max(-1, Math.min(1, -e * 2.5));
    const dist = Math.hypot(dx, dz);
    const fwd = Math.max(0, Math.min(1, dist / 30)) * Math.max(0, Math.cos(e)) * Math.max(0.15, 1 - Math.abs(cy - d.p[1]) / 12);
    const climb = Math.max(-1, Math.min(1, (cy - d.p[1]) * 0.4));
    // lateral correction relative to heading
    const right = Math.max(-1, Math.min(1, Math.sin(-e) * dist * 0.1));
    sim.setXRSticks(yaw, climb, right, fwd);
    sim.step(1 / 60); t += 1 / 60;
  }
  const passed = R.info[4] - start;
  check(passed >= 15, `only ${passed} rings in ${t.toFixed(0)} s`);
  check(sim.ringNextSlot >= 0 && sim.rings[sim.ringNextSlot * 8 + 7] === 1, 'next ring slot does not hold state 1');
  check(sim.rings[(sim.ringNextSlot - 1) * 8 + 7] === 2, 'previous ring is not marked passed');
  return `${passed} rings in ${t.toFixed(0)} s, crashes ${d.st.crashes}`;
});

await test('stability: 10 simulated minutes of random sticks in all modes', () => {
  const sim = createSim(ramp, { wind: [5, 1, 0.5] });
  const d = D(sim);
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const s = [0, 0, 0, 0], tgt = [0, 0, 0, 0];
  let maxV = 0, maxW = 0, maxY = 0;
  const steps = 600 * 60;
  for (let i = 0; i < steps; i++) {
    if (i % 30 === 0) for (let k = 0; k < 4; k++) tgt[k] = rnd() * 2 - 1;
    if (i % 3600 === 0) sim.flightMode = (i / 3600) % 3;
    for (let k = 0; k < 4; k++) s[k] += (tgt[k] - s[k]) * 0.2;
    sim.setXRSticks(s[0], s[1], s[2], s[3]);
    sim.sport = (i >> 12) & 1;
    sim.step(1 / 60);
    const v = Math.hypot(d.v[0], d.v[1], d.v[2]), w = Math.hypot(d.w[0], d.w[1], d.w[2]);
    check(Number.isFinite(v) && Number.isFinite(d.p[1]) && Number.isFinite(d.q[3]), `non-finite state at step ${i}`);
    maxV = Math.max(maxV, v); maxW = Math.max(maxW, w); maxY = Math.max(maxY, d.p[1]);
  }
  const qn = Math.hypot(d.q[0], d.q[1], d.q[2], d.q[3]);
  return [within('max speed', maxV, 0, 60, ' m/s'), within('max body rate', maxW / DEG, 0, 2500, ' deg/s'), within('max altitude', maxY, 0, 2500, ' m'),
    within('|q|', qn, 0.999999, 1.000001), `crashes ${d.st.crashes}`].join(', ');
});

await test('zero allocations in sim.step (20,000 steps after warm-up)', async () => {
  if (typeof globalThis.gc !== 'function') throw new Error('run with: node --expose-gc tools/simtest.mjs');
  // the world the renderer should provide: heightBatch(xz, n, out) next to heightAt (see API.md)
  const world = {
    heightAt: ramp.heightAt,
    heightBatch(xz, n, out) { for (let i = 0; i < n; i++) { const x = xz[2 * i], z = xz[2 * i + 1]; out[i] = 20 + (x > 300 ? (x - 300) * 0.12 : 0) + Math.min(60, Math.abs(z) * 0.05) - (x > 2000 ? (x - 2000) * 0.1 : 0); } },
    CURATED,
  };
  const sim = createSim(world, { wind: [5, 1, 0.5] });
  // stick values and frame times are boxed up front, as a renderer's gamepad/XR/rAF values already are
  const V = [{}]; V.length = 0;
  for (let i = 0; i < 1024; i++) V.push(Math.sin(i * 0.37) * 0.9);
  const DTS = [{}]; DTS.length = 0; DTS.push(1 / 60, 1 / 60 + 0.002, 1 / 72, 1 / 90, 1 / 144);
  let k = 0;
  const loop = (n) => {
    for (let i = 0; i < n; i++) {
      k++;
      const j = k & 1023;
      sim.setXRSticks(V[j], V[(j + 101) & 1023], V[(j + 211) & 1023], V[(j + 307) & 1023]);
      if (k % 4000 === 0) sim.flightMode = (sim.flightMode + 1) % 3;
      if (k % 3000 === 0) sim.cameraMode = (sim.cameraMode + 1) % 3;
      sim.boost = (k >> 11) & 1;
      sim.step(DTS[k % 5]);
    }
  };
  // warm-up: every flight mode x sport x boost x camera combination, twice, so all branches have type feedback
  // and are optimised (a deopt on a first-seen branch runs a few frames in V8's baseline tiers, which box doubles)
  for (let rep = 0; rep < 2; rep++)
    for (let fm = 0; fm < 3; fm++) for (let sp = 0; sp < 2; sp++) for (let bo = 0; bo < 2; bo++) for (let cm = 0; cm < 3; cm++) {
      sim.flightMode = fm; sim.sport = sp; sim.cameraMode = cm;
      for (let i = 0; i < 1500; i++) {
        k++; const j = k & 1023;
        sim.setXRSticks(V[j], V[(j + 101) & 1023], V[(j + 211) & 1023], V[(j + 307) & 1023]);
        sim.boost = bo; sim.step(DTS[k % 5]);
      }
      if (fm === 0 && bo === 1) sim.teleport(0, 0); // come back from a 120 m/s transit
    }
  sim.sport = 0;
  loop(20000);
  globalThis.gc(); globalThis.gc();
  const gcs = [];
  const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) gcs.push(e); });
  obs.observe({ entryTypes: ['gc'] });
  const h0 = process.memoryUsage().heapUsed;
  loop(20000);
  const h1 = process.memoryUsage().heapUsed;
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  const grow = h1 - h0;
  check(grow < 64 * 1024, `heapUsed grew by ${(grow / 1024).toFixed(1)} KB over 20,000 steps`);
  check(gcs.length === 0, `${gcs.length} garbage collections ran during the loop (allocation)`);
  return `heap growth ${(grow / 1024).toFixed(1)} KB, ${gcs.length} GCs during 20,000 steps (~${Math.round(20000 * 0.0157 * 240 / 1000)}k substeps)`;
});

const failed = results.filter((r) => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
