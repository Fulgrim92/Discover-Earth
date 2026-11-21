// realmmap.wgsl (terrain-art): bake the realm map read by clip.wgsl realmWeightsMap. One thread per 64 m texel:
// the exact warped-Voronoi skin weights of realm 0-3 into layer 0, 4-7 into layer 1 and 8-11 into layer 2 (a fixed
// 12 slots: realms.js MAX_REALM).
@group(1) @binding(0) var<uniform> RMU: vec4f; // map centre x, z
@group(1) @binding(1) var rmOut: texture_storage_2d_array<rgba8unorm, write>;

@compute @workgroup_size(8, 8) fn csRealm(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= 1024u || g.y >= 1024u) { return; }
  let p = RMU.xy + (vec2f(g.xy) + 0.5 - 512.0) * 64.0;
  let r = realmWeights(p);
  var w = array<vec4f, 3>(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  for (var s = 0; s < 4; s++) {
    let id = r.id[s];
    if (id >= 0 && id < 12) { w[id >> 2][id & 3] += r.w[s]; }
  }
  for (var l = 0; l < 3; l++) { textureStore(rmOut, vec2i(g.xy), l, w[l]); }
}
