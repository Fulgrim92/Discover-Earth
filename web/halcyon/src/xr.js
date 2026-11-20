// xr.js: immersive VR through the WebXR/WebGPU binding (XRGPUBinding, Immersive Web WG editor's draft
// "WebXR/WebGPU Binding Module - Level 1"). No WebGL path: without XRGPUBinding the Enter VR control explains the
// Chrome flag instead (DESIGN section 3).
//
// Spec calls, in order:
//   probe:  navigator.xr.isSessionSupported('immersive-vr'); typeof XRGPUBinding
//   boot:   navigator.gpu.requestAdapter({ xrCompatible: true })        (gpu.js initDevice; no makeXRCompatible in WebGPU)
//   enter:  navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['webgpu'], optionalFeatures: ['local-floor'] })
//           new XRGPUBinding(session, device); binding.getPreferredColorFormat()
//           binding.createProjectionLayer({ colorFormat, textureUsage: RENDER_ATTACHMENT, scaleFactor: 1 })
//           layer.fixedFoveation = FOVEATION (when the layer reports a number: the device supports it)
//           session.updateRenderState({ layers: [layer] }); session.requestReferenceSpace('local-floor' | 'local')
//   frame:  session.requestAnimationFrame(cb) -> frame.getViewerPose(space) -> per view binding.getViewSubImage(layer, view)
//           -> subImage.colorTexture.createView(subImage.getViewDescriptor()) + subImage.viewport (setViewport in post)
//           view.projectionMatrix (clip depth [0, 1] in a WebGPU session), view.transform; frame.getPose(gripSpace)
//           and inputSource.gamepad (xr-standard mapping) for the controllers.
// Layouts: the current draft allocates one texture array layer per view (getViewDescriptor().baseArrayLayer = view
// index, viewport = the whole layer); earlier implementations put both views side by side in one layer (same
// baseArrayLayer, viewport x offset). Rendering always goes through getViewDescriptor() + viewport, so both work;
// `layered` only decides whether the second view clears or loads its target.
//
// Zero allocations of our own per frame (DESIGN section 9): every number goes into typed arrays here. The XR frame
// objects (XRFrame, XRViewerPose, XRView, XRRigidTransform, DOMPointReadOnly, projection Float32Arrays, XRPose,
// XRGPUSubImage, the view descriptor, the GPUTextureView of each frame's new colour texture, gamepad snapshots) are
// the platform's; tools/alloc.mjs --xrmock lists them.
// (no gpu.js import: main.js hands over its GPU state with useGPU(), so tools/xrtest.mjs can run this module in node)
import { quatMul, quatRotate, mat4XRToRevZ } from './math.js';
import { CLK, C_DT, C_TIME } from './clock.js';

export const XR_LOS = 0, XR_FPV = 1;
// state: 0 no navigator.xr (no control), 1 VR unavailable (control explains), 2 ready, 3 starting, 4 in session
export const XR = {
  state: 0, why: '', session: null, binding: null, layer: null, space: null, format: 'rgba8unorm',
  views: 0, layered: 1, mode: XR_LOS, vignette: 1, floor: 1, mock: null, frameRate: 90, wantCompatible: false,
  sub: [null, null], target: [null, null], texSeen: [null, null], layerSeen: new Int32Array(2), changed: 0,
  onStart: null, onEnd: null, button: null,
};
let G = { device: null, xrCompatible: false };
export function useGPU(g) { G = g; }
const NEAR = 0.05;           // m: hands and the HUD panel are close
const FOVEATION = 0.5;       // fixed foveation hint (0..1) where the layer supports it

