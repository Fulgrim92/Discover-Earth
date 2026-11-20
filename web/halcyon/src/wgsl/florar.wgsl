// florar.wgsl: flora geometry. The vertex shaders read the instance records written by the compute prepass in
// floracs.wgsl (one record per accepted instance, per-layer sub-range bound at group 2), so placement, masks and the
// sun-shadow march run once per instance, not once per vertex.
@group(2) @binding(0) var<storage, read> FI: array<vec4f>;

fn rec(ii: u32) -> Inst {
  var I: Inst;
  let a = FI[ii * 4u]; let b = FI[ii * 4u + 1u]; let c = FI[ii * 4u + 2u]; let e = FI[ii * 4u + 3u];
  I.ok = true; I.p = a.xyz; I.fade = a.w; I.g = b.xy; I.sh = b.z; I.cell = b.w; I.alb = c.xyz; I.d = c.w;
  I.kind = bitcast<u32>(e.x); I.h = bitcast<u32>(e.y); I.x = e.z; I.hy = e.w;
  return I;
}

struct FV {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) alb: vec3f,
  @location(3) emis: vec3f,
  @location(4) loc: vec2f,     // planar metric coords (across, along) or lathe (around, ring)
  @location(5) prm: vec4f,     // shadow, ao, translucency, fade
  @location(6) @interpolate(flat) kind: u32,
  @location(7) @interpolate(flat) shp: vec4f, // kind-specific shape params
}

fn dead() -> FV { var o: FV; o.pos = LF_DEAD; o.kind = 0u; return o; }

// width profile of a strip per kind at level j (0..3), as a fraction of W
fn widthAt(k: u32, j: u32) -> f32 {
  let jf = f32(j);
  switch k {
    case 2u: { return 1.0 - jf * 0.3; }
    case 1u, 12u: { return select(0.7, 1.0, j == 1u) - select(0.0, 0.3, j == 2u); }
    case 4u: { return select(1.0, 0.25, j == 0u) - select(0.0, 0.3, j == 2u); }
    case 3u: { return 1.0 - select(0.0, 0.25, j == 2u); }
    default: { return 1.0 - jf * 0.2; }
  }
}

