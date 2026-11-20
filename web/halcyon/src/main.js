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
//   overlay=0        no start overlay (title, controls): flying starts at once, audio on the first gesture. hud=0
//                    implies it (captures on a real GPU) unless overlay=1
//   grab=<n>         live mode (the real loop, no shot): after n frames stop, read the frame back like a shot and
//                    report __halcyon.campose / .time, so tools/livecheck.mjs can render the same pose with shot=1
//   campose=x,y,z,qx,qy,qz,qw,fovY(rad)  static shots: exact camera (overrides realm/pos/yaw/pitch/fov)
//   f32=0            behave as if the adapter had no float32-filterable (the target RX 6650 XT / D3D12 path); every
//                    tools/ gate passes it unless told f32=1
//   off=<list>       ablation for benching: comma list of OFF_NAMES (flora, fauna, particles, tshadow, tdetail, tao,
//                    fshadow, clouds, cloudshadow, water, rings, drone, msaa, veil, atmo), sent as bits in Frame.flags
//                    (OFF_* in common.wgsl); off=all switches everything off
//   split=1          opaque pass split into terrain / flora / fauna passes, timed separately (TS_FLORA, TS_FAUNA;
//                    costs an extra MSAA store and load per split, so totals read a little high)
//   bench=1          renders at a fixed 1920x1080 canvas (w=, h= override) with dynamic resolution on (dynres=0: off)
//   VR (src/xr.js): an Enter VR control (also V, gamepad d-pad left) wherever navigator.xr exists.
//   xrmock=1|2       fake WebXR + XRGPUBinding (src/xrmock.js): 1 texture-array layer, 2 side-by-side; with shot=1
//                    renders xrframes=<n> (3) XR frames and shows both eyes side by side; xrview=los|fpv,
//                    xrhead=x,y,z,yaw,pitch, xrsticks=lx,ly,rx,ry, xrw/xrh (eye size), xrscript=1 (moving head/sticks),
//                    xrvig=<0..1> (force the FPV comfort vignette, shots); xrenter=1 enters VR at once (alloc gate)
// Debug: dbg=1 no water, 2 terrain albedo, 3 sun shadow, 4 terrain normal, 5 water reflection only, 6 water
// refraction only, 7 water normal, 8 no fog, 9 no clouds. staged=1 (+verbose=1) times each pass of a static shot separately.
import { G, H, fail, initDevice, Unsupported, bgl, bindGroup, tex, buffer, FRAME_FLOATS, VIEW_FLOATS, FO, VO, pipelinesReady,
  setTimerBase, tsBoth, TS_BAKE, TS_OPAQUE, TS_CLOUDS, TS_COMPOSITE, TS_FX, TS_BLOOM, TS_FINAL, TS_LIFE, TS_WEATHER,
  TS_FLORA, TS_FAUNA } from './gpu.js';
import { TABLE, ROWF, F, realmCentre, CURATED, REALM_NAMES } from './realms.js';
import { skyTick, SKY_IN } from './realms.js'; // the sky turns (sky programmer)
import { heightAt, heightBatch, blendAtA, W_IN, W_NEAR, setFootprint } from './world.js';
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
import { aim as herdAim, AIM as HERD_AIM } from './fx/herd.js';
import { phys as IN_PHYS, buttons as IN_BUTTONS } from './sim/input.js'; // direct bindings: no namespace getter per frame
import { createPlayer, simState } from './script.js';
import * as perf from './perf.js';
import { startOverlay, showMessage, benchPanel } from './ui.js';
import * as flora from './fx/flora.js';
import * as fauna from './fx/fauna.js';
import * as particles from './fx/particles.js';
import * as atmo from './fx/atmo.js'; // the physical sky LUT (sky programmer)
import * as xr from './xr.js';
import { XR, XR_LOS, XR_FPV, VP, WHEAD } from './xr.js';
import * as xrfx from './fx/xrfx.js';

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
  tod: Q.has('tod') ? Math.min(Math.max(num('tod', 0), 0), 1) : -1, // time of day 0..1 pinned (captures)
  w: num('w', 0), h: num('h', 0), scale: Q.has('scale') ? Math.min(1, Math.max(0.25, num('scale', 1))) : 0,
  stereo: num('stereo', 0) > 0, hud: num('hud', 1) > 0, bench: num('bench', 0) > 0,
  quality: Q.get('quality') === 'low' ? 0 : Q.get('quality') === 'high' ? 2 : 1,
  shot: num('shot', 0) > 0, dbg: num('dbg', 0), staged: num('staged', 0) > 0, heightcheck: num('heightcheck', 0) > 0,
  script: Q.get('script') || '', fps: num('fps', 60), free: num('free', 0) > 0, present: num('present', 1) > 0,
  stride: SCRIPT_STRIDE(), alloc: num('alloc', 0) > 0, warm: num('warm', 600), frames: num('frames', 0), audio: num('audio', 0) > 0,
  dynres: num('dynres', -1), target: num('target', 11), hdr: num('hdr', 0) > 0, sim: num('sim', -1), simt: num('simt', 0.5),
  track: Q.has('track') ? Q.get('track').split(',').map(parseFloat) : null, // species, distance, height: aim at a herd
  orbit: Q.has('orbit') ? Q.get('orbit').split(',').map(parseFloat) : null, timer: num('timer', 1) > 0,
  grab: num('grab', 0) | 0, campose: Q.has('campose') ? Q.get('campose').split(',').map(parseFloat) : null,
};
if (P.bench && !P.script) P.script = 'bench';
// bench: a fixed 1920x1080 canvas whatever the window, so runs on different screens compare
if (P.bench && !P.w) { P.w = 1920; P.h = 1080; P.benchFixed = true; }
P.split = num('split', 0) > 0;
P.xrmock = num('xrmock', 0) | 0;
P.xrenter = P.xrmock > 0 && (P.shot || P.alloc || num('xrenter', 0) > 0);