// ---- per-frame numbers (local = the XR reference space, world = the game world) ----
export const VP = new Float32Array(2 * 4);     // sub-image viewport per view: x, y, w, h
export const PROJ = new Float32Array(2 * 16);  // converted projection per view (reverse-Z)
export const EYE = new Float64Array(2 * 7);    // eye pose, local: px, py, pz, qx, qy, qz, qw
export const HEAD = new Float64Array(7);       // viewer pose, local
export const GRIP = new Float64Array(2 * 8);   // grip pose per hand (0 left, 1 right), local, [7] = tracked
export const PAD = new Float32Array(2 * 8);    // per hand: stick x, stick y (up +), trigger, squeeze, A/X, B/Y, stick press, present
const PADPREV = new Float32Array(2 * 8);
// world results
export const WEYE = new Float64Array(2 * 7);   // eye poses in the world
export const WHEAD = new Float32Array(7);      // head pose in the world (sim.setHeadPose)
export const WGRIP = new Float64Array(2 * 8);  // grips in the world, [7] tracked
export const N = new Float64Array(16);         // misc doubles, see N_*
const N_OX = 0, N_OY = 1, N_OZ = 2, N_YAW = 3, N_PX = 4, N_PZ = 5, N_ANCH = 6, N_YREF = 7, N_PSI = 8, N_VIG = 9,
  N_VX = 10, N_VY = 11, N_VZ = 12, N_PADT = 13, N_T = 14, N_HY = 15;
export const N_VIGNETTE = N_VIG;
const qa = new Float64Array(4), qb = new Float64Array(4), v3 = new Float64Array(3), v3b = new Float64Array(3);
const PJ = new Float32Array(16);

// ---------------------------------------------------------------------------------------------- detection
// Before the GPU device exists: the adapter must be requested with xrCompatible when VR may be used.
export async function probe(useMock) {
  if (useMock) { const m = await import('./xrmock.js'); XR.mock = m.install(useMock); }
  if (typeof navigator === 'undefined' || !navigator.xr) { XR.state = 0; return; }
  let vr = false;
  // bounded: with no XR runtime some browsers (headless Chrome) never settle isSessionSupported, and start-up waits here
  try {
    vr = await Promise.race([navigator.xr.isSessionSupported('immersive-vr'), new Promise((r) => setTimeout(() => r(false), 1500))]);
  } catch (e) { vr = false; }
  const bind = typeof XRGPUBinding === 'function';
  if (!bind) { XR.state = 1; XR.why = 'flag'; }
  else if (!vr) { XR.state = 1; XR.why = 'nohmd'; }
  else { XR.state = 2; XR.wantCompatible = true; }
}
// after initDevice: the adapter may have refused xrCompatible
export function deviceReady() {
  if (XR.state === 2 && !G.xrCompatible) { XR.state = 1; XR.why = 'adapter'; }
}

const WHY = {
  flag: 'VR needs the WebXR/WebGPU binding: in Chrome open chrome://flags/#webxr-webgpu-binding, set it to Enabled, relaunch, and connect a PC headset (OpenXR).',
  nohmd: 'This browser has the WebXR/WebGPU binding but no VR headset answered: connect the headset, start its OpenXR runtime (SteamVR, Meta Link, WMR) and reload.',
  adapter: 'The GPU could not be opened for VR (no XR-compatible adapter): make the headset\'s OpenXR runtime use this GPU and reload.',
  failed: 'The VR session could not start: ',
};

// ---------------------------------------------------------------------------------------------- the control
export function attachButton(hooks) {
  XR.onStart = hooks.start; XR.onEnd = hooks.end;
  if (XR.state === 0 || typeof document === 'undefined') return;
  const b = document.createElement('div');
  b.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:22;padding:8px 18px;border:1px solid rgba(255,255,255,0.45);' +
    'border-radius:3px;cursor:pointer;font:500 13px system-ui,sans-serif;letter-spacing:0.22em;font-variant:all-small-caps;' +
    'color:rgba(255,255,255,0.85);background:rgba(5,8,14,0.35);user-select:none';
  b.textContent = 'enter vr';
  const note = document.createElement('div');
  note.style.cssText = 'position:fixed;right:18px;bottom:58px;z-index:22;max-width:430px;padding:10px 14px;border-radius:3px;' +
    'font:13px/1.6 system-ui,sans-serif;color:rgba(255,255,255,0.85);background:rgba(5,8,14,0.78);display:none';
  document.body.appendChild(b); document.body.appendChild(note);
  XR.button = b;
  const explain = (s) => { note.textContent = s; note.style.display = 'block'; clearTimeout(note._t); note._t = setTimeout(() => { note.style.display = 'none'; }, 12000); };
  if (XR.state === 1) { b.style.opacity = '0.6'; b.title = WHY[XR.why]; }
  XR.click = () => {
    if (XR.state === 1) { explain(WHY[XR.why]); return; }
    if (XR.state === 4 && XR.session) { XR.session.end(); return; }
    if (XR.state !== 2) return;
    enter().catch((e) => { XR.state = 2; explain(WHY.failed + (e && e.message ? e.message : e)); });
  };
  b.addEventListener('click', (e) => { e.stopPropagation(); XR.click(); });
  b.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
  addEventListener('keydown', (e) => { if (e.code === 'KeyV' && !e.repeat && !e.ctrlKey && !e.metaKey) XR.click(); });
}

