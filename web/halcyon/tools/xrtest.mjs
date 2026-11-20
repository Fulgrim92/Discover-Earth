// HALCYON VR math and frame plumbing in node (no browser, no GPU):
//   node tools/xrtest.mjs
// 1. mat4XRToRevZ: a WebGPU-session XR projection (clip depth [0, 1], asymmetric frustum) converted to this renderer's
//    infinite reverse-Z keeps x / y / w exactly and maps depth to near / -z (1 at the near plane, 0 at infinity).
// 2. viewRay with the off-axis skew (common.wgsl, mirrored here) inverts the converted projection for every pixel.
// 3. xr.readFrame against fake XR objects in both layouts (texture array, side by side): viewports, view descriptors,
//    targets reused while the texture is, stick y negated, grips read.
// 4. xr.place: line of sight puts the head on sim.pilot facing the drone; FPV rides sim.cam with horizon-locked yaw
//    that follows the drone heading; the comfort vignette rises with yaw rate and stays 0 in line of sight.
import { mat4XRToRevZ, mat4PerspRevZ } from '../src/math.js';
import * as xr from '../src/xr.js';
import { XR, VP, PROJ, PAD, WEYE, WHEAD, N, N_VIGNETTE, XR_LOS, XR_FPV } from '../src/xr.js';
import { CLK, C_DT, C_TIME } from '../src/clock.js';

const results = [];
function test(name, fn) {
  try { const note = fn(); results.push(true); console.log('ok    ' + name + (note ? '  —  ' + note : '')); }
  catch (e) { results.push(false); console.log('FAIL  ' + name + '  —  ' + e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);
const DEG = Math.PI / 180;

// WebXR (WebGPU binding) projection: column-major, clip z in [0, 1]
function xrProj(l, r, t, b, n, f) {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[8] = (r + l) / (r - l); m[9] = (t + b) / (t - b);
  m[10] = f / (n - f); m[11] = -1; m[14] = (n * f) / (n - f);
  return m;
}
const mul = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
// a left eye of a typical headset: 52 deg out, 42 in, 44 up, 52 down (tangents; l and b negative)
const L = -Math.tan(52 * DEG), R = Math.tan(42 * DEG), T = Math.tan(44 * DEG), B = -Math.tan(52 * DEG);
const P = xrProj(L, R, T, B, 0.1, 1000);
const NEAR = 0.05;
const C = mat4XRToRevZ(new Float32Array(16), P, NEAR, 0);

test('reverse-Z conversion keeps the frustum (x, y, w) and maps depth to near / -z', () => {
  let worst = 0;
  for (const [x, y, z] of [[0, 0, -1], [0.3, -0.2, -2], [-5, 3, -40], [100, -80, -900], [0.01, 0.02, -0.06], [2e3, 1e3, -5e4]]) {
    const a = mul(P, x, y, z), b = mul(C, x, y, z);
    for (const k of [0, 1, 3]) worst = Math.max(worst, Math.abs(a[k] - b[k]) / Math.max(1, Math.abs(a[k])));
    near(b[2] / b[3], NEAR / -z, 1e-6, 'ndc z at z=' + z);
  }
  assert(worst < 1e-6, 'x/y/w changed by ' + worst);
  near(mul(C, 0, 0, -NEAR)[2] / mul(C, 0, 0, -NEAR)[3], 1, 1e-6, 'near plane depth');
  return 'max x/y/w deviation ' + worst.toExponential(1);
});

test('reverse-Z depth: nearer is greater, stays above 0 out to 100 km (depth test "greater", clear 0)', () => {
  let prev = 2;
  for (const d of [0.05, 0.1, 1, 10, 100, 1000, 1e4, 1e5]) {
    const c = mul(C, 0, 0, -d), z = c[2] / c[3];
    assert(z < prev && z > 0 && z <= 1 + 1e-6, 'depth at ' + d + ' m: ' + z);
    prev = z;
  }
  // the original was [0, 1] near-to-far: the order flips, the frustum edges do not
  const zf = (m, d) => { const c = mul(m, 0, 0, -d); return c[2] / c[3]; };
  assert(zf(P, 1) < zf(P, 10) && zf(C, 1) > zf(C, 10), 'order');
});

test('a symmetric XR projection converts to exactly mat4PerspRevZ (desktop path)', () => {
  const t = Math.tan(45 * DEG), a = 1.2;
  const S = mat4XRToRevZ(new Float32Array(16), xrProj(-t * a, t * a, t, -t, 0.1, 500), 0.1, 0);
  const D = mat4PerspRevZ(new Float32Array(16), 90 * DEG, a, 0.1, 0);
  for (let i = 0; i < 16; i++) near(S[i], D[i], 1e-6, 'element ' + i);
});

test('viewRay with skew inverts the asymmetric projection at every pixel corner and centre', () => {
  // common.wgsl: x = (uv.x * 2 - 1) * tanX + skew.x, y = (1 - uv.y * 2) * tanY + skew.y, dir = fwd + right x + up y
  const tanX = 1 / C[0], tanY = 1 / C[5], sx = C[8] / C[0], sy = C[9] / C[5];
  let worst = 0;
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.25, 0.8]]) {
    const x = (u * 2 - 1) * tanX + sx, y = (1 - v * 2) * tanY + sy; // view space (x, y, -1)
    const c = mul(C, x, y, -1);
    const nu = (c[0] / c[3]) * 0.5 + 0.5, nv = 0.5 - (c[1] / c[3]) * 0.5;
    worst = Math.max(worst, Math.abs(nu - u), Math.abs(nv - v));
  }
  assert(worst < 1e-6, 'pixel error ' + worst);
  // and the frustum edges are the headset's: left edge at tan 52 deg out, right at 42 in
  near(-tanX + sx, L, 1e-6, 'left edge'); near(tanX + sx, R, 1e-6, 'right edge');
  near(tanY + sy, T, 1e-6, 'top edge'); near(-tanY + sy, B, 1e-6, 'bottom edge');
  return 'skew ' + sx.toFixed(4) + ', ' + sy.toFixed(4);
});

