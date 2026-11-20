// flora.wgsl: grass, flowers, heather, tussocks, reeds, ferns, alien stalks/tendrils (triangle strips) and lathe
// props (mushroom trees, foliage crowns, crystal clusters, ice shards). Every instance is placed here from its
// instance index: a world-snapped hashed grid around the camera per layer (layer = instance_index >> 20), so
// nothing swims. Rejected instances collapse to one degenerate point before any texture fetch.

// layers: LA = cell (m), grid N, strips per instance, class (0 tuft, 1 flower, 2 alien strip, 3 lathe, 4 crystals)
//         LB = fade-in start/end (0 = none), fade-out start/end (3D distance, m). Mirrored in flora.js.
const LA = array<vec4f, 8>(
  vec4f(0.2, 128.0, 5.0, 0.0),
  vec4f(0.55, 112.0, 5.0, 0.0),
  vec4f(1.4, 112.0, 3.0, 0.0),
  vec4f(0.4, 96.0, 1.0, 1.0),
  vec4f(1.0, 96.0, 1.0, 1.0),
  vec4f(1.1, 96.0, 3.0, 2.0),
  vec4f(7.0, 36.0, 1.0, 3.0),
  vec4f(4.0, 48.0, 4.0, 4.0),
);
const LB = array<vec4f, 8>(
  vec4f(0.0, 0.0, 8.0, 12.0),
  vec4f(7.0, 11.0, 22.0, 30.0),
  vec4f(20.0, 28.0, 55.0, 77.0),
  vec4f(0.0, 0.0, 11.0, 17.0),
  vec4f(11.0, 16.0, 30.0, 46.0),
  vec4f(0.0, 0.0, 36.0, 52.0),
  vec4f(0.0, 0.0, 90.0, 122.0),
  vec4f(0.0, 0.0, 70.0, 94.0),
);

const K_GRASS = 0u; const K_HEATHER = 1u; const K_TUSSOCK = 2u; const K_REED = 3u; const K_FERN = 4u;
const K_FLOWER = 5u; const K_STALK = 6u; const K_TENDRIL = 7u; const K_MUSH = 8u; const K_CROWN = 9u;
const K_CRYSTAL = 10u; const K_SHARD = 11u; const K_SHRUB = 12u;

struct Inst {
  ok: bool,
  p: vec3f,   // root
  g: vec2f,   // ground gradient
  kind: u32,
  h: u32,
  fade: f32,
  d: f32,
  cell: f32,
  sh: f32,
  alb: vec3f,
  mA: vec4f,
  mB: vec4f,
}

fn pick(u: f32, w: vec4f) -> i32 {
  let u1 = u * max(1.0, w.x + w.y + w.z + w.w);
  var a = w.x; if (u1 < a) { return 0; }
  a += w.y; if (u1 < a) { return 1; }
  a += w.z; if (u1 < a) { return 2; }
  a += w.w; if (u1 < a) { return 3; }
  return -1;
}

fn kindRadius(k: u32) -> f32 {
  switch k {
    case 6u, 7u: { return 2.0; }
    case 8u: { return 9.0; }
    case 9u: { return 9.0; }
    case 10u: { return 3.0; }
    case 11u: { return 1.5; }
    case 3u, 4u: { return 1.6; }
    default: { return 0.9; }
  }
}

// terrain mask mA.y = pillar top height / 600 m over the pillar footprint (0 off pillars); canopy rises ~5 m above
fn onPillarTop(m: f32, y: f32) -> f32 {
  let top = m * 600.0;
  return select(0.0, 1.0, top > 1.0 && y > top - 2.5);
}