// ---------------------------------------------------------------------------------------------- session
export async function enter() {
  XR.state = 3;
  const s = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['webgpu'], optionalFeatures: ['local-floor'] });
  try {
    XR.binding = new XRGPUBinding(s, G.device);
    XR.format = XR.binding.getPreferredColorFormat();
    XR.layer = XR.binding.createProjectionLayer({ colorFormat: XR.format, textureUsage: GPUTextureUsage.RENDER_ATTACHMENT, scaleFactor: 1.0 });
    if (typeof XR.layer.fixedFoveation === 'number') XR.layer.fixedFoveation = FOVEATION;
    s.updateRenderState({ layers: [XR.layer] });
    try { XR.space = await s.requestReferenceSpace('local-floor'); XR.floor = 1; }
    catch (e) { XR.space = await s.requestReferenceSpace('local'); XR.floor = 0; }
  } catch (e) { s.end().catch(() => {}); throw e; }
  XR.session = s;
  XR.frameRate = s.frameRate || 90;
  s.addEventListener('end', onEnd);
  XR.texSeen[0] = XR.texSeen[1] = null; XR.layerSeen[0] = XR.layerSeen[1] = -1;
  N[N_ANCH] = 0; N[N_PADT] = -1;
  XR.state = 4;
  if (XR.button) XR.button.textContent = 'exit vr';
  if (XR.onStart) XR.onStart(s);
}
function onEnd() {
  XR.session = null; XR.binding = null; XR.layer = null; XR.space = null;
  XR.target[0] = XR.target[1] = null; XR.texSeen[0] = XR.texSeen[1] = null;
  XR.state = 2;
  if (XR.button) XR.button.textContent = 'enter vr';
  if (XR.onEnd) XR.onEnd();
}
export function recenter() { N[N_ANCH] = 0; }

// ---------------------------------------------------------------------------------------------- per frame: read
// Read everything the frame needs from the XR objects into the typed arrays above. Returns the view count (0: no
// pose this frame, render nothing). The platform reads are kept in this one function (and readInputs).
export function readFrame(xf) {
  const pose = xf.getViewerPose(XR.space);
  if (!pose) return 0;
  const tr = pose.transform, p = tr.position, o = tr.orientation;
  HEAD[0] = p.x; HEAD[1] = p.y; HEAD[2] = p.z; HEAD[3] = o.x; HEAD[4] = o.y; HEAD[5] = o.z; HEAD[6] = o.w;
  const vs = pose.views;
  let n = vs.length; if (n > 2) n = 2;     // primary stereo views ('secondary-views' is not requested)
  XR.changed = 0;
  for (let i = 0; i < n; i++) {
    const v = vs[i];
    const sub = XR.binding.getViewSubImage(XR.layer, v);
    const vp = sub.viewport;
    const k = i * 4;
    if (VP[k + 2] !== vp.width || VP[k + 3] !== vp.height) XR.changed = 1;
    VP[k] = vp.x; VP[k + 1] = vp.y; VP[k + 2] = vp.width; VP[k + 3] = vp.height;
    const tex = sub.colorTexture;
    const desc = sub.getViewDescriptor();
    const layer = desc.baseArrayLayer | 0;
    // a new GPUTexture every frame on a real device (spec: acquire WebGPU textures), so a new view; a mock that
    // keeps its texture keeps its view
    if (tex !== XR.texSeen[i] || layer !== XR.layerSeen[i]) { XR.target[i] = tex.createView(desc); XR.texSeen[i] = tex; XR.layerSeen[i] = layer; }
    const t = v.transform, vpp = t.position, vq = t.orientation;
    const e = i * 7;
    EYE[e] = vpp.x; EYE[e + 1] = vpp.y; EYE[e + 2] = vpp.z; EYE[e + 3] = vq.x; EYE[e + 4] = vq.y; EYE[e + 5] = vq.z; EYE[e + 6] = vq.w;
    const m = v.projectionMatrix;
    for (let j = 0; j < 16; j++) PJ[j] = m[j];
    mat4XRToRevZ(PROJ, PJ, NEAR, i * 16);
  }
  XR.layered = n === 2 && XR.layerSeen[0] !== XR.layerSeen[1] ? 1 : 0;
  XR.views = n;
  readInputs(xf);
  return n;
}

