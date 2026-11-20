// life.wgsl: shared by flora, fauna and particles (after clip.wgsl + sky.wgsl). Light that matches terrain.wgsl:
// the camera realm's sun and sky ambient, the clipmap-marched sun shadow, travelling wind gusts.

// sky ambient for a surface whose normal has vertical component ny (terrain.wgsl "amb" without its AO)
fn lfAmb(ny: f32, alb: vec3f) -> vec3f {
  let I = rowv(S3).w;
  let zen = rowv(S2).rgb * I;
  let hor = rowv(S3).rgb * I;
  let skyUp = mix(hor, zen, 0.55) * rowv(S6).x + rowv(S7).rgb * rowv(S7).w;
  let ground = (hor * 0.25 + alb * sunCol() * max(FR.sun.y, 0.0) * 0.6) * rowv(S6).w;
  return mix(ground, skyUp, 0.5 + 0.5 * ny);
}

// terrain-matched meadow albedo: terrain.wgsl base grass M0 * (0.85 + 0.22 nL) with its ridge / hollow tint from
// the broad concavity (clip aux at level >= 5). Keep in step with terrain.wgsl.
fn lfGrassAlb(p: vec2f, m0: vec4f) -> vec3f {
  let nL = fbm(p * (1.0 / 380.0), 3, 200u);
  var g = m0.rgb * (0.85 + 0.22 * nL);
  let lc = clipLevel(p, 5u, 4.0);
  let conc = clipS(lc, p).w / FR.lv[lc].z;
  g = mix(g, g * vec3f(1.3, 1.22, 0.78), sstep(0.0, -0.25, conc) * 0.65);
  g = mix(g, g * vec3f(0.62, 0.78, 0.72), sstep(0.02, 0.35, conc) * 0.7);
  return g;
}

// wind: xz bend vector and gust strength (0..1). Gusts are noise bands travelling downwind across the field.
const LF_WD = vec2f(0.83, 0.56);
fn lfWind(p: vec2f, t: f32) -> vec3f {
  let sp = 0.6 + 0.12 * rowv(C2).w; // realm wind (m/s) -> gust speed scale
  let a = dot(p, LF_WD); let c = dot(p, vec2f(-LF_WD.y, LF_WD.x));
  let g1 = vn(vec2f(a * 0.045 - t * 0.55 * sp, c * 0.02), 771u);
  let g2 = vn(vec2f(a * 0.16 - t * 1.9 * sp, c * 0.09), 772u);
  let g = clamp(0.5 + 0.6 * g1 + 0.3 * g2, 0.0, 1.0);
  let gust = g * g;
  return vec3f(LF_WD * (0.08 + 0.55 * gust), gust);
}

// fog transmittance and in-scatter colour for a point at distance t along d (per vertex)
fn lfFogT(ro: vec3f, d: vec3f, t: f32) -> vec3f {
  return applyFog(vec3f(1.0), ro, d, t) - applyFog(vec3f(0.0), ro, d, t);
}

// cheap sun shadow for small things: fewer steps than the terrain, same march, times the cloud shadow that the
// terrain gets (common.wgsl cloudShadow, here with the camera row's cloud fields; skipped where already shadowed)
fn lfShadow(p: vec3f, dist: f32, jit: f32, steps: i32) -> f32 {
  let L = FR.sun.xyz;
  if (L.y < -0.03) { return 0.0; }
  if (isOff(OFF_FSHADOW)) { return lfCloudShadow(p); }
  let sh = sunShadow(p, L, dist, rowv(S6).y, jit, steps);
  if (sh < 0.02) { return sh; }
  return sh * lfCloudShadow(p);
}
fn lfCloudShadow(p: vec3f) -> f32 {
  return cloudShadowF(p, FR.sun.xyz, rowv(C0), rowv(C1), rowv(C2), rowv(C3));
}

fn lfRand(h: u32, k: u32) -> f32 { return f32(hu(i32(h), i32(k), 0x51u) >> 8u) * (1.0 / 16777216.0); }

// clip-space visibility of a sphere (centre relative to camera, radius r)
fn lfVisible(c: vec3f, r: f32) -> bool {
  let q = VW.vp * vec4f(c, 1.0);
  let m = r * 2.2;
  return q.w > -r && abs(q.x) < q.w + m && abs(q.y) < q.w + m;
}

const LF_DEAD = vec4f(-4.0, -4.0, 0.5, 1.0);
