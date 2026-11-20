// composite.wgsl: water, cloud-sea slab and fog/cloud composite over the resolved opaque scene (sky.wgsl first).

@group(2) @binding(0) var sceneT: texture_2d<f32>;
@group(2) @binding(1) var distT: texture_2d<f32>;
@group(2) @binding(2) var cloudT: texture_2d<f32>;
@group(2) @binding(3) var linS: sampler;

@group(2) @binding(4) var cloudR: texture_2d<f32>;
@group(2) @binding(5) var cloudD: texture_2d<f32>;

// ---- clouds: depth-aware upsample of the half-res (1/3 in VR) cloud pass (front clouds + clouds in the mirror) ----
var<private> gRC: vec4f; // mirrored clouds for this pixel, read by reflectRay's sky branch

struct CUp { front: vec4f, refl: vec4f }
// 3x3 half-res neighbourhood: a small Gaussian (it also averages out the march jitter) times a depth weight
fn cloudUp(pix: vec2f, dist: f32) -> CUp {
  let hs = vec2i(textureDimensions(cloudT));
  let S = max(round(VW.size.x / f32(hs.x)), 1.0); // 2 (half res), 4 (quarter, quality=low) or 3 (VR)
  let ic = vec2i(floor(pix / S));
  var o: CUp;
  o.front = vec4f(0.0); o.refl = vec4f(0.0);
  var ws = 0.0; var best = 1e9;
  var nf = vec4f(0.0); var nr = vec4f(0.0);
  for (var k = 0; k < 9; k++) {
    let off = vec2i(k % 3 - 1, k / 3 - 1);
    let q = clamp(ic + off, vec2i(0), hs - 1);
    let dp = ((vec2f(q) + 0.5) * S - pix) / S;
    let wb = exp(-dot(dp, dp) * 1.1);
    let dq = textureLoad(cloudD, q, 0).x;
    let rel = abs(dq - dist) / max(min(dq, dist), 1.0);
    let wd = 1.0 / (1.0 + rel * 24.0);
    let w = wb * wd * wd;
    let cf = textureLoad(cloudT, q, 0); let cr = textureLoad(cloudR, q, 0);
    o.front += cf * w; o.refl += cr * w; ws += w;
    if (rel < best) { best = rel; nf = cf; nr = cr; }
  }
  if (ws < 0.01) { o.front = nf; o.refl = nr; } else { o.front /= ws; o.refl /= ws; }
  return o;
}

// screen-space sun shafts: radial march toward the sun over the open sky left by clouds and terrain
fn sunShafts(uv: vec2f, jit: f32) -> f32 {
  let L = FR.sun.xyz;
  if (L.y < -0.04) { return 0.0; }
  let cs = VW.vp * vec4f(L * 1000.0, 1.0);
  if (cs.w <= 0.0) { return 0.0; }
  let su = vec2f(cs.x / cs.w * 0.5 + 0.5, 0.5 - cs.y / cs.w * 0.5);
  var dl = su - uv;
  let len = length(dl * vec2f(VW.size.x * VW.size.w, 1.0));
  if (len > 1.4) { dl *= 1.4 / len; }
  let NS = 20;
  let st = dl / f32(NS);
  var p = uv + st * jit;
  var acc = 0.0; var wsum = 0.0; var dec = 1.0;
  for (var i = 0; i < NS; i++) {
    let q = clamp(p, vec2f(0.001), vec2f(0.999));
    let sky = sstep(30000.0, 55000.0, textureSampleLevel(distT, linS, q, 0.0).x);
    let cl = textureSampleLevel(cloudT, linS, q, 0.0).a;
    acc += sky * (1.0 - cl) * dec; wsum += dec;
    dec *= 0.95;
    p += st;
  }
  return acc / wsum;
}

// ---- water ----
// slope variance of the wave octaves filtered out at this pixel: added to the sun-glint roughness, so the
// glitter path keeps its energy and width at distance instead of shrinking to a few aliased sparkles
var<private> WVAR: f32 = 0.0;