// ---------- ablation (?off=) ----------
// bit i of Frame.flags = OFF_NAMES[i]; the same bits are named constants OFF_* in wgsl/common.wgsl
export const OFF_NAMES = ['flora', 'fauna', 'particles', 'tshadow', 'tdetail', 'tao', 'fshadow', 'clouds', 'cloudshadow',
  'water', 'rings', 'drone', 'msaa', 'tmat', 'trealm', 'tflat', 'tgeo', 'tvert', 'sky', 'tgrid', 'veil', 'atmo']; // tmat..tgrid: terrain-art's bits
const OFF_ALL = (1 << 13) - 1; // off=all: the original 13 costs (the terrain diagnostic bits are not costs)
export const OFF_FLORA = 1, OFF_FAUNA = 2, OFF_PARTICLES = 4, OFF_TSHADOW = 8, OFF_TDETAIL = 16, OFF_TAO = 32,
  OFF_FSHADOW = 64, OFF_CLOUDS = 128, OFF_CLOUDSHADOW = 256, OFF_WATER = 512, OFF_RINGS = 1024, OFF_DRONE = 2048,
  OFF_MSAA = 4096, OFF_TGEO = 65536, OFF_TGRID = 524288, OFF_VEIL = 1048576, OFF_ATMO = 2097152;
function parseOff(list) {
  let b = 0;
  for (const w of list.split(',')) {
    const k = w.trim().toLowerCase();
    if (!k) continue;
    if (k === 'all') { b |= OFF_ALL; continue; }
    const i = OFF_NAMES.indexOf(k);
    if (i < 0) console.warn('[halcyon] off=: unknown name "' + k + '" (known: ' + OFF_NAMES.join(', ') + ')');
    else b |= 1 << i;
  }
  return b;
}
const OFF = Q.has('off') ? parseOff(Q.get('off')) : 0;
H.off = OFF_NAMES.filter((n, i) => OFF & (1 << i));
const SCRIPTED = P.script !== '';
const CAPTURE = P.shot && SCRIPTED;         // tools/play.mjs drives frames through __halcyon.capture(t)
const STATIC = P.shot && !SCRIPTED;         // one frame from the URL camera
const OFFSCREEN = P.shot || !P.present || P.grab > 0;
// Offscreen (present=0) there is no swap chain to hold the CPU back, so a slow GPU (SwiftShader) falls further and
// further behind: frame times would measure rAF, not rendering, and readbacks would wait behind an ever longer
// queue. Cap the frames in flight (default 2; inflight=0 turns the cap off, as the alloc gate does).
const MAX_INFLIGHT = OFFSCREEN && !P.shot ? num('inflight', 2) : 0;
const FL = { n: 0, done: () => { FL.n--; } };
const USE_SIM = !P.free && (STATIC ? P.sim > 0 || P.xrmock > 0 : true);
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
const ctx = { frame: new Float32Array(FRAME_FLOATS), frameBuf: null, views: [], bgl0: null, linear: null, quality: P.quality,
  msaa: OFF & OFF_MSAA ? 1 : 4, off: OFF };
