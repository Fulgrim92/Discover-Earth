// lifefx.wgsl: encounter slots and water ripple sources shared by the living world and the water shader.
// Declare `@group(G) @binding(0) var<uniform> LFX: LifeFx;` (G = a free group, bound to lifeFx.bg from
// fx/lifefx.js) before including this file.
//   enc[2s]   = type, x, y, z        enc[2s+1] = t0, duration, seed, intensity     (8 slots; type 0 = empty)
//   rip[i]    = x, z, t0, strength   (16 sources; strength 0 = unused)
// Encounter types: 1 orca pod, 2 murmuration, 3 flamingo take-off, 4 whale breach, 5 jelly gathering,
// 6 migration of giants.
struct LifeFx { enc: array<vec4f, 16>, rip: array<vec4f, 16> }

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
