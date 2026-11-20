// clip.wgsl: clipmap sampling, level choice and the height-marched sun shadow. Bound as group 1.
@group(1) @binding(0) var clipT: texture_2d_array<f32>;
@group(1) @binding(1) var clipA: texture_2d_array<f32>;
@group(1) @binding(2) var clipB: texture_2d_array<f32>;
@group(1) @binding(3) var clipSm: sampler;
@group(1) @binding(4) var clipSh: texture_2d_array<f32>; // shade: sun shadow, sky visibility, nL, nM (bake.wgsl)
fn clipSH(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipSh, clipSm, clipUV(i, p), i, 0.0); }

fn nLevels() -> u32 { return u32(FR.misc.x); }

// finest level whose baked square covers p with `margin` texels to spare
fn clipLevel(p: vec2f, start: u32, margin: f32) -> u32 {
  let n = nLevels();
  for (var i = start; i < n; i++) {
    let lv = FR.lv[i];
    let c = lv.xy + 256.0 * lv.z;
    let d = max(abs(p.x - c.x), abs(p.y - c.y));
    if (d < (256.0 - margin) * lv.z) { return i; }
  }
  return n - 1u;
}
// 0 inside, 1 at the coverage edge of level i (for cross-fading to i+1)
fn clipEdge(i: u32, p: vec2f) -> f32 {
  let lv = FR.lv[i];
  let c = lv.xy + 256.0 * lv.z;
  let d = max(abs(p.x - c.x), abs(p.y - c.y)) / lv.z;
  return sstep(200.0, 246.0, d);
}
fn clipUV(i: u32, p: vec2f) -> vec2f {
  let lv = FR.lv[i];
  return ((p - lv.xy) / lv.z + 0.5) * (1.0 / 512.0);
}
fn clipS(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipT, clipSm, clipUV(i, p), i, 0.0); }
fn clipH(i: u32, p: vec2f) -> f32 { return clipS(i, p).x; }
fn clipMA(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipA, clipSm, clipUV(i, p), i, 0.0); }
fn clipMB(i: u32, p: vec2f) -> vec4f { return textureSampleLevel(clipB, clipSm, clipUV(i, p), i, 0.0); }

// best height anywhere (cross-faded at level edges)
fn heightAny(p: vec2f) -> f32 {
  let l = clipLevel(p, 0u, 8.0);
  let e = clipEdge(l, p);
  var h = clipH(l, p);
  if (e > 0.0 && l + 1u < nLevels()) { h = mix(h, clipH(l + 1u, p), e); }
  return h;
}

// soft sun shadow by marching the height clipmaps toward the sun
fn sunShadow(p: vec3f, L: vec3f, dist: f32, soft: f32, jit: f32, steps: i32) -> f32 {
  if (L.y < -0.05) { return 0.0; }
  var t = max(0.6, dist * 0.004) * (1.0 + jit * 0.5);
  var res = 1.0;
  var lv = clipLevel(p.xz, 0u, 8.0);
  for (var i = 0; i < steps; i++) {
    let q = p + L * t;
    lv = clipLevel(q.xz, lv, 8.0);
    let lt = FR.lv[lv].z;
    let h = clipH(lv, q.xz);
    let d = q.y - h;
    res = min(res, d / (soft * t + 0.25 * lt));
    if (res < -0.1 || q.y > 2600.0) { break; }
    t = t * 1.26 + 0.8;
  }
  return sstep(-0.1, 1.0, res);
}

