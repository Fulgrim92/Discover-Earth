// Allocation-free vector / quaternion helpers for the sim.
// Quaternions are [x, y, z, w] and rotate body -> world (v_world = q * v_body * q^-1).
//
// Zero-allocation rule used across src/sim: V8 boxes a double (a 16-byte HeapNumber) whenever it is passed to, or
// returned from, a function that the optimiser did not inline. So every helper here takes arrays (and small
// integer constants) and writes into an output array; scalar inputs come from an array slot. Never Math.hypot
// (variadic builtin, boxes its arguments).

export function qcopy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; o[3] = a[3]; }

// o = a * b (apply b first, then a); o may alias a or b
export function qmul(o, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = aw * bx + ax * bw + ay * bz - az * by;
  o[1] = aw * by - ax * bz + ay * bw + az * bx;
  o[2] = aw * bz + ax * by - ay * bx + az * bw;
  o[3] = aw * bw - ax * bx - ay * by - az * bz;
}

// o = conj(a) * b  (rotation from a to b, in a's frame)
export function qmulConjA(o, a, b) {
  const ax = -a[0], ay = -a[1], az = -a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = aw * bx + ax * bw + ay * bz - az * by;
  o[1] = aw * by - ax * bz + ay * bw + az * bx;
  o[2] = aw * bz + ax * by - ay * bx + az * bw;
  o[3] = aw * bw - ax * bx - ay * by - az * bz;
}

export function qnorm(o) {
  const l = Math.sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2] + o[3] * o[3]);
  if (l < 1e-12) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return; }
  const s = 1 / l;
  o[0] *= s; o[1] *= s; o[2] *= s; o[3] *= s;
}

// rotation of angle A[i] about the unit axis (ax, ay, az) given as small integer constants
export function qaxisA(o, ax, ay, az, A, i) {
  const h = 0.5 * A[i], s = Math.sin(h);
  o[0] = ax * s; o[1] = ay * s; o[2] = az * s; o[3] = Math.cos(h);
}

// yaw A[i] about world +Y. yaw 0 looks down -Z; positive yaw turns toward -X (counter-clockwise seen from above)
export function qyawA(o, A, i) {
  const h = 0.5 * A[i];
  o[0] = 0; o[1] = Math.sin(h); o[2] = 0; o[3] = Math.cos(h);
}

// rotation from a rotation vector r (axis * angle)
export function qrotvec(o, r) {
  const a = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
  if (a < 1e-9) { o[0] = 0.5 * r[0]; o[1] = 0.5 * r[1]; o[2] = 0.5 * r[2]; o[3] = 1; qnorm(o); return; }
  const s = Math.sin(0.5 * a) / a;
  o[0] = r[0] * s; o[1] = r[1] * s; o[2] = r[2] * s; o[3] = Math.cos(0.5 * a);
}

// shortest rotation taking world up (0,1,0) to the unit vector b
export function qfromUp(o, b) {
  const d = b[1];
  if (d < -0.999999) { o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0; return; }
  // cross((0,1,0), b) = (b.z, 0, -b.x)
  o[0] = b[2]; o[1] = 0; o[2] = -b[0]; o[3] = 1 + d;
  qnorm(o);
}