let splitDesc = null; // ?split=1: [terrain, flora, fauna] pass descriptors
// VR session state (ints only): [in session, eye viewport w, h, d-pad-left last frame]
const XRI = new Int32Array(4);
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
  const dist = T(w, h, 'rg16float', RA | TB, { label: 'dist' }); // x: distance, y: terrain coverage (deferred shading)
  t.sceneV = scene.createView(); t.distV = dist.createView();
  const depth = T(w, h, 'depth32float', RA | TB, { samples: ctx.msaa, label: 'depth' }); // read by terrain.shade
  t.compV = T(w, h, 'rgba16float', RA | TB, { label: 'comp' }).createView();
  const ca = [
    { view: t.sceneV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    { view: t.distV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 60000, g: 0, b: 0, a: 1 } },
  ];
  if (ms) {
    ca[0].view = T(w, h, 'rgba16float', RA, { samples: ctx.msaa, label: 'sceneMS' }).createView();
    ca[0].resolveTarget = t.sceneV; ca[0].storeOp = 'discard';
    ca[1].view = T(w, h, 'rg16float', RA | TB, { samples: ctx.msaa, label: 'distMS' }).createView();
    ca[1].resolveTarget = t.distV; ca[1].storeOp = 'store'; // per-sample terrain marks for terrain.shade
  }
  const depthV = depth.createView();
  t.distSV = ca[1].view; t.depthSV = depthV;
  opaqueDesc = { colorAttachments: ca, depthStencilAttachment: { view: depthV, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    timestampWrites: tsBoth(TS_OPAQUE) };
  if (P.split) {
    // the same attachments in three passes: the first clears and stores, the middle loads and stores, the last
    // loads and resolves (MSAA) like the single pass does
    const att = (a, load, last) => ({ view: a.view, loadOp: load ? 'load' : 'clear', clearValue: a.clearValue,
      storeOp: last ? a.storeOp : 'store', resolveTarget: last ? a.resolveTarget : undefined });
    const mk = (k, ts) => ({
      colorAttachments: [att(ca[0], k > 0, k === 2), att(ca[1], k > 0, k === 2)],
      depthStencilAttachment: { view: depthV, depthClearValue: 0, depthLoadOp: k > 0 ? 'load' : 'clear', depthStoreOp: 'store' },
      timestampWrites: tsBoth(ts),
    });
    splitDesc = [mk(0, TS_OPAQUE), mk(1, TS_FLORA), mk(2, TS_FAUNA)];
  }
  terrain.bind(ctx, t);
  t.cloudV = clouds.bind(ctx, t);
  composite.bind(ctx, t);
  rings.bind(ctx, t);
  post.bind(ctx, t);
  particles.bind(ctx, t);
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
    offTex = G.device.createTexture({ size: [cw, ch], format: G.canvasFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, label: 'offscreen' });
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
  const mx = G.device ? G.device.limits.maxTextureDimension2D : 8192;
  if (w > mx || h > mx) { const k = mx / Math.max(w, h); w = Math.floor(w * k); h = Math.floor(h * k); }
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
  xr.useGPU(G);
  await xr.probe(P.xrmock); // before the device: VR needs an xrCompatible adapter
  await initDevice({ noF32: num('f32', 1) === 0, noTimer: !P.timer, syncPipelines: num('asyncpipes', 1) === 0, xrCompatible: XR.wantCompatible });
  xr.deviceReady();
  canvas = document.getElementById('c');
  const W = P.w || Math.round(innerWidth * devicePixelRatio), Hh = P.h || Math.round(innerHeight * devicePixelRatio);
  canvas.width = W; canvas.height = Hh;
  if (P.w && !P.benchFixed) { canvas.style.width = P.w + 'px'; canvas.style.height = P.h + 'px'; } else if (!P.w) fitCanvas();
  if (P.shot || P.grab) {
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
  realmBufG = realmBuf; // rewritten each frame as the suns move (skyTime)
  G.queue.writeBuffer(realmBuf, 0, TABLE);
  ctx.bgl0 = bgl('uurfsf', 'g0'); // + the sky-view LUT and its sampler (fx/atmo.js)
  atmo.init(ctx, FO.sun, FO.flags, OFF_ATMO, realmBuf);
  ctx.linear = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  nViews = P.stereo ? 2 : 1;
  for (let i = 0; i < 2; i++) {
    const buf = buffer(VIEW_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'view' + i);
    ctx.views.push({
      data: new Float32Array(VIEW_FLOATS), buf, bg0: bindGroup(ctx.bgl0, [ctx.frameBuf, buf, realmBuf, atmo.atmo.view, atmo.atmo.sampler, atmo.atmo.csm]),
      vx: 0, vy: 0, vw: 1, vh: 1, eye: i === 0 ? (P.stereo ? -0.032 : 0) : 0.032,
      // the view's own pose and projection (XR fills these from XRView; desktop/stereo from cam + eye offset)
      pose: new Float32Array(7), fovY: 1, proj: new Float32Array(16), useProj: 0, anc: new Float32Array(4),
    });
  }
  perf.initTimer();
  // on in play and in bench unless dynres=0 (or a fixed scale=); off for shots and the alloc gate, which need fixed targets
  perf.dyn.enabled = P.scale > 0 ? false : P.dynres >= 0 ? P.dynres > 0 : !P.shot && !P.alloc;
  perf.dyn.target = P.target;
  perf.dyn.timer = G.timestamp;
  terrain.weather[0] = num('rain', 0); terrain.weather[1] = num('wet', 0); // weather stub (fx/terrain.js)
  clipmap.init(ctx); terrain.init(ctx); clouds.init(ctx); composite.init(ctx); rings.init(ctx); drone.init(ctx); post.init(ctx);
  flora.init(ctx); fauna.init(ctx); particles.init(ctx);
  if (XR.state > 0) xrfx.init(ctx);
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
  if (XR.state > 0 && !P.shot && !P.grab) xr.attachButton({ start: xrStart, end: xrEnd });
  else if (XR.state > 0) { XR.onStart = xrStart; XR.onEnd = xrEnd; } // shots: no DOM control over the capture
  H.timer = G.timestamp ? 'timestamp-query' : 'none';
  H.gpu = G.paths;
  // live counters: __halcyon.bakes is computed when read (JSON.stringify included), nothing runs per frame
  Object.defineProperty(H, 'bakes', { get: bakeReport, enumerable: true });
  H.xr = XR.state === 0 ? 'none' : XR.state === 1 ? 'unavailable: ' + XR.why : 'ready';
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
  if (!SCRIPTED && !P.alloc && !P.free && num('overlay', P.hud ? 1 : 0) > 0) {
    overlay = startOverlay(() => {
      started = true;
      canvas.focus();
      if (R.sim) R.sim.startAudio();
      document.body.style.cursor = 'none';
    });
  } else {
    started = true;
    if (R.sim && !SCRIPTED && !P.alloc) {
      // no overlay to click: audio may only start from a gesture
      const go = () => { R.sim.startAudio(); removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); };
      addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
    }
  }
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
  // off-axis centre (XR projections are asymmetric; see math.js mat4XRToRevZ and common.wgsl viewRay)
  a[VO.skew] = v.useProj ? v.proj[8] / v.proj[0] : 0; a[VO.skew + 1] = v.useProj ? v.proj[9] / v.proj[5] : 0;
  a[VO.skew + 2] = 0; a[VO.skew + 3] = 0;
  // anchor for camera-centred grids: the head in VR (xr.fillView), the flat camera otherwise (?stereo=1 too)
  if (XRI[0]) { a[VO.anc] = v.anc[0]; a[VO.anc + 1] = v.anc[1]; a[VO.anc + 2] = v.anc[2]; a[VO.anc + 3] = v.anc[3]; }
  else { a[VO.anc] = cam[0]; a[VO.anc + 1] = cam[1]; a[VO.anc + 2] = cam[2]; a[VO.anc + 3] = 0; }
  G.queue.writeBuffer(v.buf, 0, a);
}