fn place(L: u32, li: u32) -> Inst {
  var I: Inst; I.ok = false;
  let la = LA[L]; let lb = LB[L];
  var cell = la.x; var N = u32(la.y);
  if (FR.time.w < 0.5) { cell *= 2.0; N = N / 2u; }
  if (li >= N * N) { return I; }
  let cam = VW.cam.xyz;
  let b0 = vec2i(floor(cam.xz / cell)) - vec2i(i32(N / 2u));
  let ci = b0 + vec2i(i32(li % N), i32(li / N));
  let h = hu(ci.x, ci.y, 7001u + L * 31u);
  I.h = h; I.cell = cell;
  let u = lfRand(h, 3u); let u2 = lfRand(h, 4u);
  let p2 = (vec2f(ci) + vec2f(lfRand(h, 1u), lfRand(h, 2u))) * cell;
  if (length(p2 - cam.xz) > lb.w) { return I; }
  let cls = u32(la.w);
  let v0 = rowv(V0); let v1 = rowv(V1);
  // kind from the realm weights (no texture fetch yet: zero-weight kinds cost one hash)
  var kind = 99u;
  if (cls == 0u) { let k = pick(u, vec4f(v0.x, v0.w, v1.x, v1.y)); if (k == 0) { kind = K_GRASS; } else if (k == 1) { kind = K_TUSSOCK; } else if (k == 2) { kind = K_REED; } else if (k == 3) { kind = K_FERN; } }
  else if (cls == 1u) { if (u < v0.y) { kind = K_FLOWER; } }
  else if (cls == 2u) { if (u < v1.z) { kind = select(K_STALK, K_TENDRIL, lfRand(h, 9u) > 0.62); } }
  else if (cls == 3u) { let k = pick(u, vec4f(v1.z, v1.y, 0.0, 0.0)); if (k == 0) { kind = K_MUSH; } else if (k == 1) { kind = K_CROWN; } }
  else { let k = pick(u, vec4f(v1.z, v1.w, 0.0, 0.0)); if (k == 0) { kind = K_CRYSTAL; } else if (k == 1) { kind = K_SHARD; } }
  if (kind == 99u) { return I; }

  let lv = clipLevel(p2, 0u, 8.0);
  let s = clipS(lv, p2);
  I.p = vec3f(p2.x, s.x, p2.y); I.g = s.yz;
  let d = length(I.p - cam);
  var fade = sstep(lb.w, lb.z, d);
  if (lb.y > 0.0) { fade *= sstep(lb.x, lb.y, d); }
  if (fade <= 0.002) { return I; }
  let rad = kindRadius(kind) * select(1.0, 2.5, cls == 0u && L == 2u);
  if (!lfVisible(I.p - cam + vec3f(0.0, rad * 0.5, 0.0), rad)) { return I; }
  let slope = 1.0 - inverseSqrt(1.0 + dot(s.yz, s.yz));
  let y = s.x;
  var keep = 0.0;
  var alb = vec3f(0.2);

  if (kind == K_GRASS || kind == K_FLOWER) {
    let nM = fbm(p2 * (1.0 / 41.0), 2, 210u);
    let rockT = sstep(0.2 + 0.1 * nM, 0.36 + 0.1 * nM, slope);
    let shore = sstep(rowv(M3).w + 0.4, rowv(M3).w + 1.6, y + 0.5 * vn(p2 * 0.3, 813u));
    let high = sstep(rowv(M2).w + 60.0, rowv(M2).w - 40.0, y);
    let base = (1.0 - rockT) * shore * high;
    if (kind == K_GRASS) {
      let clump = 0.45 + 0.55 * sstep(-0.35, 0.35, vn(p2 * (1.0 / 2.1), 811u));
      keep = base * clump;
      alb = lfGrassAlb(p2);
      let heath = sstep(0.06, 0.15, slope + 0.07 * vn(p2 * (1.0 / 17.0), 812u)) * v0.z;
      if (lfRand(h, 5u) < heath * 0.85) { kind = K_HEATHER; }
    } else {
      let drift = sstep(0.1, 0.5, vn(p2 * (1.0 / 23.0), 251u));
      keep = base * drift * 0.9;
      // drifts of one colour: yellow, white, violet
      let c = vn(p2 * (1.0 / 9.0), 252u) + 0.35 * (lfRand(h, 6u) - 0.5);
      alb = vec3f(0.95, 0.62, 0.04);
      if (c > 0.08) { alb = vec3f(0.86, 0.86, 0.8); }
      if (c > 0.42 || c < -0.55) { alb = vec3f(0.22, 0.12, 0.85); }
    }
  } else if (kind == K_TUSSOCK) {
    let nM = fbm(p2 * (1.0 / 41.0), 2, 210u);
    let veg = sstep(0.18, 0.06, slope) * sstep(0.0, 0.5, nM + 0.25);
    keep = veg * 0.4 * select(1.0, 0.0, y < 1.0);
    alb = mix(vec3f(0.34, 0.25, 0.1), vec3f(0.22, 0.17, 0.07), lfRand(h, 7u));
    if (lfRand(h, 8u) < 0.3) { kind = K_SHRUB; alb = vec3f(0.06, 0.07, 0.03) * (0.8 + 0.5 * lfRand(h, 7u)); }
  } else if (kind == K_REED) {
    I.mB = clipMB(lv, p2);
    let isl = sstep(0.05, 0.25, I.mB.z) * sstep(0.02, 0.15, y);
    if (y < 3.5) { keep = isl * 0.85 * sstep(3.5, 2.0, y); alb = mix(vec3f(0.16, 0.17, 0.06), vec3f(0.36, 0.28, 0.12), lfRand(h, 7u)); }
    else { kind = K_TUSSOCK; keep = isl * 0.28 * sstep(0.4, 0.2, slope); alb = mix(vec3f(0.26, 0.2, 0.09), vec3f(0.14, 0.16, 0.06), lfRand(h, 7u)); }
  } else if (kind == K_FERN) {
    I.mA = clipMA(lv, p2);
    keep = sstep(0.42, 0.25, slope) * mix(0.55, 0.9, onPillarTop(I.mA.y, y)) * sstep(0.0, 1.0, y);
    alb = rowv(M0).rgb * mix(vec3f(0.45, 0.55, 0.38), vec3f(0.8, 0.78, 0.5), lfRand(h, 7u));
  } else if (kind == K_STALK || kind == K_TENDRIL) {
    I.mB = clipMB(lv, p2); I.mA = clipMA(lv, p2);
    let pch = sstep(-0.15, 0.45, vn(p2 * (1.0 / 16.0), 821u));
    keep = (0.12 + 0.8 * pch + 0.5 * I.mA.w) * sstep(0.25, 0.0, I.mB.y) * sstep(0.2, 0.8, y) * sstep(0.45, 0.25, slope);
  } else if (kind == K_MUSH) {
    I.mB = clipMB(lv, p2);
    let pch = sstep(-0.3, 0.5, vn(p2 * (1.0 / 60.0), 822u));
    keep = (0.04 + 0.22 * pch) * sstep(0.1, 0.0, I.mB.y) * sstep(0.5, 1.5, y) * sstep(0.35, 0.2, slope);
  } else if (kind == K_CROWN) {
    I.mA = clipMA(lv, p2);
    keep = sstep(0.32, 0.18, slope) * mix(0.35, 0.95, onPillarTop(I.mA.y, y)) * sstep(0.5, 2.0, y);
    alb = rowv(M0).rgb * mix(vec3f(0.4, 0.5, 0.36), vec3f(0.75, 0.75, 0.48), lfRand(h, 7u));
  } else if (kind == K_CRYSTAL) {
    I.mB = clipMB(lv, p2);
    keep = (0.06 + 0.9 * sstep(0.0, 0.6, I.mB.y)) * sstep(0.2, 0.6, y);
  } else if (kind == K_SHARD) {
    I.mB = clipMB(lv, p2);
    keep = 0.4 * sstep(0.15, 0.6, y) * sstep(3.5, 2.0, y) * sstep(0.3, 0.05, I.mB.w) * sstep(0.3, 0.15, slope);
  }
  if (u2 >= keep) { return I; }
  I.kind = kind; I.alb = alb; I.d = d; I.fade = fade;
  let sz = select(0.4, rad * 0.4, cls >= 3u);
  I.sh = lfShadow(I.p + vec3f(0.0, sz + 0.15, 0.0), d, lfRand(h, 11u), 10);
  I.ok = true;
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

fn pulseAt(p: vec2f, t: f32) -> f32 {
  let w = sin(dot(p, vec2f(0.11, 0.07)) + 0.8 * vn(p * 0.02, 830u) * 6.0 - t * 1.7);
  return 0.35 + 0.65 * pow(0.5 + 0.5 * w, 3.0);
}

fn glowCol(p: vec2f, r: f32) -> vec3f {
  let c = vn(p * (1.0 / 40.0), 831u) * 0.8 + (r - 0.5) * 0.7;
  var g = vec3f(0.15, 0.95, 0.85);             // teal
  g = mix(g, vec3f(0.25, 0.75, 1.0), sstep(-0.1, 0.25, c)); // cyan
  g = mix(g, vec3f(1.0, 0.55, 0.12), sstep(0.35, 0.55, c)); // amber
  g = mix(g, vec3f(0.95, 0.25, 0.85), sstep(-0.45, -0.65, c)); // a little magenta
  return g;
}

@vertex fn vsStrip(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FV {
  let L = ii >> 20u;
  let I = place(L, ii & 0xFFFFFu);
  if (!I.ok) { return dead(); }
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
  // blade root inside the tuft (clumped toward the centre)
  let ang = r1 * 6.2832;
  var spread = I.cell * 0.45;
  if (kind == K_HEATHER || kind == K_SHRUB) { spread = I.cell * 0.25; }
  if (kind == K_FERN || kind == K_STALK) { spread = min(I.cell * 0.4, 0.35); }
  if (kind == K_FLOWER) { spread = 0.0; }
  let ofs = vec2f(cos(ang), sin(ang)) * spread * sqrt(r2);
  let root = vec3f(I.p.x + ofs.x, I.p.y + dot(I.g, ofs) - 0.03, I.p.z + ofs.y);
  // size per kind
  var H = 0.3; var W = 0.012; var leanM = 0.3; var stiff = 1.0; var tr = 1.0; var ao0 = 0.35;
  var alb = I.alb * (0.85 + 0.3 * r3);
  var emis = vec3f(0.0);
  let hs = pow(lscale, 0.18); let ws = pow(lscale, 0.85);
  switch kind {
    case 0u: { H = (0.22 + 0.38 * r4 * r4 + 0.12 * r3) * hs; W = 0.015 * ws; leanM = 0.15 + 0.4 * r3; }
    case 1u: { H = (0.12 + 0.12 * r4) * hs; W = 0.024 * ws; leanM = 0.55 + 0.4 * r3; alb = vec3f(0.045, 0.05, 0.022) * (0.8 + 0.4 * r3); tr = 0.35; stiff = 0.3; }
    case 12u: { H = (0.12 + 0.14 * r4) * hs; W = 0.035 * ws; leanM = 0.75 + 0.4 * r3; tr = 0.2; stiff = 0.2; }
    case 2u: { H = (0.28 + 0.3 * r4) * hs; W = 0.006 * ws; leanM = 0.45 + 0.6 * r3; stiff = 0.4; tr = 0.8; }
    case 3u: { H = (0.7 + 0.8 * r4); W = 0.012 * ws; leanM = 0.05 + 0.12 * r3; stiff = 0.5; }
    case 4u: { H = (0.45 + 0.5 * r4) * hs; W = 0.11 * ws; leanM = 0.95 + 0.4 * r3; stiff = 0.25; tr = 0.8; }
    case 5u: { H = (0.18 + 0.25 * r4) * hs; W = 0.004 * ws; leanM = 0.08; alb = vec3f(0.08, 0.14, 0.04); }
    case 6u: { H = 0.35 + 1.2 * r4 * r4; W = 0.016; leanM = 0.08; stiff = 0.6; alb = vec3f(0.03, 0.025, 0.05); tr = 0.2; }
    case 7u: { H = 0.45 + 0.8 * r4; W = 0.012; leanM = 0.15 + 0.35 * r3; stiff = 0.8; alb = vec3f(0.02, 0.02, 0.04); tr = 0.0; }
    default: {}
  }
  H *= sizeF; W *= sizeF;
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
    o.alb = I.alb;
    o.emis = vec3f(0.0);
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
  if (j == 3u) { wj = 0.0; }
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
  o.n = normalize(mix(fn0, gn, 0.55));
  // colour along the blade: dark roots, lighter tips
  var a2 = alb;
  if (kind == K_GRASS) { a2 = mix(alb * 0.85, alb * vec3f(1.3, 1.22, 0.7), s); }
  if (kind == K_TUSSOCK) { a2 = mix(alb * 0.7, alb * vec3f(1.5, 1.35, 1.1), s); }
  if (kind == K_HEATHER) { a2 = mix(alb, vec3f(0.2, 0.06, 0.22) * (0.6 + 0.6 * r2), sstep(0.55, 1.0, s) * step(0.35, r1)); }
  if (kind == K_FERN) { a2 = alb * (0.75 + 0.35 * s); }
  if (kind == K_STALK) {
    let gc = glowCol(I.p.xz, r1);
    let pl = pulseAt(I.p.xz, t + r2 * 0.6);
    emis = gc * pl * 0.06 * s * s;
    shp.z = W;
    o.shp = shp;
    o.alb = gc * pl * 9.0;  // bulb emission (fragment)
  } else {
    o.alb = a2;
  }
  if (kind == K_TENDRIL) {
    let gc = glowCol(I.p.xz, 1.0 - r1);
    let pl = pulseAt(I.p.xz, t + s * 0.8);
    emis = gc * (0.5 + 2.4 * s * s * (0.35 + 0.65 * pow(0.5 + 0.5 * sin(s * 6.0 - t * 2.5 + r1 * 6.0), 2.0))) * (0.5 + 0.5 * pl);
  }
  o.emis = emis;
  o.wp = pos;
  o.loc = vec2f(wj * 0.5 * sgn, y);
  if (kind != K_STALK) { o.shp = vec4f(H, W, f32(b), r1); }
  // ambient occlusion low in the sward; tufts deep in a meadow are darker at the root
  let ao = mix(0.55, 1.0, sstep(0.0, 0.8, s));
  o.prm = vec4f(I.sh, ao, tr, I.fade);
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

fn lathePt(kind: u32, k: u32, a: f32, H: f32, R: f32, h: u32) -> vec3f {
  var pr: vec2f;
  if (kind == K_MUSH) { pr = mushProf(k); } else { pr = crownProf(k); }
  var r = pr.x * R; var y = pr.y * H;
  if (kind == K_CROWN && k >= 2u && k <= 7u) {
    // lumpy, layered foliage
    let sd = f32(h & 1023u);
    let ca = vec2f(cos(a), sin(a));
    let l = vn(ca * 1.7 + vec2f(sd, f32(k) * 0.9), 840u) * 0.55 + vn(ca * 4.3 + vec2f(sd, f32(k) * 2.1), 841u) * 0.3;
    r *= 1.0 + 0.5 * l;
    y += l * 0.08 * H;
  }
  if (kind == K_MUSH && k >= 4u) {
    // scalloped cap rim
    r *= 1.0 + 0.06 * sin(a * 7.0 + f32(h & 63u));
  }
  return vec3f(cos(a) * r, y, sin(a) * r);
}

@vertex fn vsLathe(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FV {
  let L = ii >> 20u;
  let I = place(L, ii & 0xFFFFFu);
  if (!I.ok) { return dead(); }
  let cam = VW.cam.xyz;
  let t = FR.time.x;
  var o: FV;
  o.kind = I.kind;
  let r1 = lfRand(I.h, 21u); let r2 = lfRand(I.h, 22u); let r3 = lfRand(I.h, 23u);
  let sizeF = 0.25 + 0.75 * I.fade;
  var wp: vec3f; var n: vec3f; var loc: vec2f; var alb = I.alb; var emis = vec3f(0.0); var tr = 0.3;
  var shp = vec4f(0.0);
  if (I.kind == K_MUSH || I.kind == K_CROWN) {
    let q = vi / 6u; let c = CO[vi % 6u];
    let seg = q % LSEG + c.x; let ring = q / LSEG + c.y;
    let a = f32(seg) / f32(LSEG) * 6.2832 + r1 * 6.2832;
    var H: f32; var R: f32;
    if (I.kind == K_MUSH) { H = 2.5 + 9.0 * r2 * r2 * r2; R = H * (0.28 + 0.22 * r3); }
    else { H = 4.0 + 6.0 * r2; R = H * (0.3 + 0.12 * r3); }
    H *= sizeF; R *= sizeF;
    let pk = lathePt(I.kind, ring, a, H, R, I.h);
    let pa = lathePt(I.kind, max(ring, 1u) - 1u, a, H, R, I.h);
    let pb = lathePt(I.kind, min(ring + 1u, 8u), a, H, R, I.h);
    let pc = lathePt(I.kind, ring, a + 0.3, H, R, I.h);
    var nn = normalize(cross(pb - pa, pc - pk));
    if (ring == 8u) { nn = vec3f(0.0, 1.0, 0.0); }
    // sway grows with height
    let sw = sin(t * 0.5 + r1 * 9.0) * 0.04 * H * (pk.y / H) * (pk.y / H);
    wp = I.p + pk + vec3f(sw * 0.8, 0.0, sw * 0.6);
    n = nn;
    loc = vec2f(f32(seg) / f32(LSEG), f32(ring));
    if (I.kind == K_MUSH) {
      let gc = glowCol(I.p.xz, r3);
      let pl = pulseAt(I.p.xz, t);
      alb = mix(vec3f(0.035, 0.025, 0.06), vec3f(0.06, 0.03, 0.08), r1);
      emis = gc * pl;
      shp = vec4f(H, R, r1, pl);
      tr = 0.0;
    } else {
      alb = select(alb, vec3f(0.12, 0.1, 0.08), ring <= 1u);
      shp = vec4f(H, R, r1, 0.0);
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
  o.prm = vec4f(I.sh, 1.0, tr, I.fade);
  o.pos = VW.vp * vec4f(wp - cam, 1.0);
  return o;
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
  if (dot(n, V) < 0.0 && kind < K_MUSH) { n = -n; }
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
  } else if (kind == K_FERN) {
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
    emis = in.emis * (under * gill * 4.5 + rim * 3.0 + spots * 2.2 + vein * 0.5 + 0.06);
  } else if (kind == K_CROWN) {
    // leaf clusters: high-frequency normal noise and dark gaps
    let lp = in.wp * 2.2;
    let g = vec3f(vn3(lp), vn3(lp + 7.1), vn3(lp + 3.3));
    let edge = 1.0 - abs(dot(n, V));
    n = normalize(n + g * 0.8);
    let gap = vn3(in.wp * 3.1 + 11.0) * 0.6 + vn3(in.wp * 7.3) * 0.4;
    alpha = sstep(-0.05, 0.12, gap + 0.62 - edge * 1.1); // ragged leafy silhouette
    alb *= 0.65 + 0.5 * sstep(-0.4, 0.5, gap);
    alb = mix(vec3f(luma(alb)), alb, 0.8);
    ao = mix(0.5, 1.0, sstep(2.0, 6.5, in.loc.y)) * (0.7 + 0.3 * sstep(-0.5, 0.3, gap));
  } else if (kind == K_CRYSTAL || kind == K_SHARD) {
    n = normalize(cross(dpdx(in.wp), dpdy(in.wp)));
    if (dot(n, V) < 0.0) { n = -n; }
    let fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    let inner = 0.25 + 0.75 * in.loc.x * in.loc.x;
    if (kind == K_CRYSTAL) { emis = in.emis * (inner * 0.7 + fres * 1.1); }
    else { emis = in.emis * (0.15 + 0.5 * inner + fres * 0.6); }
  }

  let ndl = dot(n, L);
  let sh = in.prm.x;
  // thin leaves pass light: diffuse from behind + forward scattering toward a viewer looking into the sun
  let back = max(-ndl, 0.0) * tr * 0.55;
  let mu = max(dot(-V, L), 0.0);
  let fwd = (pow(mu, 8.0) * 4.0 + pow(mu, 3.0) * 0.7) * tr;
  let tcol = alb * vec3f(1.9, 1.75, 0.65) + vec3f(0.012, 0.01, 0.0);
  var col = alb * (sc * sh * max(ndl, 0.0) + lfAmb(n.y, alb) * ao) + tcol * sc * sh * (back + fwd) * ao;
  // soft sheen on leaves
  let hv = normalize(L + V);
  col += sc * sh * pow(max(dot(n, hv), 0.0), 40.0) * 0.06 * select(1.0, 4.0, kind >= K_CRYSTAL && kind != K_SHRUB);
  if (VW.cam.w == 9.0) { col = emis; }
  if (VW.cam.w == 10.0) { col = col - emis; }
  col += emis;
  var o: FOut;
  alpha *= sstep(0.0, 0.35, in.prm.w) ;
  o.c = vec4f(col, alpha);
  o.d = vec4f(dist, 0.0, 0.0, 1.0);
  return o;
}
