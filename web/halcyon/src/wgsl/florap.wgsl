// florap.wgsl: light pools under glowing mushrooms. Drawn additively in the blended pass after the composite (owned
// by particles.js): one quad per mushroom record (layers 6 and 9), and each pixel lights the surface it sees,
// reconstructed from the resolved linear depth, so the glow falls on the ground, stems and grass beneath the cap.
@group(2) @binding(0) var sceneDist: texture_2d<f32>;
@group(3) @binding(0) var<storage, read> PR: array<vec4f>;
@group(3) @binding(1) var<storage, read> PA: array<u32>;

struct PV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) @interpolate(flat) col: vec4f, // light colour, pool radius
  @location(2) @interpolate(flat) ctr: vec4f, // cap centre xz, ground y, height
}

fn layerBase(L: u32) -> u32 {
  var b = 0u;
  for (var i = 0u; i < L; i++) { let n = u32(LA[i].y); b += (n * n + 3u) & ~3u; }
  return b;
}

@vertex fn vsPool(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PV {
  var o: PV; o.pos = LF_DEAD;
  let n6 = u32(LA[6].y) * u32(LA[6].y);
  var L = 6u; var k = ii;
  if (ii >= n6) { L = 9u; k = ii - n6; }
  if (k >= PA[L * 4u + 1u]) { return o; }
  let r = (layerBase(L) + k) * 4u;
  let a = PR[r]; let e = PR[r + 3u];
  if (bitcast<u32>(e.x) != K_MUSH) { return o; }
  var I: Inst; I.p = a.xyz; I.fade = a.w; I.h = bitcast<u32>(e.y); I.x = e.z;
  let hr = mushHR(I) * (0.25 + 0.75 * I.fade);
  let rad = hr.y * 1.7 + 1.0;
  let cam = VW.cam.xyz;
  let cx = f32(vi & 1u) * 2.0 - 1.0; let cz = f32((vi >> 1u) & 1u) * 2.0 - 1.0;
  // a horizontal quad at the ground covers the lit ground (bumps aside) from any view above it
  let wp = I.p + vec3f(cx * rad, -0.3, cz * rad);
  let t = FR.time.x;
  o.col = vec4f(glowCol(I.p.xz, lfRand(I.h, 23u)) * pulseAt(I.p.xz, t) * I.fade * select(1.0, 1.6, I.x > 0.5), rad);
  o.ctr = vec4f(I.p.x, I.p.z, I.p.y, hr.x);
  o.wp = wp;
  o.pos = VW.vp * vec4f(wp - cam, 1.0);
  return o;
}

@fragment fn fsPool(in: PV) -> @location(0) vec4f {
  let cam = VW.cam.xyz;
  let dir = normalize(in.wp - cam);
  let sd = textureLoad(sceneDist, vec2i(in.pos.xy), 0).x;
  let sp = cam + dir * sd;
  let q = length(sp.xz - in.ctr.xy) / in.col.w;
  let fall = pow(clamp(1.0 - q * q, 0.0, 1.0), 2.0);
  let hy = sp.y - in.ctr.z;
  let band = sstep(-2.0, 0.0, hy) * sstep(in.ctr.w * 0.62, in.ctr.w * 0.1, hy); // ground up to under the cap
  let L = in.col.rgb * fall * band * 0.22;
  return vec4f(L * lfFogT(cam, dir, sd), 0.0);
}