fn waveN(p: vec2f, amp: f32, foot: f32) -> vec3f {
  // band-limited: each octave fades out once its wavelength nears the pixel footprint (no moire)
  let tm = FR.time.x;
  var g = vec2f(0.0);
  var a = 1.0; var f = 0.06;
  var dir = vec2f(0.8, 0.6);
  var lost = 0.0;
  for (var i = 0; i < 7; i++) {
    let wl = 6.2832 / f;
    let bl = sstep(6.0 * foot, 2.0 * foot, wl);
    let ph = dot(p, dir) * f + tm * sqrt(9.8 * f);
    g += dir * cos(ph) * a * f * (1.0 - bl);
    let sa = a * f * 0.3 * amp;
    lost += sa * sa * 0.5 * bl;
    dir = vec2f(dir.x * -0.737 - dir.y * 0.676, dir.x * 0.676 - dir.y * 0.737);
    a *= 0.7; f *= 1.73;
  }
  let nb = sstep(0.5, 0.15, foot);
  let nd = vnoised(p * 0.9 + vec2f(tm * 0.4, tm * 0.25), 540u).yz * 0.06 * nb;
  lost += (0.06 * amp) * (0.06 * amp) * 0.3 * (1.0 - nb);
  WVAR = lost;
  g = (g * 0.3 + nd) * amp;
  return normalize(vec3f(-g.x, 1.0, -g.y));
}

// irregular salt polygons (same pattern as terrain.wgsl saltEdge): distance to the cell edge in cell units
fn saltEdgeW(xz: vec2f) -> f32 {
  let q = xz * (1.0 / 2.1);
  let g = floor(q);
  var d1 = 9.0; var d2 = 9.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let ci = i32(g.x) + i; let cj = i32(g.y) + j;
      let pt = vec2f(f32(ci), f32(cj)) + 0.1 + 0.8 * vec2f(hf(ci, cj, 410u), hf(ci, cj, 411u));
      let d = length(q - pt);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return (d2 - d1) * 0.5;
}

// march the height clipmaps along a reflected ray; returns hit colour or sky
fn reflectRay(P: vec3f, R: vec3f, rw: RWt, pix: f32) -> vec3f {
  var t = 1.0 + length(P - VW.cam.xyz) * 0.003;
  var lv = clipLevel(P.xz, 0u, 8.0);
  var hit = false; var hp = vec3f(0.0);
  for (var i = 0; i < 28; i++) {
    let q = P + R * t;
    if (q.y > 1200.0) { break; }
    lv = clipLevel(q.xz, lv, 8.0);
    let h = clipH(lv, q.xz);
    if (q.y < h) { hit = true; hp = q; break; }
    t = t * 1.2 + 1.0;
  }
  var c: vec3f;
  if (hit) {
    // cheap terrain shade in the reflection
    let l = clipLevel(hp.xz, 0u, 8.0);
    let cd = clipS(l, hp.xz);
    let n = normalize(vec3f(-cd.y, 1.0, -cd.z));
    let rq = realmWeights(hp.xz);
    let m0 = bf(rq, M0).rgb; let m1 = bf(rq, M1).rgb;
    let mb = clipMB(l, hp.xz); let ma = clipMA(l, hp.xz);
    var alb = mix(m0, m1, sstep(0.25, 0.5, 1.0 - n.y));
    let m4 = bf(rq, M4);
    alb = mix(alb, vec3f(0.55, 0.25, 0.1), m4.x * 0.7);
    alb = mix(alb, vec3f(0.75, 0.85, 0.92), mb.w * m4.w);
    alb = mix(alb, bf(rq, M2).rgb, sstep(bf(rq, M2).w - 50.0, bf(rq, M2).w + 50.0, hp.y));
    let L = sunDirFrom(bf(rq, S0), FR.sun.w);
    let s1 = bf(rq, S1); let s0 = bf(rq, S0);
    let sc = s1.rgb * s0.z * sstep(-0.035, 0.06, L.y);
    let I = rowv(S3).w;
    let amb = mix(rowv(S3).rgb, rowv(S2).rgb, 0.55) * I * rowv(S6).x + rowv(S7).rgb * rowv(S7).w;
    c = alb * (sc * max(dot(n, L), 0.0) * 0.8 + amb);
    let m6 = bf(rq, M6);
    c += m6.rgb * m6.w * (mb.y + mb.x + ma.w * 0.5) * 0.8;
    c = applyFog(c, P, R, t);
  } else {
    c = skyFull(R, pix);
    c = c * (1.0 - gRC.a) + gRC.rgb; // clouds in the mirror (marched by the cloud pass)
  }
  return c;
}