// one view: opaque -> clouds -> composite -> effects (drone, rings) -> post into its viewport of `target`.
// Independent of the canvas: target view, viewport and matrices all come in through `v` and `target`.
const TSLOT = new Int32Array(1); // this frame's GPU timer slot
function renderView(v, enc, target, first) {
  writeView(v);
  flora.prepare(ctx, enc, v); // flora placement prepass (compute), before the opaque pass
  let p = enc.beginRenderPass(splitDesc ? splitDesc[0] : opaqueDesc);
  if (!(OFF & OFF_DRONE)) drone.drawBody(ctx, p, v);
  if (XRI[0]) xrfx.drawControllers(p, v);
  terrain.draw(ctx, p, v);
  if (splitDesc) { p.end(); p = enc.beginRenderPass(splitDesc[1]); }
  if (!(OFF & OFF_FLORA)) flora.draw(ctx, p, v);
  if (splitDesc) { p.end(); p = enc.beginRenderPass(splitDesc[2]); }
  if (!(OFF & OFF_FAUNA)) fauna.draw(ctx, p, v);
  p.end();
  terrain.shade(ctx, enc, v); // deferred terrain shading into the resolved scene
  if (clouds.draw(ctx, enc, v)) perf.markRan(TSLOT[0], TS_WEATHER); // + the weather window bake (first view)
  composite.draw(ctx, enc, v);
  // fauna's transparent jellies + motes (off=fauna hides the jellies through the fauna row, see prepareFrame)
  if (!(OFF & OFF_PARTICLES) && particles.draw(ctx, enc, v)) perf.markRan(TSLOT[0], TS_LIFE);
  rings.pass(ctx, enc, v, drone.drawFx, XRI[0] ? xrfx.drawHud : null);
  post.draw(ctx, enc, v, target, first);
}

function ss(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }
const KLS = new Float64Array(8); // keyLightDir scratch: no boxed doubles per frame
// mirror of common.wgsl keyLight: the brightness-weighted direction of the sun and the moon (sky programmer)
// drift comes in KLS[7]: a double passed as an argument would be boxed every frame
function keyLightDir(fr, row) {
  const R = Math.PI / 180, s0 = F.S0 * 4, s1 = F.S1 * 4, s8 = F.S8 * 4, k = KLS, o = FO.sun, drift = k[7];
  k[0] = (row[s0] + drift * 0.5) * R; k[1] = (row[s0 + 1] + drift) * R;
  k[2] = (row[s8] + drift * 0.25) * R; k[3] = (row[s8 + 1] + drift * 0.5) * R;
  k[4] = (0.2126 * row[s1] + 0.7152 * row[s1 + 1] + 0.0722 * row[s1 + 2]) * row[s0 + 2] * ss(-0.035, 0.06, Math.sin(k[0])) + 1e-5;
  k[5] = 1 / (Math.max(Math.sin(k[2]), 0) + 0.50572 * Math.pow(Math.max(k[2] / R + 6.07995, 0.3), -1.6364));
  k[5] = 0.9493 * row[s8 + 2] * ss(-0.035, 0.06, Math.sin(k[2])) * Math.exp(-0.22 * k[5]);
  fr[o] = Math.sin(k[1]) * Math.cos(k[0]) * k[4] + Math.sin(k[3]) * Math.cos(k[2]) * k[5];
  fr[o + 1] = Math.sin(k[0]) * k[4] + Math.sin(k[2]) * k[5];
  fr[o + 2] = -Math.cos(k[1]) * Math.cos(k[0]) * k[4] - Math.cos(k[3]) * Math.cos(k[2]) * k[5];
  k[6] = Math.sqrt(fr[o] * fr[o] + fr[o + 1] * fr[o + 1] + fr[o + 2] * fr[o + 2]);
  k[6] = k[6] > 0 ? 1 / k[6] : 1;
  fr[o] *= k[6]; fr[o + 1] *= k[6]; fr[o + 2] *= k[6];
}

// frame-wide uniforms, the drone and the rings
// ---- the sky turns (sky programmer, DESIGN 12.1): one day every SKY_PERIOD seconds; each realm's sun and moon
// swing along their arcs (realms.js SKY_ARC, skyTick). FR.sky: x time of day, y star-field turn (rad), z the
// accumulated sun motion in degrees (a monotonic key for re-baking sun shadows)
const SKY_PERIOD = 900;
let realmBufG = null;
const SKYM = new Float64Array(3); // previous s, accumulated motion (deg), time of day: typed, never boxed
const SKY_TOD = Math.max(P.tod, -1); // a small int or a constant: read once
function skyTime(fr) {
  SKYM[2] = SKY_TOD >= 0 ? SKY_TOD : (CLK[C_TIME] / SKY_PERIOD) % 1;
  SKY_IN[0] = -Math.sin(SKYM[2] * 2 * Math.PI); // from the signature light the sun first sinks
  skyTick();
  SKYM[1] += Math.abs(SKY_IN[0] - SKYM[0]) * 16; SKYM[0] = SKY_IN[0];
  fr[FO.sky] = SKYM[2]; fr[FO.sky + 1] = SKYM[2] * 2 * Math.PI; fr[FO.sky + 2] = SKYM[1];
}

