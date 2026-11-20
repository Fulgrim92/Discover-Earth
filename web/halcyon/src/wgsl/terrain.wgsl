// terrain.wgsl: clipmap grid mesh (one draw per level, geomorphed, skirted) and the per-realm terrain material.

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) @interpolate(flat) lvl: u32,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) li: u32) -> VOut {
  let G = i32(FR.misc.y);
  let W = u32(G + 3);
  var ix = i32(vi % W) - 1;
  var iz = i32(vi / W) - 1;
  let skirt = ix < 0 || iz < 0 || ix > G || iz > G;
  ix = clamp(ix, 0, G); iz = clamp(iz, 0, G);
  let mc = FR.mc[li];
  let s = mc.z;
  let hg = G / 2;
  let gp = mc.xy + vec2f(f32(ix - hg), f32(iz - hg)) * s;
  let half = f32(hg) * s;
  let cam = VW.cam.xyz;
  let dc = max(abs(gp.x - cam.x), abs(gp.y - cam.z)) / half;
  var m = clamp((dc - 0.62) / 0.26, 0.0, 1.0);
  if (li + 1u >= nLevels()) { m = 0.0; }
  let odd = vec2f(f32(ix & 1), f32(iz & 1));
  let p = gp - odd * s * m;
  var h = clipH(li, p);
  if (m > 0.0) { h = mix(h, clipH(li + 1u, p), m); }
  if (skirt) { h -= s * 1.5 + 2.0; }
  var o: VOut;
  o.wp = vec3f(p.x, h, p.y);
  o.pos = VW.vp * vec4f(o.wp - cam, 1.0);
  o.lvl = li;
  return o;
}

struct FOut { @location(0) c: vec4f, @location(1) d: vec4f }

fn hexDist(p: vec2f) -> f32 {
  // distance to the nearest hexagon edge (cell size 1), 0 on the edge
  let r = vec2f(1.0, 1.7320508);
  let hr = r * 0.5;
  let a = p - r * floor(p / r) - hr;
  let b = p - r * floor((p - hr) / r) - r;
  let g = select(b, a, dot(a, a) < dot(b, b));
  let q = abs(g);
  return 0.5 - max(dot(q, normalize(r)), q.x);
}

fn ggx(n: vec3f, v: vec3f, l: vec3f, rough: f32, f0: f32) -> f32 {
  let hv = normalize(v + l);
  let nh = max(dot(n, hv), 0.0); let nl = max(dot(n, l), 0.0); let nv = max(dot(n, v), 1e-3);
  let a = max(rough * rough, 0.002); let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let Gv = nv / (nv * (1.0 - k) + k); let Gl = nl / (nl * (1.0 - k) + k);
  let F = f0 + (1.0 - f0) * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  return D * Gv * Gl * F / (4.0 * nv + 1e-3) ;
}

const STRATA = array<vec3f, 5>(
  vec3f(0.462, 0.056, 0.023), // rust  #b5432a
  vec3f(0.745, 0.371, 0.042), // ochre #e0a43a
  vec3f(0.879, 0.768, 0.527), // cream #f1e3c0
  vec3f(0.051, 0.381, 0.326), // teal  #3fa69a
  vec3f(0.147, 0.044, 0.111), // plum  #6b3b5e
);
fn strataCol(i: f32) -> vec3f {
  let h = hf(i32(i), 7, 300u);
  var k = 0u;
  if (h > 0.32) { k = 1u; }
  if (h > 0.56) { k = 2u; }
  if (h > 0.8) { k = 3u; }
  if (h > 0.87) { k = 4u; }
  let v = 0.8 + 0.35 * hf(i32(i), 9, 301u);
  return STRATA[k] * v;
}

