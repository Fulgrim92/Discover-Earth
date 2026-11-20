// main.js: boot, frame loop, pass order, per-view rendering, resize, dynamic resolution, harness modes.
// Zero per-frame allocations: everything the loop touches is built in init(); see DESIGN section 9. Platform
// objects we cannot avoid per frame: the command encoder, its pass encoders and command buffer, the rAF timestamp,
// and getCurrentTexture().createView() (canvas path only); see tools/alloc.mjs for the measured list.
//
// Modes (URL):
//   (default)        fly: the sim drives the camera; start overlay until the first gesture
//   script=<name>    scripted flight (src/script.js) at a fixed dt (fps=60); bench=1 flies script 'bench' and reports;
//                    stride=<n> flies n fixed steps per rendered frame (long routes on a slow software GPU)
//   shot=1           harness capture into an offscreen texture: static URL camera (realm, pos, yaw, pitch, fov), or
//                    with script=<name> the page exposes __halcyon.capture(t) for tools/play.mjs
//   free=1           debug free-fly camera without the sim (WASD, arrows, E/Q up/down, Shift fast)
//   present=0        render the final pass offscreen (headless runs of the real loop: alloc, bench)
//                    with at most inflight=<n> (2) frames queued on the GPU; inflight=0: no cap
//   alloc=1          zero-allocation gate hooks (tools/alloc.mjs): warm=<frames>, frames=<frames>
//   dynres=0|1, target=<gpu ms>, hdr=1, stereo=1, scale=<fixed internal scale>, quality=low|high, hud=0, audio=1
// Debug: dbg=1 no water, 2 terrain albedo, 3 sun shadow, 4 terrain normal, 5 water reflection only, 6 water
// refraction only, 7 water normal, 8 no fog. staged=1 (+verbose=1) times each pass of a static shot separately.
import { G, H, fail, initDevice, Unsupported, bgl, bindGroup, tex, buffer, FRAME_FLOATS, VIEW_FLOATS, FO, VO,
  setTimerBase, tsBoth, TS_BAKE, TS_OPAQUE, TS_CLOUDS, TS_COMPOSITE, TS_FX, TS_BLOOM, TS_FINAL } from './gpu.js';
import { TABLE, ROWF, F, realmCentre, CURATED, REALM_NAMES } from './realms.js';
import { heightAt, heightBatch, blendAtA, W_IN, W_NEAR } from './world.js';
import { CLK, C_DT, C_TIME, C_FRAME_MS, C_PREV } from './clock.js';
import { quatFromYawPitchRoll, quatRotate, mat4ViewRot, mat4PerspRevZ, mat4Mul, mat4Invert } from './math.js';
import * as clipmap from './fx/clipmap.js';
import * as terrain from './fx/terrain.js';
import * as clouds from './fx/clouds.js';
import * as composite from './fx/composite.js';
import * as post from './fx/post.js';
import * as rings from './fx/rings.js';
import * as drone from './fx/drone.js';
import { createSim } from './sim/index.js';
import { createPlayer, simState } from './script.js';
import * as perf from './perf.js';
import { startOverlay, showMessage, benchPanel } from './ui.js';

export const world = { heightAt, heightBatch, CURATED };

// ---------- URL parameters ----------
const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) && Q.get(k) !== '' ? parseFloat(Q.get(k)) : d);
const SCRIPT_STRIDE = () => (Q.has('script') || num('bench', 0) > 0 ? Math.max(1, num('stride', 1) | 0) : 1);
const P = {
  realm: Q.has('realm') ? parseInt(Q.get('realm'), 10) : -1,
  pos: Q.has('pos') ? Q.get('pos').split(',').map(parseFloat) : null,
  agl: num('agl', 0) > 0,
  yaw: num('yaw', 0), pitch: num('pitch', -4), fov: num('fov', 60),
  t: Q.has('t') ? num('t', 0) : -1,
  w: num('w', 0), h: num('h', 0), scale: Q.has('scale') ? Math.min(1, Math.max(0.25, num('scale', 1))) : 0,
  stereo: num('stereo', 0) > 0, hud: num('hud', 1) > 0, bench: num('bench', 0) > 0,
  quality: Q.get('quality') === 'low' ? 0 : Q.get('quality') === 'high' ? 2 : 1,
  shot: num('shot', 0) > 0, dbg: num('dbg', 0), staged: num('staged', 0) > 0, heightcheck: num('heightcheck', 0) > 0,
  script: Q.get('script') || '', fps: num('fps', 60), free: num('free', 0) > 0, present: num('present', 1) > 0,
  stride: SCRIPT_STRIDE(), alloc: num('alloc', 0) > 0, warm: num('warm', 600), frames: num('frames', 0), audio: num('audio', 0) > 0,
  dynres: num('dynres', -1), target: num('target', 11), hdr: num('hdr', 0) > 0, sim: num('sim', -1), simt: num('simt', 0.5),
  orbit: Q.has('orbit') ? Q.get('orbit').split(',').map(parseFloat) : null, timer: num('timer', 1) > 0,
};
if (P.bench && !P.script) P.script = 'bench';
const SCRIPTED = P.script !== '';
const CAPTURE = P.shot && SCRIPTED;         // tools/play.mjs drives frames through __halcyon.capture(t)
const STATIC = P.shot && !SCRIPTED;         // one frame from the URL camera
const OFFSCREEN = P.shot || !P.present;
// Offscreen (present=0) there is no swap chain to hold the CPU back, so a slow GPU (SwiftShader) falls further and
// further behind: frame times would measure rAF, not rendering, and readbacks would wait behind an ever longer
// queue. Cap the frames in flight (default 2; inflight=0 turns the cap off, as the alloc gate does).
const MAX_INFLIGHT = OFFSCREEN && !P.shot ? num('inflight', 2) : 0;
const FL = { n: 0, done: () => { FL.n--; } };
const USE_SIM = !P.free && (STATIC ? P.sim > 0 : true);
const FIXED_DT = SCRIPTED ? 1 / P.fps : 0;