function prepareFrame() {
  const fr = ctx.frame, dt = CLK[C_DT], timeS = CLK[C_TIME];
  skyTime(fr);
  W_IN[0] = cam[0]; W_IN[1] = cam[2]; blendAtA(rowTmp);
  for (let i = 0; i < ROWF; i++) fr[FO.row + i] = rowTmp[i];
  const drift = 0; // the suns move along their arcs in the realm table now (skyTime)
  const s0 = F.S0 * 4;
  const el = ((rowTmp[s0] + drift * 0.5) * Math.PI) / 180, az = ((rowTmp[s0 + 1] + drift) * Math.PI) / 180;
  fr[FO.sun] = Math.sin(az) * Math.cos(el); fr[FO.sun + 1] = Math.sin(el); fr[FO.sun + 2] = -Math.cos(az) * Math.cos(el); fr[FO.sun + 3] = drift;
  KLS[7] = drift; keyLightDir(fr, rowTmp); // the key light is the sun or the moon (common.wgsl keyLight), FR.sun its direction
  fr[FO.time] = timeS; fr[FO.time + 1] = dt; fr[FO.time + 2] = frameNo; fr[FO.time + 3] = P.quality;
  fr[FO.flags] = OFF; fr[FO.mc + 19] = W_NEAR[2]; // FR.mc[4].w: the camera's nearest realm (trealm ablation)
  if (OFF & OFF_FAUNA) for (let i = 0; i < 4; i++) fr[FO.row + F.V2 * 4 + i] = 0; // no fauna anywhere (incl. jellies)
  const sim = R.sim;
  if (sim) {
    drone.update(sim, sim.cameraMode === 0 || OFF & OFF_DRONE ? 0 : 1);
    rings.update(sim);
    if (OFF & OFF_RINGS) rings.hide();
  }
}

// encode and submit one frame (all views). bakeAll: bake every stale clip level now (frame 0)
function renderFrame(bakeAll) {
  prepareFrame();
  if (R.sim) rings.upload(); // writeBuffer: platform calls stay in renderFrame
  if (XRI[0]) xrfx.upload();
  const slot = perf.frameBegin(frameNo, nViews);
  TSLOT[0] = slot;
  setTimerBase(slot, 0);
  const enc = G.device.createCommandEncoder();
  if (clipmap.update(ctx, enc, cam[0], cam[2], bakeAll) > 0) perf.markRan(slot, TS_BAKE);
  terrain.setup(ctx, cam[0], cam[2]);
  atmo.bake(enc, cam); // + the cloud-shadow map window, in ctx.frame
  G.queue.writeBuffer(ctx.frameBuf, 0, ctx.frame);
  G.queue.writeBuffer(realmBufG, 0, TABLE); // the suns moved (skyTime)
  // VR: each view renders into its own sub-image (a texture-array layer, or one half of a side-by-side texture)
  const target = XRI[0] ? null : offView || context.getCurrentTexture().createView();
  for (let i = 0; i < nViews; i++) {
    const v = ctx.views[i];
    if (!v.useProj) viewFromCam(v);
    setTimerBase(slot, i);
    if (XRI[0]) renderView(v, enc, XR.target[i], i === 0 || XR.layered === 1);
    else renderView(v, enc, target, i === 0);
  }
  perf.markRan(slot, TS_OPAQUE); perf.markRan(slot, TS_COMPOSITE); perf.markRan(slot, TS_FX);
  if (splitDesc) { perf.markRan(slot, TS_FLORA); perf.markRan(slot, TS_FAUNA); }
  perf.markRan(slot, TS_BLOOM); perf.markRan(slot, TS_FINAL);
  perf.markRan(slot, TS_CLOUDS);
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
  if (P.campose) { for (let i = 0; i < 8; i++) cam[i] = P.campose[i]; q4[0] = cam[3]; q4[1] = cam[4]; q4[2] = cam[5]; q4[3] = cam[6]; }
  // track=species,dist,height: frame the nearest herd of that species from dist metres along the shot's yaw
  if (P.track && herdAim(P.track[0] | 0, CLK[C_TIME], camPos[0], camPos[2])) {
    const d = P.track[1] || 10, hy = P.track[2] || 2, fx = Math.sin(yaw), fz = -Math.cos(yaw);
    cam[0] = HERD_AIM[0] - fx * d; cam[2] = HERD_AIM[2] - fz * d;
    cam[1] = Math.max(heightAt(cam[0], cam[2]) + 0.5, HERD_AIM[1] + hy);
    quatFromYawPitchRoll(q4, yaw, Math.atan2(HERD_AIM[1] + 0.7 - cam[1], d), 0);
    cam[3] = q4[0]; cam[4] = q4[1]; cam[5] = q4[2]; cam[6] = q4[3];
  }
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
// the clock lives in CLK (doubles in a typed array: no boxing on the frame path); `now` is the rAF timestamp
function advanceClock(now) {
  const frameMs = CLK[C_PREV] < 0 || resumed ? 1000 / 60 : now - CLK[C_PREV];
  CLK[C_PREV] = now; resumed = false;
  let dt = frameMs * 0.001;
  dt = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt;
  if (FIXED_DT > 0) dt = FIXED_DT;
  CLK[C_DT] = dt; CLK[C_FRAME_MS] = frameMs;
  CLK[C_TIME] = P.t >= 0 ? P.t : CLK[C_TIME] + dt;
}

function frame(now) {
  if (!running || paused || XRI[0]) return; // in VR the session's requestAnimationFrame drives xrFrame instead
  if (MAX_INFLIGHT > 0 && FL.n >= MAX_INFLIGHT) { requestAnimationFrame(frame); return; } // GPU behind: wait
  if (P.bench) A.cpu0 = performance.now();
  advanceClock(now);
  const dt = CLK[C_DT];
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
    // gamepad d-pad left: Enter VR (a gamepad press may not count as a user gesture: then the control says so)
    if (XR.state > 0 && XR.click) {
      const b = IN_BUTTONS[14] > 0.5 ? 1 : 0;
      if (b && !XRI[3]) XR.click();
      XRI[3] = b;
    }
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
    atmo.bake(enc, cam);
    G.queue.writeBuffer(ctx.frameBuf, 0, ctx.frame);
    G.queue.writeBuffer(realmBufG, 0, TABLE);
    CMD[0] = enc.finish(); G.queue.submit(CMD); running = false;
    stagedFrame().then(shotDone);
    return;
  }
  renderFrame(frameNo === 0);

  if (P.shot) { running = false; G.queue.onSubmittedWorkDone().then(shotDone); return; }
  if (P.grab > 0 && frameNo >= P.grab) {
    running = false;
    H.campose = Array.from(cam.subarray(0, 8)).join(',');
    H.time = CLK[C_TIME];
    G.queue.onSubmittedWorkDone().then(shotDone);
    return;
  }
  // once: the first frame has finished on the GPU (or, where a broken swap chain never settles the queue, 30 frames on)
  if (frameNo === 1) G.queue.onSubmittedWorkDone().then(playReady);
  else if (frameNo === 30 && !H.ready) playReady();
  if (P.bench) benchFrame();
  if (P.alloc) allocFrame();
  if (SCRIPTED && R.player.done && !P.bench) R.player.reset(P.alloc); // loops (alloc: from the start realm)
  if (P.frames > 0 && !P.alloc && !P.bench && frameNo >= P.frames) { running = false; H.done = true; return; }
  if (running) requestAnimationFrame(frame);
}

