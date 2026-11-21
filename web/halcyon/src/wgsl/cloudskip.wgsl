// cloudskip.wgsl (sky programmer): empty-space maps for the cloud march, baked right after the weather window
// (fx/clouds.js, same compute pass). Fine: one texel per 8x8 window texels (1 km), dilated by one texel so the
// bilinear window fetch near a block edge is covered. Coarse: one texel per 4x4 fine texels (4 km).
// rgba: max main coverage, min base, max top (of texels with coverage), max cloud-sea amount.
@group(1) @binding(0) var sWx: texture_2d<f32>;
@group(1) @binding(1) var sWy: texture_2d<f32>;
@group(1) @binding(2) var sOutF: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var sInF: texture_2d<f32>;
@group(1) @binding(4) var sOutC: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8) fn csSkipF(@builtin(global_invocation_id) id: vec3u) {
  let nf = textureDimensions(sOutF).x;
  if (id.x >= nf || id.y >= nf) { return; }
  let n = i32(textureDimensions(sWx).x);
  let B = n / i32(nf);
  let b0 = vec2i(id.xy) * B - 1;
  var mc = 0.0; var mb = 60000.0; var mt = -1000.0; var ms = 0.0;
  for (var z = 0; z < B + 2; z++) {
    for (var x = 0; x < B + 2; x++) {
      let q = clamp(b0 + vec2i(x, z), vec2i(0), vec2i(n - 1));
      let w = textureLoad(sWx, q, 0);
      if (w.x > 0.004) { mc = max(mc, w.x); mb = min(mb, w.y); mt = max(mt, w.z); }
      ms = max(ms, textureLoad(sWy, q, 0).z);
    }
  }
  textureStore(sOutF, id.xy, vec4f(mc, mb, mt, ms));
}

@compute @workgroup_size(4, 4) fn csSkipC(@builtin(global_invocation_id) id: vec3u) {
  let nc = textureDimensions(sOutC).x;
  if (id.x >= nc || id.y >= nc) { return; }
  let nf = textureDimensions(sInF).x;
  let B = nf / nc;
  var o = vec4f(0.0, 60000.0, -1000.0, 0.0);
  for (var z = 0u; z < B; z++) {
    for (var x = 0u; x < B; x++) {
      let s = textureLoad(sInF, vec2u(id.xy * B + vec2u(x, z)), 0);
      o = vec4f(max(o.x, s.x), min(o.y, s.y), max(o.z, s.z), max(o.w, s.w));
    }
  }
  textureStore(sOutC, id.xy, o);
}
