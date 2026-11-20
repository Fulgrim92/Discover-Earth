// bake.wgsl: clipmap level bake. Pass 1 evaluates the terrain on a 514x514 grid (1 texel border) into
// height + two mask targets; pass 2 turns heights into (h, dH/dx, dH/dz, concavity) for the level.

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
  let t = terrainAt(p, true);
  var o: B1;
  o.h = t.h; o.a = t.mA; o.b = t.mB;
  return o;
}

@fragment fn fsGrad(in: VO) -> @location(0) vec4f {
  let m = vec2i(floor(in.pos.xy)) + 1;
  let h = textureLoad(tmpH, m, 0).x;
  let hx0 = textureLoad(tmpH, m - vec2i(1, 0), 0).x;
  let hx1 = textureLoad(tmpH, m + vec2i(1, 0), 0).x;
  let hz0 = textureLoad(tmpH, m - vec2i(0, 1), 0).x;
  let hz1 = textureLoad(tmpH, m + vec2i(0, 1), 0).x;
  let t = BK.c.z;
  return vec4f(h, (hx1 - hx0) / (2.0 * t), (hz1 - hz0) / (2.0 * t), (hx0 + hx1 + hz0 + hz1) * 0.25 - h);
}