// __halcyon.ready outside shot mode: pipelines compiled and the first frame finished on the GPU
function playReady() { if (P.grab) return; H.realm = REALM_NAMES[W_NEAR[2]]; H.ready = true; } // grab: ready after the grab

// any gamepad button (or stick throw) also starts
function pollStartButton(sim) {
  const IN = sim._dbg.IN;
  if (!IN.padInfo[0]) return;
  for (let i = 0; i < IN.MAX_BUTTONS; i++) if (IN.buttons[i] > 0.5) { overlay.dismiss(); return; }
}

// ---------- VR (xr.js) ----------
// The XR frame shares the desktop frame body: real dt from the XR rAF timestamp, sim step, one renderView per XR
// view into intermediate targets sized to the sub-image viewport (rebuilt only when that or the dynres scale
// changes), the final pass into the XR colour texture at its viewport. Once-per-frame work (clip bake, realm row,
// weather, sim, uniform uploads) runs once, in renderFrame / prepareFrame, as on the desktop.
const miscSaved = new Float32Array(1);
function xrStart(session) {
  XRI[0] = 1; XRI[1] = 0; XRI[2] = 0;
  started = true;
  if (overlay) overlay.dismiss();
  post.setFinalFormat(XR.format);
  ctx.cloudDiv = 3; // a third of each eye's internal size: eyes are large and the frame budget short
  miscSaved[0] = ctx.frame[FO.misc + 3];
  ctx.frame[FO.misc + 3] = 4 + (/-srgb$/.test(XR.format) ? 8 : 0); // XR: no screen vignette; an sRGB layer encodes itself
  // dynamic resolution against the session's frame budget (72/90/120 Hz): GPU target 80 % of the frame
  perf.dyn.enabled = P.scale > 0 ? false : P.dynres !== 0 && !P.shot && !P.alloc;
  perf.dyn.target = (1000 / XR.frameRate) * 0.8;
  perf.dyn.vsyncTarget = (1000 / XR.frameRate) * 1.05;
  if (R.sim) xr.setMode(R.sim, Q.get('xrview') === 'fpv' ? XR_FPV : XR_LOS);
  resumed = true;
  session.requestAnimationFrame(xrFrame);
}
function xrEnd() {
  XRI[0] = 0;
  post.setFinalFormat(G.canvasFormat);
  ctx.cloudDiv = 2;
  ctx.frame[FO.misc + 3] = miscSaved[0];
  nViews = P.stereo ? 2 : 1;
  for (const v of ctx.views) v.useProj = 0;
  perf.dyn.target = P.target; perf.dyn.vsyncTarget = 17.5;
  perf.dyn.enabled = P.scale > 0 ? false : P.dynres >= 0 ? P.dynres > 0 : !P.shot && !P.alloc;
  if (R.sim) { R.sim.setHeadPose(null); R.sim.cameraMode = 1; }
  layoutViews();
  resumed = true;
  if (running) requestAnimationFrame(frame);
}
function layoutXR() {
  const s = internalScale();
  const w = Math.max(8, Math.round(VP[2] * s)), h = Math.max(8, Math.round(VP[3] * s));
  if (!tg || tg.w !== w || tg.h !== h) tg = makeTargets(w, h);
  XRI[1] = VP[2]; XRI[2] = VP[3];
  H.size = [VP[2], VP[3], w, h];
}
const XVIG = new Float32Array([Q.has('xrvig') ? num('xrvig', 0.6) : -1]); // shots: force the comfort vignette
function xrFrame(now, xf) {
  const session = XR.session;
  if (!session || !running) return;
  session.requestAnimationFrame(xrFrame);
  if (MAX_INFLIGHT > 0 && FL.n >= MAX_INFLIGHT) return; // GPU behind: skip this one
  advanceClock(now);
  const n = xr.readFrame(xf);
  if (!n) return; // no pose (tracking lost): nothing to show this frame
  const sim = R.sim;
  if (sim) {
    xr.controls(sim);
    sim.dtIn[0] = CLK[C_DT];
    if (R.player) R.player.update();
    sim.step();
    xr.place(sim);
  }
  // the head drives the clipmap centre, the realm row and the terrain mesh (shared by both eyes)
  cam[0] = WHEAD[0]; cam[1] = WHEAD[1]; cam[2] = WHEAD[2];
  if (XRI[1] !== VP[2] || XRI[2] !== VP[3]) layoutXR();
  if (perf.dyn.tick(frameNo)) layoutXR();
  nViews = n;
  for (let i = 0; i < n; i++) xr.fillView(ctx.views[i], i);
  if (XVIG[0] >= 0) for (let i = 0; i < n; i++) ctx.views[i].anc[3] = XVIG[0];
  if (sim) xrfx.update(sim, IN_PHYS, XR.mode, XR.vignette);
  renderFrame(frameNo === 0);
  if (P.alloc) allocFrame();
  if (SCRIPTED && R.player.done) R.player.reset(P.alloc);
}
// ?shot=1&xrmock=1|2: enter VR on the mock, render xrframes XR frames, show both eyes side by side in the 2D canvas
async function xrShot() {
  const M = XR.mock;
  M.auto = false; // frames on demand, not on the page's rAF
  await xr.enter();
  const nf = num('xrframes', 3);
  for (let i = 0; i < nf; i++) { M.frame(); await G.queue.onSubmittedWorkDone(); }
  const img = await M.readback();
  canvas.width = img.w; canvas.height = img.h;
  context.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  H.realm = REALM_NAMES[W_NEAR[2]];
  H.xrcalls = M.calls;
  H.xrstate = { mode: XR.mode === XR_FPV ? 'fpv' : 'los', layered: XR.layered, views: XR.views, format: XR.format,
    head: Array.from(WHEAD), vignette: ctx.views[0].anc[3], internal: [tg.w, tg.h], cloudDiv: ctx.cloudDiv,
    drone: R.sim ? Array.from(R.sim.drone.subarray(0, 3)) : null, pilot: R.sim ? Array.from(R.sim.pilot) : null };
  H.ready = true;
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
    resolution: P.benchFixed ? 'fixed 1920x1080 canvas (bench default), internal = 1920x1080 x dynres scale' : 'w=' + P.w + ' h=' + P.h + ' from the URL',
    off: H.off, offBits: OFF, split: !!splitDesc, msaa: ctx.msaa, gpu: G.paths, canvasFormat: G.canvasFormat, hdr: G.hdr,
    quality: ['low', 'normal', 'high'][P.quality], stereo: nViews === 2, adapter: adapterInfo(), stride: P.stride,
    inflight: MAX_INFLIGHT, present: !OFFSCREEN, bakes: bakeReport(),
    route: 'Home Fjords rings, boost transit, Stone Forest rings, Lumen Deep rings, FPV (fixed dt 1/' + P.fps + ')',
  });
  H.bench = r;
  console.log('HALCYON_BENCH ' + JSON.stringify(r));
  benchPanel(r);
  H.benchState = 'done';
}
// clip bakes since load (fx/clipmap.js stats): full bakes, shade-only re-bakes, per second of sim time and per frame
function bakeReport() {
  const t = CLK[C_TIME] > 0 ? CLK[C_TIME] : 1, f = frameNo > 0 ? frameNo : 1;
  const s = clipmap.stats;
  return { full: s[0], shade: s[1], perSec: (s[0] + s[1]) / t, perFrame: (s[0] + s[1]) / f, frames: frameNo, time: CLK[C_TIME] };
}
function adapterInfo() {
  const i = G.adapter && G.adapter.info;
  return i ? { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description } : null;
}

