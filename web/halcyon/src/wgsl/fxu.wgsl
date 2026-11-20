// fxu.wgsl: the per-frame drone / effects uniform shared by drone.wgsl (opaque pass) and fx.wgsl (effects pass).

struct FxU {
  drone: vec4f,   // drone position xyz, visible (0 hidden in FPV)
  dq: vec4f,      // drone attitude quaternion (body -> world)
  motors: vec4f,  // motor levels m0..m3 (Betaflight order RR FR RL FL)
  props: vec4f,   // prop blade angles (rad)
  dinfo: vec4f,   // airframe (0 camera drone, 1 five-inch), shutter (s), height above ground (m), time (s)
  sp0: vec4f,     // spark trail start xyz, spark count
  sp1: vec4f,     // spark trail end xyz, intensity
  rinfo: vec4f,   // ring count, next slot, 0, 0
}
fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