// ---------- camera ----------
// cam: [px,py,pz, qx,qy,qz,qw, fovY] for the flat view (sim.cam when the sim runs)
export const cam = new Float32Array(8);
const camPos = new Float64Array(3);
let yaw = (P.yaw * Math.PI) / 180, pitch = (P.pitch * Math.PI) / 180;
const q4 = new Float32Array(4), v3a = new Float32Array(3), v3b = new Float32Array(3), FWD = new Float32Array([0, 0, -1]);
const RIGHT = new Float32Array([1, 0, 0]), UPV = new Float32Array([0, 1, 0]);
export const R = { sim: null, player: null };

function initCamera() {
  const c = new Float32Array(2);
  if (P.realm >= 0) realmCentre(P.realm, c);
  let x = c[0], y = 120, z = c[1];
  if (P.pos) { x += P.pos[0] || 0; y = P.pos[1] == null || isNaN(P.pos[1]) ? 120 : P.pos[1]; z += P.pos[2] || 0; }
  if (P.agl || !P.pos) y += Math.max(0, heightAt(x, z));
  camPos[0] = x; camPos[1] = y; camPos[2] = z;
}

// ---------- keyboard free-fly (free=1 only) ----------
const keys = new Uint8Array(256);
function keyIdx(code) {
  switch (code) {
    case 'KeyW': return 1; case 'KeyS': return 2; case 'KeyA': return 3; case 'KeyD': return 4;
    case 'KeyE': case 'Space': return 5; case 'KeyQ': case 'KeyC': return 6;
    case 'ArrowLeft': return 7; case 'ArrowRight': return 8; case 'ArrowUp': return 9; case 'ArrowDown': return 10;
    case 'ShiftLeft': case 'ShiftRight': return 11;
    default: return 0;
  }
}
function freeFly(dt) {
  const sp = (keys[11] ? 220 : 40) * dt, tr = 1.2 * dt;
  yaw += (keys[8] - keys[7]) * tr; pitch += (keys[9] - keys[10]) * tr;
  pitch = Math.max(-1.5, Math.min(1.5, pitch));
  const fx = Math.sin(yaw), fz = -Math.cos(yaw);
  const f = keys[1] - keys[2], s = keys[4] - keys[3];
  camPos[0] += (fx * f - fz * s) * sp; camPos[2] += (fz * f + fx * s) * sp;
  camPos[1] += (keys[5] - keys[6]) * sp;
  const g = heightAt(camPos[0], camPos[2]);
  if (camPos[1] < Math.max(g, 0) + 1.5) camPos[1] = Math.max(g, 0) + 1.5;
}

// ---------- renderer state ----------
const ctx = { frame: new Float32Array(FRAME_FLOATS), frameBuf: null, views: [], bgl0: null, linear: null, quality: P.quality, msaa: 4 };
let context = null, canvas, tg, opaqueDesc, nViews = 1, offTex = null, offView = null;
const owned = [];
const CMD = [null];
const rowTmp = new Float32Array(ROWF);
const vpTmp = new Float32Array(16), rotTmp = new Float32Array(16);
CLK[C_PREV] = -1;
let frameNo = 0, running = true, paused = false, resumed = true, needResize = false, started = false;
let overlay = null;
const MAXPIX = [1280 * 720, 2560 * 1440, 3840 * 2160]; // internal resolution cap per quality