// controllers: grip poses and the xr-standard gamepad (axes 2, 3 = thumbstick; buttons 0 trigger, 1 squeeze,
// 3 thumbstick press, 4 A/X, 5 B/Y)
function readInputs(xf) {
  GRIP[7] = 0; GRIP[15] = 0; PAD[7] = 0; PAD[15] = 0;
  const srcs = XR.session.inputSources;
  const n = srcs.length;
  for (let i = 0; i < n; i++) {
    const s = srcs[i];
    const h = s.handedness === 'left' ? 0 : s.handedness === 'right' ? 1 : -1;
    if (h < 0) continue;
    if (s.gripSpace) {
      const gp = xf.getPose(s.gripSpace, XR.space);
      if (gp) {
        const p = gp.transform.position, o = gp.transform.orientation, g = h * 8;
        GRIP[g] = p.x; GRIP[g + 1] = p.y; GRIP[g + 2] = p.z; GRIP[g + 3] = o.x; GRIP[g + 4] = o.y; GRIP[g + 5] = o.z; GRIP[g + 6] = o.w; GRIP[g + 7] = 1;
      }
    }
    const pad = s.gamepad;
    if (pad) {
      const a = pad.axes, b = pad.buttons, k = h * 8;
      PAD[k] = a.length > 3 ? a[2] : a.length > 1 ? a[0] : 0;
      PAD[k + 1] = -(a.length > 3 ? a[3] : a.length > 1 ? a[1] : 0); // XR reports up as negative (API.md)
      PAD[k + 2] = b.length > 0 ? b[0].value : 0; PAD[k + 3] = b.length > 1 ? b[1].value : 0;
      PAD[k + 4] = b.length > 4 && b[4].pressed ? 1 : 0; PAD[k + 5] = b.length > 5 && b[5].pressed ? 1 : 0;
      PAD[k + 6] = b.length > 3 && b[3].pressed ? 1 : 0; PAD[k + 7] = 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------- per frame: act
// Controls, before sim.step. Buttons (edges): right A flight mode, right B LOS/FPV, left X reset, left Y comfort
// vignette, left stick press Normal/Sport, right stick press recenter; right trigger boost (hold).
// A real gamepad or transmitter takes priority while it moves (for a second after its last movement).
export function controls(sim) {
  const IN = sim._dbg.IN, time = CLK[C_TIME];
  let padMoving = 0;
  for (let s = 0; s < 4; s++) if (IN.gp[s] > 0.12 || IN.gp[s] < -0.12 || IN.kb[s] > 0.05 || IN.kb[s] < -0.05) padMoving = 1;
  if (padMoving) N[N_PADT] = time;
  const xrSticks = PAD[7] > 0 || PAD[15] > 0;
  if (xrSticks && !(N[N_PADT] >= 0 && time - N[N_PADT] < 1)) {
    // what sim.setXRSticks(lx, ly, rx, ry) does, without passing four doubles (each would be boxed every frame)
    IN.xr[0] = PAD[0]; IN.xr[1] = PAD[1]; IN.xr[2] = PAD[8]; IN.xr[3] = PAD[9]; IN.xrFlag[0] = 1;
  }
  sim.boost = PAD[8 + 2] > 0.5 ? 1 : 0;
  if (edge(8 + 4)) sim.press(IN.ACT_MODE);
  if (edge(8 + 5)) setMode(sim, XR.mode === XR_LOS ? XR_FPV : XR_LOS);
  if (edge(4)) sim.press(IN.ACT_RESET);
  if (edge(5)) XR.vignette = XR.vignette ? 0 : 1;
  if (edge(6)) sim.press(IN.ACT_SPORT);
  if (edge(8 + 6)) recenter();
  for (let i = 0; i < 16; i++) PADPREV[i] = PAD[i];
  sim.cameraMode = XR.mode === XR_FPV ? 0 : 2;
  if (WHEAD[6] !== 0 || WHEAD[3] !== 0) sim.setHeadPose(WHEAD);
}
function edge(k) { return PAD[k] > 0.5 && PADPREV[k] <= 0.5 ? 1 : 0; }
export function setMode(sim, m) { XR.mode = m; N[N_ANCH] = 0; sim.cameraMode = m === XR_FPV ? 0 : 2; }

// ---------------------------------------------------------------------------------------------- per frame: place
// After sim.step: world poses of the eyes, head and hands.
//   Line of sight: the local-floor origin sits on the ground under sim.pilot, turned so that the direction the
//   player faced when anchored looks at the drone. World = O + Ry(yaw0) * local. Re-anchors when the sim moves the
//   pilot (300 m rule, teleport, respawn) and on recenter.
//   FPV: the eyes ride rigidly on the drone camera (sim.cam position); orientation is the head's, its yaw turned by
//   the drone heading since the last recenter (horizon locked: the drone's pitch and roll never tilt the view).
//   World = C + Ry(psi - yawRef) * (local - head), orientation Ry(psi - yawRef) * local.
export function place(sim) {
  const dt = CLK[C_DT];
  const n = XR.views;
  const fpv = XR.mode === XR_FPV;
  yawOf(HEAD, 3); // -> N[N_HY] (a returned double would be boxed)
  const hy = N[N_HY];
  if (!fpv) {
    const pl = sim.pilot;
    if (N[N_ANCH] === 0 || Math.abs(pl[0] - N[N_PX]) > 0.01 || Math.abs(pl[2] - N[N_PZ]) > 0.01) {
      const d = sim.drone;
      const want = Math.atan2(-(d[0] - pl[0]), -(d[2] - pl[2])); // heading that faces the drone
      N[N_YAW] = want - hy;
      const c = Math.cos(N[N_YAW]), s = Math.sin(N[N_YAW]);
      // put the head (as it stands now) on the pilot spot
      N[N_OX] = pl[0] - (c * HEAD[0] + s * HEAD[2]);
      N[N_OZ] = pl[2] - (-s * HEAD[0] + c * HEAD[2]);
      N[N_OY] = pl[1] - 1.7 + (XR.floor ? 0 : 1.7);
      N[N_PX] = pl[0]; N[N_PZ] = pl[2]; N[N_ANCH] = 1;
    }
    for (let i = 0; i < n; i++) toWorldLOS(EYE, i * 7, WEYE, i * 7);
    toWorldLOS(HEAD, 0, WHEADD, 0);
    for (let h = 0; h < 2; h++) { toWorldLOS(GRIP, h * 8, WGRIP, h * 8); WGRIP[h * 8 + 7] = GRIP[h * 8 + 7]; }
    N[N_VIG] = 0;
  } else {
    const psi = sim.info[6];
    if (N[N_ANCH] === 0) { N[N_YREF] = hy; N[N_PSI] = psi; N[N_VX] = sim.drone[7]; N[N_VY] = sim.drone[8]; N[N_VZ] = sim.drone[9]; N[N_ANCH] = 1; }
    N[N_YAW] = psi - N[N_YREF];
    const c = sim.cam;
    N[N_OX] = c[0]; N[N_OY] = c[1]; N[N_OZ] = c[2];
    for (let i = 0; i < n; i++) toWorldFPV(EYE, i * 7, WEYE, i * 7);
    toWorldFPV(HEAD, 0, WHEADD, 0);
    for (let h = 0; h < 2; h++) { toWorldFPV(GRIP, h * 8, WGRIP, h * 8); WGRIP[h * 8 + 7] = GRIP[h * 8 + 7]; }
    // comfort vignette: the view turning (yaw rate) and accelerating that the inner ear does not feel
    let dpsi = psi - N[N_PSI]; dpsi -= 6.283185307179586 * Math.round(dpsi / 6.283185307179586);
    N[N_PSI] = psi;
    const idt = dt > 1e-4 ? 1 / dt : 0;
    const ax = (sim.drone[7] - N[N_VX]) * idt, ay = (sim.drone[8] - N[N_VY]) * idt, az = (sim.drone[9] - N[N_VZ]) * idt;
    N[N_VX] = sim.drone[7]; N[N_VY] = sim.drone[8]; N[N_VZ] = sim.drone[9];
    let want = Math.abs(dpsi * idt) * 0.55 + Math.sqrt(ax * ax + ay * ay + az * az) * 0.035;
    want = want > 1 ? 1 : want;
    // fast in, slow out
    const k = want > N[N_VIG] ? 1 - Math.exp(-12 * dt) : 1 - Math.exp(-1.5 * dt);
    N[N_VIG] += (want - N[N_VIG]) * k;
  }
  for (let i = 0; i < 7; i++) WHEAD[i] = WHEADD[i];
}
const WHEADD = new Float64Array(7);
function yawOf(a, o) {
  // heading of the -Z axis of quaternion a[o..o+3], sim convention (faces (-sin, 0, -cos)), into N[N_HY]
  qa[0] = a[o]; qa[1] = a[o + 1]; qa[2] = a[o + 2]; qa[3] = a[o + 3];
  v3[0] = 0; v3[1] = 0; v3[2] = -1;
  quatRotate(v3b, qa, v3);
  N[N_HY] = Math.atan2(-v3b[0], -v3b[2]);
}
function rotYaw(src, so, dst, d0) {
  qb[0] = 0; qb[1] = Math.sin(N[N_YAW] * 0.5); qb[2] = 0; qb[3] = Math.cos(N[N_YAW] * 0.5);
  qa[0] = src[so + 3]; qa[1] = src[so + 4]; qa[2] = src[so + 5]; qa[3] = src[so + 6];
  quatMul(qa, qb, qa);
  dst[d0 + 3] = qa[0]; dst[d0 + 4] = qa[1]; dst[d0 + 5] = qa[2]; dst[d0 + 6] = qa[3];
}
function toWorldLOS(src, so, dst, d0) {
  const c = Math.cos(N[N_YAW]), s = Math.sin(N[N_YAW]);
  const x = src[so], y = src[so + 1], z = src[so + 2];
  dst[d0] = N[N_OX] + c * x + s * z; dst[d0 + 1] = N[N_OY] + y; dst[d0 + 2] = N[N_OZ] - s * x + c * z;
  rotYaw(src, so, dst, d0);
}
function toWorldFPV(src, so, dst, d0) {
  const c = Math.cos(N[N_YAW]), s = Math.sin(N[N_YAW]);
  const x = src[so] - HEAD[0], y = src[so + 1] - HEAD[1], z = src[so + 2] - HEAD[2];
  dst[d0] = N[N_OX] + c * x + s * z; dst[d0 + 1] = N[N_OY] + y; dst[d0 + 2] = N[N_OZ] - s * x + c * z;
  rotYaw(src, so, dst, d0);
}

// view i of the renderer from the XR view: world pose, converted projection, viewport, anchor and vignette
export function fillView(v, i) {
  const e = i * 7;
  for (let k = 0; k < 7; k++) v.pose[k] = WEYE[e + k];
  for (let k = 0; k < 16; k++) v.proj[k] = PROJ[i * 16 + k];
  v.useProj = 1;
  const q = i * 4;
  v.vx = VP[q]; v.vy = VP[q + 1]; v.vw = VP[q + 2]; v.vh = VP[q + 3];
  v.anc[0] = WHEADD[0]; v.anc[1] = WHEADD[1]; v.anc[2] = WHEADD[2];
  v.anc[3] = XR.mode === XR_FPV && XR.vignette ? N[N_VIG] : 0;
}
