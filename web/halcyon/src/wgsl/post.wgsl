// post.wgsl: bloom chain (13-tap down, tent up), then exposure, tone map, grade, vignette, dither, P3.

@group(1) @binding(0) var srcT: texture_2d<f32>;
@group(1) @binding(1) var srcS: sampler;
@group(1) @binding(2) var bloomT: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  o.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(uv.x, 1.0 - uv.y);
  return o;
}

fn tx(uv: vec2f) -> vec3f { return textureSampleLevel(srcT, srcS, uv, 0.0).rgb; }

@fragment fn fsDown(in: VO) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(srcT));
  let uv = in.uv;
  let a = tx(uv + ts * vec2f(-2.0, -2.0)); let b = tx(uv + ts * vec2f(0.0, -2.0)); let c = tx(uv + ts * vec2f(2.0, -2.0));
  let d = tx(uv + ts * vec2f(-2.0, 0.0)); let e = tx(uv); let f = tx(uv + ts * vec2f(2.0, 0.0));
  let g = tx(uv + ts * vec2f(-2.0, 2.0)); let h = tx(uv + ts * vec2f(0.0, 2.0)); let i = tx(uv + ts * vec2f(2.0, 2.0));
  let j = tx(uv + ts * vec2f(-1.0, -1.0)); let k = tx(uv + ts * vec2f(1.0, -1.0));
  let l = tx(uv + ts * vec2f(-1.0, 1.0)); let m = tx(uv + ts * vec2f(1.0, 1.0));
  var o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  o = min(o, vec3f(400.0)); // tame the sun disc
  return vec4f(o, 1.0);
}

// upsample the smaller level (srcT) with a tent and add the current level (bloomT)
@fragment fn fsUp(in: VO) -> @location(0) vec4f {
  let ts = 1.0 / vec2f(textureDimensions(srcT));
  let uv = in.uv;
  var s = tx(uv) * 4.0;
  s += (tx(uv + vec2f(ts.x, 0.0)) + tx(uv - vec2f(ts.x, 0.0)) + tx(uv + vec2f(0.0, ts.y)) + tx(uv - vec2f(0.0, ts.y))) * 2.0;
  s += tx(uv + ts) + tx(uv - ts) + tx(uv + vec2f(ts.x, -ts.y)) + tx(uv + vec2f(-ts.x, ts.y));
  s *= 1.0 / 16.0;
  let cur = textureSampleLevel(bloomT, srcS, uv, 0.0).rgb;
  return vec4f(cur + s * 0.85, 1.0);
}

// Khronos PBR Neutral
fn neutral(c0: vec3f) -> vec3f {
  let start = 0.8 - 0.04; let desat = 0.15;
  var c = c0;
  let x = min(c.r, min(c.g, c.b));
  let off = select(0.04, x - 6.25 * x * x, x < 0.08);
  c -= off;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  let g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3f(np), g);
}

// AgX base + punchy look
fn agx(c0: vec3f) -> vec3f {
  let m = mat3x3f(0.842479, 0.0423282, 0.0423756, 0.0784336, 0.878468, 0.0784336, 0.0792237, 0.0791661, 0.879142);
  let mi = mat3x3f(1.19688, -0.0528969, -0.0529716, -0.0980209, 1.15190, -0.0980435, -0.0990297, -0.0989612, 1.15107);
  var c = m * max(c0, vec3f(1e-10));
  c = clamp(log2(c), vec3f(-12.47393), vec3f(4.026069));
  c = (c + 12.47393) / 16.5;
  let x2 = c * c; let x4 = x2 * x2;
  c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
  // punchy
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = l + 1.25 * (c - l);
  c = pow(max(c, vec3f(0.0)), vec3f(1.12));
  c = mi * c;
  // back to linear for the shared encode
  return pow(max(c, vec3f(0.0)), vec3f(2.2));
}

fn oetf(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment fn fsFinal(in: VO) -> @location(0) vec4f {
  // in.uv is over this view's viewport
  let uv = (in.pos.xy - VW.ofs.xy) / VW.ofs.zw;
  var c = textureSampleLevel(srcT, srcS, uv, 0.0).rgb;
  let b = textureSampleLevel(bloomT, srcS, uv, 0.0).rgb * (1.0 / 5.5);
  let g0 = FR.row[G0]; let g1 = FR.row[G1]; let g2 = FR.row[G2]; let g3 = FR.row[G3];
  c = mix(c, b, g2.w);
  c *= exp2(g0.x);
  // misc.w bits: 1 = Display-P3 output, 2 = HDR canvas (toneMapping 'extended'): keep HR x SDR white of headroom
  let mw = u32(FR.misc.w + 0.5);
  var HR = 1.0;
  if ((mw & 2u) != 0u) { HR = 2.5; c *= 1.0 / HR; }
  // tone map: blend Neutral and AgX by the realm row
  let tn = neutral(c);
  var t = tn;
  if (g0.w > 0.01) { t = mix(tn, agx(c), g0.w); }
  t = clamp(t, vec3f(0.0), vec3f(1.0));
  // grade: saturation, contrast, lift/gamma/gain
  let l = dot(t, vec3f(0.2126, 0.7152, 0.0722));
  t = max(mix(vec3f(l), t, g0.y), vec3f(0.0));
  t = clamp((t - 0.18) * g0.z + 0.18 + (t - 0.18) * 0.0, vec3f(0.0), vec3f(1.0));
  t = t * g2.rgb + g1.rgb * (1.0 - t);
  t = pow(max(t, vec3f(0.0)), 1.0 / max(g3.rgb, vec3f(0.2)));
  // vignette
  let q = uv * 2.0 - 1.0;
  let asp = VW.ofs.z / VW.ofs.w;
  let v = 1.0 - g1.w * 0.22 * pow(dot(q * vec2f(asp * 0.75, 1.0), q * vec2f(asp * 0.75, 1.0)) * 0.5, 1.3);
  t *= v;
  // Display-P3: convert linear sRGB primaries to P3
  if ((mw & 1u) != 0u) {
    t = mat3x3f(0.8225, 0.0332, 0.0171, 0.1774, 0.9669, 0.0724, 0.0, 0.0, 0.9108) * t;
  }
  // HDR: the graded image fills [0, 1] of the shoulder-compressed range; scale it back up into the headroom
  t = clamp(t, vec3f(0.0), vec3f(1.0)) * HR;
  var e = oetf(t);
  // triangular dither
  let n1 = ign(in.pos.xy); let n2 = ign(in.pos.xy + vec2f(17.0, 59.0));
  e += (n1 + n2 - 1.0) / 255.0;
  return vec4f(e, 1.0);
}