function makeTargets(w, h) {
  for (const t of owned) t.destroy();
  owned.length = 0;
  const U = GPUTextureUsage;
  const RA = U.RENDER_ATTACHMENT, TB = U.TEXTURE_BINDING;
  const T = (...a) => { const x = tex(...a); owned.push(x); return x; };
  const t = { w, h };
  const ms = ctx.msaa > 1;
  const scene = T(w, h, 'rgba16float', RA | TB, { label: 'scene' });
  const dist = T(w, h, 'r16float', RA | TB, { label: 'dist' });
  t.sceneV = scene.createView(); t.distV = dist.createView();
  const depth = T(w, h, 'depth32float', RA, { samples: ctx.msaa, label: 'depth' });
  t.compV = T(w, h, 'rgba16float', RA | TB, { label: 'comp' }).createView();
  const ca = [
    { view: t.sceneV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    { view: t.distV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 60000, g: 0, b: 0, a: 1 } },
  ];
  if (ms) {
    ca[0].view = T(w, h, 'rgba16float', RA, { samples: ctx.msaa, label: 'sceneMS' }).createView();
    ca[0].resolveTarget = t.sceneV; ca[0].storeOp = 'discard';
    ca[1].view = T(w, h, 'r16float', RA, { samples: ctx.msaa, label: 'distMS' }).createView();
    ca[1].resolveTarget = t.distV; ca[1].storeOp = 'discard';
  }
  opaqueDesc = { colorAttachments: ca, depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    timestampWrites: tsBoth(TS_OPAQUE) };
  t.cloudV = clouds.bind(ctx, t);
  composite.bind(ctx, t);
  rings.bind(ctx, t);
  post.bind(ctx, t);
  return t;
}

function internalScale() { return P.scale > 0 ? P.scale : perf.dyn.scale; }

function layoutViews() {
  const cw = canvas.width, ch = canvas.height;
  const vw = Math.floor(cw / nViews);
  for (let i = 0; i < nViews; i++) {
    const v = ctx.views[i];
    v.vx = i * vw; v.vy = 0; v.vw = vw; v.vh = ch;
  }
  const s = internalScale();
  tg = makeTargets(Math.max(8, Math.round(vw * s)), Math.max(8, Math.round(ch * s)));
  if (OFFSCREEN && !P.shot && (!offTex || offTex.width !== cw || offTex.height !== ch)) {
    if (offTex) offTex.destroy();
    offTex = G.device.createTexture({ size: [cw, ch], format: G.canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'offscreen' });
    offView = offTex.createView();
  }
  H.size = [cw, ch, tg.w, tg.h];
}

// canvas size from the window, devicePixelRatio and the per-quality pixel cap (the browser scales the rest)
function fitCanvas() {
  if (P.w) return false;
  const dpr = devicePixelRatio || 1;
  let w = Math.max(16, Math.round(innerWidth * dpr)), h = Math.max(16, Math.round(innerHeight * dpr));
  const cap = MAXPIX[P.quality], px = w * h;
  if (px > cap) { const k = Math.sqrt(cap / px); w = Math.round(w * k); h = Math.round(h * k); }
  if (w === canvas.width && h === canvas.height) return false;
  canvas.width = w; canvas.height = h;
  return true;
}

// real canvas path: preferred format (or rgba16float for HDR), Display-P3 when the screen has it, 'extended'
// tone mapping for HDR (toggle: G key or ?hdr=1, only where the display reports high dynamic range)
function configureCanvas() {
  const hdrOk = matchMedia('(dynamic-range: high)').matches;
  if (G.hdr && !hdrOk) G.hdr = false;
  G.canvasFormat = G.hdr ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
  G.p3 = matchMedia('(color-gamut: p3)').matches;
  const cfg = { device: G.device, format: G.canvasFormat, alphaMode: 'opaque', colorSpace: G.p3 ? 'display-p3' : 'srgb' };
  if (G.hdr) cfg.toneMapping = { mode: 'extended' };
  context.configure(cfg);
  if (G.hdr) {
    // older Chrome ignores toneMapping: then the float canvas is clamped to SDR, so fall back
    const c = context.getConfiguration ? context.getConfiguration() : null;
    if (!c || !c.toneMapping || c.toneMapping.mode !== 'extended') { G.hdr = false; configureCanvas(); return; }
  }
  ctx.frame[FO.misc + 3] = (G.p3 ? 1 : 0) + (G.hdr ? 2 : 0);
  H.canvas = { format: G.canvasFormat, colorSpace: cfg.colorSpace, hdr: G.hdr };
}
function toggleHDR() {
  if (OFFSCREEN) return;
  G.hdr = !G.hdr;
  configureCanvas();
  post.init(ctx); post.bind(ctx, tg); // the final pipeline targets the canvas format
}

