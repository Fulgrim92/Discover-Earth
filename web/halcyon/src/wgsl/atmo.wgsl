// atmo.wgsl: the physical atmosphere on the GPU (same model as src/atmo.js): Rayleigh + Mie + ozone, single
// scattering of the sun and the moon plus an isotropic multiple-scattering term. Two small compute bakes per frame
// from the camera's blended realm row (so the air, the sun and the moon morph together across the Drift):
//   csTrans: transmittance LUT (64 x 32: cos zenith x altitude)
//   csSky:   sky-view LUT (256 x 128: azimuth x elevation, display radiance; a = mean view transmittance) and an
//            info row 128 (x 0: sun irradiance at the camera, x 1: moon irradiance at the camera)
// Units: km; display radiance = pi * radiance (surfaces are lit as albedo * E).

@group(1) @binding(0) var transOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var skyOut: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var transT: texture_2d<f32>;
@group(1) @binding(3) var<uniform> AU: vec4f; // camera altitude (m), sun drift, 0, 0
@group(1) @binding(4) var linS: sampler;

const A_RG: f32 = 6360.0;
const A_RT: f32 = 6460.0;
const OZ: vec3f = vec3f(0.65, 1.881, 0.085);

struct AP { br: vec3f, bms: f32, bme: f32, g: f32, bo: vec3f, hm: f32, star: vec3f, ms: f32 }
fn atmoP() -> AP {
  let a0 = FR.row[A0]; let a1 = FR.row[A1]; let a2 = FR.row[A2];
  var p: AP;
  p.br = a1.rgb * 1e-3 * a0.x;
  p.bms = 3.996e-3 * a0.y; p.bme = p.bms / 0.9; p.g = a0.z;
  p.bo = OZ * 1e-3 * a0.w;
  p.hm = max(a1.w, 0.2);
  p.star = a2.rgb; p.ms = a2.w;
  return p;
}
fn densA(h: f32, hm: f32) -> vec3f { return vec3f(exp(-h / 8.0), exp(-h / hm), max(0.0, 1.0 - abs(h - 25.0) / 15.0)); }
fn toTopA(r: f32, mu: f32) -> f32 { let b = r * mu; let c = r * r - A_RT * A_RT; return -b + sqrt(max(b * b - c, 0.0)); }
fn toGroundA(r: f32, mu: f32) -> f32 {
  let b = r * mu; let c = r * r - A_RG * A_RG; let d = b * b - c;
  if (mu >= 0.0 || d < 0.0) { return -1.0; }
  return -b - sqrt(d);
}

// transmittance LUT mapping: x = cos zenith in [-0.35, 1], y = sqrt(altitude / 100 km)
fn trUV(r: f32, mu: f32) -> vec2f {
  return vec2f((mu + 0.35) / 1.35, sqrt(clamp((r - A_RG) / (A_RT - A_RG), 0.0, 1.0)));
}
fn trLook(r: f32, mu: f32) -> vec3f { return textureSampleLevel(transT, linS, trUV(r, mu), 0.0).rgb; }

@compute @workgroup_size(8, 8) fn csTrans(@builtin(global_invocation_id) id: vec3u) {
  let N = textureDimensions(transOut);
  if (id.x >= N.x || id.y >= N.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(N);
  let mu = uv.x * 1.35 - 0.35;
  let r = A_RG + uv.y * uv.y * (A_RT - A_RG);
  let P = atmoP();
  let L = toTopA(r, mu);
  var od = vec3f(0.0);
  let n = 16;
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + 0.5) / f32(n) * L;
    let rr = sqrt(r * r + t * t + 2.0 * r * mu * t);
    od += densA(rr - A_RG, P.hm);
  }
  od *= L / f32(n);
  var T = exp(-(P.br * od.x + vec3f(P.bme * od.y) + P.bo * od.z));
  // below the horizon: the planet's shadow, softened over ~0.5 degree
  if (toGroundA(r, mu) > 0.0) {
    let hor = -sqrt(max(1.0 - (A_RG / r) * (A_RG / r), 0.0));
    T *= clamp((mu - hor) / 0.009 + 1.0, 0.0, 1.0);
  }
  textureStore(transOut, id.xy, vec4f(T, 1.0));
}

