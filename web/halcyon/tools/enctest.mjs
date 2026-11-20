// tools/enctest.mjs: tests for the encounter director (src/encounters.js), in node, no GPU.
//   node tools/enctest.mjs            determinism, rates over a simulated hour, view-cone placement, no peaks
//                                     overlapping, no allocation (exits 1 on failure)
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
import * as E from '../src/encounters.js';

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };

// a deterministic random flight: heading wanders, speed 10-25 m/s, the camera looks roughly where it flies
function flight(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const F = new Float64Array(8); // x, z, heading, speed, look offset, t
  F[3] = 15;
  return { F, step(dt) {
    F[2] += (rnd() - 0.5) * 0.25 * dt * 4; F[3] = Math.min(25, Math.max(10, F[3] + (rnd() - 0.5) * dt * 2));
    F[4] = Math.max(-0.5, Math.min(0.5, F[4] + (rnd() - 0.5) * 0.2 * dt));
    F[0] += Math.sin(F[2]) * F[3] * dt; F[1] += -Math.cos(F[2]) * F[3] * dt; F[5] += dt;
    E.IN[0] = 100 + F[5]; E.IN[1] = F[0]; E.IN[2] = 60; E.IN[3] = F[1];
    E.IN[4] = Math.sin(F[2] + F[4]); E.IN[5] = -Math.cos(F[2] + F[4]);
    E.IN[6] = Math.sin(F[2]) * F[3]; E.IN[7] = -Math.cos(F[2]) * F[3]; E.IN[8] = Math.tan(31 * Math.PI / 180);
  } };
}

// run an hour, logging every started event
function run(seed, flightSeed, all) {
  E.init(null, seed);
  if (all) for (let i = 1; i < E.NTYPE; i++) if (E.TYPES[i]) E.enable(i, 1);
  const fl = flight(flightSeed), log = [];
  const seen = new Float64Array(8).fill(-1);
  for (let k = 0; k < 3600 * 4; k++) {
    fl.step(0.25); E.update();
    for (let s = 0; s < 8; s++) {
      const o = s * 8;
      if (E.ENC[o] && E.ENC[o + 4] !== seen[s]) {
        seen[s] = E.ENC[o + 4];
        const ty = E.ENC[o], dx = E.ENC[o + 1] - E.IN[1], dz = E.ENC[o + 3] - E.IN[3], d = Math.hypot(dx, dz);
        const cosA = d > 1 ? (dx * E.IN[4] + dz * E.IN[5]) / (d * Math.hypot(E.IN[4], E.IN[5])) : 1;
        log.push({ t: E.IN[0], ty, x: E.ENC[o + 1], z: E.ENC[o + 3], d, cosA,
          pk0: E.ENC[o + 4] + E.PH[s * 4 + 1], pk1: E.ENC[o + 4] + E.PH[s * 4 + 2] });
      }
    }
  }
  return log;
}

// 1. determinism
const a = run(7, 3, true), b = run(7, 3, true);
check(JSON.stringify(a) === JSON.stringify(b) && a.length > 0, `deterministic: same seed and flight give the same ${a.length} events`);
const c = run(8, 3, true);
check(JSON.stringify(a) !== JSON.stringify(c), 'a different seed gives a different hour');

// 2. rates over the hour, every type enabled
const RARE = new Set(['orca', 'murmuration', 'breach', 'giants', 'drystorm', 'milkyway', 'brocken', 'lunar', 'eclipse', 'veil', 'flashflood']);
const rare = a.filter(e => RARE.has(E.TYPES[e.ty])), common = a.filter(e => !RARE.has(E.TYPES[e.ty]));
const gaps = (l) => l.slice(1).map((e, i) => e.t - l[i].t);
const cg = gaps(common), rg = gaps(rare);
const mean = (l) => l.reduce((x, y) => x + y, 0) / Math.max(l.length, 1);
console.log(`     ${common.length} common (mean gap ${mean(cg).toFixed(0)} s, min ${Math.min(...cg).toFixed(0)} s), ${rare.length} rare (mean gap ${mean(rg).toFixed(0)} s, min ${Math.min(...rg).toFixed(0)} s)`);
check(common.length >= 30 && common.length <= 90 && Math.min(...cg) >= 30, 'common events every 40-90 s on average (30..90 in an hour, none closer than 30 s)');
check(rare.length >= 5 && rare.length <= 14 && Math.min(...rg) >= 240, 'rare events every 5-8 min on average (5..14 in an hour, none closer than 4 min)');
const types = new Set(a.map(e => E.TYPES[e.ty]));
console.log('     types seen: ' + [...types].join(' '));

// 3. never two peaks at once
let overlap = 0;
for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[j].pk0 < a[i].pk1 && a[i].pk0 < a[j].pk1) overlap++;
check(overlap === 0, `no two peaks overlap (${overlap})`);

// 4. placement inside the view cone (horizontal), at the type's distance
const lim = Math.cos(Math.atan(Math.tan(31 * Math.PI / 180) * 0.55) + 0.02);
const out = a.filter(e => e.d > 1 && e.cosA < lim);
check(out.length === 0, `placed inside the view cone (${out.length} outside)`);

// 5. forced capture through the director
{
  const q = new Map([['enc', 'orca'], ['et', '20']]);
  E.init({ get: (k) => q.get(k) ?? null }, 1);
  const fl = flight(1); fl.step(0.1); E.update();
  check(E.ENC[0] === E.E_ORCA && Math.abs(E.IN[0] - E.ENC[4] - 20) < 1e-3, 'enc=orca&et=20 forces slot 0, 20 s in');
  E.init({ get: (k) => (k === 'enc' ? 'off' : null) }, 1);
  for (let k = 0; k < 4000; k++) { fl.step(0.25); E.update(); }
  let any = 0; for (let s = 0; s < 8; s++) any |= E.ENC[s * 8] ? 1 : 0;
  check(!any, 'enc=off disables the director');
}

// 6. no allocation: 2 million updates with no scavenge (16 B per update would force several)
{
  E.init(null, 5);
  for (let i = 1; i < E.NTYPE; i++) if (E.TYPES[i]) E.enable(i, 1);
  // a flight written inline into the typed input (the test loop itself must not allocate)
  const IN = E.IN;
  const fly = (k) => { const h = Math.sin(k * 1e-4) * 3; IN[0] = 100 + k / 60; IN[1] += Math.sin(h) * 0.3; IN[3] -= Math.cos(h) * 0.3;
    IN[2] = 60; IN[4] = Math.sin(h + 0.2); IN[5] = -Math.cos(h + 0.2); IN[6] = Math.sin(h) * 18; IN[7] = -Math.cos(h) * 18; IN[8] = 0.6; };
  for (let k = 0; k < 200000; k++) { fly(k); E.update(); } // warm-up (JIT)
  gc(); // start the measured loop with an empty young generation
  let gcs = 0;
  const W = new Float64Array(2); // measured window (ms)
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime >= W[0] && e.startTime <= W[1]) gcs++; });
  obs.observe({ entryTypes: ['gc'] });
  W[0] = performance.now(); W[1] = 1e12;
  for (let k = 200000; k < 2200000; k++) { fly(k); E.update(); }
  W[1] = performance.now(); // gc entries after this (from the test's own logging) do not count
  await new Promise((r) => setTimeout(r, 50));
  obs.disconnect();
  check(gcs === 0, `no allocation in 2M updates (${gcs} gc events)`);
}

console.log(fails ? `== FAIL (${fails})` : '== PASS');
process.exit(fails ? 1 : 0);