async function init() {
  await initDevice({ noTimer: !P.timer });
  canvas = document.getElementById('c');
  const W = P.w || Math.round(innerWidth * devicePixelRatio), Hh = P.h || Math.round(innerHeight * devicePixelRatio);
  canvas.width = W; canvas.height = Hh;
  if (P.w) { canvas.style.width = P.w + 'px'; canvas.style.height = P.h + 'px'; } else fitCanvas();
  if (P.shot) {
    // Headless capture: WebGPU canvas presentation is not reliable under SwiftShader, so the final pass renders to
    // an offscreen texture that is read back into a 2D canvas once per shot (harness only, outside the frame loop).
    G.canvasFormat = 'rgba8unorm';
    offTex = G.device.createTexture({ size: [W, Hh], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    offView = offTex.createView();
    context = canvas.getContext('2d');
  } else if (OFFSCREEN) {
    G.canvasFormat = 'rgba8unorm';
  } else {
    context = canvas.getContext('webgpu');
    if (!context) throw new Unsupported('nogpu');
    G.hdr = P.hdr;
    configureCanvas();
  }
  G.lost = (info) => { running = false; if (!P.shot) showMessage('lost', info && info.message); };
  if (OFFSCREEN) ctx.frame[FO.misc + 3] = 0;

  const d = G.device;
  ctx.frameBuf = buffer(FRAME_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'frame');
  const realmBuf = buffer(TABLE.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'realms');
  G.queue.writeBuffer(realmBuf, 0, TABLE);
  ctx.bgl0 = bgl('uur', 'g0');
  ctx.linear = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  nViews = P.stereo ? 2 : 1;
  for (let i = 0; i < 2; i++) {
    const buf = buffer(VIEW_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'view' + i);
    ctx.views.push({
      data: new Float32Array(VIEW_FLOATS), buf, bg0: bindGroup(ctx.bgl0, [ctx.frameBuf, buf, realmBuf]),
      vx: 0, vy: 0, vw: 1, vh: 1, eye: i === 0 ? (P.stereo ? -0.032 : 0) : 0.032,
      // the view's own pose and projection (XR fills these from XRView; desktop/stereo from cam + eye offset)
      pose: new Float32Array(7), fovY: 1, proj: new Float32Array(16), useProj: 0,
    });
  }
  perf.initTimer();
  perf.dyn.enabled = P.scale > 0 ? false : P.dynres >= 0 ? P.dynres > 0 : !P.shot && !P.bench && !P.alloc;
  perf.dyn.target = P.target;
  clipmap.init(ctx); terrain.init(ctx); clouds.init(ctx); composite.init(ctx); rings.init(ctx); drone.init(ctx); post.init(ctx);
  layoutViews();
  initCamera();

  if (USE_SIM) {
    const sim = createSim(world, { hud: P.hud ? undefined : false, help: false });
    R.sim = sim;
    if (P.realm >= 0 && !STATIC) sim.jumpToRealm(P.realm);
    if (Q.has('fm')) sim.flightMode = num('fm', 0) | 0;
    if (STATIC) {
      if (P.realm >= 0) sim.jumpToRealm(P.realm);
      for (let t = 0; t < P.simt; t += 1 / 60) sim.step(1 / 60);
    }
    if (SCRIPTED) {
      R.player = createPlayer(sim, P.script);
      if (!R.player) throw new Error('unknown script "' + P.script + '"');
    }
    if (!STATIC) sim.attach(canvas);
    if (P.audio) sim.startAudio();
  }
  if (!P.shot) attachPage();
  H.timer = G.timestamp ? 'timestamp-query' : 'none';
}

// ---------- page events (outside the frame loop) ----------
function attachPage() {
  addEventListener('resize', () => { needResize = true; });
  document.addEventListener('visibilitychange', () => {
    const hid = document.hidden;
    if (hid === paused) return;
    paused = hid;
    if (R.sim) R.sim.pauseAudio(hid);
    if (!hid && running) { resumed = true; requestAnimationFrame(frame); }
  });
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyG' && !e.repeat && !e.ctrlKey && !e.metaKey) toggleHDR();
    if (P.free) keys[keyIdx(e.code)] = 1;
  });
  if (P.free) addEventListener('keyup', (e) => { keys[keyIdx(e.code)] = 0; });
  addEventListener('blur', () => keys.fill(0));
  // hide the cursor while flying; any movement shows it again for 2.5 s
  let hideT = 0;
  addEventListener('pointermove', () => {
    if (!started) return;
    document.body.style.cursor = '';
    clearTimeout(hideT);
    hideT = setTimeout(() => { document.body.style.cursor = 'none'; }, 2500);
  });
  if (!SCRIPTED && !P.alloc && !P.free) {
    overlay = startOverlay(() => {
      started = true;
      canvas.focus();
      if (R.sim) R.sim.startAudio();
      document.body.style.cursor = 'none';
    });
  } else started = true;
}