struct VO { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment fn fs(in: VO) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let uv = in.pos.xy * VW.size.zw;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let d = viewRay(in.pos.xy);
  let ro = VW.cam.xyz;
  let pix = 2.0 * VW.fwd.w * VW.size.w;
  let jit = ign(in.pos.xy);
  var dist = textureLoad(distT, px, 0).x;
  var cu = cloudUp(in.pos.xy, dist);
  if (VW.cam.w == 9.0) { cu.front = vec4f(0.0); cu.refl = vec4f(0.0); } // dbg=9: no clouds
  gRC = cu.refl;
  let isSky = dist > 50000.0;
  if (isSky) { dist = 1e9; }
  var col = textureLoad(sceneT, px, 0).rgb;

  var tEnd = dist;
  // water plane at sea level
  if (ro.y > 0.0 && d.y < 0.0 && (VW.cam.w == 0.0 || VW.cam.w >= 5.0) && !isOff(OFF_WATER)) {
    let tw = ro.y / -d.y;
    // r16float distance is quantised (0.5 m at 1 km): allow for it, or 4 cm of water flickers in and out
    if (tw < dist + max(0.6, dist * 0.0015)) {
      tEnd = tw;
      let P = ro + d * tw;
      let rw = realmWeights(P.xz);
      let w0 = bf(rw, W0); let w1 = bf(rw, W1); let w2 = bf(rw, W2);
      let foot = tw * pix / max(-d.y, 0.05);
      var n = waveN(P.xz, w0.w, foot);
      let V = -d;
      // Mirror Salt: raised polygon rims of salt just under the sheet, seen with a few cm of parallax;
      // the meniscus over each rim breaks the mirror slightly
      var saltRim = 0.0;
      if (w2.w > 0.45 && tw < 140.0) {
        let depth0 = 0.03;
        let off = d.xz / max(-d.y, 0.08) * depth0 * 0.75;
        let pr = P.xz + off;
        let ed = saltEdgeW(pr);
        let ew = max(0.035, foot * 0.6 / 2.1);
        saltRim = (1.0 - sstep(ew * 0.4, ew, ed)) * (0.035 / ew) * sstep(140.0, 40.0, tw);
        let e1 = saltEdgeW(pr + vec2f(0.05, 0.0)); let e2 = saltEdgeW(pr + vec2f(0.0, 0.05));
        let gr = vec2f(e1 - ed, e2 - ed) * (1.0 / 0.05);
        n = normalize(n + vec3f(gr.x, 0.0, gr.y) * saltRim * 0.05);
      }
      let ndv = max(dot(n, V), 0.0);
      let fr = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
      let refl = max(fr, w2.w * (1.0 - 0.3 * saltRim));
      var R = reflect(d, n);
      R.y = abs(R.y);
      var rc = reflectRay(P, R, rw, pix);
      // sun glitter: base roughness widened by the filtered wave slopes (a path under the sun, sparkles close up)
      let L = FR.sun.xyz;
      let hv = normalize(L + V);
      let r0 = max(w1.w, 0.02);
      let a2 = r0 * r0 * r0 * r0 + WVAR * 2.0;
      let nh = max(dot(n, hv), 0.0);
      let dd = nh * nh * (a2 - 1.0) + 1.0;
      rc += sunCol() * min(a2 / (PI * dd * dd) * 0.25, 60.0) * sstep(0.0, 0.05, L.y) * cloudShadow(P, L, rw);
      // refraction + absorption
      // water depth from the height clipmap (r16 scene depth is too coarse for 4 cm of water)
      let depth = max(-heightAny(P.xz), 0.0);
      let thick = min(dist - tw, depth / max(-d.y, 0.02));
      let ruv = clamp(uv + n.xz * 0.04 * min(depth, 4.0) / (1.0 + tw * 0.02), vec2f(0.0), vec2f(1.0));
      var under = textureSampleLevel(sceneT, linS, ruv, 0.0).rgb;
      let dist2 = textureSampleLevel(distT, linS, ruv, 0.0).x;
      if (dist2 + max(0.6, dist2 * 0.0015) < tw) { under = col; }
      if (isSky) { under = vec3f(0.0); }
      let path = min(thick, 400.0);
      let tr = exp(-w0.rgb * path);
      let I = rowv(S3).w;
      // in-water scattering: lit by the sky dome and the sun (a lit body of water, not a black hole)
      let scat = w1.rgb * (mix(rowv(S3).rgb, rowv(S2).rgb, 0.5) * I * 1.1 + sunCol() * max(L.y, 0.0) * 0.6 + rowv(S7).rgb * rowv(S7).w);
      var wcol = under * tr + (scat + w2.rgb * 0.6) * (1.0 - tr);
      wcol = mix(wcol, vec3f(0.75, 0.73, 0.7) * (mix(rowv(S3).rgb, rowv(S2).rgb, 0.4) * I + sunCol() * max(L.y, 0.0) * 0.5), saltRim * 0.25);
      // foam at the shore
      let foamAmt = rowv(G3).w;
      let fz = sstep(1.2, 0.0, depth + 0.3 * vn(P.xz * 0.3 + vec2f(FR.time.x * 0.3, 0.0), 550u));
      let fn1 = sstep(0.1, 0.6, vn(P.xz * 1.7 + vec2f(0.0, FR.time.x * 0.5), 551u) * 0.5 + 0.5 * fz);
      let foam = fz * fn1 * foamAmt * bf(rw, G3).w;
      wcol = mix(wcol, vec3f(0.8) * (sunCol() * 0.25 + mix(rowv(S3).rgb, rowv(S2).rgb, 0.5) * I), foam * 0.6);
      col = mix(wcol, rc, refl * (1.0 - foam));
      if (VW.cam.w == 5.0) { col = rc; }
      if (VW.cam.w == 6.0) { col = wcol; }
      if (VW.cam.w == 7.0) { col = n * 0.5 + 0.5; }
          }
  }