// ---- fake XR frame objects --------------------------------------------------------------------------------------
function fakeSession(layered, W, H) {
  const tex = { n: 0, createView(d) { this.n++; return { layer: d.baseArrayLayer, tex: this }; } };
  const P1 = xrProj(-R, -L, T, B, 0.1, 1000); // right eye: mirrored
  const ori = { x: 0, y: 0, z: 0, w: 1 };
  const views = [0, 1].map((i) => ({ projectionMatrix: i ? P1 : P, transform: { position: { x: (i ? 0.0315 : -0.0315), y: 1.6, z: 0 }, orientation: ori }, i }));
  const subs = [0, 1].map((i) => ({ colorTexture: tex, viewport: { x: layered ? 0 : i * W, y: 0, width: W, height: H },
    getViewDescriptor: () => ({ baseArrayLayer: layered ? i : 0, arrayLayerCount: 1 }) }));
  const btn = (p) => ({ pressed: p, value: p ? 1 : 0 });
  const pad = (h) => ({ axes: [0, 0, 0.5 * (h ? -1 : 1), -0.75], buttons: [btn(h === 1), btn(false), btn(false), btn(false), btn(h === 1), btn(false)] });
  const srcs = [{ handedness: 'left', gripSpace: 'gl', gamepad: pad(0) }, { handedness: 'right', gripSpace: 'gr', gamepad: pad(1) }];
  const grip = { transform: { position: { x: 0.2, y: 1.2, z: -0.3 }, orientation: ori } };
  XR.binding = { getViewSubImage: (layer, v) => subs[v.i] };
  XR.layer = {}; XR.space = {}; XR.session = { inputSources: srcs };
  XR.texSeen[0] = XR.texSeen[1] = null; XR.layerSeen[0] = XR.layerSeen[1] = -1;
  const frame = { getViewerPose: () => ({ transform: { position: { x: 0, y: 1.6, z: 0 }, orientation: ori }, views }), getPose: () => grip };
  return { frame, tex };
}

test('readFrame, texture-array layout: one layer per view, full viewports, targets reused', () => {
  const { frame, tex } = fakeSession(true, 1832, 1920);
  assert(xr.readFrame(frame) === 2, 'views');
  assert(XR.layered === 1, 'layered flag');
  assert(XR.target[0].layer === 0 && XR.target[1].layer === 1, 'layers ' + XR.target[0].layer + ',' + XR.target[1].layer);
  assert(VP[0] === 0 && VP[4] === 0 && VP[2] === 1832 && VP[7] === 1920, 'viewports ' + Array.from(VP));
  xr.readFrame(frame);
  assert(tex.n === 2, 'views created again for the same texture: ' + tex.n);
  near(PROJ[14], 0.05, 1e-7, 'converted near'); near(PROJ[16 + 8], -PROJ[8], 1e-6, 'right eye skew mirrors the left');
});

