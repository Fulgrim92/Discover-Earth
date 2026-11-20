// perf.js: GPU pass timing (timestamp-query) read back without per-frame allocation, frame statistics for
// ?bench=1, and the dynamic-resolution controller.
//
// Timer: every frame writes begin/end timestamps of each timed pass (gpu.js TS_*) into a ring of TS_SLOTS frame
// slots and resolves its slot into one resolve buffer. Every READ_EVERY frames the finished half of the ring is
// copied into one of two preallocated readback buffers and mapped. mapAsync()/then() return promises and
// getMappedRange() returns a fresh ArrayBuffer: those are platform allocations we cannot avoid, so they happen once
// per READ_EVERY frames (about 4 times a second at 60 Hz), never per frame. Without timestamp-query the frame
// delta drives the controller instead.
import { G, TS, TS_N, TS_SLOTS, TS_PER_FRAME, TS_PASSES, TS_ONCE, TS_FRAME_Q } from './gpu.js';
import { dyn } from './dynres.js';

export const READ_EVERY = TS_SLOTS / 2;
const HALF_Q = READ_EVERY * TS_PER_FRAME;   // queries per half ring
const HALF_BYTES = HALF_Q * 8;

const P = {
  resolve: null, read: [null, null], state: new Uint8Array(2), // 0 idle, 1 copy queued, 2 mapping
  onMapped: [null, null], half: new Int32Array(2), // which ring half each readback buffer holds
  frameOfSlot: new Int32Array(TS_SLOTS), views: new Uint8Array(TS_SLOTS), ran: new Uint8Array(TS_SLOTS * TS_N),
};
// latest per-frame GPU timings (ms): pass i of the most recent complete frame, plus totals
export const gpuMs = new Float64Array(TS_N + 2);  // [passes..., sum of passes, whole frame (first pass begin -> last pass end)]
export const stats = { gpuFrames: 0, lastGpuFrame: -1, readbacks: 0, dropped: 0, invalid: 0, lastBad: new Float64Array(3) };

// bench recording: per frame [cpu frame delta ms, cpu work ms, gpu frame ms, gpu sum of passes ms, gpu pass ms x TS_N]
export const REC_W = 4 + TS_N;
let rec = null, recN = 0, recMax = 0;
const recFrameIdx = new Int32Array(1); // frame index of record 0

export function initTimer() {
  if (!G.timestamp) return;
  const U = GPUBufferUsage;
  P.resolve = G.device.createBuffer({ size: TS_SLOTS * TS_PER_FRAME * 8, usage: U.QUERY_RESOLVE | U.COPY_SRC, label: 'tsResolve' });
  for (let h = 0; h < 2; h++) {
    P.read[h] = G.device.createBuffer({ size: HALF_BYTES, usage: U.MAP_READ | U.COPY_DST, label: 'tsRead' + h });
    // named wrappers (not arrows): when V8 inlines onMapped into its caller, the readback's platform ArrayBuffer is
    // attributed to the caller, and tools/alloc.mjs keys sites by function name (onMapped0/1 -> onMapped)
    P.onMapped[h] = h === 0 ? onMapped0 : onMapped1;
  }
}
function onMapped0() { onMapped(0); }
function onMapped1() { onMapped(1); }

// call once per frame before encoding: which passes will run, and in how many views
export function frameBegin(frameNo, nViews) {
  const slot = frameNo % TS_SLOTS;
  if (GD.on) guardBegin();
  P.frameOfSlot[slot] = frameNo; P.views[slot] = nViews;
  for (let i = 0; i < TS_N; i++) P.ran[slot * TS_N + i] = 0;
  return slot;
}
export function markRan(slot, pass) { P.ran[slot * TS_N + pass] = 1; }

// after the last pass of the frame: resolve this slot, and when a half of the ring is complete, copy it out
export function frameEnd(enc, slot) {
  if (GD.on) guardEnd(slot);
  if (!P.resolve) return;
  enc.resolveQuerySet(TS.set, slot * TS_PER_FRAME, TS_PER_FRAME, P.resolve, slot * TS_PER_FRAME * 8);
  if ((slot + 1) % READ_EVERY !== 0) return;
  const half = slot < READ_EVERY ? 0 : 1;
  // ping-pong between the two readback buffers; if both are busy (GPU far behind), drop this half
  let h = -1;
  if (P.state[0] === 0) h = 0; else if (P.state[1] === 0) h = 1;
  if (h < 0) { stats.dropped++; return; }
  enc.copyBufferToBuffer(P.resolve, half * HALF_BYTES, P.read[h], 0, HALF_BYTES);
  P.state[h] = 1; P.half[h] = half;
}
// after submit: start the maps that were queued this frame (platform allocation: one promise chain per map)
export function afterSubmit() {
  for (let h = 0; h < 2; h++) {
    if (P.state[h] !== 1) continue;
    P.state[h] = 2;
    P.read[h].mapAsync(GPUMapMode.READ).then(P.onMapped[h], P.onMapped[h]);
  }
}