// ---------- per view ----------
// desktop and ?stereo=1: the view's pose is the flat camera plus a sideways eye offset
function viewFromCam(v) {
  quatRotate(v3a, q4, RIGHT);
  v.pose[0] = cam[0] + v3a[0] * v.eye; v.pose[1] = cam[1] + v3a[1] * v.eye; v.pose[2] = cam[2] + v3a[2] * v.eye;
  v.pose[3] = q4[0]; v.pose[4] = q4[1]; v.pose[5] = q4[2]; v.pose[6] = q4[3];
  v.fovY = cam[7]; v.useProj = 0;
}

const vq = new Float32Array(4);
// View uniforms from v.pose (eye position + camera quaternion, -Z forward) and either v.proj (useProj = 1, e.g. an
// XRView projection; must be symmetric for viewRay) or a reverse-Z perspective from v.fovY and the viewport aspect.
function writeView(v) {
  const a = v.data;
  vq[0] = v.pose[3]; vq[1] = v.pose[4]; vq[2] = v.pose[5]; vq[3] = v.pose[6];
  a[VO.cam] = v.pose[0]; a[VO.cam + 1] = v.pose[1]; a[VO.cam + 2] = v.pose[2]; a[VO.cam + 3] = P.dbg; // debug view selector
  if (!v.useProj) mat4PerspRevZ(v.proj, v.fovY, v.vw / v.vh, 0.1, 0);
  const tanY = 1 / v.proj[5], tanX = 1 / v.proj[0];
  mat4ViewRot(rotTmp, vq);
  mat4Mul(vpTmp, v.proj, rotTmp);
  for (let i = 0; i < 16; i++) a[VO.vp + i] = vpTmp[i];
  mat4Invert(vpTmp, vpTmp);
  for (let i = 0; i < 16; i++) a[VO.ivp + i] = vpTmp[i];
  a[VO.size] = tg.w; a[VO.size + 1] = tg.h; a[VO.size + 2] = 1 / tg.w; a[VO.size + 3] = 1 / tg.h;
  quatRotate(v3a, vq, RIGHT);
  quatRotate(v3b, vq, FWD);
  a[VO.fwd] = v3b[0]; a[VO.fwd + 1] = v3b[1]; a[VO.fwd + 2] = v3b[2]; a[VO.fwd + 3] = tanY;
  a[VO.right] = v3a[0]; a[VO.right + 1] = v3a[1]; a[VO.right + 2] = v3a[2]; a[VO.right + 3] = tanX;
  quatRotate(v3b, vq, UPV);
  a[VO.up] = v3b[0]; a[VO.up + 1] = v3b[1]; a[VO.up + 2] = v3b[2]; a[VO.up + 3] = 0;
  a[VO.ofs] = v.vx; a[VO.ofs + 1] = v.vy; a[VO.ofs + 2] = v.vw; a[VO.ofs + 3] = v.vh;
  G.queue.writeBuffer(v.buf, 0, a);
}

// one view: opaque -> clouds -> composite -> effects (drone, rings) -> post into its viewport of `target`.
// Independent of the canvas: target view, viewport and matrices all come in through `v` and `target`.
function renderView(v, enc, target, first) {
  writeView(v);
  const p = enc.beginRenderPass(opaqueDesc);
  drone.drawBody(ctx, p, v);
  terrain.draw(ctx, p, v);
  p.end();
  clouds.draw(ctx, enc, v);
  composite.draw(ctx, enc, v);
  rings.pass(ctx, enc, v, drone.drawFx);
  post.draw(ctx, enc, v, target, first);
}

// frame-wide uniforms, the drone and the rings
function prepareFrame() {
  const fr = ctx.frame, dt = CLK[C_DT], timeS = CLK[C_TIME];
  W_IN[0] = cam[0]; W_IN[1] = cam[2]; blendAtA(rowTmp);
  for (let i = 0; i < ROWF; i++) fr[FO.row + i] = rowTmp[i];
  const drift = 6 * Math.sin(timeS * 0.004);
  const s0 = F.S0 * 4;
  const el = ((rowTmp[s0] + drift * 0.5) * Math.PI) / 180, az = ((rowTmp[s0 + 1] + drift) * Math.PI) / 180;
  fr[FO.sun] = Math.sin(az) * Math.cos(el); fr[FO.sun + 1] = Math.sin(el); fr[FO.sun + 2] = -Math.cos(az) * Math.cos(el); fr[FO.sun + 3] = drift;
  fr[FO.time] = timeS; fr[FO.time + 1] = dt; fr[FO.time + 2] = frameNo; fr[FO.time + 3] = P.quality;
  const sim = R.sim;
  if (sim) {
    drone.update(sim, sim.cameraMode === 0 ? 0 : 1);
    rings.update(sim);
  }
}