// ---- Surf (DESIGN 12; terrain programmer): swell that travels toward the shore, shoals and breaks, then runs up the
// beach and drains back. Shared by the water (composite.wgsl) and the beach swash (terrain.wgsl), so the foam line on
// the sand belongs to the same wave as the breaker in the water. Crests follow the depth contours: the phase at a
// point is the shallow-water travel time from there to the shoreline, 2 sqrt(d) / (m sqrt(g)) on a slope m.
const SURF_T: f32 = 9.0; // swell period (s)
struct ShoreF { h: f32, sea: vec2f, m: f32, expo: f32 }
// coarse shore frame: smoothed height, seaward (downhill) direction, slope, and exposure to the open sea (deep water
// 160 m and 400 m out along the seaward direction; sheltered lagoons and salt flats get none). 3 clip fetches.
fn shoreFrame(p: vec2f) -> ShoreF {
  let l = clipLevel(p, 2u, 8.0); // >= 2 m texels: crest lines follow the broad bathymetry, not every rock
  let d = clipS(l, p);
  var o: ShoreF;
  o.h = d.x;
  let gl = length(d.yz);
  o.sea = select(vec2f(1.0, 0.0), -d.yz / gl, gl > 1e-4);
  o.m = clamp(gl, 0.012, 3.0);
  let q1 = p + o.sea * 160.0; let q2 = p + o.sea * 400.0;
  let h1 = clipH(clipLevel(q1, l, 4.0), q1);
  let h2 = clipH(clipLevel(q2, l, 4.0), q2);
  o.expo = sstep(-2.0, -12.0, h1) * sstep(-4.0, -22.0, h2);
  return o;
}
// shoreline phase (cycles): an integer when a crest reaches the shore; noise breaks the crests up along the coast
fn surfPhase(p: vec2f, depth: f32, sf: ShoreF, t: f32) -> f32 {
  let tau = 2.0 * sqrt(clamp(depth, 0.0, 40.0)) / (max(sf.m, 0.015) * 3.13);
  return (t + tau) / SURF_T + 0.35 * vn(p * (1.0 / 150.0), 560u);
}
// water side: x = d(eta)/d(seaward distance), y = whitewater 0..1, z = breaking 0..1
fn surfWave(p: vec2f, depth: f32, sf: ShoreF, amp: f32, t: f32) -> vec3f {
  let d = max(depth, 0.05);
  let H0 = 0.75 * sf.expo * amp;
  if (H0 < 0.01 || d > 18.0) { return vec3f(0.0); }
  let cyc = surfPhase(p, d, sf, t);
  let f = fract(cyc);                          // 0 just as a crest passes, rising after it
  let ph = 6.2832 * cyc;
  let H = min(H0 * pow(8.0 / max(d, 0.4), 0.25), 0.8 * d + 0.05); // shoaling, limited by breaking
  let brk = sstep(0.4, 0.75, H / d) * sstep(0.1, 0.3, H0);
  let s = 0.5 + 0.5 * cos(ph);
  let k = 1.0 + 4.0 * brk;                     // crests sharpen and their shoreward face steepens as they break
  let deta = -H * k * pow(s, k - 1.0) * 0.5 * sin(ph) * (1.0 + 0.8 * brk * sstep(0.0, -0.6, sin(ph)));
  let kw = 6.2832 / (SURF_T * 3.13 * sqrt(max(d, 0.3)));
  // whitewater: the plunging crest, the bore behind it, and lace that thins as it is left behind
  let lace = sstep(-0.2, 0.5, vn(p * 0.55 + sf.sea * (f * 3.0), 561u) + 0.6 * vn(p * 1.9, 562u));
  let crest = sstep(0.82, 0.98, s) * brk;
  let bore = exp(-4.5 * f) * brk * lace;
  let shallow = sstep(0.9 * H0, 0.1, d) * sstep(0.1, 0.3, H0) * lace * 0.5;
  return vec3f(deta * kw, clamp(crest + bore + shallow, 0.0, 1.0), brk);
}
// beach side, at a height h above the still water: x = water sheet over the sand, y = foam lace at the swash edge,
// z = wet sand up to the reach of the run-up (above it the sand is dry)
fn surfSwash(p: vec2f, h: f32, sf: ShoreF, amp: f32, t: f32) -> vec3f {
  let R = 0.15 + 1.1 * sf.expo * amp * clamp(0.6 + 2.0 * (0.12 - sf.m), 0.4, 1.0); // run-up: higher on gentle beaches
  if (h > R + 0.4 || h < -0.5) { return vec3f(0.0); }
  let f = fract(surfPhase(p, 0.0, sf, t));
  // uprush in the first quarter of the cycle, then a slower backwash that drains the sheet
  let z = R * select(1.0 - sstep(0.25, 0.95, f), sqrt(sstep(0.0, 0.25, f)), f < 0.25) + 0.08 * vn(p * 0.8, 563u);
  let sheet = sstep(z + 0.03, z - 0.06, h) * sstep(-0.5, 0.0, h);
  let lace = sstep(0.12, 0.0, abs(h - z)) * mix(1.0, 0.4, sstep(0.25, 0.6, f)) * sstep(-0.1, 0.5, vn(p * 1.3, 564u))
           + sheet * 0.35 * exp(-4.0 * f) * sstep(0.1, 0.6, vn(p * 0.9 + vec2f(0.0, f * 2.0), 565u));
  let wetS = sstep(R + 0.25, R * 0.75, h);
  return vec3f(sheet, clamp(lace, 0.0, 1.0), wetS);
}
// cliff spray (DESIGN 12): bursts where a breaker hits an exposed steep shore, and mist drifting downwind.
// y is the height above the still water. Returns spray density 0..1 on a surface at (p, y).
fn surfSpray(p: vec2f, y: f32, sf: ShoreF, amp: f32, t: f32) -> f32 {
  let e = sf.expo * amp * sstep(0.35, 0.9, sf.m);
  if (e < 0.02 || y > 32.0) { return 0.0; }
  let cyc = surfPhase(p, 0.0, sf, t);
  let f = fract(cyc);
  let top = 2.0 + 15.0 * e * sqrt(sstep(0.0, 0.3, f));               // the burst climbs the face
  // a breaker bursts where it hits a jut of the face: patches along the coast, not the whole wall at once
  let jut = sstep(0.0, 0.5, vn(p * (1.0 / 22.0) + vec2f(floor(cyc) * 3.7, 0.0), 571u));
  let burst = sstep(0.0, 0.05, f) * sstep(0.6, 0.15, f) * sstep(top, top * 0.3, y) * jut;
  let wd = CLOUD_WIND * t;                                           // mist drifts with the wind
  let q = p - wd * 0.8;
  let mist = sstep(14.0 * e + 2.0, 0.0, y) * (0.5 + 0.5 * vn3(vec3f(q.x, y * 1.5 - t * 0.6, q.y) * (1.0 / 11.0)));
  // billowing 3D grain (a vertical face sees x/z and y alike: no streaks), rising and spreading through the burst
  let q2 = p - wd;
  let grain = sstep(0.1, 0.9, vn3(vec3f(q2.x, y - f * 9.0, q2.y) * (1.0 / 3.2)) + 0.4 * vn3(vec3f(q2.x, y - f * 14.0, q2.y) * (1.0 / 1.1)));
  return clamp((burst * grain * 0.8 + 0.12 * mist) * e, 0.0, 1.0);
}

// weather (stub until sky-clouds' rain field arrives): FR.mc[0].w rain intensity 0..1, FR.mc[1].w ground wetness 0..1
fn rainNow() -> f32 { return FR.mc[0].w; }
fn groundWet() -> f32 { return FR.mc[1].w; }