function onMapped(h) {
  const buf = P.read[h];
  if (buf.mapState !== 'mapped') { P.state[h] = 0; return; }
  const q = new Uint32Array(buf.getMappedRange(0, HALF_BYTES)); // platform: new ArrayBuffer + view per map
  const s0 = P.half[h] * READ_EVERY;
  for (let k = 0; k < READ_EVERY; k++) {
    const slot = s0 + k, nv = P.views[slot];
    let total = 0, ok = 1;
    for (let i = 0; i < TS_N; i++) {
      let ms = 0;
      if (P.ran[slot * TS_N + i]) {
        const nvi = (TS_ONCE >> i) & 1 ? 1 : nv; // once-per-frame passes live in view 0's block
        for (let v = 0; v < nvi; v++) {
          const o = (k * TS_PER_FRAME + v * TS_N * 2 + i * 2) * 2;
          const b = q[o + 1] * 4294967296 + q[o], e = q[o + 3] * 4294967296 + q[o + 2];
          const d = (e - b) * 1e-6;
          if (d >= 0 && d < 60000) ms += d; // (a software GPU can take seconds per pass)
          else { ok = 0; stats.lastBad[0] = i; stats.lastBad[1] = b; stats.lastBad[2] = e; }
        }
      }
      gpuMs[i] = ms; total += ms;
    }
    gpuMs[TS_N] = total;
    // the frame bracket (gpu.js tsFrameOpen/Close): what the GPU spent on the frame, gaps between passes included
    const of = (k * TS_PER_FRAME + TS_FRAME_Q) * 2;
    const fb = q[of + 1] * 4294967296 + q[of], fe = q[of + 3] * 4294967296 + q[of + 2];
    const fms = (fe - fb) * 1e-6;
    if (fms >= 0 && fms < 60000 && fms >= total * 0.999) gpuMs[TS_N + 1] = fms;
    else { ok = 0; stats.lastBad[0] = TS_N; stats.lastBad[1] = fb; stats.lastBad[2] = fe; }
    if (!ok) { stats.invalid++; continue; }
    const f = P.frameOfSlot[slot];
    if (f > stats.lastGpuFrame) stats.lastGpuFrame = f;
    stats.gpuFrames++;
    dyn.sample(fms, f);
    if (rec) {
      const r = f - recFrameIdx[0];
      if (r >= 0 && r < recMax) {
        const o = r * REC_W;
        rec[o + 2] = fms; rec[o + 3] = total;
        for (let i = 0; i < TS_N; i++) rec[o + 4 + i] = gpuMs[i];
      }
    }
  }
  buf.unmap();
  P.state[h] = 0;
  stats.readbacks++;
}

// ------------------------------------------------------------------------------------------------ bench record
export function recordStart(frameNo, maxFrames) {
  rec = new Float64Array(maxFrames * REC_W).fill(NaN); recMax = maxFrames; recN = 0; recFrameIdx[0] = frameNo;
}
export function record(frameNo, frameMs, cpuMs) {
  if (!rec) return;
  const r = frameNo - recFrameIdx[0];
  if (r < 0 || r >= recMax) return;
  rec[r * REC_W] = frameMs; rec[r * REC_W + 1] = cpuMs;
  if (!G.timestamp) rec[r * REC_W + 2] = NaN;
  if (r + 1 > recN) recN = r + 1;
}
function summarise(col) {
  const a = [];
  for (let r = 0; r < recN; r++) { const v = rec[r * REC_W + col]; if (v === v) a.push(v); }
  if (!a.length) return null;
  a.sort((x, y) => x - y);
  const pick = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
  let sum = 0; for (const v of a) sum += v;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { avg: r3(sum / a.length), p50: r3(pick(0.5)), p99: r3(pick(0.99)), max: r3(a[a.length - 1]), n: a.length };
}
// (end of bench only: allocates)
export function benchReport(meta) {
  const passes = {};
  for (let i = 0; i < TS_N; i++) { const s = summarise(4 + i); if (s && s.max > 0) passes[TS_PASSES[i]] = s; }
  const errors = timerErrors();
  for (const e of errors) console.error('HALCYON_BENCH timer: ' + e);
  const frame = G.timestamp ? summarise(2) : null;
  return Object.assign({
    frames: recN,
    frameMs: summarise(0), cpuMs: summarise(1),
    // gpuFrameMs: the whole frame on the GPU (one timestamp pair: start of the first pass, end of the last), the
    // headline and what dynres reads. gpuPassSumMs: the sum of the timed passes; the difference is GPU time between
    // passes (barriers, copies, clears outside passes). gpuMs is kept as an alias of gpuFrameMs.
    gpuFrameMs: frame, gpuMs: frame, gpuPassSumMs: G.timestamp ? summarise(3) : null, gpuPassMs: G.timestamp ? passes : null,
    timer: G.timestamp ? 'timestamp-query' : 'none (frame delta only)',
    timerOk: errors.length === 0, timerErrors: errors,
    timerReadbacks: stats.readbacks, timerDropped: stats.dropped, timerInvalidFrames: stats.invalid, timerFrames: stats.gpuFrames,
    timerLastBad: stats.invalid ? { pass: stats.lastBad[0] < TS_N ? TS_PASSES[stats.lastBad[0]] : 'frame', begin: stats.lastBad[1], end: stats.lastBad[2] } : null,
    dynres: { enabled: dyn.enabled, target: dyn.target, finalScale: dyn.scale, changes: dyn.changes, minScale: dyn.minSeen, meanScale: dyn.meanScale() },
  }, meta);
}