// encode and submit one frame (all views). bakeAll: bake every stale clip level now (frame 0)
function renderFrame(bakeAll) {
  prepareFrame();
  if (R.sim) rings.upload(); // writeBuffer: platform calls stay in renderFrame
  const slot = perf.frameBegin(frameNo, nViews);
  setTimerBase(slot, 0);
  const enc = G.device.createCommandEncoder();
  if (clipmap.update(ctx, enc, cam[0], cam[2], bakeAll) > 0) perf.markRan(slot, TS_BAKE);
  terrain.setup(ctx, cam[0], cam[2]);
  G.queue.writeBuffer(ctx.frameBuf, 0, ctx.frame);
  const target = offView || context.getCurrentTexture().createView();
  for (let i = 0; i < nViews; i++) {
    const v = ctx.views[i];
    if (!v.useProj) viewFromCam(v);
    setTimerBase(slot, i);
    renderView(v, enc, target, i === 0);
  }
  perf.markRan(slot, TS_OPAQUE); perf.markRan(slot, TS_COMPOSITE); perf.markRan(slot, TS_FX);
  perf.markRan(slot, TS_BLOOM); perf.markRan(slot, TS_FINAL);
  if (clouds.clouds.enabled) perf.markRan(slot, TS_CLOUDS);
  perf.frameEnd(enc, slot);
  CMD[0] = enc.finish();
  G.queue.submit(CMD);
  perf.afterSubmit();
  if (MAX_INFLIGHT > 0) { FL.n++; G.queue.onSubmittedWorkDone().then(FL.done, FL.done); }
  frameNo++;
  H.frame = frameNo;
}

function cameraFromSim() {
  const c = R.sim.cam;
  for (let i = 0; i < 8; i++) cam[i] = c[i];
  q4[0] = cam[3]; q4[1] = cam[4]; q4[2] = cam[5]; q4[3] = cam[6];
}
function cameraFromUrl() {
  quatFromYawPitchRoll(q4, yaw, pitch, 0);
  cam[0] = camPos[0]; cam[1] = camPos[1]; cam[2] = camPos[2];
  cam[3] = q4[0]; cam[4] = q4[1]; cam[5] = q4[2]; cam[6] = q4[3]; cam[7] = (P.fov * Math.PI) / 180;
  // orbit=dist,azimuth,elevation (deg): look at the drone from around it (static shots with sim=1)
  if (P.orbit && R.sim) {
    const d = R.sim.drone, r = P.orbit[0], az = (P.orbit[1] * Math.PI) / 180, el = ((P.orbit[2] || 0) * Math.PI) / 180;
    const hd = R.sim.info[6] + az;
    cam[0] = d[0] - Math.sin(hd) * Math.cos(el) * r; cam[1] = d[1] + Math.sin(el) * r; cam[2] = d[2] - Math.cos(hd) * Math.cos(el) * r;
    const dx = d[0] - cam[0], dy = d[1] - cam[1], dz = d[2] - cam[2];
    quatFromYawPitchRoll(q4, Math.atan2(dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), 0);
    cam[3] = q4[0]; cam[4] = q4[1]; cam[5] = q4[2]; cam[6] = q4[3];
  }
}

// ---------- the frame loop ----------
const A = { cpu0: 0 };
function frame(now) {
  if (!running || paused) return;
  if (MAX_INFLIGHT > 0 && FL.n >= MAX_INFLIGHT) { requestAnimationFrame(frame); return; } // GPU behind: wait
  if (P.bench) A.cpu0 = performance.now();
  // the clock lives in CLK (doubles in a typed array: no boxing on the frame path)
  const frameMs = CLK[C_PREV] < 0 || resumed ? 1000 / 60 : now - CLK[C_PREV];
  CLK[C_PREV] = now; resumed = false;
  let dt = frameMs * 0.001;
  dt = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt;
  if (FIXED_DT > 0) dt = FIXED_DT;
  CLK[C_DT] = dt; CLK[C_FRAME_MS] = frameMs;
  CLK[C_TIME] = P.t >= 0 ? P.t : CLK[C_TIME] + dt;
  if (H.error && !P.shot) { running = false; showMessage('error', H.error); return; }

  const sim = R.sim;
  if (sim) {
    if (overlay && !started) pollStartButton(sim);
    sim.dtIn[0] = dt;
    // stride=N (scripted runs): fly N fixed steps per rendered frame, to cover a long route with few slow frames
    for (let k = 1; k < P.stride; k++) { R.player.update(); sim.step(); CLK[C_TIME] += dt; }
    if (R.player) R.player.update();
    sim.step();
    if (STATIC) cameraFromUrl(); else cameraFromSim();
  } else {
    if (P.free && frameNo > 0) freeFly(dt);
    cameraFromUrl();
  }
  if (needResize) { needResize = false; if (fitCanvas()) layoutViews(); }
  if (perf.dyn.tick(frameNo)) layoutViews();

  if (P.staged) {
    prepareFrame();
    if (R.sim) rings.upload();
    const enc = G.device.createCommandEncoder();
    clipmap.update(ctx, enc, cam[0], cam[2], true);
    terrain.setup(ctx, cam[0], cam[2]);
    G.queue.writeBuffer(ctx.frameBuf, 0, ctx.frame);
    CMD[0] = enc.finish(); G.queue.submit(CMD); running = false;
    stagedFrame().then(shotDone);
    return;
  }
  renderFrame(frameNo === 0);

  if (P.shot) { running = false; G.queue.onSubmittedWorkDone().then(shotDone); return; }
  if (P.bench) benchFrame();
  if (P.alloc) allocFrame();
  if (SCRIPTED && R.player.done && !P.bench) R.player.reset(P.alloc); // loops (alloc: from the start realm)
  if (P.frames > 0 && !P.alloc && !P.bench && frameNo >= P.frames) { running = false; H.done = true; return; }
  if (running) requestAnimationFrame(frame);
}