// quaternion from a 3x3 rotation matrix given as columns m = [right(3), up(3), back(3)]
export function qfromMat(o, m) {
  const m00 = m[0], m10 = m[1], m20 = m[2], m01 = m[3], m11 = m[4], m21 = m[5], m02 = m[6], m12 = m[7], m22 = m[8];
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    o[3] = 0.25 / s; o[0] = (m21 - m12) * s; o[1] = (m02 - m20) * s; o[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    o[3] = (m21 - m12) / s; o[0] = 0.25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = 0.25 * s; o[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = 0.25 * s;
  }
  qnorm(o);
}

const LM = new Float64Array(9);
// camera-style look rotation: body -Z along f (array 3), body +Y as close to world up as possible
export function qlook(o, f) {
  let fx = f[0], fy = f[1], fz = f[2];
  let l = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (l < 1e-9) { o[0] = 0; o[1] = 0; o[2] = 0; o[3] = 1; return; }
  fx /= l; fy /= l; fz /= l;
  let rx = -fz, rz = fx; // right = f x (0,1,0)
  l = Math.sqrt(rx * rx + rz * rz);
  if (l < 1e-6) { rx = 1; rz = 0; } else { rx /= l; rz /= l; }
  LM[0] = rx; LM[1] = 0; LM[2] = rz;
  LM[3] = -rz * fy; LM[4] = rz * fx - rx * fz; LM[5] = rx * fy; // up = right x f
  LM[6] = -fx; LM[7] = -fy; LM[8] = -fz;
  qfromMat(o, LM);
}

// normalised lerp along the shorter arc, t = A[i]
export function qnlerpA(o, a, b, A, i) {
  const t = A[i];
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -t : t, u = 1 - t;
  o[0] = a[0] * u + b[0] * s; o[1] = a[1] * u + b[1] * s; o[2] = a[2] * u + b[2] * s; o[3] = a[3] * u + b[3] * s;
  qnorm(o);
}

// o = q v q^-1 (body -> world); o may alias v
export function vrot(o, q, v) {
  const vx = v[0], vy = v[1], vz = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  o[0] = vx + qw * tx + (qy * tz - qz * ty);
  o[1] = vy + qw * ty + (qz * tx - qx * tz);
  o[2] = vz + qw * tz + (qx * ty - qy * tx);
}

// o = q^-1 v q (world -> body); o may alias v
export function vrotInv(o, q, v) {
  const vx = v[0], vy = v[1], vz = v[2];
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  o[0] = vx + qw * tx + (qy * tz - qz * ty);
  o[1] = vy + qw * ty + (qz * tx - qx * tz);
  o[2] = vz + qw * tz + (qx * ty - qy * tx);
}

// body up (+Y) in world
export function vup(o, q) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  o[0] = 2 * (qx * qy - qw * qz); o[1] = 1 - 2 * (qx * qx + qz * qz); o[2] = 2 * (qy * qz + qw * qx);
}

// heading (yaw) of attitude q into out[i]: angle of body -Z projected on the ground; body up when the nose is vertical
export function qheadingA(q, out, i) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  let fx = -2 * (qx * qz + qw * qy), fz = -(1 - 2 * (qx * qx + qy * qy));
  if (fx * fx + fz * fz < 0.04) {
    const ux = 2 * (qx * qy - qw * qz), uz = 2 * (qy * qz + qw * qx);
    const fy = -2 * (qy * qz - qw * qx);
    if (fy < 0) { fx = ux; fz = uz; } else { fx = -ux; fz = -uz; }
  }
  out[i] = Math.atan2(-fx, -fz);
}

// --- seeded integer hash (no Math.random). Returns a Smi in [0, 2^30) so nothing is boxed.
export function hashi(i, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h & 0x3fffffff;
}
export const HASH_SCALE = 1 / 1073741824;

// smooth 1D value noise: A[i] (time) -> A[i] in [-1, 1]
export function vnoiseA(A, i, seed) {
  const t = A[i];
  const fl = Math.floor(t), f = t - fl, k = fl | 0;
  const a = hashi(k, seed) * (2 * HASH_SCALE) - 1, b = hashi(k + 1, seed) * (2 * HASH_SCALE) - 1;
  A[i] = a + (b - a) * (f * f * (3 - 2 * f));
}

// (init-time / tests only; returns a double)
export function wrapPi(a) { return a - 6.283185307179586 * Math.round(a / 6.283185307179586); }

// JIT warm-up at load: run every branch of qfromMat and qfromUp, so the optimising compiler has type feedback for
// all of them and never deoptimises the first time a flight turns into a rare branch (each deopt runs the function
// in baseline code for a while, boxing doubles: tools/alloc.mjs --xrmock caught one in the steady state). V8 only
// records feedback once a function has run a few times (lazy feedback allocation), hence the repeats.
{
  const q = new Float64Array(4);
  const M = [[1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 0, -1, 0, 0, 0, -1], [-1, 0, 0, 0, 1, 0, 0, 0, -1], [-1, 0, 0, 0, -1, 0, 0, 0, 1]]
    .map((m) => new Float64Array(m));
  const U = [new Float64Array([0, 1, 0]), new Float64Array([0, -1, 0]), new Float64Array([0.6, 0.8, 0])];
  for (let r = 0; r < 64; r++) {
    for (let k = 0; k < 4; k++) qfromMat(q, M[k]);
    for (let k = 0; k < 3; k++) qfromUp(q, U[k]);
  }
}
