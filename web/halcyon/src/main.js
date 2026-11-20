// main.js: boot, frame loop, pass order, per-view rendering, resize, dynamic-resolution plumbing.
// Zero per-frame allocations: everything the loop touches is built in init(); see DESIGN section 9.
// Debug URL params: dbg=1 no water, 2 terrain albedo, 3 sun shadow, 4 terrain normal, 5 water reflection only,
// 6 water refraction only, 7 water normal, 8 no fog. staged=1 (+verbose=1) times each pass of a shot separately.
// Platform objects we cannot avoid per frame: the command encoder, pass encoders, the command buffer and
// getCurrentTexture().createView() (canvas path only).
import { G, H, fail, initDevice, bgl, bindGroup, tex, buffer, FRAME_FLOATS, VIEW_FLOATS, FO, VO } from './gpu.js';
import { TABLE, ROWF, F, realmCentre, CURATED, REALM_NAMES } from './realms.js';
import { heightAt, blendAt, W_NEAR } from './world.js';
import { quatFromYawPitchRoll, quatRotate, mat4ViewRot, mat4PerspRevZ, mat4Mul, mat4Invert } from './math.js';
import * as clipmap from './fx/clipmap.js';
import * as terrain from './fx/terrain.js';
import * as clouds from './fx/clouds.js';
import * as composite from './fx/composite.js';
import * as post from './fx/post.js';

export const world = { heightAt, CURATED };

// ---------- URL parameters ----------
const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) && Q.get(k) !== '' ? parseFloat(Q.get(k)) : d);
const P = {
  realm: Q.has('realm') ? parseInt(Q.get('realm'), 10) : -1,
  pos: Q.has('pos') ? Q.get('pos').split(',').map(parseFloat) : null,
  agl: num('agl', 0) > 0,
  yaw: num('yaw', 0), pitch: num('pitch', -4), fov: num('fov', 60),
  t: Q.has('t') ? num('t', 0) : -1,
  w: num('w', 0), h: num('h', 0), scale: Math.min(1, Math.max(0.25, num('scale', 1))),
  stereo: num('stereo', 0) > 0, hud: num('hud', 1) > 0, bench: num('bench', 0) > 0,
  quality: Q.get('quality') === 'low' ? 0 : Q.get('quality') === 'high' ? 2 : 1,
  shot: num('shot', 0) > 0, dbg: num('dbg', 0), staged: num('staged', 0) > 0, heightcheck: num('heightcheck', 0) > 0,
};

// ---------- camera state (later replaced by sim.cam) ----------
// cam: [px,py,pz, qx,qy,qz,qw, fovY]
export const cam = new Float32Array(8);
const camPos = new Float64Array(3);
let yaw = (P.yaw * Math.PI) / 180, pitch = (P.pitch * Math.PI) / 180;
const q4 = new Float32Array(4), v3a = new Float32Array(3), v3b = new Float32Array(3), FWD = new Float32Array([0, 0, -1]);
const RIGHT = new Float32Array([1, 0, 0]), UPV = new Float32Array([0, 1, 0]);
export const R = { sim: null }; // the sim, when wired: R.sim.step(dt); camera from R.sim.cam

function initCamera() {
  const c = new Float32Array(2);
  if (P.realm >= 0) realmCentre(P.realm, c);
  let x = c[0], y = 120, z = c[1];
  if (P.pos) { x += P.pos[0] || 0; y = P.pos[1] == null || isNaN(P.pos[1]) ? 120 : P.pos[1]; z += P.pos[2] || 0; }
  if (P.agl || !P.pos) y += Math.max(0, heightAt(x, z));
  camPos[0] = x; camPos[1] = y; camPos[2] = z;
}

// ---------- keyboard free-fly (not in shot mode) ----------
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
let context, canvas, tg, opaqueDesc, nViews = 1, shotTex = null, shotView = null;
const CMD = [null];
const rowTmp = new Float32Array(ROWF);
const vpTmp = new Float32Array(16), projTmp = new Float32Array(16), rotTmp = new Float32Array(16);
let tPrev = 0, timeS = 0, frameNo = 0, running = true;
const bench = { n: 0, sum: 0, max: 0 };

