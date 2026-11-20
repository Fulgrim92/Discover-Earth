// HALCYON dynamic-resolution controller test (src/dynres.js) with synthetic GPU-time feeds. No dependencies.
//   node tools/dyntest.mjs
// SwiftShader is far too slow to exercise the controller in a browser, so this drives it the way perf.js does:
// GPU times arrive in batches of 16 frames, 16 to 32 frames late (the timestamp readback ring), and each frame's GPU
// time scales with the pixel count of the scale it was rendered at.
import { dyn } from '../src/dynres.js';
import { CLK, C_DT, C_FRAME_MS } from '../src/clock.js';

const READ_EVERY = 16;
function reset(o) {
  Object.assign(dyn, {
    enabled: true, timer: true, target: 11, vsyncTarget: 17.5, scale: 1, changes: 0, minSeen: 1, scaleSum: 0, scaleN: 0,
    over: 0, under: 0, cool: 0, upHold: 2, lastUp: -1e9, ignoreBefore: 0, ema: 0, emaN: 0, now: 0,
  }, o || {});
}
// run `seconds` at `hz`; gpu(frame, scale) -> ms at that scale. Returns the scale trace (one entry per second).
function run(seconds, gpu, hz = 60) {
  const n = Math.round(seconds * hz), scaleAt = new Float64Array(n), trace = [];
  CLK[C_DT] = 1 / hz;
  for (let f = 0; f < n; f++) {
    scaleAt[f] = dyn.scale;
    const ms = gpu(f, dyn.scale);
    CLK[C_FRAME_MS] = dyn.timer ? 1000 / hz : Math.max(1000 / hz, ms);
    // readback: at the end of every 16th frame the previous complete half of the ring lands
    if (dyn.timer && (f + 1) % READ_EVERY === 0 && f >= 2 * READ_EVERY - 1) {
      for (let k = f - 2 * READ_EVERY + 1; k <= f - READ_EVERY; k++) dyn.sample(gpu(k, scaleAt[k]), k);
    }
    dyn.tick(f);
    if (f % hz === hz - 1) trace.push(dyn.scale);
  }
  return trace;
}
// GPU time model: fixed part plus a part proportional to pixels (scale^2)
const load = (full, fixed = 1) => (f, s) => fixed + (full - fixed) * s * s;
// deterministic noise (no Math.random: reruns give the same result)
let seed = 1;
const noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push(true); console.log('ok    ' + name + (note ? '  —  ' + note : '')); }
  catch (e) { results.push(false); console.log('FAIL  ' + name + '  —  ' + e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const changesIn = (tr, from) => { let c = 0; for (let i = from + 1; i < tr.length; i++) if (tr[i] !== tr[i - 1]) c++; return c; };

test('over budget: steps down and settles inside the target', () => {
  reset();
  const g = load(20), tr = run(120, g);
  const s = dyn.scale, t = g(0, s);
  assert(s < 1 && s >= dyn.MIN, 'scale ' + s);
  assert(t <= dyn.target * 1.04, 'settled GPU time ' + t.toFixed(2) + ' ms over target');
  assert(g(0, s + dyn.STEP) > dyn.target * 0.95 || s >= dyn.MAX, 'settled too low: next step up would also fit');
  assert(changesIn(tr, 30) === 0, 'still changing after 30 s: ' + tr.slice(30).join(','));
  return 'scale ' + s + ', ' + t.toFixed(2) + ' ms, ' + dyn.changes + ' changes';
});

test('reaches the floor under a load it cannot meet, never below MIN', () => {
  reset();
  run(60, load(60));
  assert(Math.abs(dyn.scale - dyn.MIN) < 1e-9, 'scale ' + dyn.scale);
  assert(dyn.minSeen >= dyn.MIN - 1e-9, 'went below MIN');
  return 'scale ' + dyn.scale;
});

test('light load: climbs back to full resolution', () => {
  reset({ scale: 0.6 });
  run(90, load(6));
  assert(dyn.scale === 1, 'scale ' + dyn.scale);
  return dyn.changes + ' steps up';
});

test('near the edge with 25% noise: no oscillation', () => {
  reset(); seed = 7;
  const tr = run(240, (f, s) => load(13)(f, s) * (1 + 0.5 * noise()));
  const late = changesIn(tr, 60);
  assert(late <= 2, late + ' changes after the first minute: ' + tr.join(','));
  return 'scale ' + dyn.scale + ', ' + dyn.changes + ' changes, upHold ' + dyn.upHold + ' s';
});

test('a single 100 ms spike does not change the scale', () => {
  reset();
  run(20, (f, s) => (f === 600 ? 100 : load(8)(f, s)));
  assert(dyn.scale === 1 && dyn.changes === 0, 'scale ' + dyn.scale + ', changes ' + dyn.changes);
});

test('load step mid-run (cloudy realm): follows down, then back up when it clears', () => {
  reset();
  const tr = run(150, (f, s) => load(f < 60 * 40 ? 8 : f < 60 * 90 ? 18 : 8)(f, s));
  const mid = tr[85];
  assert(mid < 0.85, 'did not step down for the heavy section: ' + mid);
  assert(dyn.scale === 1, 'did not recover: ' + dyn.scale);
  return 'heavy ' + mid + ', end ' + dyn.scale;
});

test('90 Hz XR budget (target 10 ms): settles inside it', () => {
  reset({ target: 10 });
  run(90, load(16), 90);
  assert(load(16)(0, dyn.scale) <= 10 * 1.04, 'scale ' + dyn.scale);
  return 'scale ' + dyn.scale;
});

test('no GPU timer: frame delta against the vsync target', () => {
  reset({ timer: false });
  run(60, load(30)); // 30 ms frames at full res: must drop
  const s = dyn.scale;
  assert(s < 0.85, 'scale ' + s);
  return 'scale ' + s;
});

test('disabled: never changes', () => {
  reset({ enabled: false });
  run(30, load(40));
  assert(dyn.scale === 1 && dyn.changes === 0, 'scale ' + dyn.scale);
});

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
