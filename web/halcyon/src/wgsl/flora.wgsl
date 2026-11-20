// flora.wgsl: grass, flowers, heather, tussocks, reeds, ferns, alien stalks/tendrils (triangle strips) and lathe
// props (mushroom trees, foliage crowns, crystal clusters, ice shards). Every instance is placed here from its
// instance index: a world-snapped hashed grid around the camera per layer (layer = instance_index >> 20), so
// nothing swims. Rejected instances collapse to one degenerate point before any texture fetch.

// layers: LA = cell (m), grid N, strips per instance, class (0 tuft, 1 flower, 2 alien strip, 3 lathe, 4 crystals)
//         LB = fade-in start/end (0 = none), fade-out start/end (3D distance, m). Mirrored in flora.js.
const NL = 10u;
const LA = array<vec4f, 10>(
  vec4f(0.2, 128.0, 6.0, 0.0),
  vec4f(0.55, 112.0, 5.0, 0.0),
  vec4f(1.4, 112.0, 3.0, 0.0),
  vec4f(0.4, 96.0, 1.0, 1.0),
  vec4f(1.0, 96.0, 1.0, 1.0),
  vec4f(1.1, 96.0, 3.0, 2.0),
  vec4f(7.0, 64.0, 1.0, 3.0),
  vec4f(4.0, 48.0, 4.0, 4.0),
  vec4f(3.0, 168.0, 3.0, 5.0),
  vec4f(90.0, 14.0, 1.0, 6.0),
);
const LB = array<vec4f, 10>(
  vec4f(0.0, 0.0, 8.0, 12.0),
  vec4f(7.0, 11.0, 22.0, 30.0),
  vec4f(20.0, 28.0, 55.0, 77.0),
  vec4f(0.0, 0.0, 11.0, 17.0),
  vec4f(11.0, 16.0, 30.0, 46.0),
  vec4f(0.0, 0.0, 36.0, 52.0),
  vec4f(0.0, 0.0, 160.0, 220.0),
  vec4f(0.0, 0.0, 70.0, 94.0),
  vec4f(30.0, 50.0, 185.0, 250.0),
  vec4f(0.0, 0.0, 650.0, 900.0),
);
// vertices per instance (strips: 9 per blade, flowers 14; lathe: see latheVerts, crystals 288). The prepass raises a
// layer's vertexCount to the largest kind it accepted.
const LV = array<u32, 10>(54u, 45u, 27u, 14u, 14u, 27u, 672u, 288u, 27u, 1440u);
const MUSH_SEG = 20u; const MUSH_RING = 12u; const CROWN_SEG = 14u; const CROWN_RING = 8u;
fn latheVerts(kind: u32) -> u32 {
  if (kind == K_MUSH) { return MUSH_SEG * MUSH_RING * 6u; }
  if (kind == K_CROWN) { return CROWN_SEG * CROWN_RING * 6u; }
  return 288u;
}

const K_GRASS = 0u; const K_HEATHER = 1u; const K_TUSSOCK = 2u; const K_REED = 3u; const K_FERN = 4u;
const K_FLOWER = 5u; const K_STALK = 6u; const K_TENDRIL = 7u; const K_MUSH = 8u; const K_CROWN = 9u;
const K_CRYSTAL = 10u; const K_SHARD = 11u; const K_SHRUB = 12u; const K_TUFT = 13u; const K_VINE = 14u;

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
  hy: f32,    // dream hybrid amount (flowers: frost toward Ice; grass: strata tips toward Painted)
  x: f32,     // kind-specific extra (far tuft: flower tint code + drift, -1 dry)
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
    case 13u: { return 2.5; }
    case 14u: { return 8.0; }
    case 3u, 4u: { return 1.6; }
    default: { return 0.9; }
  }
}

// terrain mask mA.y = pillar top height / 600 m over the pillar footprint (0 off pillars); canopy rises ~5 m above
fn onPillarTop(m: f32, y: f32) -> f32 {
  let top = m * 600.0;
  return select(0.0, 1.0, top > 1.0 && y > top - 2.5);
}