test('readFrame, side-by-side layout: same layer, viewport x offsets, second view loads', () => {
  const { frame } = fakeSession(false, 1000, 1100);
  xr.readFrame(frame);
  assert(XR.layered === 0, 'layered flag');
  assert(XR.target[0].layer === 0 && XR.target[1].layer === 0, 'layers');
  assert(VP[0] === 0 && VP[4] === 1000 && VP[6] === 1000, 'viewports ' + Array.from(VP));
});

test('controller input: stick y negated (XR up is -1), triggers and A/X read per hand', () => {
  const { frame } = fakeSession(true, 100, 100);
  xr.readFrame(frame);
  near(PAD[0], 0.5, 1e-6, 'left x'); near(PAD[1], 0.75, 1e-6, 'left y up');
  near(PAD[8], -0.5, 1e-6, 'right x'); near(PAD[9], 0.75, 1e-6, 'right y up');
  assert(PAD[8 + 2] === 1 && PAD[8 + 4] === 1 && PAD[2] === 0, 'buttons');
  assert(PAD[7] === 1 && PAD[15] === 1, 'present');
});

// ---- placement --------------------------------------------------------------------------------------------------
function fakeSim() {
  return {
    pilot: new Float32Array([100, 21.7, 200]), drone: new Float32Array(16), cam: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1]),
    info: new Float32Array(16), cameraMode: 2,
  };
}
const yawOfQ = (q) => { // heading of -Z, sim convention
  const [x, y, z, w] = q;
  const fx = -2 * (x * z + w * y), fz = -(1 - 2 * (x * x + y * y));
  return Math.atan2(-fx, -fz);
};

test('line of sight: head on sim.pilot (eye height), facing the drone, eyes 63 mm apart', () => {
  const { frame } = fakeSession(true, 100, 100);
  const sim = fakeSim();
  sim.drone[0] = 130; sim.drone[1] = 40; sim.drone[2] = 160; // ahead-right of the pilot
  XR.floor = 1; xr.setMode(sim, XR_LOS);
  CLK[C_DT] = 1 / 90; CLK[C_TIME] = 1;
  xr.readFrame(frame); xr.place(sim);
  near(WHEAD[0], 100, 1e-3, 'head x'); near(WHEAD[2], 200, 1e-3, 'head z');
  near(WHEAD[1], 21.7 - 1.7 + 1.6, 1e-3, 'head y (floor + tracked height)');
  const want = Math.atan2(-(130 - 100), -(160 - 200));
  near(yawOfQ(WHEAD.subarray(3, 7)), want, 1e-4, 'facing the drone');
  const ipd = Math.hypot(WEYE[0] - WEYE[7], WEYE[1] - WEYE[8], WEYE[2] - WEYE[9]);
  near(ipd, 0.063, 1e-4, 'IPD');
  near(N[N_VIGNETTE], 0, 0, 'no vignette in line of sight');
  assert(sim.cameraMode === 2, 'sim camera mode LOS');
});

test('FPV: eyes ride the drone camera, yaw follows the heading, horizon stays level; vignette rises with yaw rate', () => {
  const { frame } = fakeSession(true, 100, 100);
  const sim = fakeSim();
  sim.cam[0] = 10; sim.cam[1] = 50; sim.cam[2] = -20;
  xr.setMode(sim, XR_FPV);
  assert(sim.cameraMode === 0, 'sim camera mode FPV');
  CLK[C_DT] = 1 / 90;
  xr.readFrame(frame); xr.place(sim);
  near(WHEAD[0], 10, 1e-3, 'head x on the camera'); near(WHEAD[1], 50, 1e-3, 'head y'); near(WHEAD[2], -20, 1e-3, 'head z');
  // turn the drone at 90 deg/s for half a second
  for (let k = 0; k < 45; k++) { sim.info[6] += (Math.PI / 2) / 90; xr.readFrame(frame); xr.place(sim); }
  near(yawOfQ(WHEAD.subarray(3, 7)), sim.info[6], 1e-4, 'view yaw = heading');
  const q = WHEAD; // level: the head's right axis stays horizontal (head itself is level here)
  const ry = 2 * (q[3] * q[4] + q[6] * q[5]);
  near(ry, 0, 1e-6, 'roll');
  const v = N[N_VIGNETTE];
  assert(v > 0.3, 'vignette while turning: ' + v);
  for (let k = 0; k < 270; k++) { xr.readFrame(frame); xr.place(sim); }
  assert(N[N_VIGNETTE] < 0.05, 'vignette relaxes when steady: ' + N[N_VIGNETTE]);
  return 'turning ' + v.toFixed(2) + ', steady ' + N[N_VIGNETTE].toFixed(3);
});

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
