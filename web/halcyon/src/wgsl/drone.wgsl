// drone.wgsl: the drone body in the opaque pass (clip.wgsl, sky.wgsl and fxu.wgsl first). The mesh is built once
// in fx/drone.js (body space: +X right, +Y up, -Z nose; metres) and read from a storage buffer by vertex index:
// per vertex [x, y, z, nx, ny, nz, material]. Lit by the realm sun (with terrain shadow from the height clipmaps),
// sky ambient and a sky reflection; LEDs are emissive and bloom.

@group(2) @binding(0) var<uniform> U: FxU;
@group(2) @binding(1) var<storage, read> MESH: array<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) bp: vec3f,
  @location(3) @interpolate(flat) mat: u32,
}

@vertex fn vsBody(@builtin(vertex_index) vi: u32) -> VOut {
  let o = vi * 7u;
  let bp = vec3f(MESH[o], MESH[o + 1u], MESH[o + 2u]);
  let bn = vec3f(MESH[o + 3u], MESH[o + 4u], MESH[o + 5u]);
  var r: VOut;
  r.wp = U.drone.xyz + qrot(U.dq, bp);
  r.n = qrot(U.dq, bn);
  r.bp = bp;
  r.mat = u32(MESH[o + 6u]);
  r.pos = VW.vp * vec4f(r.wp - VW.cam.xyz, 1.0);
  if (U.drone.w < 0.5) { r.pos = vec4f(0.0); }
  return r;
}

struct FOut { @location(0) c: vec4f, @location(1) d: vec4f }

fn ggxD(n: vec3f, h: vec3f, rough: f32) -> f32 {
  let a = max(rough * rough, 0.003); let a2 = a * a;
  let nh = max(dot(n, h), 0.0);
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * dd * dd);
}

@fragment fn fsBody(in: VOut, @builtin(front_facing) ff: bool) -> FOut {
  var n = normalize(in.n);
  if (!ff) { n = -n; }
  let V = normalize(VW.cam.xyz - in.wp);
  let dist = length(in.wp - VW.cam.xyz);
  let L = FR.sun.xyz;
  let m = in.mat;
  var alb = vec3f(0.5); var rough = 0.5; var f0 = 0.04; var metal = 0.0; var emis = vec3f(0.0);
  let bp = in.bp;
  if (m == 0u) {
    // carbon fibre: 3K twill weave under clear coat
    let q = floor(bp.xz * 900.0);
    let tw = fract((q.x + q.y) * 0.25);
    let w = select(0.0, 1.0, tw < 0.5);
    alb = vec3f(0.022 + 0.012 * w);
    rough = mix(0.22, 0.38, w); f0 = 0.05;
  } else if (m == 1u) {
    alb = vec3f(0.085, 0.088, 0.094); rough = 0.32; f0 = 0.05; // graphite shell, satin clear coat
  } else if (m == 2u) {
    alb = vec3f(0.028, 0.029, 0.032); rough = 0.5;        // dark plastic
  } else if (m == 3u) {
    alb = vec3f(0.55, 0.56, 0.58); metal = 1.0; rough = 0.28; // motor bell (machined aluminium)
    let g = fract(atan2(bp.z, bp.x) * 3.0);               // cooling slots
    alb *= 0.55 + 0.45 * sstep(0.1, 0.25, g) * sstep(0.9, 0.75, g);
  } else if (m == 4u) {
    alb = vec3f(0.80, 0.22, 0.05); metal = 1.0; rough = 0.28; // anodised bell top
  } else if (m == 5u) {
    alb = vec3f(0.9); emis = vec3f(26.0, 27.0, 30.0);       // front nav light (white)
  } else if (m == 6u) {
    alb = vec3f(0.9, 0.1, 0.1); emis = vec3f(34.0, 1.6, 0.8); // rear nav light (red)
    emis *= 0.55 + 0.45 * step(0.5, fract(U.dinfo.w * 1.1));
  } else if (m == 7u) {
    alb = vec3f(0.01, 0.012, 0.02); f0 = 0.09; rough = 0.06; // lens glass
  } else if (m == 8u) {
    // battery: graphite wrap with a yellow label band
    let band = sstep(0.004, 0.0035, abs(bp.z + 0.012));
    alb = mix(vec3f(0.05, 0.05, 0.055), vec3f(0.75, 0.55, 0.05), band); rough = 0.5;
  } else if (m == 9u) {
    alb = vec3f(0.45, 0.04, 0.03); rough = 0.85;          // strap
  } else {
    alb = vec3f(0.55, 0.12, 0.6); metal = 1.0; rough = 0.3; // anodised standoffs
  }

  let sunC = sunCol();
  var sh = 1.0;
  if (L.y > -0.05) {
    let jit = ign(in.pos.xy);
    sh = sunShadow(in.wp + vec3f(0.0, 0.05, 0.0), L, max(dist, 30.0), rowv(S6).y, jit, 12);
  }
  let I = rowv(S3).w;
  let zen = rowv(S2).rgb * I; let hor = rowv(S3).rgb * I;
  let skyAmb = mix(hor, zen, 0.5 + 0.5 * n.y) * rowv(S6).x + rowv(S7).rgb * rowv(S7).w;
  let gnd = hor * 0.18 * rowv(S6).w;
  let amb = mix(gnd, skyAmb, 0.5 + 0.5 * n.y);
  let ndl = max(dot(n, L), 0.0);
  let diffC = alb * (1.0 - metal);
  let F0 = mix(vec3f(f0), alb, metal);
  let H = normalize(V + L);
  let nv = max(dot(n, V), 1e-3);
  let Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  let spec = ggxD(n, H, rough) * Fs * 0.25 / max(nv, 0.2);
  var col = diffC * (sunC * ndl * sh + amb) + sunC * spec * ndl * sh;
  // sky reflection (rougher surfaces see a blurrier, dimmer sky)
  let R = reflect(-V, n);
  let Fr = F0 + (1.0 - F0) * pow(1.0 - nv, 5.0);
  col += mix(hor, zen, clamp(R.y, 0.0, 1.0)) * Fr * (1.0 - rough * 0.7) * mix(0.35, 1.0, sstep(-0.2, 0.3, R.y));
  col += emis;
  var o: FOut;
  o.c = vec4f(col, 1.0);
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