// gullies and hollows from the clipmap's concavity channel (aux, normalised per level), 0..1
fn gully(p: vec2f) -> f32 {
  let lc = clipLevel(p, 5u, 4.0);
  return sstep(0.02, 0.3, clipS(lc, p).w / FR.lv[lc].z);
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

// mushroom height and cap radius (shared by the lathe and the light pools)
fn mushHR(I: Inst) -> vec2f {
  let r2 = lfRand(I.h, 22u); let r3 = lfRand(I.h, 23u);
  var H = 2.5 + 9.0 * r2 * r2 * r2;
  if (I.x > 0.5) { H = 25.0 + 15.0 * r2; }
  return vec2f(H, H * select(0.28 + 0.22 * r3, 0.36 + 0.14 * r3, I.x > 0.5));
}

var<private> PRW: RWt;
fn lrow(f: u32) -> vec4f { return bf(PRW, f); }

fn place(L: u32, li: u32) -> Inst {
  var I: Inst; I.ok = false; I.x = 0.0; I.hy = 0.0;
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
  // The Drift: the realm row at the instance's own position (not the camera's), so both realms' life coexists
  // and thins out through each other across a border zone, and nothing pops when the camera crosses it
  PRW = realmWeights(p2);
  let v0 = lrow(V0); let v1 = lrow(V1);
  // hybrids peak at the middle of a two-realm zone
  let zone = 4.0 * PRW.w.x * (1.0 - PRW.w.x);
  // kind from the realm weights (no texture fetch yet: zero-weight kinds cost one hash)
  var kind = 99u;
  if (cls == 0u) { let k = pick(u, vec4f(v0.x, v0.w, v1.x, v1.y)); if (k == 0) { kind = K_GRASS; } else if (k == 1) { kind = K_TUSSOCK; } else if (k == 2) { kind = K_REED; } else if (k == 3) { kind = K_FERN; } }
  else if (cls == 1u) { if (u < v0.y) { kind = K_FLOWER; } }
  else if (cls == 2u) { if (u < v1.z) { kind = select(K_STALK, K_TENDRIL, lfRand(h, 9u) > 0.62); } }
  else if (cls == 3u) { let k = pick(u, vec4f(v1.z, v1.y, 0.0, 0.0)); if (k == 0) { kind = K_MUSH; } else if (k == 1) { kind = K_CROWN; } }
  else if (cls == 4u) { let k = pick(u, vec4f(v1.z, v1.w, 0.0, 0.0)); if (k == 0) { kind = K_CRYSTAL; } else if (k == 1) { kind = K_SHARD; } }
  else if (cls == 5u) { let k = pick(u, vec4f(v0.x, v0.w, v1.y * lrow(V4).w, 0.0)); if (k == 0) { kind = K_TUFT; I.x = 0.0; } else if (k == 1) { kind = K_TUFT; I.x = -1.0; } else if (k == 2) { kind = K_VINE; } }
  else { if (u < lrow(V4).z * 0.35) { kind = K_MUSH; I.x = 1.0; } } // giant mushrooms, landmarks from afar
  if (kind == 99u) { return I; }

  let lv = clipLevel(p2, 0u, 8.0);
  let s = clipS(lv, p2);
  I.p = vec3f(p2.x, s.x, p2.y); I.g = s.yz;
  let d = length(I.p - cam);
  var fade = sstep(lb.w, lb.z, d);
  if (kind == K_MUSH && L == 6u) { fade = sstep(122.0, 90.0, d); } // mushrooms share the crown layer, nearer reach
  if (lb.y > 0.0 && kind != K_VINE) { fade *= sstep(lb.x, lb.y, d); }
  if (fade <= 0.002) { return I; }
  var rad = kindRadius(kind) * select(1.0, 2.5, cls == 0u && L == 2u);
  if (cls == 6u) { rad = 45.0; }
  if (!lfVisible(I.p - cam + vec3f(0.0, rad * 0.5, 0.0), rad)) { return I; }
  let slope = 1.0 - inverseSqrt(1.0 + dot(s.yz, s.yz));
  let y = s.x;
  var keep = 0.0;
  var alb = vec3f(0.2);

  if (kind == K_TUFT && I.x < 0.0) {
    // far dry clumps (Painted Range): gullies
    let nM = fbm(p2 * (1.0 / 41.0), 2, 210u);
    let veg = sstep(0.22, 0.08, slope) * sstep(-0.1, 0.4, nM + 0.25) * select(1.0, 0.0, y < 1.0);
    keep = veg * (0.06 + 0.9 * gully(p2));
    alb = mix(vec3f(0.36, 0.28, 0.13), vec3f(0.22, 0.24, 0.16), lfRand(h, 7u));
  } else if (kind == K_GRASS || kind == K_FLOWER || kind == K_TUFT) {
    let nM = fbm(p2 * (1.0 / 41.0), 2, 210u);
    let rockT = sstep(0.2 + 0.1 * nM, 0.36 + 0.1 * nM, slope);
    let shore = sstep(lrow(M3).w + 0.4, lrow(M3).w + 1.6, y + 0.5 * vn(p2 * 0.3, 813u));
    let high = sstep(lrow(M2).w + 60.0, lrow(M2).w - 40.0, y);
    let base = (1.0 - rockT) * shore * high;
    if (kind == K_TUFT) {
      // far impostor tufts: thin out with distance (they grow in the vertex shader), flower colour in the drifts
      keep = base * (0.55 + 0.45 * sstep(-0.35, 0.35, vn(p2 * (1.0 / 9.0), 811u))) * clamp(90.0 / d, 0.4, 1.0);
      I.hy = lrow(M4).x;
      alb = lfGrassAlb(p2, lrow(M0));
      let drift = sstep(0.2, 0.6, vn(p2 * (1.0 / 23.0), 251u)) * v0.y * 0.45;
      let c = vn(p2 * (1.0 / 9.0), 252u);
      var code = 1.0;
      if (c > 0.08) { code = 2.0; }
      if (c > 0.42 || c < -0.55) { code = 3.0; }
      I.x = select(0.0, code + min(drift, 0.99), drift > 0.05);
    } else if (kind == K_GRASS) {
      let clump = 0.45 + 0.55 * sstep(-0.35, 0.35, vn(p2 * (1.0 / 2.1), 811u));
      keep = base * clump;
      alb = lfGrassAlb(p2, lrow(M0));
      I.hy = lrow(M4).x; // toward the Painted Range the tips take the strata colours
      let heath = sstep(0.06, 0.15, slope + 0.07 * vn(p2 * (1.0 / 17.0), 812u)) * v0.z;
      if (lfRand(h, 5u) < heath * 0.85) { kind = K_HEATHER; }
    } else {
      // sparse, as in a grazed Faroese hayfield: a few flowers per square metre inside loose drifts
      let drift = sstep(0.2, 0.6, vn(p2 * (1.0 / 23.0), 251u));
      keep = base * drift * 0.32;
      I.hy = lrow(M4).w; // toward Aurora Ice: frost on the petals
      // drifts of one colour: yellow, white, violet
      let c = vn(p2 * (1.0 / 9.0), 252u) + 0.35 * (lfRand(h, 6u) - 0.5);
      alb = vec3f(0.95, 0.62, 0.04);
      if (c > 0.08) { alb = vec3f(0.86, 0.86, 0.8); }
      if (c > 0.42 || c < -0.55) { alb = vec3f(0.22, 0.12, 0.85); }
      alb *= 0.8; // measured-range petal albedo
    }
  } else if (kind == K_TUSSOCK) {
    let nM = fbm(p2 * (1.0 / 41.0), 2, 210u);
    // fewer, larger, drier clumps gathered in the gullies; constant density per m2 over the layers
    let veg = sstep(0.22, 0.08, slope) * sstep(-0.1, 0.4, nM + 0.25) * select(1.0, 0.0, y < 1.0);
    keep = veg * (0.05 + 0.95 * gully(p2)) * min(1.0, 0.32 * cell * cell);
    alb = mix(vec3f(0.36, 0.28, 0.13), vec3f(0.22, 0.24, 0.16), lfRand(h, 7u)) * (0.85 + 0.3 * lfRand(h, 9u));
    if (lfRand(h, 8u) < 0.25) { kind = K_SHRUB; alb = vec3f(0.16, 0.18, 0.12) * (0.7 + 0.5 * lfRand(h, 7u)); }
  } else if (kind == K_REED) {
    I.mB = clipMB(lv, p2);
    let isl = sstep(0.05, 0.25, I.mB.z) * sstep(0.02, 0.15, y);
    // dream hybrid: toward the Mirror, reeds stand in its first centimetres of water
    let mir = lrow(M4).y;
    let shallow = zone * sstep(0.05, 0.6, mir) * sstep(-0.25, -0.02, y) * sstep(0.12, 0.0, y);
    if (y < 3.5) { keep = max(isl * 0.85 * sstep(3.5, 2.0, y), shallow * 0.7); alb = mix(vec3f(0.16, 0.17, 0.06), vec3f(0.36, 0.28, 0.12), lfRand(h, 7u)); }
    else { kind = K_TUSSOCK; keep = isl * 0.28 * sstep(0.4, 0.2, slope); alb = mix(vec3f(0.26, 0.2, 0.09), vec3f(0.14, 0.16, 0.06), lfRand(h, 7u)); }
  } else if (kind == K_FERN) {
    I.mA = clipMA(lv, p2);
    keep = sstep(0.42, 0.25, slope) * mix(0.55, 0.9, onPillarTop(I.mA.y, y)) * sstep(0.0, 1.0, y);
    alb = lrow(M0).rgb * mix(vec3f(0.45, 0.55, 0.38), vec3f(0.8, 0.78, 0.5), lfRand(h, 7u));
  } else if (kind == K_STALK || kind == K_TENDRIL) {
    I.mB = clipMB(lv, p2); I.mA = clipMA(lv, p2);
    let pch = sstep(-0.15, 0.45, vn(p2 * (1.0 / 16.0), 821u));
    keep = (0.12 + 0.8 * pch + 0.5 * I.mA.w) * sstep(0.25, 0.0, I.mB.y) * sstep(0.2, 0.8, y) * sstep(0.45, 0.25, slope);
  } else if (kind == K_MUSH) {
    I.mB = clipMB(lv, p2);
    let pch = sstep(-0.3, 0.5, vn(p2 * (1.0 / 60.0), 822u));
    keep = select(0.04 + 0.22 * pch, 1.0, cls == 6u) * sstep(0.1, 0.0, I.mB.y) * sstep(0.5, 1.5, y) * sstep(0.35, 0.2, slope);
  } else if (kind == K_VINE) {
    // vines over the rim of a pillar top: the ground falls away within 3.5 m in some direction
    I.mA = clipMA(lv, p2);
    if (onPillarTop(I.mA.y, y) > 0.5) {
      var lo = 1e9; var dir = 0.0;
      for (var i = 0; i < 6; i++) {
        let a = f32(i) * 1.0472 + lfRand(h, 14u);
        let hh = heightAny(p2 + vec2f(cos(a), sin(a)) * 3.5);
        if (hh < lo) { lo = hh; dir = a; }
      }
      keep = 0.75 * sstep(5.0, 12.0, y - lo);
      I.x = dir;
      alb = lrow(M0).rgb * mix(vec3f(0.42, 0.55, 0.36), vec3f(0.6, 0.66, 0.4), lfRand(h, 7u));
    }
  } else if (kind == K_CROWN) {
    I.mA = clipMA(lv, p2);
    keep = sstep(0.32, 0.18, slope) * mix(0.35, 0.95, onPillarTop(I.mA.y, y)) * sstep(0.5, 2.0, y);
    // varied greens by patch and tree: deep, yellow-green, blue-green (relative to the realm's ground green)
    let hv = vn(p2 * (1.0 / 30.0), 842u) + 0.6 * (lfRand(h, 7u) - 0.5);
    var tint = vec3f(0.36, 0.44, 0.3);
    tint = mix(tint, vec3f(0.66, 0.66, 0.38), sstep(0.15, 0.45, hv));
    tint = mix(tint, vec3f(0.3, 0.42, 0.38), sstep(-0.2, -0.5, hv));
    alb = lrow(M0).rgb * tint * (0.85 + 0.3 * lfRand(h, 9u));
    if (lfRand(h, 12u) < 0.12) { I.x = 1.0; } // emergent tree above the canopy
  } else if (kind == K_CRYSTAL) {
    I.mB = clipMB(lv, p2);
    keep = (0.06 + 0.9 * sstep(0.0, 0.6, I.mB.y)) * sstep(0.2, 0.6, y);
  } else if (kind == K_SHARD) {
    I.mB = clipMB(lv, p2);
    keep = 0.4 * sstep(0.15, 0.6, y) * sstep(3.5, 2.0, y) * sstep(0.3, 0.05, I.mB.w) * sstep(0.3, 0.15, slope);
  }
  if (u2 >= keep) { return I; }
  I.kind = kind; I.alb = alb; I.d = d; I.fade = fade;
  I.sh = select(0.4, rad * 0.4, cls == 3u || cls == 4u) + 0.15; // shadow probe height; the prepass marches it
  I.ok = true;
  return I;
}

