// dynres.js: the dynamic-resolution controller (perf.js feeds it GPU frame times from the timestamp readback).
// No GPU or DOM imports: tools/dyntest.mjs drives it in node with synthetic GPU-time feeds.
import { CLK, C_DT, C_FRAME_MS } from './clock.js';

// Holds a GPU-time target by scaling the internal render targets between MIN and MAX in STEP steps.
// Hysteresis: step down after DOWN_HOLD s over target; step up only after upHold s under UP_FRAC of target, where the
// predicted time at the larger scale also fits. A step up that is followed by a step down within 4 s doubles upHold
// (up to 64 s), so the controller settles instead of oscillating. Samples from frames rendered before a change are
// ignored. Without timestamps (timer = false) the frame delta is used against vsyncTarget (60 Hz by default; an XR session
// sets it from its display rate).
export const dyn = {
  enabled: false, timer: false, target: 11, vsyncTarget: 17.5, scale: 1, MIN: 0.6, MAX: 1, STEP: 0.05, changes: 0,
  minSeen: 1, scaleSum: 0, scaleN: 0,
  over: 0, under: 0, cool: 0, upHold: 2, lastUp: -1e9, ignoreBefore: 0, ema: 0, emaN: 0, pending: 0, now: 0,
  sample(ms, frame) {
    if (!this.enabled || frame < this.ignoreBefore) return;
    this.ema = this.emaN < 4 ? ms : this.ema + (ms - this.ema) * 0.15;
    this.emaN++;
  },
  // once per frame (dt and the frame delta from the clock). Returns 1 when the scale changed (the caller rebuilds the targets).
  tick(frame) {
    if (!this.enabled) return 0;
    const dt = CLK[C_DT], frameMs = CLK[C_FRAME_MS];
    this.now += dt;
    this.scaleSum += this.scale; this.scaleN++;
    if (!this.timer && frameMs > 0) this.sample(frameMs, frame);
    if (this.emaN < 8) return 0;
    if (this.cool > 0) { this.cool -= dt; return 0; }
    const t = this.timer ? this.target : this.vsyncTarget; // no GPU timer: hold vsync
    const s = this.scale, up = s + this.STEP;
    const predicted = this.ema * (up * up) / (s * s);
    if (this.ema > t * 1.04) { this.over += dt; this.under = 0; }
    else if (this.ema < t * 0.82 && predicted < t * 0.95) { this.under += dt; this.over = 0; }
    else { this.over = 0; this.under = 0; }
    let ns = s;
    if (this.over > 0.3 && s > this.MIN + 1e-6) {
      ns = s - (this.ema > t * 1.35 ? 2 : 1) * this.STEP;
      if (this.now - this.lastUp < 4) this.upHold = Math.min(64, this.upHold * 2);
    } else if (this.under > this.upHold && s < this.MAX - 1e-6) {
      ns = up; this.lastUp = this.now;
    }
    if (ns === s) return 0;
    ns = Math.round(Math.min(this.MAX, Math.max(this.MIN, ns)) * 20) / 20;
    this.scale = ns; this.changes++;
    if (ns < this.minSeen) this.minSeen = ns;
    this.over = 0; this.under = 0; this.emaN = 0; this.cool = 0.75;
    this.ignoreBefore = frame + 2;
    return 1;
  },
  meanScale() { return this.scaleN ? Math.round((this.scaleSum / this.scaleN) * 1000) / 1000 : this.scale; },
};
