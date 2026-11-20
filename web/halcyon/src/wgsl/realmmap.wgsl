// realmmap.wgsl (terrain-art): bake the realm map read by clip.wgsl realmWeightsMap. One thread per 64 m texel:
// the exact warped-Voronoi skin weights of realm 0-3 into layer 0 and 4-7 into layer 1.
@group(1) @binding(0) var<uniform> RMU: vec4f; // map centre x, z
@group(1) @binding(1) var rmOut: texture_storage_2d_array<rgba8unorm, write>;

@compute @workgroup_size(8, 8) fn csRealm(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= 1024u || g.y >= 1024u) { return; }
  let p = RMU.xy + (vec2f(g.xy) + 0.5 - 512.0) * 64.0;
  let r = realmWeights(p);
  var a = vec4f(0.0); var b = vec4f(0.0);
  for (var s = 0; s < 4; s++) {
    let id = r.id[s];
    if (id >= 0 && id < 4) { a[id] += r.w[s]; }
    if (id >= 4 && id < 8) { b[id - 4] += r.w[s]; }
  }
  textureStore(rmOut, vec2i(g.xy), 0, a);
  textureStore(rmOut, vec2i(g.xy), 1, b);
}