fn phaseRA(mu: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
fn phaseMA(mu: f32, g: f32) -> f32 {
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

// display radiance along d from radius r, lit by two lights (sun Ls/Es, moon Lm/Em); a = mean view transmittance
fn skyMarch(P: AP, r: f32, d: vec3f, Ls: vec3f, Es: vec3f, Lm: vec3f, Em: vec3f) -> vec4f {
  let gnd = toGroundA(r, d.y);
  let tmax = select(toTopA(r, d.y), gnd, gnd > 0.0);
  let n = 24;
  let nus = dot(d, Ls); let num = dot(d, Lm);
  let prs = phaseRA(nus); let pms = phaseMA(nus, P.g);
  let prm = phaseRA(num); let pmm = phaseMA(num, P.g);
  var od = vec3f(0.0);
  var acc = vec3f(0.0);
  var prev = 0.0;
  for (var i = 0; i < n; i++) {
    let s = (f32(i) + 0.5) / f32(n);
    let t = tmax * s * s;
    let ds = t - prev; prev = t;
    let p = vec3f(0.0, r, 0.0) + d * t;
    let rr = length(p);
    let up = p / rr;
    let dn = densA(rr - A_RG, P.hm);
    od += dn * ds;
    let Tv = exp(-(P.br * od.x + vec3f(P.bme * od.y) + P.bo * od.z));
    let sR = P.br * dn.x; let sM = P.bms * dn.y;
    let mus = dot(up, Ls); let mum = dot(up, Lm);
    let Ts = trLook(rr, mus); let Tm = trLook(rr, mum);
    // multiple scattering: light scattered at least once reaches p from the whole sky; it follows the light's
    // transmittance from a point higher up, which keeps a blue hour after sunset
    let Ps = trLook(rr + 6.0, mus + 0.06); let Pm = trLook(rr + 6.0, mum + 0.06);
    let ms = (sR + vec3f(sM)) * P.ms * 0.08;
    let ss = (sR * prs + vec3f(sM * pms)) * Ts * Es + ms * Ps * Es
           + (sR * prm + vec3f(sM * pmm)) * Tm * Em + ms * Pm * Em;
    acc += Tv * ss * ds;
  }
  let Tend = exp(-(P.br * od.x + vec3f(P.bme * od.y) + P.bo * od.z));
  return vec4f(acc * PI, dot(Tend, vec3f(0.3333)));
}

// sky-view LUT mapping (shared with sky.wgsl atmoUV): u = azimuth (0 = north, clockwise), v = elevation with the
// horizon at 0.5 and square-root spacing toward it
fn skyDir(uv: vec2f) -> vec3f {
  let az = uv.x * 2.0 * PI;
  let sv = uv.y * 2.0 - 1.0;
  let el = sign(sv) * sv * sv * 0.5 * PI;
  return vec3f(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
}

@compute @workgroup_size(8, 8) fn csSky(@builtin(global_invocation_id) id: vec3u) {
  let N = textureDimensions(skyOut); // 256 x 129
  if (id.x >= N.x || id.y >= N.y) { return; }
  let P = atmoP();
  let r = A_RG + max(AU.x, 1.0) * 1e-3;
  let Ls = sunDirFrom(FR.row[S0], AU.y);
  let Lm = moonDirFrom(FR.row[S8], AU.y);
  let Es = P.star * FR.row[S0].z;
  let Em = MOON_COL * FR.row[S8].z;
  if (id.y == N.y - 1u) {
    // info row: irradiance of the sun and the moon at the camera (normal incidence)
    var o = vec4f(0.0);
    if (id.x == 0u) { o = vec4f(Es * trLook(r, Ls.y), 1.0); }
    if (id.x == 1u) { o = vec4f(Em * trLook(r, Lm.y), 1.0); }
    textureStore(skyOut, id.xy, o);
    return;
  }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(f32(N.x), f32(N.y - 1u));
  let d = skyDir(uv);
  textureStore(skyOut, id.xy, skyMarch(P, r, d, Ls, Es, Lm, Em));
}

// ---- cloud-shadow map (sky programmer): the occlusion of the main layer, the cloud sea's coverage and the Drift
// zone weight (the veil), top-down,
// on CSM texels around the camera (window in FR.flags.yzw). cloudShadowF (common.wgsl) projects a point along the
// sun to each layer's height and reads this instead of evaluating the coverage field per pixel.
@group(1) @binding(5) var csmOut: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn csCloudShadow(@builtin(global_invocation_id) id: vec3u) {
  let N = textureDimensions(csmOut);
  if (id.x >= N.x || id.y >= N.y) { return; }
  let xz = FR.flags.yz + (vec2f(id.xy) + 0.5) * FR.flags.w;
  let rw = realmWeights(xz);
  let c0 = bf(rw, C0);
  var occ = 0.0;
  if (c0.x > 0.005) { occ = sstep(0.05, 0.6, cloudCov(cloudField(xz, bf(rw, C3).x), c0.x)) * clamp(c0.w * 0.85, 0.0, 0.88); }
  // weather: clear cells thin the shadow, squalls are solid (the land under them goes dark)
  let wn = wxCell(xz);
  occ = max(occ * (1.0 - 0.75 * wxClear(wn)), select(wxStorm(wn) * 0.96, 0.0, isOff(OFF_RAIN)));
  // the cloud sea: optical depth per metre of path (presence x coverage x density), and its top (-1000: none)
  let c1w = bf(rw, C1).w;
  var sea = 0.0; var seaTop = -1000.0;
  if (c1w > 0.001) { let c2 = bf(rw, C2); sea = c1w * seaCov(xz) * (c2.z / c1w) * 0.03; seaTop = c2.y / c1w; }
  // z: how much this is the middle of a Drift (1 - sum w^2): the veil skips everything where it is 0
  textureStore(csmOut, id.xy, vec4f(occ, sea, clamp(2.0 * (1.0 - dot(rw.w, rw.w)), 0.0, 1.0), seaTop));
}
