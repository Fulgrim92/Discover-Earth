// xrmock.js (?xrmock=1 | 2): a stand-in for navigator.xr + XRGPUBinding so the VR path runs headless and in
// any browser. It follows the WebXR/WebGPU binding draft's shapes and checks the calls the real thing checks:
// 'webgpu' must be a required/optional feature, the device must come from an xrCompatible adapter, the projection
// layer must be in renderState.layers before getViewSubImage, sub-images only inside an animation frame.
//   variant 1: projection layer = 2-layer texture array, one layer per view (the current draft)
//   variant 2: one texture with both views side by side (earlier implementations)
// Two views with asymmetric, mirrored frusta (52/42 deg out/in, 44 up, 52 down) and a 63 mm IPD; WebGPU depth range.
// Head and controllers come from the URL (xrhead=x,y,z,yawDeg,pitchDeg in the local-floor space; xrsticks=lx,ly,rx,ry)
// or, with xrscript=1, sway and fly by themselves (alloc gate). Nothing here allocates per frame: the objects are
// reused (a real UA hands out new ones; the alloc gate lists those as platform allocations).
// Harness: __halcyon.xrmock.frame() delivers one XR animation frame synchronously (shots); readback() returns the
// layer's pixels as one side-by-side RGBA image.
import { G } from './gpu.js';

const DEG = Math.PI / 180;