// ---------- ?alloc=1 (tools/alloc.mjs) ----------
// warm up, force a GC, mark, run `frames` frames, force a GC, mark. The harness reads --trace-gc between marks.
const AL = { phase: 0, f0: 0 };
function HEAP() { const m = performance.memory; return m ? m.usedJSHeapSize | 0 : -1; }
function allocFrame() {
  if (AL.phase === 0 && frameNo >= P.warm) {
    AL.phase = 1; AL.f0 = frameNo;
    allocMark('start');
  } else if (AL.phase === 1 && frameNo >= AL.f0 + (P.frames || 1800)) {
    AL.phase = 2; running = false;
    allocMark('end');
  }
}
// the end mark falls inside the sampled window: it only writes small ints into the records made at the start
// (t starts as a double so its field never changes representation; __halcyon.alloc is attached at load, because
// adding a property to __halcyon at the start mark changes its map and deoptimises the frame loop mid-window)
const AL_REC = { start: { frame: 0, heap: 0, t: -0.5 }, end: { frame: 0, heap: 0, t: -0.5 } };
if (P.alloc) H.alloc = AL_REC;
// the end heap is read when the harness reads the record, after the window (the frame loop has stopped by then):
// performance.memory makes a new object on every read
if (P.alloc) Object.defineProperty(AL_REC.end, 'heap', { enumerable: true, get() { if (globalThis.gc) globalThis.gc(); return HEAP(); } });
function allocMark(which) {
  // runs twice per test, at the edges of the measured steady state 
  if (globalThis.gc) { globalThis.gc(); globalThis.gc(); }
  const r = which === 'start' ? AL_REC.start : AL_REC.end;
  r.frame = frameNo;
  if (which === 'start') { r.heap = HEAP(); r.t = performance.now(); console.log('HALCYON_ALLOC_START ' + frameNo); }
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

// DESIGN section 6: read back baked levels and compare with heightAt at 256 points (max error < 0.15 m). Then
// the heights the shaders see: clipH (clip.wgsl) at 256 off-grid points against an f64 bilinear of the read-back
// texels (max error < 0.15 m). Runs with and without float32-filterable (f32=0): the half-float fallback that made
// the RX 6650 XT terrain faceted fails the second check by up to 0.25 m.
async function heightCheck() {
  let maxErr = 0, sum = 0, n = 0, worst = null;
  const levels = [0, 2, 4, 6, 8];
  const reads = [];
  for (const L of levels) {
    const r = await clipmap.readLevel(ctx, L);
    reads.push(r);
    setFootprint(r.t); // coarse levels are band-limited (terrfn.wgsl footprint())
    const per = L === 8 ? 52 : 51;
    for (let k = 0; k < per; k++) {
      const h1 = Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(L + 7, 0x85ebca6b);
      const m = (h1 >>> 3) % 512, j = (h1 >>> 15) % 512;
      const x = r.x0 + m * r.t, z = r.z0 + j * r.t;
      const g = r.data[j * 512 + m];
      const c = heightAt(x, z);
      const e = Math.abs(g - c);
      sum += e; n++;
      if (e > maxErr) { maxErr = e; worst = { level: L, x, z, gpu: g, cpu: c }; }
    }
  }
  setFootprint(0);
  // sampled: points inside each level (8 texels from its edge), fractional texel offsets
  const per = 52, pts = new Float32Array(levels.length * per * 4);
  for (let li = 0; li < levels.length; li++) {
    const r = reads[li];
    for (let k = 0; k < per; k++) {
      const h1 = Math.imul(k + 101, 0x9e3779b1) ^ Math.imul(levels[li] + 3, 0x85ebca6b);
      const u = 8 + ((h1 >>> 2) % 495000) / 1000, v = 8 + ((Math.imul(h1, 0x27d4eb2f) >>> 2) % 495000) / 1000;
      const o = (li * per + k) * 4;
      pts[o] = r.x0 + u * r.t; pts[o + 1] = r.z0 + v * r.t; pts[o + 2] = levels[li];
    }
  }
  const got = await clipmap.probe(ctx, pts);
  let sMax = 0, sSum = 0, sWorst = null;
  for (let li = 0; li < levels.length; li++) {
    const r = reads[li];
    for (let k = 0; k < per; k++) {
      const o = (li * per + k) * 4;
      const u = (pts[o] - r.x0) / r.t, v = (pts[o + 1] - r.z0) / r.t;
      const i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
      const at = (i, j) => r.data[j * 512 + i];
      const ref = (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
      const e = Math.abs(got[o + 3] - ref);
      sSum += e;
      if (e >= sMax) { sMax = e; sWorst = { level: levels[li], x: pts[o], z: pts[o + 1], gpu: got[o + 3], cpu: ref }; }
    }
  }
  const sampled = { n: levels.length * per, maxErr: sMax, meanErr: sSum / (levels.length * per), worst: sWorst };
  H.heightcheck = { n, maxErr, meanErr: sum / n, worst, sampled, f32filter: G.f32filter, clipFormat: clipmap.clip.format,
    pass: maxErr < 0.15 && sMax < 0.15 };
  if (maxErr >= 0.15) fail('heightcheck failed: max error ' + maxErr.toFixed(3) + ' m at ' + JSON.stringify(worst));
  if (sMax >= 0.15) fail('heightcheck failed: sampled height off by ' + sMax.toFixed(3) + ' m at ' + JSON.stringify(sWorst));
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
  await log('flora', (enc) => flora.prepare(ctx, enc, v));
  await log('opaque', (enc) => { const p = enc.beginRenderPass(opaqueDesc); drone.drawBody(ctx, p, v); terrain.draw(ctx, p, v); flora.draw(ctx, p, v); fauna.draw(ctx, p, v); p.end(); });
  await log('terrain shade', (enc) => terrain.shade(ctx, enc, v));
  await log('clouds', (enc) => clouds.draw(ctx, enc, v));
  await log('composite', (enc) => composite.draw(ctx, enc, v));
  await log('particles', (enc) => particles.draw(ctx, enc, v));
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
    // every pipeline compiles in parallel (createRenderPipelineAsync, gpu.js) behind the start overlay
    const t0 = performance.now();
    await pipelinesReady(overlay ? overlay.progress : null);
    H.compileMs = Math.round(performance.now() - t0);
    if (CAPTURE) {
      H.capture = capture;
      H.scriptReady = true;
      return;
    }
    if (STATIC && P.xrmock) { cameraFromUrl(); await xrShot(); return; }
    if (STATIC) { cameraFromUrl(); await prebake(); }
    H.running = true;
    if (P.xrenter && !P.shot) xr.enter().catch((e) => fail('xr: ' + (e && e.message)));
    requestAnimationFrame(frame);
  }).catch((e) => {
    if (e instanceof Unsupported) { H.error = 'unsupported: ' + e.message; if (!P.shot) showMessage(e.message); return; }
    fail(e && e.stack ? e.stack : e);
    if (!P.shot) showMessage('error', e && e.stack ? e.stack : String(e));
  });
}
boot();