// any gamepad button (or stick throw) also starts
function pollStartButton(sim) {
  const IN = sim._dbg.IN;
  if (!IN.padInfo[0]) return;
  for (let i = 0; i < IN.MAX_BUTTONS; i++) if (IN.buttons[i] > 0.5) { overlay.dismiss(); return; }
}

// ---------- ?bench=1 ----------
const B = { start: -1, end: -1 };
function benchFrame() {
  const frameMs = CLK[C_FRAME_MS];
  if (B.start < 0) {
    // record from the first rendered frame to the end of the script (or frames=N)
    const total = P.frames > 0 ? P.frames : Math.ceil((R.player.duration * P.fps) / P.stride);
    B.start = frameNo - 1; B.end = B.start + total;
    perf.recordStart(B.start, total + 1);
    H.benchState = 'running';
  }
  perf.record(frameNo - 1, frameMs, performance.now() - A.cpu0);
  if (frameNo >= B.end) { running = false; finishBench().catch((e) => { H.error = "bench: " + (e && e.stack || e); H.benchState = "error"; }); }
}
async function finishBench() {
  // let the last timer readbacks land
  // (bounded: headless SwiftShader does not always settle onSubmittedWorkDone once the frame loop has stopped)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) { await Promise.race([G.queue.onSubmittedWorkDone(), sleep(400)]); await sleep(50); }
  const r = perf.benchReport({
    script: R.player.name, w: canvas.width, h: canvas.height, internal: [tg.w, tg.h], scale: internalScale(),
    quality: ['low', 'normal', 'high'][P.quality], stereo: nViews === 2, adapter: adapterInfo(), stride: P.stride,
    inflight: MAX_INFLIGHT, present: !OFFSCREEN,
    route: 'Home Fjords rings, boost transit, Stone Forest rings, Lumen Deep rings, FPV (fixed dt 1/' + P.fps + ')',
  });
  H.bench = r;
  console.log('HALCYON_BENCH ' + JSON.stringify(r));
  benchPanel(r);
  H.benchState = 'done';
}
function adapterInfo() {
  const i = G.adapter && G.adapter.info;
  return i ? { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description } : null;
}

// ---------- ?alloc=1 (tools/alloc.mjs) ----------
// warm up, force a GC, mark, run `frames` frames, force a GC, mark. The harness reads --trace-gc between marks.
const AL = { phase: 0, f0: 0 };
function allocFrame() {
  if (AL.phase === 0 && frameNo >= P.warm) {
    AL.phase = 1; AL.f0 = frameNo;
    allocMark('start');
  } else if (AL.phase === 1 && frameNo >= AL.f0 + (P.frames || 1800)) {
    AL.phase = 2; running = false;
    allocMark('end');
  }
}
function allocMark(which) {
  // runs twice per test, outside the measured steady state
  if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }
  const m = performance.memory;
  H.alloc = H.alloc || {};
  H.alloc[which] = { frame: frameNo, heap: m ? m.usedJSHeapSize : -1, t: performance.now() };
  console.log('HALCYON_ALLOC_' + which.toUpperCase() + ' ' + frameNo);
  if (H.onAlloc) H.onAlloc(which);
  // tools/alloc.mjs binds this before the page loads, so it never has to evaluate script in the page while the
  // frame loop runs (each evaluate touches the global object and deoptimises the frame loop)
  if (globalThis.__halcyonAllocMark) globalThis.__halcyonAllocMark(which);
}

// ---------- static shots ----------
async function blitShot() {
  const w = offTex.width, h = offTex.height, bpr = Math.ceil((w * 4) / 256) * 256;
  const buf = G.device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = G.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: offTex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  G.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const img = context.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
  buf.unmap(); buf.destroy();
  context.putImageData(img, 0, 0);
}

async function shotDone() {
  await blitShot();
  if (P.heightcheck) await heightCheck();
  H.realm = REALM_NAMES[W_NEAR[2]];
  H.ready = true;
}

