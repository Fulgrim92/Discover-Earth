// math.js: alloc-free vec/mat/quat on Float32Array slots. Every function writes into `out` and returns it.
// Matrices are column-major (WGSL mat4x4f layout): m[col * 4 + row].

export function v3set(out, x, y, z) { out[0] = x; out[1] = y; out[2] = z; return out; }
export function v3len(a) { return Math.hypot(a[0], a[1], a[2]); }

export function quatIdentity(out) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out; }
export function quatMul(out, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
export function quatNormalize(out, a) {
  const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
  out[0] = a[0] / l; out[1] = a[1] / l; out[2] = a[2] / l; out[3] = a[3] / l; return out;
}
// camera orientation: yaw about +Y (0 looks toward -Z = north, positive turns toward +X = east), pitch up, roll
export function quatFromYawPitchRoll(out, yaw, pitch, roll) {
  const cy = Math.cos(-yaw * 0.5), sy = Math.sin(-yaw * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  // q = qYaw(Y) * qPitch(X) * qRoll(Z)
  const x1 = sp, w1 = cp; // pitch about X
  // qYaw * qPitch
  const qx = cy * x1, qy = sy * w1, qz = -sy * x1, qw = cy * w1;
  // * qRoll (z)
  out[0] = qx * cr + qy * sr;
  out[1] = qy * cr - qx * sr;
  out[2] = qw * sr + qz * cr;
  out[3] = qw * cr - qz * sr;
  return out;
}
// rotate vector v by unit quaternion q
export function quatRotate(out, q, v) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3], vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
  return out;
}

// view rotation (inverse of camera rotation q) as a mat4, no translation (camera-relative rendering)
export function mat4ViewRot(out, q) {
  const x = -q[0], y = -q[1], z = -q[2], w = q[3];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy); out[3] = 0;
  out[4] = 2 * (xy - wz); out[5] = 1 - 2 * (xx + zz); out[6] = 2 * (yz + wx); out[7] = 0;
  out[8] = 2 * (xz + wy); out[9] = 2 * (yz - wx); out[10] = 1 - 2 * (xx + yy); out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}
// infinite reverse-Z perspective (depth 1 at near, 0 at infinity); off-axis shift sx (NDC units) for stereo
export function mat4PerspRevZ(out, fovY, aspect, near, sx) {
  const f = 1 / Math.tan(fovY * 0.5);
  out.fill(0);
  out[0] = f / aspect; out[5] = f;
  out[8] = sx; out[11] = -1;
  out[14] = near;
  return out;
}
export function mat4Mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    T16[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    T16[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    T16[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    T16[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  for (let i = 0; i < 16; i++) out[i] = T16[i];
  return out;
}
const T16 = new Float64Array(16);
export function mat4Invert(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return out;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

// WebXR projection -> this renderer's projection.
// XRView.projectionMatrix in a WebGPU session (WebXR/WebGPU binding: "clip-space depth range of [0, 1]") is a
// standard perspective: for a view-space point (x, y, z) with z < 0 in front,
//   clip.x = P0 x + P4 y + P8 z + P12,  clip.y = P1 x + P5 y + P9 z + P13,  clip.w = P3 x + P7 y + P11 z + P15 (= -z),
//   clip.z = P10 z + P14 with P10 = f / (n - f), P14 = n f / (n - f): ndc z = 0 at the near plane, 1 at the far one.
// P8 = (r + l) / (r - l) and P9 = (t + b) / (t - b) carry the asymmetric (off-axis) frustum of each eye.
// This renderer uses infinite reverse-Z (mat4PerspRevZ): clip.z = near, so ndc z = near / -z: 1 at the near plane,
// falling to 0 at infinity (depth test 'greater', clear 0). The conversion keeps the x, y and w rows exactly (the
// frustum, asymmetry included) and replaces the z row: P2 = P6 = P10 = 0, P14 = near. Depth never goes to the
// XR compositor (no depthStencilFormat), so the near plane is ours to choose. tools/xrtest.mjs checks it against
// a known frustum. off: output offset (floats) into out.
export function mat4XRToRevZ(out, p, near, off) {
  const o = off || 0;
  for (let i = 0; i < 16; i++) out[o + i] = p[i];
  out[o + 2] = 0; out[o + 6] = 0; out[o + 10] = 0; out[o + 14] = near;
  return out;
}