  // fog over the visible distance (sky gets it toward the horizon only)
  if ((!isSky || tEnd < 1e8) && VW.cam.w != 8.0) { col = applyFog(col, ro, d, tEnd); }
  // under the cloud sea: the sky light is mostly gone (sun is handled by cloudShadow in the terrain)
  let c1 = rowv(C1);
  if (c1.w > 0.01 && !isSky) {
    let P = ro + d * tEnd;
    let sb = rowv(C2).x / c1.w;
    let us = sstep(sb + 25.0, sb - 15.0, P.y) * c1.w;
    col *= mix(vec3f(1.0), vec3f(0.5, 0.56, 0.52), us);
  }
  // volumetric clouds in front of whatever we hit (aerial perspective is already in them)
  col = col * (1.0 - cu.front.a) + cu.front.rgb;
  // sun shafts: in-scattered sun along open lines of sight toward the sun, scaled by the air in front
  let mu = dot(d, FR.sun.xyz);
  let ph = hg(mu, 0.8) * 0.5;
  if (ph > 0.004 && VW.cam.w != 8.0) {
    let air = 1.0 - exp(-min(tEnd, 30000.0) * (rowv(F0).w * 3.0 + rowv(F1).w * 0.2));
    let sh = sunShafts(uv, jit);
    col += sunCol() * sh * ph * sstep(0.004, 0.03, ph) * air * rowv(F2).w * 0.35;
  }
  return vec4f(col, 1.0);
}