// DESIGN section 6: read back baked levels and compare with heightAt at 256 points (max error < 0.15 m)
async function heightCheck() {
  if (G.clipFormat !== 'rgba32float') { H.heightcheck = { skipped: 'no float32-filterable' }; return; }
  let maxErr = 0, sum = 0, n = 0, worst = null;
  const levels = [0, 2, 4, 6, 8];
  for (const L of levels) {
    const r = await clipmap.readLevel(ctx, L);
    const per = L === 8 ? 52 : 51;
    for (let k = 0; k < per; k++) {
      const h1 = Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(L + 7, 0x85ebca6b);
      const m = (h1 >>> 3) % 512, j = (h1 >>> 15) % 512;
      const x = r.x0 + m * r.t, z = r.z0 + j * r.t;
      const g = r.data[(j * 512 + m) * 4];
      const c = heightAt(x, z);
      const e = Math.abs(g - c);
      sum += e; n++;
      if (e > maxErr) { maxErr = e; worst = { level: L, x, z, gpu: g, cpu: c }; }
    }
  }
  H.heightcheck = { n, maxErr, meanErr: sum / n, worst, pass: maxErr < 0.15 };
  if (maxErr >= 0.15) fail('heightcheck failed: max error ' + maxErr.toFixed(3) + ' m at ' + JSON.stringify(worst));
}

// verbose shot mode: run each stage of view 0 as its own submit and log its time (finds slow or crashing passes)
async function stagedFrame() {
  const v = ctx.views[0];
  const log = async (name, fn) => {
    const t0 = performance.now();
    const enc = G.device.createCommandEncoder();
    fn(enc);
    G.queue.submit([enc.finish()]);
    await G.queue.onSubmittedWorkDone();
    console.log('stage ' + name + ' ' + Math.round(performance.now() - t0) + ' ms');
  };
  viewFromCam(v);
  writeView(v);
  await log('opaque', (enc) => { const p = enc.beginRenderPass(opaqueDesc); drone.drawBody(ctx, p, v); terrain.draw(ctx, p, v); p.end(); });
  await log('composite', (enc) => composite.draw(ctx, enc, v));
  await log('fx', (enc) => rings.pass(ctx, enc, v, drone.drawFx));
  await log('post', (enc) => post.draw(ctx, enc, v, offView, true));
}

// bake every stale clip level around the current camera, one level per submit (slow software GPUs)
async function bakeAround(x, z) {
  H.timing = [];
  for (let i = 0; i < clipmap.LEVELS; i++) {
    const t0 = performance.now();
    const enc = G.device.createCommandEncoder();
    const n = clipmap.update(ctx, enc, x, z, false);
    G.queue.submit([enc.finish()]);
    await G.queue.onSubmittedWorkDone();
    if (!n) break;
    H.timing.push('bake ' + Math.round(performance.now() - t0));
    if (Q.has('verbose')) console.log('bake ' + Math.round(performance.now() - t0) + ' ms');
  }
}

async function prebake() {
  H.timing = [];
  for (let i = 0; i < clipmap.LEVELS; i++) {
    const t0 = performance.now();
    const enc = G.device.createCommandEncoder();
    clipmap.bakeOne(ctx, enc, i, cam[0], cam[2]);
    G.queue.submit([enc.finish()]);
    await G.queue.onSubmittedWorkDone();
    H.timing.push('bake' + i + ' ' + Math.round(performance.now() - t0));
    if (Q.has('verbose')) console.log('bake level ' + i + ' ' + Math.round(performance.now() - t0) + ' ms');
  }
}

// ---------- scripted captures (tools/play.mjs) ----------
// capture(t): fly the script to time t at the fixed dt (no rendering), bake around the camera, render one frame
// into the offscreen texture and show it on the 2D canvas. Returns a summary of the sim state.
async function capture(t) {
  const sim = R.sim, pl = R.player, dt = FIXED_DT;
  while (pl.time() < t - 1e-9) {
    pl.update(dt); sim.step(dt);
    CLK[C_DT] = dt; CLK[C_TIME] += dt;
    drone.update(sim, 1); rings.update(sim); // keeps prop angles and ring bursts on time
  }
  cameraFromSim();
  await bakeAround(cam[0], cam[2]);
  renderFrame(false);
  await G.queue.onSubmittedWorkDone();
  await blitShot();
  H.realm = REALM_NAMES[W_NEAR[2]];
  return simState(sim, pl);
}

function boot() {
  init().then(async () => {
    if (CAPTURE) {
      H.capture = capture;
      H.scriptReady = true;
      return;
    }
    if (STATIC) { cameraFromUrl(); await prebake(); }
    H.running = true;
    requestAnimationFrame(frame);
  }).catch((e) => {
    if (e instanceof Unsupported) { H.error = 'unsupported: ' + e.message; if (!P.shot) showMessage(e.message); return; }
    fail(e && e.stack ? e.stack : e);
    if (!P.shot) showMessage('error', e && e.stack ? e.stack : String(e));
  });
}
boot();