@vertex fn vsStrip(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FV {
  let I = rec(ii);
  let cam = VW.cam.xyz;
  let t = FR.time.x;
  var o: FV;
  o.kind = I.kind;
  let kind = I.kind;
  var b = vi / 9u;
  let k = vi % 9u;
  let isHead = kind == K_FLOWER && vi >= 9u;
  if (kind == K_FLOWER) { b = 0u; }
  let hb = hu(i32(I.h), i32(b), 0x77u);
  let r1 = lfRand(hb, 1u); let r2 = lfRand(hb, 2u); let r3 = lfRand(hb, 3u); let r4 = lfRand(hb, 4u);
  let sizeF = sqrt(I.fade);
  let lscale = I.cell / LA[0].x;
  if (kind == K_VINE) {
    // a hanging strand over the rim: out of the canopy edge, then down the wall, swaying slowly
    let out = vec2f(cos(I.x), sin(I.x));
    let tg = vec2f(-out.y, out.x);
    let k2 = min(max(i32(k) - 1, 0), 6);
    let j = f32(k2 / 2) / 3.0;
    let sg = select(-1.0, 1.0, (k2 & 1) == 1);
    let Hv = (3.0 + 9.0 * r4 * r4) * sizeF;
    let base = I.p + vec3f(tg.x, 0.0, tg.y) * (r1 - 0.5) * I.cell * 1.2 + vec3f(out.x, 0.0, out.y) * (1.6 + 0.6 * r2) + vec3f(0.0, 1.2, 0.0);
    let sw = sin(t * 0.6 + r1 * 6.0 + j * 2.0) * 0.25 * j * j;
    let wv = (0.22 + 0.12 * r3) * sizeF * (1.0 - 0.5 * j);
    let pos = base + vec3f(out.x, 0.0, out.y) * (0.7 * sin(j * 1.6) + sw) + vec3f(0.0, -Hv * j, 0.0) + vec3f(tg.x, 0.0, tg.y) * (sg * wv * 0.5 + sw * 0.5);
    o.wp = pos;
    o.n = normalize(vec3f(out.x, 0.25, out.y));
    o.alb = I.alb * (0.75 + 0.35 * r3) * (1.0 - 0.3 * j);
    o.emis = vec3f(0.0);
    o.loc = vec2f(sg * wv * 0.5, Hv * (1.0 - j));
    o.shp = vec4f(Hv, wv, f32(b), r1);
    o.prm = vec4f(I.sh, mix(0.6, 1.0, 1.0 - j), 0.5, I.fade);
    o.pos = VW.vp * vec4f(pos - cam, 1.0);
    return o;
  }
  // blade root inside the tuft (clumped toward the centre)
  let ang = r1 * 6.2832;
  var spread = I.cell * 0.45;
  if (kind == K_HEATHER || kind == K_SHRUB) { spread = I.cell * 0.25; }
  if (kind == K_FERN || kind == K_STALK) { spread = min(I.cell * 0.4, 0.35); }
  if (kind == K_TUSSOCK) { spread = 0.06 + 0.1 * r4; }
  if (kind == K_FLOWER) { spread = 0.0; }
  let ofs = vec2f(cos(ang), sin(ang)) * spread * sqrt(r2);
  let root = vec3f(I.p.x + ofs.x, I.p.y + dot(I.g, ofs) - 0.03, I.p.z + ofs.y);
  // size per kind
  var H = 0.3; var W = 0.012; var leanM = 0.3; var stiff = 1.0; var tr = 1.0; var ao0 = 0.35;
  var alb = I.alb * (0.85 + 0.3 * r3);
  var emis = vec3f(0.0);
  let hs = pow(lscale, 0.18); let ws = pow(lscale, 0.85);
  switch kind {
    case 0u: {
      // grazed Faroese sward: mostly short blades, taller where sheep left a patch (tall grass reads from afar)
      let tallP = sstep(0.1, 0.55, vn(I.p.xz * (1.0 / 7.0), 815u));
      H = mix(0.09 + 0.12 * r4 * r4 + 0.04 * r3, 0.2 + 0.35 * r4 * r4 + 0.1 * r3, tallP) * hs; W = mix(0.032, 0.022, tallP) * ws; leanM = mix(0.45, 0.2, tallP) + 0.45 * r3;
    }
    case 1u: { H = (0.12 + 0.12 * r4) * hs; W = 0.024 * ws; leanM = 0.55 + 0.4 * r3; alb = vec3f(0.045, 0.05, 0.022) * (0.8 + 0.4 * r3); tr = 0.35; stiff = 0.3; }
    case 12u: { H = (0.12 + 0.14 * r4) * hs; W = 0.035 * ws; leanM = 0.75 + 0.4 * r3; tr = 0.2; stiff = 0.2; }
    case 2u: { H = 0.4 + 0.45 * r4; W = 0.22 + 0.16 * r3; leanM = 0.4 + 0.5 * r3; stiff = 0.4; tr = 0.35; } // a fringe card (shaped like the far tufts)
    case 13u: {
      // far impostor tuft: a wide card with a fringe of grass spikes (shaped in the fragment shader) that grows
      // with distance so the ring keeps its cover as the count thins
      let sc = max(1.0, I.d / 28.0);
      H = (0.3 + 0.25 * r4) * min(sc, 2.4); W = (0.35 + 0.3 * r3) * sc; leanM = 0.35 + 0.4 * r3; stiff = 0.5; tr = 0.6;
      if (I.x < 0.0) { H *= 1.3; W *= 0.7; }
    }
    case 3u: { H = (0.7 + 0.8 * r4); W = 0.012 * ws; leanM = 0.05 + 0.12 * r3; stiff = 0.5; }
    case 4u: { H = (0.45 + 0.5 * r4) * hs; W = 0.11 * ws; leanM = 0.95 + 0.4 * r3; stiff = 0.25; tr = 0.8; }
    case 5u: { H = (0.18 + 0.25 * r4) * hs; W = 0.004 * ws; leanM = 0.08; alb = vec3f(0.08, 0.14, 0.04); }
    case 6u: { H = 0.35 + 1.2 * r4 * r4; W = 0.016; leanM = 0.08; stiff = 0.6; alb = vec3f(0.03, 0.025, 0.05); tr = 0.2; }
    case 7u: { H = 0.45 + 0.8 * r4; W = 0.012; leanM = 0.15 + 0.35 * r3; stiff = 0.8; alb = vec3f(0.02, 0.02, 0.04); tr = 0.0; }
    default: {}
  }
  H *= sizeF; W *= sizeF;
  let pix = I.d * 2.0 * VW.fwd.w * VW.size.w;
  if (kind == K_GRASS || kind == K_HEATHER) { W = max(W, pix * 1.3 * sizeF); }
  // lean + travelling wind gusts + flutter
  let lang = ang + (r3 - 0.5) * 1.2;
  let lean = vec2f(cos(lang), sin(lang)) * leanM;
  let wv = lfWind(root.xz, t);
  let flut = sin(t * (5.0 + 3.0 * r2) + r1 * 40.0 + dot(root.xz, LF_WD) * 0.6) * (0.04 + 0.12 * wv.z);
  var bend = lean + (wv.xy + LF_WD * flut) * stiff;
  if (kind == K_STALK || kind == K_TENDRIL) {
    // alien garden sway: slow, deep, in waves
    let sw = sin(t * 0.7 + dot(root.xz, vec2f(0.21, 0.13)) + r1 * 2.0);
    bend = lean + vec2f(0.6, 0.8) * sw * 0.25 * stiff;
  }
  let bl = length(bend);
  // blade plane: side vector perpendicular to the lean
  var sd = normalize(vec2f(-sin(lang + (r2 - 0.5) * 0.8), cos(lang + (r2 - 0.5) * 0.8)));
  if (kind == K_STALK || kind == K_FLOWER) { let v = root.xz - cam.xz; sd = normalize(vec2f(-v.y, v.x) + 1e-4); }
  let side = vec3f(sd.x, 0.0, sd.y);

  if (isHead) {
    // flower head: a small disc above the stem tip, tilted toward the light and the viewer
    let sTip = 1.0;
    let tip = root + vec3f(bend.x * H * sTip * sTip, H * sTip * (1.0 - 0.42 * min(bl * bl, 1.9) * sTip), bend.y * H * sTip * sTip);
    let toC = normalize(cam - tip);
    let hn = normalize(vec3f(0.0, 1.0, 0.0) + vec3f(toC.x, 0.0, toC.z) * 0.6 + vec3f(r1 - 0.5, 0.0, r2 - 0.5) * 0.5);
    let t1 = normalize(cross(hn, vec3f(0.31, 0.0, 0.95)));
    let t2 = cross(hn, t1);
    let kk = select(vi - 10u, 0u, vi == 9u);
    let cx = f32(kk & 1u) * 2.0 - 1.0; let cy = f32(kk >> 1u) * 2.0 - 1.0;
    let rad = (0.015 + 0.013 * r3) * pow(lscale, 0.55) * sizeF * select(1.0, 1.35, I.alb.b > 0.6 && I.alb.r > 0.6);
    o.wp = tip + (t1 * cx + t2 * cy) * rad;
    o.n = hn;
    o.loc = vec2f(cx, cy);
    // dream hybrid toward Aurora Ice: rime on the petals, a few glinting ice crystals
    o.alb = mix(I.alb, vec3f(0.78, 0.86, 0.95), I.hy * 0.75);
    o.emis = vec3f(0.5, 0.8, 1.0) * I.hy * 0.035 * step(0.7, r2);
    o.prm = vec4f(I.sh, 1.0, 0.9, I.fade);
    o.shp = vec4f(0.0, r4, -1.0, 0.0);
    o.pos = VW.vp * vec4f(o.wp - cam, 1.0);
    return o;
  }

  let sv = min(max(i32(k) - 1, 0), 6);
  let j = u32(sv / 2);
  let sgn = select(-1.0, 1.0, (sv & 1) == 1);
  var s = f32(j) / 3.0;
  var wj = widthAt(kind, j) * W;
  if (j == 3u) { wj = select(0.0, W * 0.8, kind == K_TUFT || kind == K_TUSSOCK); }
  let dryC = kind == K_TUFT && I.x < 0.0;                         // Painted Range: sage shrub (-1) or bunch grass (-2)
  if (dryC) {
    let sage = I.x > -1.5;
    let pr = select(vec4f(0.35, 0.7, 0.9, 1.0), vec4f(0.55, 1.0, 0.9, 0.5), sage);
    W = select(0.3 + 0.12 * r3, 0.45 + 0.2 * r3, sage) * min(max(1.0, I.d / 28.0), 2.4) * sizeF;
    H = select(0.32 + 0.2 * r4, 0.32 + 0.25 * r4, sage) * min(max(1.0, I.d / 28.0), 2.4) * sizeF;
    wj = pr[j] * W;
  }
  var y = 0.0;
  var hz = vec2f(0.0);
  var shp = vec4f(0.0);
  if (kind == K_STALK) {
    // stalk with a bulb: hull levels at 0, H-2.4r, H-r, tip H+r; the fragment shader shapes it
    let rb = (0.03 + 0.03 * r3) * (0.6 + 0.4 * H);
    let ys = array<f32, 4>(0.0, H - 2.4 * rb, H - rb, H + rb);
    let wsx = array<f32, 4>(W * 1.2, rb * 1.7, rb * 2.5, 0.0);
    y = ys[j]; wj = wsx[j];
    s = y / H;
    hz = bend * H * s * s;
    shp = vec4f(rb, H - rb, W, H);
  } else {
    y = H * s * (1.0 - 0.42 * min(bl * bl, 1.9) * s);
    hz = bend * H * s * s;
  }
  let pos = root + vec3f(hz.x, y, hz.y) + side * (wj * 0.5 * sgn);
  // normal: blade face, curved across its width, bent toward the sky
  let tng = normalize(vec3f(bend.x * 2.0 * s * H, max(H * (1.0 - 0.84 * min(bl * bl, 1.9) * s), 0.05 * H), bend.y * 2.0 * s * H));
  var fn0 = normalize(cross(side, tng));
  fn0 = normalize(fn0 + side * sgn * 0.45);
  let gn = normalize(vec3f(-I.g.x, 1.0, -I.g.y));
  o.n = normalize(mix(fn0, gn, select(0.55, 0.8, kind == K_TUFT)));
  // colour along the blade: dark roots, lighter tips
  var a2 = alb;
  if (kind == K_GRASS) {
    // green at the base, lighter toward the tip; olive-straw dry ends on a few blades only
    let dry = step(0.96, r2) * sstep(0.45, 1.0, s); // a few dry tips as accents (the sward reads green)
    a2 = mix(alb * 0.8, alb * vec3f(1.18, 1.12, 0.78), s);
    a2 = mix(a2, mix(alb, vec3f(0.26, 0.23, 0.12), 0.6) * (0.85 + 0.3 * r1), dry * 0.7);
    // dream hybrid toward the Painted Range: strata colours climb the tips in bands
    let band = fract(I.p.y * (1.0 / 6.0) + 0.3 * r1);
    let strata = mix(vec3f(0.55, 0.22, 0.1), vec3f(0.66, 0.46, 0.26), sstep(0.3, 0.7, band));
    a2 = mix(a2, strata, I.hy * sstep(0.2, 0.9, s) * 0.85);
  }
  if (kind == K_TUSSOCK) { a2 = mix(alb * 0.6, alb * vec3f(1.15, 1.1, 1.0), s); }
  if (kind == K_TUFT) {
    a2 = mix(alb * 0.72, alb * select(vec3f(1.25, 1.2, 0.75), vec3f(1.08, 1.06, 1.02), I.x < 0.0), s);
    if (I.x >= 1.0 && b == 0u) {
      // a flower drift seen from afar: blossom colour on the tips of one card
      let code = floor(I.x);
      var fc = vec3f(0.95, 0.62, 0.04);
      if (code == 2.0) { fc = vec3f(0.86, 0.86, 0.8); }
      if (code == 3.0) { fc = vec3f(0.22, 0.12, 0.85); }
      a2 = mix(a2, fc, sstep(0.3, 0.9, s) * fract(I.x) * 0.8);
    }
  }
  if (kind == K_HEATHER) { a2 = mix(alb, vec3f(0.2, 0.06, 0.22) * (0.6 + 0.6 * r2), sstep(0.55, 1.0, s) * step(0.35, r1)); }
  if (kind == K_FERN) { a2 = alb * (0.75 + 0.35 * s); }
  if (kind == K_STALK) {
    let gc = glowCol(I.p.xz, r1);
    let pl = pulseAt(I.p.xz, t + r2 * 0.6);
    emis = gc * pl * 0.06 * s * s;
    shp.z = W;
    o.shp = shp;
    o.alb = gc * pl * 4.0;  // bulb emission (fragment): a soft photophore, not a lamp
  } else {
    o.alb = a2;
  }
  if (kind == K_TENDRIL) {
    let gc = glowCol(I.p.xz, 1.0 - r1);
    let pl = pulseAt(I.p.xz, t + s * 0.8);
    emis = gc * (0.05 + 1.1 * s * s * s * (0.35 + 0.65 * pow(0.5 + 0.5 * sin(s * 6.0 - t * 2.5 + r1 * 6.0), 2.0))) * (0.5 + 0.5 * pl);
  }
  o.emis = emis;
  o.wp = pos;
  o.loc = vec2f(wj * 0.5 * sgn, y);
  if (kind != K_STALK) { o.shp = vec4f(H, W, f32(b) + select(0.0, 100.0, dryC && I.x > -1.5), r1); }
  // ambient occlusion low in the sward; tufts deep in a meadow are darker at the root
  // self-shadowing in the sward: the root sits in the shade of its neighbours, more so in dense tall grass
  let ao = mix(select(0.55, 0.3, kind == K_GRASS || kind == K_TUFT), 1.0, sstep(0.0, 0.85, s));
  // on a slope facing away from the sun the ground itself hides it: whatever stands low on it is in shade
  let gshade = sstep(-0.04, 0.12, dot(gn, FR.sun.xyz));
  o.prm = vec4f(I.sh * gshade, ao * select(1.0, 0.85, dryC), select(tr, 0.12, dryC), I.fade);
  if (dryC && I.x < -1.5) { o.kind = K_TUSSOCK; }                 // bunch grass: the fan of fine blades
  o.pos = VW.vp * vec4f(pos - cam, 1.0);
  return o;
}

// ---- lathe props: mushroom trees and foliage crowns (10 x 8 quads), crystal clusters (4 prisms of 6 x 2) ----
const CO = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
const LSEG = 14u;

// profile point k (0..8): radius, height (fractions of R and H)
fn mushProf(k: u32) -> vec2f {
  switch k {
    case 0u: { return vec2f(0.16, -0.03); }
    case 1u: { return vec2f(0.1, 0.12); }
    case 2u: { return vec2f(0.08, 0.45); }
    case 3u: { return vec2f(0.09, 0.66); }
    case 4u: { return vec2f(0.55, 0.69); }
    case 5u: { return vec2f(0.98, 0.64); }
    case 6u: { return vec2f(1.0, 0.71); }
    case 7u: { return vec2f(0.72, 0.9); }
    default: { return vec2f(0.0, 1.0); }
  }
}
fn crownProf(k: u32) -> vec2f {
  switch k {
    case 0u: { return vec2f(0.1, -0.05); }
    case 1u: { return vec2f(0.07, 0.3); }
    case 2u: { return vec2f(0.6, 0.3); }
    case 3u: { return vec2f(0.94, 0.42); }
    case 4u: { return vec2f(1.0, 0.57); }
    case 5u: { return vec2f(0.92, 0.72); }
    case 6u: { return vec2f(0.7, 0.86); }
    case 7u: { return vec2f(0.38, 0.96); }
    default: { return vec2f(0.0, 1.0); }
  }
}

// smooth mushroom profile: Catmull-Rom through mushProf's points, t in 0..8
fn mushCR(t: f32) -> vec2f {
  let tc = clamp(t, 0.0, 8.0);
  let i = u32(min(floor(tc), 7.0)); let f = tc - f32(i);
  let p0 = mushProf(max(i, 1u) - 1u); let p1 = mushProf(i); let p2 = mushProf(i + 1u); let p3 = mushProf(min(i + 2u, 8u));
  let f2 = f * f; let f3 = f2 * f;
  return 0.5 * (2.0 * p1 + (p2 - p0) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 + (3.0 * p1 - p0 - 3.0 * p2 + p3) * f3);
}

// subtropical crown: a cluster of 6 rounded sub-crowns (cauliflower lobes) at random bearings and heights, so the
// canopy reads as many trees' worth of billowing foliage instead of one lumpy dome; 0..1 how far out on a lobe
fn crownLobe(k: u32, a: f32, h: u32) -> f32 {
  let y = crownProf(k).y;
  var lob = 0.0;
  for (var i = 0u; i < 6u; i++) {
    let th = lfRand(h, 60u + i) * 6.2832;
    let e = 0.42 + 0.5 * lfRand(h, 70u + i);
    var da = a - th; da = da - 6.2832 * round(da / 6.2832);
    let dy = y - e;
    lob = max(lob, exp(-(da * da * 2.6 + dy * dy * 26.0)));
  }
  return lob;
}
fn lathePt(kind: u32, k: u32, a: f32, H: f32, R: f32, h: u32) -> vec3f {
  var pr: vec2f;
  if (kind == K_MUSH) { pr = mushProf(k); } else { pr = crownProf(k); }
  var r = pr.x * R; var y = pr.y * H;
  if (kind == K_CROWN && k >= 2u && k <= 7u) {
    // lumpy, layered foliage
    let sd = f32(h & 1023u);
    let ca = vec2f(cos(a), sin(a));
    let l = vn(ca * 1.7 + vec2f(sd, f32(k) * 0.9), 840u) * 0.55 + vn(ca * 4.3 + vec2f(sd, f32(k) * 2.1), 841u) * 0.3;
    let lob = crownLobe(k, a, h);
    r *= 0.72 + 0.62 * lob + 0.22 * l;
    y += (lob * 0.07 + l * 0.04) * H;
  }
  if (kind == K_MUSH && k >= 4u) {
    // scalloped cap rim
    r *= 1.0 + 0.06 * sin(a * 7.0 + f32(h & 63u));
  }
  return vec3f(cos(a) * r, y, sin(a) * r);
}

@vertex fn vsLathe(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FV {
  let I = rec(ii);
  let cam = VW.cam.xyz;
  let t = FR.time.x;
  var o: FV;
  o.kind = I.kind;
  let r1 = lfRand(I.h, 21u); let r2 = lfRand(I.h, 22u); let r3 = lfRand(I.h, 23u);
  let sizeF = 0.25 + 0.75 * I.fade;
  var wp: vec3f; var n: vec3f; var loc: vec2f; var alb = I.alb; var emis = vec3f(0.0); var tr = 0.3;
  var shp = vec4f(0.0); var lobe = 1.0;
  if (I.kind == K_MUSH || I.kind == K_CROWN) {
    let isM = I.kind == K_MUSH;
    let NS = select(CROWN_SEG, MUSH_SEG, isM); let NR = select(CROWN_RING, MUSH_RING, isM);
    if (vi >= NS * NR * 6u) { return dead(); }
    let q = vi / 6u; let c = CO[vi % 6u];
    let seg = q % NS + c.x; let ring = q / NS + c.y;
    let a = f32(seg) / f32(NS) * 6.2832 + r1 * 6.2832;
    var H: f32; var R: f32;
    if (isM) { let hr = mushHR(I); H = hr.x; R = hr.y; }
    else {
      H = 4.0 + 6.0 * r2; R = H * (0.42 + 0.16 * r3); // broad crowns that close into a canopy
      if (I.x > 0.5) { H = 13.0 + 6.0 * r2; R = H * (0.26 + 0.08 * r3); } // emergent
    }
    H *= sizeF; R *= sizeF;
    // profile parameter 0..8 over the table points (mushrooms: smooth Catmull-Rom with analytic normals)
    let tp = f32(ring) * 8.0 / f32(NR);
    var pk: vec3f; var nn: vec3f;
    if (isM) {
      let pr = mushCR(tp); let dp = mushCR(tp + 0.04) - mushCR(tp - 0.04);
      var r = pr.x * R;
      if (tp >= 4.0) { r *= 1.0 + 0.05 * sin(a * 7.0 + f32(I.h & 63u)) * sstep(4.0, 5.5, tp); } // scalloped rim
      pk = vec3f(cos(a) * r, pr.y * H, sin(a) * r);
      nn = normalize(vec3f(cos(a) * dp.y * H, -dp.x * R, sin(a) * dp.y * H));
      if (ring == NR) { nn = vec3f(0.0, 1.0, 0.0); }
    } else {
      pk = lathePt(I.kind, ring, a, H, R, I.h);
      let pa = lathePt(I.kind, max(ring, 1u) - 1u, a, H, R, I.h);
      let pb = lathePt(I.kind, min(ring + 1u, 8u), a, H, R, I.h);
      let pc = lathePt(I.kind, ring, a + 0.3, H, R, I.h);
      nn = normalize(cross(pb - pa, pc - pk));
      if (ring == 8u) { nn = vec3f(0.0, 1.0, 0.0); }
    }
    // sway grows with height
    let sw = sin(t * 0.5 + r1 * 9.0) * 0.04 * H * (pk.y / H) * (pk.y / H) * select(1.0, 0.25, I.x > 0.5 && isM);
    wp = I.p + pk + vec3f(sw * 0.8, 0.0, sw * 0.6);
    n = nn;
    loc = vec2f(f32(seg) / f32(NS), tp);
    if (isM) {
      let gc = glowCol(I.p.xz, r3);
      let pl = pulseAt(I.p.xz, t);
      alb = mix(vec3f(0.035, 0.025, 0.06), vec3f(0.06, 0.03, 0.08), r1);
      emis = gc * pl;
      shp = vec4f(H, R, r1, pl);
      tr = 0.0;
    } else {
      alb = select(alb, vec3f(0.12, 0.1, 0.08), ring <= 1u);
      shp = vec4f(H, R, r1, 0.0);
      lobe = select(crownLobe(ring, a, I.h), 1.0, ring >= 8u); // out on a sub-crown (1) or in a fold (0)
      tr = 0.25;
    }
  } else {
    // crystal cluster / ice shard: 4 tilted hexagonal prisms with pointed tips
    let pj = vi / 72u; let rem = vi % 72u;
    let q = rem / 6u; let c = CO[rem % 6u];
    let seg = q % 6u + c.x; let band = q / 6u + c.y;
    let hp = hu(i32(I.h), i32(pj), 0x91u);
    let p1 = lfRand(hp, 1u); let p2 = lfRand(hp, 2u); let p3 = lfRand(hp, 3u);
    var H: f32; var rr: f32;
    if (I.kind == K_CRYSTAL) { H = (0.6 + 2.2 * p1 * p1) * (1.0 + 0.6 * f32(pj == 0u)); rr = H * (0.12 + 0.06 * p2); }
    else { H = 0.25 + 0.9 * p1 * p1; rr = H * (0.09 + 0.08 * p2); }
    H *= sizeF; rr *= sizeF;
    let ta = p3 * 6.2832;
    let tilt = select(0.15 + 0.5 * p2, 0.0, pj == 0u && I.kind == K_CRYSTAL);
    let ax = normalize(vec3f(cos(ta) * tilt, 1.0, sin(ta) * tilt));
    let e1 = normalize(cross(ax, vec3f(0.0, 0.0, 1.0)));
    let e2 = cross(ax, e1);
    let a0 = f32(seg) * 1.0472 + p1 * 3.0;
    let am = (f32(q % 6u) + 0.5) * 1.0472 + p1 * 3.0;
    let base = vec3f(cos(ta), 0.0, sin(ta)) * rr * 1.5 * f32(pj > 0u) - ax * 0.15 * H;
    var rad = rr; var yy = 0.0;
    if (band == 1u) { yy = H * 0.72; rad = rr * 0.92; }
    if (band == 2u) { yy = H; rad = 0.0; }
    wp = I.p + base + ax * yy + (e1 * cos(a0) + e2 * sin(a0)) * rad;
    let radial = e1 * cos(am) + e2 * sin(am);
    if (q / 6u == 0u) { n = radial; } else { n = normalize(radial + ax * (rr / (0.28 * H))); }
    loc = vec2f(yy / H, f32(pj));
    if (I.kind == K_CRYSTAL) {
      alb = vec3f(0.03, 0.02, 0.06);
      emis = glowCol(I.p.xz, p2) * pulseAt(I.p.xz, t + yy * 0.3);
    } else {
      alb = vec3f(0.55, 0.78, 0.9);
      emis = vec3f(0.5, 0.91, 1.0) * rowv(M6).w;
    }
    shp = vec4f(H, rr, p1, 0.0);
    tr = select(0.0, 0.3, I.kind == K_SHARD);
  }
  o.wp = wp; o.n = n; o.loc = loc; o.alb = alb; o.emis = emis; o.shp = shp;
  o.prm = vec4f(I.sh, mix(0.45, 1.0, sstep(0.15, 0.7, lobe)), tr, I.fade); // folds between sub-crowns: deep shade
  o.pos = VW.vp * vec4f(wp - cam, 1.0);
  return o;
}

// sun + sky light for every flora kind: diffuse, light through thin leaves (diffuse from behind + forward scatter
// toward a viewer looking into the sun), soft sheen
fn floraLit(n: vec3f, V: vec3f, alb: vec3f, sh: f32, ao: f32, tr: f32, kind: u32) -> vec3f {
  let L = FR.sun.xyz;
  let sc = sunCol();
  let ndl = dot(n, L);
  // thin leaves pass light: diffuse from behind + forward scattering toward a viewer looking into the sun
  let back = max(-ndl, 0.0) * tr * 0.55;
  let mu = max(dot(-V, L), 0.0);
  let fwd = (pow(mu, 8.0) * 4.0 + pow(mu, 3.0) * 0.7) * tr;
  let tcol = alb * vec3f(1.3, 1.95, 0.55) + vec3f(0.006, 0.012, 0.0); // leaf transmission: glowing yellow-green, not ochre
  var col = alb * (sc * sh * max(ndl, 0.0) + lfAmb(n.y, alb) * ao) + tcol * sc * sh * (back + fwd) * ao;
  // soft sheen on leaves
  let hv = normalize(L + V);
  col += sc * sh * pow(max(dot(n, hv), 0.0), 40.0) * 0.06 * select(1.0, 4.0, (kind == K_CRYSTAL || kind == K_SHARD));
  return col;
}

struct FOut { @location(0) c: vec4f, @location(1) d: vec4f }

@diagnostic(off, derivative_uniformity) fn aaStep(e: f32) -> f32 { return clamp(0.5 - e / max(fwidth(e), 1e-5), 0.0, 1.0); }

@diagnostic(off, derivative_uniformity) @fragment fn fsFlora(in: FV) -> FOut {
  let cam = VW.cam.xyz;
  let toC = cam - in.wp;
  let dist = length(toC);
  let V = toC / dist;
  var n = normalize(in.n);
  let kind = in.kind;
  let t = FR.time.x;
  if (dot(n, V) < 0.0 && (kind < K_MUSH || kind >= K_SHRUB)) { n = -n; }
  let L = FR.sun.xyz;
  let sc = sunCol();
  var alb = in.alb;
  var emis = in.emis;
  var alpha = 1.0;
  var ao = in.prm.y;
  var tr = in.prm.z;
  if (kind == K_FLOWER && in.shp.z < -0.5) {
    // petals: buttercup (5 round), daisy (13 narrow), cranesbill (5 notched), centre disc
    let q = in.loc;
    let r = length(q);
    let a = atan2(q.y, q.x) + in.shp.y * 6.0;
    let white = alb.b > 0.6 && alb.r > 0.6;
    var np = 5.0; var sharp = 0.6;
    if (white) { np = 13.0; sharp = 2.5; }
    let pet = 0.55 + 0.45 * pow(abs(cos(a * np * 0.5)), sharp);
    let e = r - pet;
    alpha = aaStep(e);
    let ctr = sstep(0.3, 0.2, r);
    alb = mix(alb * (0.8 + 0.25 * r), vec3f(0.9, 0.6, 0.05), ctr * select(0.4, 1.0, white));
    if (alb.b > 0.5 && !white) { alb = mix(alb, vec3f(0.95, 0.9, 0.85), ctr * 0.8); }
    ao = 1.0;
  } else if (kind == K_TUFT || kind == K_TUSSOCK) {
    // fringe of grass spikes along the top of the card; sides taper
    let u = in.loc.x / max(in.shp.y, 1e-4);
    let yv = in.loc.y / max(in.shp.x, 1e-4);
    if (kind == K_TUSSOCK) {
      // a fan of fine tapering blades from one root (bunch grass), each with its own length
      let th = u / (yv + 0.12) * 0.55;
      let bi = floor(th * 9.0 + in.shp.w * 5.0);
      let f = fract(th * 9.0 + in.shp.w * 5.0);
      let hb = fract(sin(bi * 12.9898 + in.shp.w * 78.233) * 43758.5453);
      let top = 0.45 + 0.55 * hb;
      let w = 0.42 * (1.0 - yv / top);
      alpha = aaStep(abs(f - 0.5) - w) * aaStep(yv - top) * aaStep(abs(u) - 0.5);
    } else {
      if (in.shp.z >= 100.0) {
        // sage shrub: a rounded dome with a scalloped, leafy edge and a few gaps between the twigs
        let q = vec2f(u * 2.0, (yv - 0.42) / 0.58);
        let a = atan2(q.y, q.x);
        let edge = 1.0 - 0.09 * abs(sin(a * 7.0 + in.shp.w * 9.0)) - 0.06 * abs(sin(a * 17.0 + in.shp.w * 3.0));
        let gap = vn(vec2f(u * 9.0, yv * 7.0) + in.shp.w * 13.0, 977u);
        alpha = aaStep(length(q) - edge) * aaStep(gap - 0.55) * aaStep(-yv);
      } else {
        let sp = abs(sin(u * 3.1416 * 6.0 + in.shp.w * 20.0)) * 0.6 + abs(sin(u * 3.1416 * 13.0 + in.shp.w * 7.0)) * 0.4;
        let top = 0.35 + 0.6 * pow(sp, 0.7);
        alpha = aaStep(yv - top) * aaStep(abs(u) - 0.5 * (1.0 - 0.35 * yv));
      }
    }
  } else if (kind == K_FERN || kind == K_VINE) {
    // pinnae: comb of leaflets along the frond
    let along = in.loc.y / max(in.shp.x, 0.01);
    let w = in.shp.y;
    let x = abs(in.loc.x) / max(w * 0.5, 1e-4);
    let comb = fract(along * 15.0 + x * 0.6);
    let leaf = sstep(0.0, 0.25, comb) * sstep(1.0, 0.6, comb);
    let e = x - (0.15 + 0.85 * leaf);
    alpha = aaStep(e) ;
  } else if (kind == K_STALK) {
    let rb = in.shp.x; let yc = in.shp.y;
    let q = vec2f(in.loc.x / rb, (in.loc.y - yc) / (rb * 1.25));
    let eb = length(q) - 1.0;
    let es = abs(in.loc.x) - in.shp.z * 0.5 * (1.0 - 0.4 * in.loc.y / max(in.shp.w, 0.1));
    let inb = aaStep(eb);
    let ins = aaStep(es) * select(1.0, 0.0, in.loc.y > yc);
    alpha = max(inb, ins);
    let core = clamp(1.0 - length(q) * 0.8, 0.0, 1.0);
    emis = mix(emis, in.alb * (0.35 + 0.9 * core + 0.4 * pow(1.0 - clamp(-eb, 0.0, 1.0), 4.0)), inb);
    alb = vec3f(0.03, 0.025, 0.05);
    // bulb normal: a sphere seen from the camera
    let z = sqrt(max(1.0 - dot(q, q), 0.0));
    n = normalize(normalize(cross(vec3f(0.0, 1.0, 0.0), V)) * q.x + vec3f(0.0, 1.0, 0.0) * q.y * 0.8 + V * z);
  } else if (kind == K_MUSH) {
    let ring = in.loc.y;
    let u = in.loc.x;
    let pl = in.shp.w;
    let under = sstep(3.0, 3.6, ring) * sstep(5.2, 4.8, ring);
    let gill = 0.55 + 0.45 * sin(u * 6.2832 * 18.0);
    let rim = sstep(5.3, 5.7, ring) * sstep(6.3, 5.9, ring);
    let spots = sstep(0.55, 0.8, vn(vec2f(u * 26.0, ring * 3.0), 850u)) * sstep(6.0, 7.0, ring);
    let vein = sstep(0.8, 0.98, sin(u * 6.2832 * 5.0 + ring * 0.7)) * sstep(3.0, 1.0, ring);
    // fungal flesh: radial fibres and blotches on the cap, darker toward its crown (no flat fill)
    let fib = 0.5 + 0.5 * sin(u * 6.2832 * 90.0 + vn(vec2f(u * 20.0, ring * 2.0), 852u) * 3.0);
    let blot = vn(vec2f(u * 8.0, ring * 1.5), 853u);
    alb = alb * (0.55 + 0.5 * fib) * (0.75 + 0.5 * blot) * mix(1.0, 0.6, sstep(6.5, 8.0, ring));
    ao = mix(0.35, 1.0, sstep(0.5, 3.0, ring)) * mix(1.0, 0.5, under);
    // light lives in the gills under the cap (fine lamellae) and in a few soft photophores; the flesh is dim
    let lam = 0.5 + 0.5 * sin(u * 6.2832 * 64.0);
    emis = in.emis * (under * (0.4 + 0.6 * gill) * (0.6 + 0.4 * lam) * 3.2 + rim * 0.35 + spots * 0.7 + vein * 0.25 + 0.02);
    // translucent cap: the gill glow shows through toward the rim and at grazing angles
    let fr = pow(1.0 - abs(dot(n, V)), 2.5);
    // translucent cap flesh: the gill light scatters through the thin margin, softly, wider at grazing angles
    emis += in.emis * sstep(5.0, 5.5, ring) * sstep(6.3, 5.7, ring) * (0.04 + 0.3 * fr);
  } else if (kind == K_CROWN) {
    // leaf clusters: high-frequency normal noise and dark gaps
    // (trig lumps, not value noise: the fragment stays cheap)
    let lp = in.wp * 2.2;
    let g = sin(lp * vec3f(1.7, 2.3, 1.9) + 2.0 * sin(lp.zxy * vec3f(1.3, 1.1, 1.7)));
    let edge = 1.0 - abs(dot(n, V));
    n = normalize(n + g * 0.6);
    let q = in.wp * 3.1;
    let gap = 0.6 * sin(q.x * 1.3 + 2.0 * sin(q.z * 1.1) + q.y) * cos(q.z * 1.4 - 1.5 * sin(q.y * 1.2 + q.x)) + 0.4 * g.x * g.y;
    alpha = sstep(-0.05, 0.12, gap + 0.62 - edge * 1.1); // ragged leafy silhouette
    alb *= 0.65 + 0.5 * sstep(-0.4, 0.5, gap);
    alb = mix(vec3f(luma(alb)), alb, 0.7);
    ao = mix(0.5, 1.0, sstep(2.0, 6.5, in.loc.y)) * (0.7 + 0.3 * sstep(-0.5, 0.3, gap));
    alb *= mix(0.85, 1.12, sstep(0.55, 1.0, in.prm.y));                // outer leaves on the sub-crowns lighter, younger
  } else if (kind == K_CRYSTAL || kind == K_SHARD) {
    n = normalize(cross(dpdx(in.wp), dpdy(in.wp)));
    if (dot(n, V) < 0.0) { n = -n; }
    let fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    let inner = 0.25 + 0.75 * in.loc.x * in.loc.x;
    if (kind == K_CRYSTAL) { emis = in.emis * (inner * 0.7 + fres * 1.1); }
    else { emis = in.emis * (0.15 + 0.5 * inner + fres * 0.6); }
  }

  var col = floraLit(n, V, alb, in.prm.x, ao, tr, kind);
  if (VW.cam.w == 9.0) { col = emis; }
  if (VW.cam.w == 10.0) { col = col - emis; }
  col += emis;
  var o: FOut;
  alpha *= sstep(0.0, 0.35, in.prm.w) ;
  o.c = vec4f(col, alpha);
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}

// opaque blades (grass, heather, tussock, reed, shrub layers when no fern is about): geometric tips, no alpha, so
// early depth and full-rate MSAA apply; no noise, no march
@fragment fn fsBlade(in: FV) -> FOut {
  let toC = VW.cam.xyz - in.wp;
  let dist = length(toC);
  let V = toC / dist;
  var n = normalize(in.n);
  if (dot(n, V) < 0.0) { n = -n; }
  var o: FOut;
  o.c = vec4f(floraLit(n, V, in.alb, in.prm.x, in.prm.y, in.prm.z, in.kind) + in.emis, 1.0);
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