@fragment fn fs(in: VOut) -> FOut {
  let p = in.wp;
  let cam = VW.cam.xyz;
  let toCam = cam - p;
  let dist = length(toCam);
  let V = toCam / dist;
  let tm = FR.time.x;
  let q = FR.time.w;

  // clipmap data at the finest covering level, cross-faded to the next at its edge
  let l0 = clipLevel(p.xz, 0u, 6.0);
  let e = clipEdge(l0, p.xz);
  var cd = clipS(l0, p.xz);
  var mA = clipMA(l0, p.xz);
  var mB = clipMB(l0, p.xz);
  if (e > 0.0 && l0 + 1u < nLevels()) {
    cd = mix(cd, clipS(l0 + 1u, p.xz), e);
    mA = mix(mA, clipMA(l0 + 1u, p.xz), e);
    mB = mix(mB, clipMB(l0 + 1u, p.xz), e);
  }
  let lc = min(l0 + 3u, nLevels() - 1u);
  let conc = clipS(lc, p.xz).w / FR.lv[lc].z; // broad concavity (+ = gully)
  var n = normalize(vec3f(-cd.y, 1.0, -cd.z));
  let gn = n;

  // realm blend here
  let rw = realmWeights(p.xz);
  let M0v = bf(rw, M0); let M1v = bf(rw, M1); let M2v = bf(rw, M2); let M3v = bf(rw, M3);
  let M4v = bf(rw, M4); let M5v = bf(rw, M5); let M6v = bf(rw, M6);
  let S0v = bf(rw, S0); let S1v = bf(rw, S1); let S2v = bf(rw, S2); let S3v = bf(rw, S3);
  let S6v = bf(rw, S6); let S7v = bf(rw, S7);
  let T3v = bf(rw, T3);

  // breakup noise at three scales
  let nL = fbm(p.xz * (1.0 / 380.0), 3, 200u);
  let nM = fbm(p.xz * (1.0 / 41.0), 2, 210u);
  let fine = clamp(1.0 - dist / 250.0, 0.0, 1.0);
  var nS = 0.0;
  if (fine > 0.0) { nS = vn(p.xz * (1.0 / 3.1), 220u) * fine; }

  // micro normal: procedural bumps that fade with distance
  if (fine > 0.0) {
    let bd = vnoised(p.xz * (1.0 / 1.7), 230u).yz * 0.25 + vnoised(p.xz * (1.0 / 0.6), 231u).yz * 0.1;
    n = normalize(n + vec3f(-bd.x, 0.0, -bd.y) * fine * (0.3 + 0.7 * (1.0 - n.y)));
  }
  let slope = 1.0 - gn.y;
  let h = p.y;

  // ---- base: grass / rock / high / shore ----
  let rockT = clamp(sstep(0.2 + 0.1 * nM, 0.36 + 0.1 * nM, slope) + sstep(-0.05, -0.25, conc) * sstep(0.08, 0.2, slope) * 0.8, 0.0, 1.0);
  var grass = M0v.rgb * (0.8 + 0.4 * nL + 0.15 * nS);
  grass = mix(grass, grass * vec3f(1.45, 1.2, 0.6), sstep(-0.1, 0.5, nM) * 0.45);
  grass = mix(grass, vec3f(0.12, 0.085, 0.04), sstep(0.05, 0.45, nL + 0.3 * nM) * 0.55 * M5v.w);
  grass = mix(grass, grass * vec3f(0.7, 0.85, 0.7), sstep(0.1, 0.6, conc) * 0.6);
  var rock = M1v.rgb * (0.75 + 0.35 * nM + 0.2 * nS);
  var alb = mix(grass, rock, max(rockT, 1.0 - M0v.w));
  let hi = sstep(M2v.w - 50.0, M2v.w + 50.0, h + 60.0 * nL) * (1.0 - rockT * 0.6);
  alb = mix(alb, M2v.rgb * (0.9 + 0.2 * nM), hi);
  let shore = sstep(M3v.w + 1.2, M3v.w - 0.6, h + nS * 0.6 + nM * 0.5);
  alb = mix(alb, M3v.rgb * (0.85 + 0.3 * nM), shore);
  var rough = 0.85;
  var f0 = 0.03;
  var emis = vec3f(0.0);
  var wet = shore * 0.6;

  // ---- Home Fjords: ledged basalt, meadows, waterfalls ----
  let wf = M5v.z;
  if (wf > 0.01) {
    // grass clings to the basalt ledges
    let led = fract((h + 4.0 * vn(p.xz * (1.0 / 90.0), 32u)) / max(T3v.w, 1.0));
    let ledge = sstep(0.55, 0.8, led) * rockT * sstep(0.85, 0.5, slope) * T3v.z * 2.0;
    alb = mix(alb, grass * 0.8, clamp(ledge, 0.0, 1.0) * wf);
    // dark wet gullies and thread-thin waterfalls on steep concave faces
    let tng = normalize(vec2f(-gn.z, gn.x) + 1e-4);
    let u = dot(p.xz, tng);
    let cell = floor(u / 26.0);
    let cu = u - cell * 26.0 - 4.0 - 18.0 * hf(i32(cell), i32(floor(h / 400.0)), 240u);
    let present = select(0.0, 1.0, hf(i32(cell), 3, 241u) < 0.35);
    let width = 0.5 + 1.2 * hf(i32(cell), 4, 242u) + dist * 0.0015;
    let strk = sstep(width, width * 0.3, abs(cu)) * present;
    let gully = sstep(0.02, 0.25, conc);
    let steep = sstep(0.35, 0.6, slope);
    let flow = 0.6 + 0.4 * vn(vec2f(u * 0.5, (h + tm * 7.0) * 0.25), 243u);
    let fall = strk * steep * max(gully, 0.25) * wf * flow * sstep(1.0, 8.0, h);
    alb = mix(alb, alb * 0.55, sstep(0.0, 0.3, conc) * steep * wf);
    alb = mix(alb, vec3f(0.82, 0.86, 0.88), clamp(fall, 0.0, 1.0));
    wet = max(wet, fall * 0.7);
  }
  // wildflowers in the meadows (yellow, white, violet)
  if (M5v.w > 0.01 && fine > 0.0) {
    let fc = floor(p.xz * 3.0);
    let fh = hf(i32(fc.x), i32(fc.y), 250u);
    let fp = p.xz * 3.0 - fc - 0.5;
    let dens = sstep(0.1, 0.5, vn(p.xz * (1.0 / 23.0), 251u)) * (1.0 - rockT) * (1.0 - shore);
    if (fh < 0.35 * dens) {
      let dot1 = sstep(0.28, 0.12, length(fp)) * fine * M5v.w;
      let k = hf(i32(fc.x), i32(fc.y), 252u);
      var fcol = vec3f(0.95, 0.75, 0.08);
      if (k > 0.55) { fcol = vec3f(0.92, 0.92, 0.88); }
      if (k > 0.82) { fcol = vec3f(0.42, 0.22, 0.75); }
      alb = mix(alb, fcol, dot1);
    }
  }
  // meadow flower tint at a distance
  alb = mix(alb, alb * vec3f(1.12, 1.08, 0.9), M5v.w * (1.0 - rockT) * (1.0 - fine) * 0.4);

  // ---- Painted Range: strata bands + prismatic pools ----
  if (M4v.x > 0.01) {
    let ph = (h + (mA.x - 0.5) * 90.0 + nM * 2.0) / 6.5;
    let bi = floor(ph); let bfr = ph - bi;
    let c1 = strataCol(bi); let c2 = strataCol(bi + 1.0);
    var sc = mix(c1, c2, sstep(0.82, 1.0, bfr));
    sc = mix(vec3f(luma(sc)), sc, 0.72) * 0.78;
    sc *= 0.82 + 0.25 * nS + 0.18 * vn(vec2f(p.x * 0.05 + p.z * 0.05, h * 1.3), 260u);
    sc *= 1.0 - 0.35 * sstep(0.04, 0.0, abs(bfr - 0.5)) * fine; // thin dark seams
    let veg = sstep(0.18, 0.06, slope) * sstep(0.1, 0.5, nM + 0.2) * M0v.w;
    let painted = mix(sc, grass * 0.9, veg);
    alb = mix(alb, painted, M4v.x);
    // hot pools
    let pf = mA.z;
    if (pf > 0.05) {
      let r = 1.4 * (1.0 - clamp(pf / max(M4v.x, 0.3), 0.0, 1.0));
      var pc = vec3f(0.42, 0.12, 0.03);
      pc = mix(pc, vec3f(0.85, 0.36, 0.04), sstep(1.25, 1.05, r));
      pc = mix(pc, vec3f(0.85, 0.66, 0.06), sstep(1.02, 0.9, r));
      pc = mix(pc, vec3f(0.22, 0.5, 0.12), sstep(0.9, 0.78, r));
      pc = mix(pc, vec3f(0.03, 0.42, 0.52), sstep(0.78, 0.6, r));
      pc = mix(pc, vec3f(0.005, 0.12, 0.36), sstep(0.55, 0.2, r));
      let pw = sstep(1.3, 1.1, r);
      alb = mix(alb, pc, pw);
      let water = sstep(0.9, 0.8, r);
      rough = mix(rough, 0.04, water);
      f0 = mix(f0, 0.02, water);
      n = normalize(mix(n, vec3f(0.0, 1.0, 0.0), water));
      emis += pc * water * 0.05 * M4v.x;
    }
  }

  // ---- Mirror Salt: hexagonal ridges ----
  if (M4v.y > 0.01) {
    let hp = p.xz * (1.0 / 1.9) + 0.25 * vec2f(vn(p.xz * 0.11, 270u), vn(p.xz * 0.11 + 4.0, 271u));
    let hd = hexDist(hp);
    let ridge = sstep(0.07, 0.0, hd) * clamp(1.0 - dist / 120.0, 0.0, 1.0);
    let salt = M0v.rgb * (0.9 + 0.08 * nM + 0.1 * ridge) ;
    let cone = mB.z;
    var sa = mix(salt, rock, sstep(0.2, 0.6, cone));
    alb = mix(alb, sa, M4v.y);
  }

  // ---- Stone Forest: limestone pillars with canopy tops ----
  if (M4v.z > 0.01) {
    let pil = mA.y;
    let wall = sstep(0.4, 0.75, slope);
    let tng = normalize(vec2f(-gn.z, gn.x) + 1e-4);
    let u = dot(p.xz, tng);
    let streak = vn(vec2f(u * 0.35, h * 0.012), 280u) * 0.5 + vn(vec2f(u * 1.3, h * 0.04), 281u) * 0.25;
    var lime = M1v.rgb * (0.95 + 0.55 * streak + 0.2 * nS);
    let band = sstep(0.75, 0.95, fract(h * 0.045 + 0.2 * vn(vec2f(u * 0.05, 1.0), 284u)));
    lime = mix(lime, M0v.rgb * 1.1, band * 0.7);
    lime = mix(lime, lime * vec3f(0.55, 0.6, 0.5), sstep(0.1, 0.5, -streak)); // water-stain streaks
    let moss = sstep(0.2, 0.6, vn(vec2f(u * 0.08, h * 0.05), 282u)) * (1.0 - wall * 0.6);
    lime = mix(lime, M0v.rgb * 0.9, moss * 0.6);
    let canopyCol = M0v.rgb * (0.65 + 0.6 * sstep(-0.4, 0.6, vn(p.xz * (1.0 / 5.0), 283u) + nM * 0.5));
    let canopy = mix(canopyCol, canopyCol * vec3f(1.3, 1.2, 0.6), sstep(0.3, 0.8, nL) * 0.4);
    var sf = mix(canopy, lime, wall);
    alb = mix(alb, sf, M4v.z);
    rough = mix(rough, 0.95, M4v.z);
  }

  // ---- Aurora Ice: black sand, glacier ice glowing from inside, crevasses, bergs ----
  if (M4v.w > 0.01) {
    let gl = mB.w;
    let iceN = vn(p.xz * (1.0 / 60.0), 290u) * 0.5 + nM * 0.5;
    var ice = mix(vec3f(0.62, 0.8, 0.9), vec3f(0.85, 0.92, 0.97), sstep(-0.3, 0.5, iceN));
    ice = mix(ice, vec3f(0.3, 0.55, 0.72), sstep(0.45, 0.8, slope));
    let sand = M3v.rgb * (0.7 + 0.5 * nS + 0.3 * nM);
    var ia = mix(sand, ice, gl);
    let berg = mB.z;
    ia = mix(ia, vec3f(0.72, 0.86, 0.94), berg);
    alb = mix(alb, ia, M4v.w);
    let crev = mB.x;
    let glow = (crev * 1.4 + berg * sstep(0.5, 0.9, slope) * 0.25 + gl * sstep(0.4, 0.8, slope) * 0.3) * M4v.w;
    emis += M6v.rgb * M6v.w * glow;
    rough = mix(rough, 0.25, (gl * 0.7 + berg) * M4v.w);
    f0 = mix(f0, 0.03, M4v.w);
    wet = max(wet, (1.0 - gl) * sstep(4.0, 0.0, h) * M4v.w);
  }

  // ---- Lumen Deep: dark crystal ground, pulsing veins, glowing crystals ----
  if (M5v.x > 0.01) {
    let site = rw.near.xy;
    let dc = length(p.xz - site);
    let pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(dc * 0.018 - tm * 1.6), 6.0);
    let vein = mA.w;
    let vcol = mix(M6v.rgb, vec3f(0.85, 0.2, 1.0), sstep(-0.3, 0.6, nL));
    emis += vcol * vein * vein * pulse * M6v.w * M5v.x * 0.7;
    let cr = mB.y * M5v.y;
    let ccol = mix(vec3f(0.7, 0.25, 1.0), M6v.rgb, sstep(-0.2, 0.4, vn(p.xz * 0.02, 300u)));
    let facet = 0.5 + 0.5 * sin(atan2(gn.z, gn.x) * 3.0 + h * 0.35);
    emis += ccol * cr * M6v.w * (0.25 + 0.5 * facet * sstep(0.3, 0.9, slope) + 0.35 * sstep(0.8, 1.0, mB.y));
    alb = mix(alb, vec3f(0.05, 0.03, 0.09), cr);
    f0 = mix(f0, 0.08, cr);
    // sparkles
    if (fine > 0.0) {
      let sc = floor(p.xz * 2.0);
      let sh = hf(i32(sc.x), i32(sc.y), 301u);
      let sp = sstep(0.25, 0.05, length(p.xz * 2.0 - sc - 0.5)) * select(0.0, 1.0, sh < 0.06);
      emis += vec3f(0.6, 0.9, 1.0) * sp * fine * M5v.x * (0.5 + 0.5 * sin(tm * 3.0 + sh * 60.0));
    }
    rough = mix(rough, 0.5, M5v.x);
    f0 = mix(f0, 0.05, M5v.x);
  }

  // underwater: darker, wet
  let under = sstep(0.3, -0.5, h);
  wet = max(wet, under);
  alb *= 1.0 - 0.45 * wet;
  rough = mix(rough, 0.3, wet * 0.6);

  // ---- light ----
  let L = sunDirFrom(S0v, FR.sun.w);
  let horizon = sstep(-0.035, 0.06, L.y);
  let sunC = S1v.rgb * S0v.z * horizon;
  let jit = ign(in.pos.xy);
  var sh = 0.0;
  let ndl = dot(n, L);
  if (horizon > 0.0 && dot(gn, L) > -0.2) {
    var steps = 22;
    if (q < 0.5) { steps = 12; }
    sh = sunShadow(p + gn * (0.3 + dist * 0.002), L, dist, S6v.y, jit, steps);
    sh *= cloudShadow(p, L, rw); // cloud shadows (common.wgsl, same coverage field as the cloud pass)
  }
  // horizon occlusion from the broad height field
  var occ = 0.0;
  for (var k = 0; k < 4; k++) {
    let a = f32(k) * 1.5708 + 0.6;
    let dd = vec2f(cos(a), sin(a));
    let r1 = 30.0 + dist * 0.01;
    let h1 = heightAny(p.xz + dd * r1);
    let h2 = heightAny(p.xz + dd * r1 * 5.0);
    occ += max(0.0, (h1 - h) / r1) * 0.5 + max(0.0, (h2 - h) / (r1 * 5.0)) * 0.5;
  }
  let ao = clamp(1.0 - occ * 0.35, 0.25, 1.0) * clamp(1.0 - conc * 0.6, 0.5, 1.0);

  let zen = S2v.rgb * S3v.w;
  let hor = S3v.rgb * S3v.w;
  let skyUp = mix(hor, zen, 0.55) * S6v.x + S7v.rgb * S7v.w;
  let ground = (hor * 0.25 + alb * sunC * max(L.y, 0.0) * 0.6) * S6v.w;
  let amb = mix(ground, skyUp, 0.5 + 0.5 * n.y) * ao;
  var col = alb * (sunC * max(ndl, 0.0) * sh + amb);
  // specular: sun + sky reflection for smooth surfaces
  let sp = ggx(n, V, L, rough, f0) * max(ndl, 0.0) * sh;
  col += sunC * sp;
  let R = reflect(-V, n);
  let fr = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  col += mix(hor, zen, clamp(R.y, 0.0, 1.0)) * fr * (1.0 - rough) * ao;
  col += emis;

  var o: FOut;
  o.c = vec4f(col, 1.0);
  if (VW.cam.w == 2.0) { o.c = vec4f(alb, 1.0); }
  if (VW.cam.w == 3.0) { o.c = vec4f(vec3f(sh), 1.0); }
  if (VW.cam.w == 4.0) { o.c = vec4f(n * 0.5 + 0.5, 1.0); }
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