// ------------------------------------------------------------------------------------------------ pass guard
// ?bench=1 only: every render/compute pass begun between frameBegin and frameEnd must be timed, either by its own
// timestampWrites or by lying inside an open bracket (a begin-only ... end-only pair of the same slot); a timed slot
// must be marked as ran (else its time is dropped from the report) and a slot marked as ran must have been timed. A
// violation is an error in the bench report (timerErrors, timerOk false) and fails tools/bench.mjs.
const GD = { on: false, active: false, frame: 0, open: new Uint8Array(TS_N), used: new Uint8Array(TS_N), errors: new Map() };
function guardErr(msg) { GD.errors.set(msg, (GD.errors.get(msg) || 0) + 1); }
function guardPass(desc) {
  if (!GD.active) return;
  const tw = desc && desc.timestampWrites;
  if (tw) {
    const hasB = tw.beginningOfPassWriteIndex !== undefined, hasE = tw.endOfPassWriteIndex !== undefined;
    const q = (hasB ? tw.beginningOfPassWriteIndex : tw.endOfPassWriteIndex) % TS_PER_FRAME;
    if (q >= TS_FRAME_Q) { GD.frame = hasB ? 1 : 2; return; }
    const i = (q % (TS_N * 2)) >> 1;
    GD.used[i] = 1;
    if (hasB && !hasE) GD.open[i] = 1; else if (hasE && !hasB) GD.open[i] = 0;
  } else {
    let any = 0;
    for (let i = 0; i < TS_N; i++) any |= GD.open[i];
    if (!any) guardErr('untimed pass "' + ((desc && desc.label) || '(no label)') + '"');
  }
  if (GD.frame !== 1) guardErr('pass "' + ((desc && desc.label) || '(no label)') + '" outside the frame bracket');
}
function guardBegin() { GD.active = true; GD.frame = 0; GD.open.fill(0); GD.used.fill(0); }
function guardEnd(slot) {
  GD.active = false;
  if (GD.frame !== 2) guardErr('frame bracket not closed');
  for (let i = 0; i < TS_N; i++) {
    const ran = P.ran[slot * TS_N + i];
    if (GD.open[i]) guardErr('timer bracket ' + TS_PASSES[i] + ' left open');
    if (GD.used[i] && !ran) guardErr('pass ' + TS_PASSES[i] + ' is timed but not marked as ran: its time is dropped (perf.markRan)');
    if (!GD.used[i] && ran) guardErr('pass ' + TS_PASSES[i] + ' is marked as ran but wrote no timestamps');
  }
}
export function guardInstall() {
  if (!G.timestamp || GD.on || typeof GPUCommandEncoder === 'undefined') return;
  GD.on = true;
  const E = GPUCommandEncoder.prototype, rp = E.beginRenderPass, cp = E.beginComputePass;
  E.beginRenderPass = function (d) { guardPass(d); return rp.call(this, d); };
  E.beginComputePass = function (d) { guardPass(d); return cp.call(this, d); };
}
function timerErrors() { const a = []; for (const [m, n] of GD.errors) a.push(m + ' (' + n + ' frames)'); return a; }

// ------------------------------------------------------------------------------------------------ dynamic resolution
// The controller lives in dynres.js (no GPU imports, so tools/dyntest.mjs runs it in node with synthetic timings).
export { dyn };
