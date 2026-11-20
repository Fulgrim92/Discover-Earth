// lifefx.wgsl: encounter slots and water ripple sources shared by the living world and the water shader.
// Declare `@group(G) @binding(0) var<uniform> LFX: LifeFx;` (G = a free group, bound to lifeFx.bg from
// fx/lifefx.js) before including this file.
//   enc[2s]   = type, x, y, z        enc[2s+1] = t0, duration, seed, intensity     (8 slots; type 0 = empty)
//   rip[i]    = x, z, t0, strength   (16 sources; strength 0 = unused)
//   dir[s/2]  = travel direction of slot s in .xy (even s) or .zw (odd s); lfDir(s)
//   ph[s]     = end of cue, end of build-up, end of peak, end of afterimage (seconds after t0)
// Encounter type ids (src/encounters.js is the director and the list):
//   living world 1 orca pod, 2 murmuration, 3 flamingo take-off, 4 whale breach, 5 jelly gathering, 6 giants,
//                7 gannet frenzy, 8 horses running, 9 swifts, 10 light pulse
//   sky          16 meteor, 17 aurora surge, 18 eclipse (ringed giant), 19 lunar eclipse, 20 Milky Way night,
//                21 Brocken spectre, 22 rainbow squall, 23 dry thunderstorm, 24 far rain shaft, 25 both skies (Drift)
//   water/ground 32 calving wave, 33 geyser, 34 cloud-sea waterfall, 35 flash flood, 36 wave set, 37 dust devil
struct LifeFx { enc: array<vec4f, 16>, rip: array<vec4f, 16>, ph: array<vec4f, 8>, dir: array<vec4f, 4> }

// water-side helper: slope of the ring waves (dh/dx, dh/dz) and foam 0..1 at p, time t
fn lfRipple(p: vec2f, t: f32) -> vec3f {
  var o = vec3f(0.0);
  for (var i = 0; i < 16; i++) {
    let r = LFX.rip[i];
    if (r.w <= 0.0) { continue; }
    let age = t - r.z;
    if (age < 0.0 || age > 14.0) { continue; }
    let dv = p - r.xy;
    let d = length(dv) + 1e-3;
    let front = age * 3.5;
    let x = d - front;
    let env = r.w * exp(-age / 6.0) * exp(-x * x / (2.0 + age)) / (1.0 + 0.15 * d);
    let w = cos(x * 2.4) * env;
    o.x += dv.x / d * w * 0.35; o.y += dv.y / d * w * 0.35;
    o.z += r.w * exp(-age / 2.5) * sstep(2.0 + 1.5 * r.w + age * 0.6, 0.5, d); // splash foam disc
  }
  return vec3f(o.xy, clamp(o.z, 0.0, 1.0));
}

// encounter slot s active of type ty: returns (rel time, duration, intensity, 1) or w = 0
fn lfEnc(ty: f32) -> vec4f {
  for (var s = 0; s < 8; s++) {
    let a = LFX.enc[s * 2]; let b = LFX.enc[s * 2 + 1];
    if (a.x == ty) {
      let rel = FR.time.x - b.x;
      if (rel >= 0.0 && rel <= b.y) { return vec4f(rel, b.y, b.w, 1.0); }
    }
  }
  return vec4f(0.0);
}
fn lfEncPos(ty: f32) -> vec3f {
  for (var s = 0; s < 8; s++) { let a = LFX.enc[s * 2]; if (a.x == ty) { return a.yzw; } }
  return vec3f(0.0);
}

// first active slot of type ty: index, or -1
fn lfSlot(ty: f32) -> i32 {
  for (var s = 0; s < 8; s++) {
    let a = LFX.enc[s * 2]; let b = LFX.enc[s * 2 + 1];
    if (a.x == ty) { let rel = FR.time.x - b.x; if (rel >= 0.0 && rel <= b.y) { return s; } }
  }
  return -1;
}
// phase of slot s: (phase 0 cue / 1 build-up / 2 peak / 3 afterimage, progress 0..1 in it, seconds in, intensity);
// x = -1 when the slot is empty or not running
fn lfPhase(s: i32) -> vec4f {
  if (s < 0) { return vec4f(-1.0, 0.0, 0.0, 0.0); }
  let a = LFX.enc[s * 2]; let b = LFX.enc[s * 2 + 1]; let p = LFX.ph[s];
  let rel = FR.time.x - b.x;
  if (a.x == 0.0 || rel < 0.0 || rel > b.y) { return vec4f(-1.0, 0.0, rel, 0.0); }
  if (rel < p.x) { return vec4f(0.0, rel / max(p.x, 1e-3), rel, b.w); }
  if (rel < p.y) { return vec4f(1.0, (rel - p.x) / max(p.y - p.x, 1e-3), rel, b.w); }
  if (rel < p.z) { return vec4f(2.0, (rel - p.y) / max(p.z - p.y, 1e-3), rel, b.w); }
  return vec4f(3.0, (rel - p.z) / max(p.w - p.z, 1e-3), rel, b.w);
}
fn lfDir(s: i32) -> vec2f { let d = LFX.dir[s / 2]; return select(d.xy, d.zw, (s & 1) == 1); }
