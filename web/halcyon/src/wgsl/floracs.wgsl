// floracs.wgsl: flora placement prepass. One thread per grid cell of every layer (threads laid out layer after
// layer); an accepted instance appends a 64-byte record to its layer's sub-range of FI and bumps that layer's
// instanceCount in FA, which is the indirect draw-args buffer (4 u32 per layer: vertexCount, instanceCount, 0, 0).
// FA is cleared by the encoder before this pass; the first thread of a layer sets its vertexCount.
@group(2) @binding(0) var<storage, read_write> FI: array<vec4f>;
@group(2) @binding(1) var<storage, read_write> FA: array<atomic<u32>>;
@group(2) @binding(2) var<uniform> FM: vec4u; // x: layers enabled this frame, y: ablation bits (OFF_* in common.wgsl)

@compute @workgroup_size(64) fn cs(@builtin(global_invocation_id) gid: vec3u) {
  let g = gid.x;
  var L = 0u; var start = 0u; var base = 0u;
  loop {
    let n = u32(LA[L].y); let c = n * n;
    if (g < start + c) { break; }
    start += c; base += (c + 3u) & ~3u; L += 1u;
    if (L >= NL) { return; }
  }
  if ((FM.x & (1u << L)) == 0u) { return; }
  let li = g - start;
  let I = place(L, li);
  if (!I.ok) { return; }
  // sun shadow once per instance (10-step march over the clipmap, then cloud shadow)
  var I2 = I;
  let pr = I.p + vec3f(0.0, I.sh, 0.0);
  // off=fshadow: no sun-shadow march (cloud shadow kept)
  if ((FM.y & OFF_FSHADOW) != 0u) { I2.sh = select(0.0, lfCloudShadow(pr), FR.sun.y > -0.03); }
  else { I2.sh = lfShadow(pr, I.d, lfRand(I.h, 11u), 10); }
  atomicMax(&FA[L * 4u], select(LV[L], latheVerts(I.kind), L == 6u || L == 9u));
  let k = atomicAdd(&FA[L * 4u + 1u], 1u);
  let o = (base + k) * 4u;
  FI[o] = vec4f(I.p, I.fade);
  FI[o + 1u] = vec4f(I.g, I2.sh, I.cell);
  FI[o + 2u] = vec4f(I.alb, I.d);
  FI[o + 3u] = vec4f(bitcast<f32>(I.kind), bitcast<f32>(I.h), I.x, I.hy);
}