export function install(variant) {
  const Q = new URLSearchParams(location.search);
  const W = parseInt(Q.get('xrw') || '448', 10), H = parseInt(Q.get('xrh') || '464', 10);
  const head = (Q.get('xrhead') || '0,1.65,0,0,0').split(',').map(parseFloat);
  const sticks = (Q.get('xrsticks') || '0,0,0,0').split(',').map(parseFloat);
  const script = Q.get('xrscript') === '1';
  const layered = variant !== 2;
  const IPD = 0.063;

  // ---- projection matrices: column-major, WebGPU clip depth [0, 1] (the draft's requirement for WebGPU sessions)
  function proj(l, r, t, b, n, f) { // l, r, t, b: tangents (l, b negative)
    const m = new Float32Array(16);
    m[0] = 2 / (r - l); m[5] = 2 / (t - b);
    m[8] = (r + l) / (r - l); m[9] = (t + b) / (t - b);
    m[10] = f / (n - f); m[11] = -1; m[14] = (n * f) / (n - f);
    return m;
  }
  const tO = Math.tan(52 * DEG), tI = Math.tan(42 * DEG), tU = Math.tan(44 * DEG), tD = Math.tan(52 * DEG);
  const P = [proj(-tO, tI, tU, -tD, 0.1, 1000), proj(-tI, tO, tU, -tD, 0.1, 1000)];

  const pt = () => ({ x: 0, y: 0, z: 0, w: 1 });
  const rigid = () => ({ position: pt(), orientation: pt() });
  const views = [0, 1].map((i) => ({
    eye: i ? 'right' : 'left', projectionMatrix: P[i], transform: rigid(), index: i,
    recommendedViewportScale: null, requestViewportScale() {},
  }));
  const viewerPose = { transform: rigid(), views, emulatedPosition: false };
  const btn = () => ({ pressed: false, touched: false, value: 0 });
  const src = (hand) => ({
    handedness: hand, targetRayMode: 'tracked-pointer', profiles: ['generic-trigger-squeeze-thumbstick'],
    gripSpace: { hand }, targetRaySpace: { hand },
    gamepad: { mapping: 'xr-standard', connected: true, axes: [0, 0, 0, 0], buttons: [btn(), btn(), btn(), btn(), btn(), btn(), btn()] },
  });
  const inputSources = [src('left'), src('right')];
  const gripPose = [{ transform: rigid() }, { transform: rigid() }];

  const M = { variant, W, H, layered, frames: 0, tex: null, session: null, cb: null, active: false, t: 0, auto: true, frameObj: null, calls: [] };

  // head and hands for time M.t (s) (read here: a double passed as an argument would be boxed every frame)
  function poses() {
    const t = M.t;
    let yaw = head[3] * DEG, pitch = head[4] * DEG, x = head[0], y = head[1], z = head[2];
    if (script) { yaw += 0.35 * Math.sin(t * 0.21); pitch += 0.12 * Math.sin(t * 0.37); x += 0.05 * Math.sin(t * 0.5); }
    // q = yaw about +Y (positive turns left) * pitch about +X
    const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5), cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
    const qx = cy * sp, qy = sy * cp, qz = -sy * sp, qw = cy * cp;
    const T = viewerPose.transform;
    T.position.x = x; T.position.y = y; T.position.z = z;
    T.orientation.x = qx; T.orientation.y = qy; T.orientation.z = qz; T.orientation.w = qw;
    // head right axis = R(q) * +X
    const rx = 1 - 2 * (qy * qy + qz * qz), ry = 2 * (qx * qy + qw * qz), rz = 2 * (qx * qz - qw * qy);
    for (let i = 0; i < 2; i++) {
      const e = views[i].transform, s = (i ? 0.5 : -0.5) * IPD;
      e.position.x = x + rx * s; e.position.y = y + ry * s; e.position.z = z + rz * s;
      e.orientation.x = qx; e.orientation.y = qy; e.orientation.z = qz; e.orientation.w = qw;
    }
    // hands: in front of the body, below the eyes, following the head's yaw; tilted forward like a held controller
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), sx = Math.cos(yaw), sz = -Math.sin(yaw);
    const hp = -35 * DEG;
    const hcp = Math.cos(hp * 0.5), hsp = Math.sin(hp * 0.5);
    for (let h = 0; h < 2; h++) {
      const g = gripPose[h].transform, side = h ? 0.17 : -0.17;
      g.position.x = x + fx * 0.32 + sx * side; g.position.y = y - 0.38 + (script ? 0.03 * Math.sin(t * 0.8 + h) : 0); g.position.z = z + fz * 0.32 + sz * side;
      g.orientation.x = cy * hsp; g.orientation.y = sy * hcp; g.orientation.z = -sy * hsp; g.orientation.w = cy * hcp;
      const ax = inputSources[h].gamepad.axes;
      ax[2] = script ? 0.35 * Math.sin(t * (0.4 + 0.3 * h)) : sticks[h * 2];
      ax[3] = script ? -0.3 * Math.sin(t * (0.33 + 0.2 * h) + 1) : -sticks[h * 2 + 1]; // XR: up is negative
    }
  }

  // ---- sub-images
  const vpo = [{ x: 0, y: 0, width: W, height: H }, { x: layered ? 0 : W, y: 0, width: W, height: H }];
  const vdesc = [{ dimension: '2d', mipLevelCount: 1, arrayLayerCount: 1, baseArrayLayer: 0 },
    { dimension: '2d', mipLevelCount: 1, arrayLayerCount: 1, baseArrayLayer: layered ? 1 : 0 }];
  const subs = [0, 1].map((i) => ({ colorTexture: null, depthStencilTexture: null, motionVectorTexture: null, viewport: vpo[i], getViewDescriptor() { return vdesc[i]; } }));

  class XRGPUBindingMock {
    constructor(session, device) {
      if (!session || !session._webgpu) throw new DOMException('not a WebGPU-compatible session', 'InvalidStateError');
      if (device !== G.device || !G.xrCompatible) throw new DOMException('device not from an xrCompatible adapter', 'InvalidStateError');
      this.session = session; this.device = device; this.nativeProjectionScaleFactor = 1; this.usesDepthValues = false;
      M.calls.push('XRGPUBinding');
    }
    getPreferredColorFormat() { return 'rgba8unorm'; }
    createProjectionLayer(init) {
      if (!init || !init.colorFormat) throw new TypeError('colorFormat is required');
      if (['rgba8unorm', 'bgra8unorm', 'rgba16float'].indexOf(init.colorFormat) < 0) throw new DOMException('format', 'NotSupportedError');
      const usage = (init.textureUsage || GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC; // + readback
      M.tex = this.device.createTexture({ size: layered ? [W, H, 2] : [W * 2, H, 1], format: init.colorFormat, usage, label: 'xrmockLayer' });
      M.format = init.colorFormat;
      subs[0].colorTexture = subs[1].colorTexture = M.tex;
      M.calls.push('createProjectionLayer(' + init.colorFormat + ')');
      const layer = { textureWidth: layered ? W : 2 * W, textureHeight: H, textureArrayLength: layered ? 2 : 1, layout: 'default',
        fixedFoveation: 0, ignoreDepthValues: true, needsRedraw: true, mipLevels: 1, deltaPose: null, destroy() {} };
      M.layer = layer;
      return layer;
    }
    getViewSubImage(layer, view) {
      if (!M.active) throw new DOMException('outside an XR animation frame', 'InvalidStateError');
      if (!M.session.renderState.layers || M.session.renderState.layers.indexOf(layer) < 0) throw new TypeError('layer not in renderState.layers');
      return subs[view.index];
    }
    getSubImage() { throw new DOMException('layers feature not enabled', 'NotSupportedError'); }
  }

  const frame = {
    session: null,
    getViewerPose(space) { return space ? viewerPose : null; },
    getPose(space) { return space && space.hand ? gripPose[space.hand === 'left' ? 0 : 1] : null; },
  };
  M.frameObj = frame;

  // auto mode: each session.requestAnimationFrame arms one page rAF (one bound function, no closure per frame)
  const onRaf = (now) => {
    M.pending = 0;
    if (!M.session || !M.cb) return;
    M.t = script ? now * 0.001 : 0;
    deliver(now);
  };
  function deliver(now) {
    const cb = M.cb; M.cb = null;
    poses();
    M.active = true;
    try { cb(now, frame); } finally { M.active = false; M.frames++; }
  }
  // harness: one frame now (shots); time advances 1/90 s per frame when scripted
  M.frame = (now) => { if (M.cb) { M.t += 1 / 90; deliver(now || M.frames * 11.1); } };

  const xr = {
    async isSessionSupported(mode) { return mode === 'immersive-vr'; },
    async requestSession(mode, init) {
      if (mode !== 'immersive-vr') throw new DOMException('mode', 'NotSupportedError');
      const feats = [].concat((init && init.requiredFeatures) || [], (init && init.optionalFeatures) || []);
      const session = {
        _webgpu: feats.indexOf('webgpu') >= 0, enabledFeatures: ['webgpu', 'local-floor'], frameRate: 90,
        supportedFrameRates: new Float32Array([72, 90]), renderState: { layers: [], depthNear: 0.1, depthFar: 1000 },
        inputSources, visibilityState: 'visible', _end: [],
        updateRenderState(s) {
          if (s.baseLayer) throw new DOMException('baseLayer cannot be set in a WebGPU session', 'NotSupportedError');
          if (s.layers) this.renderState.layers = s.layers;
        },
        async requestReferenceSpace(type) { if (type !== 'local-floor' && type !== 'local') throw new DOMException(type, 'NotSupportedError'); return { type }; },
        requestAnimationFrame(cb) { M.cb = cb; if (M.auto && !M.pending) { M.pending = 1; requestAnimationFrame(onRaf); } return 1; },
        cancelAnimationFrame() { M.cb = null; },
        addEventListener(type, fn) { if (type === 'end') this._end.push(fn); },
        removeEventListener() {},
        async end() { M.session = null; for (const f of this._end) f({ session: this }); },
        updateTargetFrameRate() { return Promise.resolve(); },
      };
      if (!session._webgpu) throw new DOMException('the mock only does WebGPU sessions', 'NotSupportedError');
      frame.session = session;
      M.session = session;
      M.calls.push('requestSession(immersive-vr, webgpu)');
      return session;
    },
    addEventListener() {},
  };
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
  globalThis.XRGPUBinding = XRGPUBindingMock;

  // the layer's pixels as one side-by-side RGBA8 image (harness, outside the frame loop)
  M.readback = async () => {
    const w = W, h = H, bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = G.device.createBuffer({ size: bpr * h * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = G.device.createCommandEncoder();
    for (let i = 0; i < 2; i++) {
      enc.copyTextureToBuffer({ texture: M.tex, origin: layered ? [0, 0, i] : [i * w, 0, 0] }, { buffer: buf, offset: i * bpr * h, bytesPerRow: bpr }, [w, h, 1]);
    }
    G.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8ClampedArray(w * 2 * h * 4);
    const bgra = M.format === 'bgra8unorm';
    for (let i = 0; i < 2; i++) for (let y = 0; y < h; y++) {
      const s0 = i * bpr * h + y * bpr, d0 = (y * w * 2 + i * w) * 4;
      for (let x = 0; x < w * 4; x += 4) {
        out[d0 + x] = src[s0 + x + (bgra ? 2 : 0)]; out[d0 + x + 1] = src[s0 + x + 1];
        out[d0 + x + 2] = src[s0 + x + (bgra ? 0 : 2)]; out[d0 + x + 3] = 255;
      }
    }
    buf.unmap(); buf.destroy();
    return { w: w * 2, h, data: out };
  };
  return M;
}
