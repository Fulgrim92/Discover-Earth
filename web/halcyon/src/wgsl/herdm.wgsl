// herdm.wgsl: mirror (Mirror Salt): flamingos doubled in the still water, in the blended pass. Appended to herd.wgsl
// in its own module (fx/herd.js), where sceneDist is group 2 and HG group 3.
@vertex fn vsHerdMirror(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> HV {
  var o = herdVert(vi, ii);
  if (o.sp != 2u || VW.cam.y <= 0.05) { o.pos = LF_DEAD; return o; }
  o.wp = vec3f(o.wp.x, -o.wp.y, o.wp.z); o.n = vec3f(o.n.x, -o.n.y, o.n.z); o.ax = vec3f(o.ax.x, -o.ax.y, o.ax.z);
  o.pos = VW.vp * vec4f(o.wp - VW.cam.xyz, 1.0);
  return o;
}
@fragment fn fsHerdMirror(in: HV) -> @location(0) vec4f {
  let ro = VW.cam.xyz;
  let d = normalize(in.wp - ro);
  if (d.y >= -0.0005) { discard; }
  let tw = ro.y / -d.y;
  let sd = textureLoad(sceneDist, vec2i(in.pos.xy), 0).x;
  if (sd + max(0.6, sd * 0.0015) < tw) { discard; }           // not the open mirror here, or something in front
  let fr = 0.02 + 0.98 * pow(1.0 - max(-d.y, 0.0), 5.0);
  let refl = clamp(max(fr, rowv(W2).w), 0.0, 1.0) * sstep(0.2, 0.6, rowv(M4).y);
  var n = in;
  n.wp = vec3f(in.wp.x, -in.wp.y, in.wp.z); n.n = vec3f(in.n.x, -in.n.y, in.n.z); n.ax = vec3f(in.ax.x, -in.ax.y, in.ax.z);
  let c = applyFog(herdShade(n), ro, d, length(in.wp - ro));
  return vec4f(c, refl * 0.92);
}
