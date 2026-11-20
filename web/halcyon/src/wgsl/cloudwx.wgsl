// cloudwx.wgsl: per-frame weather window for the clouds (needs clip.wgsl for the orographic term).
fn sat(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
// ---- weather window (every frame): the shared coverage field with realm-blended layer parameters ----
@group(2) @binding(0) var outWx: texture_storage_2d<rgba16float, write>;
@group(2) @binding(1) var outWy: texture_storage_2d<rgba16float, write>;
@group(2) @binding(2) var<uniform> CW: CloudU;

@compute @workgroup_size(8, 8) fn csWeather(@builtin(global_invocation_id) id: vec3u) {
  let N = u32(CW.win.w);
  if (id.x >= N || id.y >= N) { return; }
  let xz = CW.win.xy + (vec2f(id.xy) + 0.5) * CW.win.z;
  let rw = realmWeights(xz);
  let c0 = bf(rw, C0); let c1 = bf(rw, C1); let c2 = bf(rw, C2); let c3 = bf(rw, C3);
  let f = cloudField(xz, c3.x);
  var cov = cloudCov(f, c0.x);
  // weather cells (common.wgsl wxCell): clear sky thins the realm's cover, a squall closes it and towers up
  let wn = wxCell(xz);
  let wst = wxStorm(wn);
  cov *= 1.0 - 0.75 * wxClear(wn);
  cov = max(cov, wst * 0.92 * sstep(0.1, 0.5, cloudField(xz * 1.7 + 300.0, 0.0)));
  // cumulus grow taller the further the field is above the threshold: separate towers instead of one slab
  let tower = sat(0.2 + 2.2 * (f - (1.0 - c0.x)));
  let top = max(c0.y + (c0.z - c0.y) * mix(1.0, tower, c3.y), c0.y + wst * 2600.0);
  // orographic lift: cloud gathers on the high ground (the Fjords' low cloud snags on the peaks)
  let h = heightAny(xz);
  cov = max(cov, sstep(c0.y + 60.0, c0.y + 420.0, h) * sstep(0.3, 0.62, cloudField(xz * 1.9 + 900.0, 1.0)) * sstep(0.05, 0.35, c0.x));
  // each realm owns its sky: clouds of realms the camera is not in are thinned (borders blend smoothly because
  // both weight sets do), so the next realm still shows on the horizon without crowding this one
  var own = 0.0;
  for (var a = 0; a < 4; a++) {
    for (var b = 0; b < 4; b++) {
      if (rw.id[b] >= 0 && f32(rw.id[b]) == CW.camId[a]) { own += CW.camW[a] * rw.w[b]; }
    }
  }
  // under a moonlit night sky (Aurora Ice) the neighbours' day clouds would read as cut-outs: drop them
  let c5 = FR.row[S5];
  let moonR = sstep(0.5, 0.9, c5.w) * (1.0 - sstep(0.01, 0.2, c5.z));
  cov *= mix(mix(0.3, 0.0, moonR), 1.0, own);
  textureStore(outWx, id.xy, vec4f(cov, c0.y, max(top, c0.y + 60.0), c0.w));
  // the sea's own top and density are normalised by its weight, so the layer does not sag at realm borders
  let sw = max(c1.w, 1e-3);
  let sea = c1.w * seaCov(xz) * (c2.z / sw);
  textureStore(outWy, id.xy, vec4f(c3.y, c3.z, sea, select(0.0, c2.y / sw, c1.w > 1e-3)));
}