function makeTargets(w, h) {
  const U = GPUTextureUsage;
  const RA = U.RENDER_ATTACHMENT, TB = U.TEXTURE_BINDING;
  const t = { w, h };
  const ms = ctx.msaa > 1;
  const scene = tex(w, h, 'rgba16float', RA | TB, { label: 'scene' });
  const dist = tex(w, h, 'r16float', RA | TB, { label: 'dist' });
  t.sceneV = scene.createView(); t.distV = dist.createView();
  const depth = tex(w, h, 'depth32float', RA, { samples: ctx.msaa, label: 'depth' });
  t.compV = tex(w, h, 'rgba16float', RA | TB, { label: 'comp' }).createView();
  const ca = [
    { view: t.sceneV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    { view: t.distV, loadOp: 'clear', storeOp: 'store', clearValue: { r: 60000, g: 0, b: 0, a: 1 } },
  ];
  if (ms) {
    ca[0].view = tex(w, h, 'rgba16float', RA, { samples: ctx.msaa, label: 'sceneMS' }).createView();
    ca[0].resolveTarget = t.sceneV; ca[0].storeOp = 'discard';
    ca[1].view = tex(w, h, 'r16float', RA, { samples: ctx.msaa, label: 'distMS' }).createView();
    ca[1].resolveTarget = t.distV; ca[1].storeOp = 'discard';
  }
  opaqueDesc = { colorAttachments: ca, depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' } };
  t.cloudV = clouds.bind(ctx, t);
  composite.bind(ctx, t);
  post.bind(ctx, t);
  return t;
}

function layoutViews() {
  const cw = canvas.width, ch = canvas.height;
  const vw = Math.floor(cw / nViews);
  for (let i = 0; i < nViews; i++) {
    const v = ctx.views[i];
    v.vx = i * vw; v.vy = 0; v.vw = vw; v.vh = ch;
  }
  tg = makeTargets(Math.max(8, Math.round(vw * P.scale)), Math.max(8, Math.round(ch * P.scale)));
}

async function init() {
  await initDevice();
  canvas = document.getElementById('c');
  const W = P.w || Math.round(innerWidth * devicePixelRatio), Hh = P.h || Math.round(innerHeight * devicePixelRatio);
  canvas.width = W; canvas.height = Hh;
  if (P.w) { canvas.style.width = P.w + 'px'; canvas.style.height = P.h + 'px'; }
  if (P.shot) {
    // Headless capture: WebGPU canvas presentation is not reliable under SwiftShader, so the final pass renders to
    // an offscreen texture that is read back into a 2D canvas once per shot (harness only, outside the frame loop).
    G.canvasFormat = 'rgba8unorm';
    shotTex = G.device.createTexture({ size: [W, Hh], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    shotView = shotTex.createView();
    context = canvas.getContext('2d');
  } else {
    context = canvas.getContext('webgpu');
    G.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    G.p3 = matchMedia('(color-gamut: p3)').matches;
    const cfg = { device: G.device, format: G.canvasFormat, alphaMode: 'opaque' };
    if (G.p3) cfg.colorSpace = 'display-p3';
    context.configure(cfg);
  }
  ctx.frame[FO.misc + 3] = G.p3 ? 1 : 0;

  const d = G.device;
  ctx.frameBuf = buffer(FRAME_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'frame');
  const realmBuf = buffer(TABLE.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'realms');
  G.queue.writeBuffer(realmBuf, 0, TABLE);
  ctx.bgl0 = bgl('uur', 'g0');
  ctx.linear = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  nViews = P.stereo ? 2 : 1;
  for (let i = 0; i < 2; i++) {
    const buf = buffer(VIEW_FLOATS * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'view' + i);
    ctx.views.push({ data: new Float32Array(VIEW_FLOATS), buf, bg0: bindGroup(ctx.bgl0, [ctx.frameBuf, buf, realmBuf]), vx: 0, vy: 0, vw: 1, vh: 1, eye: i === 0 ? (P.stereo ? -0.032 : 0) : 0.032 });
  }
  clipmap.init(ctx); terrain.init(ctx); clouds.init(ctx); composite.init(ctx); post.init(ctx);
  layoutViews();
  initCamera();
  if (!P.shot) {
    addEventListener('keydown', (e) => { keys[keyIdx(e.code)] = 1; });
    addEventListener('keyup', (e) => { keys[keyIdx(e.code)] = 0; });
    addEventListener('resize', () => {
      if (P.w) return;
      canvas.width = Math.round(innerWidth * devicePixelRatio); canvas.height = Math.round(innerHeight * devicePixelRatio);
      layoutViews();
    });
  }
}

function writeView(v) {
  const a = v.data;
  // eye position: camera + right * eye offset
  quatRotate(v3a, q4, RIGHT);
  a[VO.cam] = cam[0] + v3a[0] * v.eye; a[VO.cam + 1] = cam[1] + v3a[1] * v.eye; a[VO.cam + 2] = cam[2] + v3a[2] * v.eye; a[VO.cam + 3] = P.dbg; // debug view selector (0 = normal)
  mat4PerspRevZ(projTmp, cam[7], v.vw / v.vh, 0.1, 0);
  mat4ViewRot(rotTmp, q4);
  mat4Mul(vpTmp, projTmp, rotTmp);
  for (let i = 0; i < 16; i++) a[VO.vp + i] = vpTmp[i];
  mat4Invert(vpTmp, vpTmp);
  for (let i = 0; i < 16; i++) a[VO.ivp + i] = vpTmp[i];
  a[VO.size] = tg.w; a[VO.size + 1] = tg.h; a[VO.size + 2] = 1 / tg.w; a[VO.size + 3] = 1 / tg.h;
  quatRotate(v3b, q4, FWD);
  a[VO.fwd] = v3b[0]; a[VO.fwd + 1] = v3b[1]; a[VO.fwd + 2] = v3b[2]; a[VO.fwd + 3] = Math.tan(cam[7] * 0.5);
  a[VO.right] = v3a[0]; a[VO.right + 1] = v3a[1]; a[VO.right + 2] = v3a[2]; a[VO.right + 3] = Math.tan(cam[7] * 0.5) * (v.vw / v.vh);
  quatRotate(v3b, q4, UPV);
  a[VO.up] = v3b[0]; a[VO.up + 1] = v3b[1]; a[VO.up + 2] = v3b[2]; a[VO.up + 3] = 0;
  a[VO.ofs] = v.vx; a[VO.ofs + 1] = v.vy; a[VO.ofs + 2] = v.vw; a[VO.ofs + 3] = v.vh;
  G.queue.writeBuffer(v.buf, 0, a);
}

// one view: opaque -> clouds -> composite -> post into its canvas viewport
function renderView(v, enc, canvasView, first) {
  writeView(v);
  const p = enc.beginRenderPass(opaqueDesc);
  terrain.draw(ctx, p, v);
  p.end();
  clouds.draw(ctx, enc, v);
  composite.draw(ctx, enc, v);
  post.draw(ctx, enc, v, canvasView, first);
}

function frame(now) {
  if (!running) return;
  const dt = Math.min(0.1, Math.max(0, (now - tPrev) / 1000));
  tPrev = now;
  timeS = P.t >= 0 ? P.t : timeS + dt;
  if (R.sim) {
    R.sim.step(dt);
    for (let i = 0; i < 8; i++) cam[i] = R.sim.cam[i];
    q4[0] = cam[3]; q4[1] = cam[4]; q4[2] = cam[5]; q4[3] = cam[6];
  } else {
    if (!P.shot && frameNo > 0) freeFly(dt);
    quatFromYawPitchRoll(q4, yaw, pitch, 0);
    cam[0] = camPos[0]; cam[1] = camPos[1]; cam[2] = camPos[2];
    cam[3] = q4[0]; cam[4] = q4[1]; cam[5] = q4[2]; cam[6] = q4[3]; cam[7] = (P.fov * Math.PI) / 180;
  }
  const fr = ctx.frame;
  blendAt(cam[0], cam[2], rowTmp);
  for (let i = 0; i < ROWF; i++) fr[FO.row + i] = rowTmp[i];
  const drift = 6 * Math.sin(timeS * 0.004);
  const s0 = F.S0 * 4;
  const el = ((rowTmp[s0] + drift * 0.5) * Math.PI) / 180, az = ((rowTmp[s0 + 1] + drift) * Math.PI) / 180;
  fr[FO.sun] = Math.sin(az) * Math.cos(el); fr[FO.sun + 1] = Math.sin(el); fr[FO.sun + 2] = -Math.cos(az) * Math.cos(el); fr[FO.sun + 3] = drift;
  fr[FO.time] = timeS; fr[FO.time + 1] = dt; fr[FO.time + 2] = frameNo; fr[FO.time + 3] = P.quality;

  const enc = G.device.createCommandEncoder();
  clipmap.update(ctx, enc, cam[0], cam[2], frameNo === 0);
  terrain.setup(ctx, cam[0], cam[2]);
  G.queue.writeBuffer(ctx.frameBuf, 0, fr);
  if (P.staged) {
    CMD[0] = enc.finish(); G.queue.submit(CMD); running = false;
    stagedFrame().then(shotDone);
    return;
  }
  const canvasView = shotView || context.getCurrentTexture().createView();
  for (let i = 0; i < nViews; i++) renderView(ctx.views[i], enc, canvasView, i === 0);
  CMD[0] = enc.finish();
  G.queue.submit(CMD);
  frameNo++;
  H.frame = frameNo;
  if (P.bench && frameNo > 30) { const ms = dt * 1000; bench.n++; bench.sum += ms; if (ms > bench.max) bench.max = ms; H.bench = bench; }
  if (P.shot) { running = false; G.queue.onSubmittedWorkDone().then(shotDone); return; }

  requestAnimationFrame(frame);
}

async function blitShot() {
  const w = shotTex.width, h = shotTex.height, bpr = Math.ceil((w * 4) / 256) * 256;
  const buf = G.device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = G.device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: shotTex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
  G.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange());
  const img = context.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
  buf.unmap();
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

// shot mode: bake the clipmap one level per submit first, so slow software GPUs never see one huge command buffer
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
  writeView(v);
  await log('opaque', (enc) => { const p = enc.beginRenderPass(opaqueDesc); terrain.draw(ctx, p, v); p.end(); });
  await log('composite', (enc) => composite.draw(ctx, enc, v));
  const cv = shotView;
  await log('post', (enc) => post.draw(ctx, enc, v, cv, true));
}

async function prebake() {
  H.timing = [];
  for (let i = 0; i < clipmap.LEVELS; i++) {
    const t0 = performance.now();
    const enc = G.device.createCommandEncoder();
    clipmap.bakeOne(ctx, enc, i, cam0x, cam0z);
    G.queue.submit([enc.finish()]);
    await G.queue.onSubmittedWorkDone();
    H.timing.push('bake' + i + ' ' + Math.round(performance.now() - t0));
    if (Q.has('verbose')) console.log('bake level ' + i + ' ' + Math.round(performance.now() - t0) + ' ms');
  }
}
let cam0x = 0, cam0z = 0;

init().then(async () => {
  cam0x = camPos[0]; cam0z = camPos[2];
  if (P.shot) await prebake();
  tPrev = performance.now();
  requestAnimationFrame(frame);
}).catch((e) => fail(e && e.stack ? e.stack : e));
