// bake.wgsl: clipmap level bake. Pass 1 evaluates the terrain on a 514x514 grid (1 texel border) into
// height + two mask targets; pass 2 turns heights into (h, dH/dx, dH/dz, concavity over 2 texels) for the level
// plus the shade layer (sun shadow, sky visibility, macro noise).

struct Bake { c: vec4f } // texel-0 world x, z (of the 512 grid), texel size, level
@group(1) @binding(0) var<uniform> BK: Bake;
@group(1) @binding(1) var tmpH: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

struct B1 { @location(0) h: f32, @location(1) a: vec4f, @location(2) b: vec4f }
@fragment fn fsBake(in: VO) -> B1 {
  let k = floor(in.pos.xy) - 1.0; // -1..512
  let p = BK.c.xy + k * BK.c.z;
  TEXEL = BK.c.z;
  let t = terrainAt(p, true);
  var o: B1;
  o.h = t.h; o.a = t.mA; o.b = t.mB;
  return o;
}

fn tH(q: vec2i) -> f32 { return textureLoad(tmpH, clamp(q, vec2i(0), vec2i(513)), 0).x; }

// pass 2: the level's height (r32float, read by clip.wgsl clipH with textureGather + exact bilinear) and its
// derivatives (rgba16float, hardware-filtered; .x is unused so no half-float height exists to be read by mistake).
// Heights never live in half floats: above 256 m they step 0.25-0.5 m, which drew facets, cliff bands and sawtooth
// ridges on GPUs without float32-filterable (RX 6650 XT, D3D12), where the old single texture fell back to rgba16float.
struct B2 { @location(0) h: f32, @location(1) d: vec4f }
@fragment fn fsGrad(in: VO) -> B2 {
  let m = vec2i(floor(in.pos.xy)) + 1;
  let h = tH(m);
  let t = BK.c.z;
  // aux: mean of an 8-tap ring at 2 texels minus h (+ = hollow): broad concavity for the materials
  var ring = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982;
    ring += tH(m + vec2i(round(vec2f(cos(a), sin(a)) * 2.0)));
  }
  var o: B2;
  o.h = h;
  o.d = vec4f(0.0, (tH(m + vec2i(1, 0)) - tH(m - vec2i(1, 0))) / (2.0 * t), (tH(m + vec2i(0, 1)) - tH(m - vec2i(0, 1))) / (2.0 * t),
              ring * 0.125 - h);
  return o;
}

// pass 3 (also run alone when the sun drifts): the level's shade layer (rgba8) from its baked heights.
//   r: sun shadow for the realm sun at this texel, marched through this level only (the terrain shader takes the
//      min over three levels, so near casters come from fine levels and mountains from coarse ones)
//   g: sky visibility from an 8-direction horizon at 2, 5 and 12 texels
//   b, a: the macro breakup noises nL (380 m) and nM (41 m), 0.5 + 0.5 n, faded where the level cannot hold them
// so the terrain fragment shader runs neither the shadow march nor those octaves per pixel.
@group(1) @binding(1) var lvH: texture_2d<f32>;
fn sH(q: vec2i) -> f32 { return textureLoad(lvH, clamp(q, vec2i(0), vec2i(511)), 0).x; }

@fragment fn fsShade(in: VO) -> @location(0) vec4f {
  let m = vec2i(floor(in.pos.xy));
  let h = sH(m);
  let t = BK.c.z;
  let p = BK.c.xy + vec2f(m) * t;
  var occ = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.7853982;
    let dv = vec2f(cos(a), sin(a));
    let m2 = max(sH(m + vec2i(round(dv * 2.0))) - h, 0.0) / (2.0 * t);
    let m5 = max(sH(m + vec2i(round(dv * 5.0))) - h, 0.0) / (5.0 * t);
    let m12 = max(sH(m + vec2i(round(dv * 12.0))) - h, 0.0) / (12.0 * t);
    let mx = max(m2, max(m5, m12));
    occ += mx * inverseSqrt(1.0 + mx * mx); // sine of the horizon angle
  }
  let rw = realmWeights(p);
  // the key light (common.wgsl keyLight): the sun by day, the moon by night, cross-faded through twilight; terrain.wgsl
  // lights with the same direction, so a moonlit night has moon shadows instead of the set sun's black
  let s0 = bf(rw, S0);
  let L = keyLight(s0, bf(rw, S1), bf(rw, S8), FR.sun.w).dir;
  // moonlight casts softer edges (a dimmer, broader-looking source after the eye adapts)
  let soft = bf(rw, S6).y * mix(1.8, 1.0, sstep(-0.035, 0.06, sunDirFrom(s0, FR.sun.w).y));
  var sh = 1.0;
  if (L.y < -0.05) { sh = 0.0; }
  else {
    let lh = length(L.xz);
    if (lh > 1e-3) {
      let dir = L.xz / lh;
      let rise = L.y / lh; // m up per m along the ground
      var tt = 1.5;
      var res = 1.0;
      let h0 = h + 0.3 + 0.15 * t;
      for (var i = 0; i < 28; i++) {
        let q = vec2f(m) + dir * tt;
        if (q.x < 0.0 || q.y < 0.0 || q.x > 511.0 || q.y > 511.0) { break; }
        // bilinear: nearest taps shift the casters by up to a texel and draw acne lines along the contours
        let q0 = vec2i(floor(q)); let fq = q - floor(q);
        let hq = mix(mix(sH(q0), sH(q0 + vec2i(1, 0)), fq.x), mix(sH(q0 + vec2i(0, 1)), sH(q0 + vec2i(1, 1)), fq.x), fq.y);
        let dm = tt * t;
        res = min(res, (h0 + rise * dm - hq) / (soft * dm + 0.6 * t));
        if (res < -0.1) { break; }
        tt = tt * 1.2 + 1.0;
      }
      sh = sstep(-0.1, 1.0, res);
    }
  }
  let nL = fbm(p * (1.0 / 380.0), 3, 200u);
  let nM = fbm(p * (1.0 / 41.0), 2, 210u) * sstep(40.0, 10.0, t);
  return vec4f(sh, clamp(1.0 - occ * 0.125 * 1.2, 0.0, 1.0), clamp(0.5 + 0.5 * nL, 0.0, 1.0), clamp(0.5 + 0.5 * nM, 0.0, 1.0));
}
