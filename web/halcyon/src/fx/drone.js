// fx/drone.js: the drone. Body (opaque pass): a procedural mesh built once per airframe, the 249 g camera drone
// (grey shell, folding arms, gimbal camera) for GPS/Angle and a 5-inch carbon freestyle quad for Acro. Effects pass
// (after the composite, see fx/rings.js): blob shadow, motion-blurred props driven by the motor levels, and
// navigation-light halos. Hidden in FPV. Per frame: update() writes the shared FX uniform; nothing allocates.
import { CLK, C_DT, C_TIME } from '../clock.js';
import { G, shader, bgl, bindGroup, buffer, pipeline } from '../gpu.js';
import { clip } from './clipmap.js';
import { FX, FXO } from './rings.js';
import CLIP from '../wgsl/clip.wgsl';
import SKY from '../wgsl/sky.wgsl';
import FXU from '../wgsl/fxu.wgsl';
import DRONE from '../wgsl/drone.wgsl';

// materials (drone.wgsl)
const CARBON = 0, SHELL = 1, DARK = 2, BELL = 3, ANOD = 4, LED_W = 5, LED_R = 6, LENS = 7, BATT = 8, STRAP = 9, STANDOFF = 10;

let pBody, bg2, meshRange = [0, 0, 0, 0];
const propAng = new Float64Array(4);
const S = new Float64Array(4); // [last time]

// ---------------------------------------------------------------------------------------------- mesh building (init)
function Mesh() { return { v: [] }; }
function tri(M, a, b, c, na, nb, nc, mat) {
  M.v.push(a[0], a[1], a[2], na[0], na[1], na[2], mat, b[0], b[1], b[2], nb[0], nb[1], nb[2], mat, c[0], c[1], c[2], nc[0], nc[1], nc[2], mat);
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function quad(M, a, b, c, d, mat) { // flat, counter-clockwise seen from outside
  const n = norm(cross(sub(b, a), sub(c, a)));
  tri(M, a, b, c, n, n, n, mat); tri(M, a, c, d, n, n, n, mat);
}
// box from a centre, half sizes and a frame (ax = local x axis, ay = local y axis; az = ax x ay)
function box(M, c, h, mat, ax = [1, 0, 0], ay = [0, 1, 0]) {
  const az = cross(ax, ay);
  const P = (sx, sy, sz) => [c[0] + ax[0] * h[0] * sx + ay[0] * h[1] * sy + az[0] * h[2] * sz,
    c[1] + ax[1] * h[0] * sx + ay[1] * h[1] * sy + az[1] * h[2] * sz, c[2] + ax[2] * h[0] * sx + ay[2] * h[1] * sy + az[2] * h[2] * sz];
  quad(M, P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), mat);     // top
  quad(M, P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), mat); // bottom
  quad(M, P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), mat);     // +x
  quad(M, P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), mat); // -x
  quad(M, P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), mat);     // +z
  quad(M, P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1), mat); // -z
}
// a beam of width w, height h between two points (horizontal-ish arms)
function beam(M, p0, p1, w, h, mat) {
  const d = sub(p1, p0), L = Math.hypot(d[0], d[1], d[2]);
  const ax = norm(d), up0 = [0, 1, 0];
  const az = norm(cross(ax, up0)), ay = cross(az, ax);
  box(M, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], [L / 2, h / 2, w / 2], mat, ax, ay);
}
// cylinder along +Y (or +Z with axis 'z'), smooth sides, flat caps
function cyl(M, c, r, h, seg, mat, axis = 'y', capMat = mat) {
  const P = (a, y) => {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    return axis === 'y' ? [c[0] + x, c[1] + y, c[2] + z] : [c[0] + x, c[1] + z, c[2] + y];
  };
  const N = (a) => (axis === 'y' ? [Math.cos(a), 0, Math.sin(a)] : [Math.cos(a), Math.sin(a), 0]);
  const top = axis === 'y' ? [c[0], c[1] + h / 2, c[2]] : [c[0], c[1], c[2] + h / 2];
  const bot = axis === 'y' ? [c[0], c[1] - h / 2, c[2]] : [c[0], c[1], c[2] - h / 2];
  const nt = axis === 'y' ? [0, 1, 0] : [0, 0, 1], nbt = [-nt[0], -nt[1], -nt[2]];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p00 = P(a0, -h / 2), p01 = P(a0, h / 2), p10 = P(a1, -h / 2), p11 = P(a1, h / 2);
    if (axis === 'y') { tri(M, p00, p01, p11, N(a0), N(a0), N(a1), mat); tri(M, p00, p11, p10, N(a0), N(a1), N(a1), mat); tri(M, top, p11, p01, nt, nt, nt, capMat); tri(M, bot, p00, p10, nbt, nbt, nbt, capMat); }
    else { tri(M, p00, p11, p01, N(a0), N(a1), N(a0), mat); tri(M, p00, p10, p11, N(a0), N(a1), N(a1), mat); tri(M, top, p01, p11, nt, nt, nt, capMat); tri(M, bot, p10, p00, nbt, nbt, nbt, capMat); }
  }
}
// rounded shell: superellipse cross-sections (half sizes a in x, b in z, exponent e) stacked along y with scales
function shell(M, c, a, b, e, prof, mat, seg = 28) {
  const ring = (y, s) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
      out.push([c[0] + a * s * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / e), c[1] + y, c[2] + b * s * Math.sign(st) * Math.pow(Math.abs(st), 2 / e)]);
    }
    return out;
  };
  const R = prof.map(([y, s]) => ring(y, s));
  // smooth normals from the grid
  const nrm = (j, i) => {
    const r = R[j], p = r[i], pn = r[(i + 1) % seg], pp = r[(i + seg - 1) % seg];
    const up = R[Math.min(j + 1, R.length - 1)][i], dn = R[Math.max(j - 1, 0)][i];
    return norm(cross(sub(up, dn), sub(pn, pp)));
  };
  for (let j = 0; j + 1 < R.length; j++) {
    for (let i = 0; i < seg; i++) {
      const i1 = (i + 1) % seg;
      const a0 = R[j][i], a1 = R[j][i1], b0 = R[j + 1][i], b1 = R[j + 1][i1];
      tri(M, a0, b0, b1, nrm(j, i), nrm(j + 1, i), nrm(j + 1, i1), mat);
      tri(M, a0, b1, a1, nrm(j, i), nrm(j + 1, i1), nrm(j, i1), mat);
    }
  }
  // caps
  const capC = (j, up) => {
    const r = R[j], cy = r[0][1], cc = [c[0], cy, c[2]], n = up ? [0, 1, 0] : [0, -1, 0];
    for (let i = 0; i < seg; i++) { const i1 = (i + 1) % seg; if (up) tri(M, cc, r[i1], r[i], n, n, n, mat); else tri(M, cc, r[i], r[i1], n, n, n, mat); }
  };
  capC(R.length - 1, true); capC(0, false);
}

// 249 g camera drone: body centre at the origin, bottom ~5 cm below; motors at +/-0.070 m; front arms high
function cameraDrone() {
  const M = Mesh();
  shell(M, [0, 0, 0.004], 0.033, 0.074, 3.2, [[-0.034, 0.80], [-0.030, 0.95], [-0.018, 1.0], [0.010, 1.0], [0.018, 0.93], [0.022, 0.78]], SHELL);
  // lighter top cover (the camera drone's face from above) and a dark intake band
  box(M, [0, 0.0225, 0.010], [0.021, 0.0009, 0.044], DARK);
  box(M, [0, 0.004, -0.0745], [0.022, 0.003, 0.002], DARK);
  // gimbal camera under the nose
  box(M, [0, -0.012, -0.079], [0.013, 0.011, 0.010], DARK);
  cyl(M, [0, -0.012, -0.089], 0.0065, 0.004, 16, DARK, 'z', LENS);
  cyl(M, [0, -0.012, -0.0915], 0.0042, 0.002, 16, LENS, 'z');
  // arms and motors (front arms leave from the top of the body, rear arms from the bottom)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const front = sz < 0, ym = front ? 0.006 : -0.016;
    const root = [sx * 0.028, front ? 0.012 : -0.022, sz * 0.040];
    const tip = [sx * 0.070, ym, sz * 0.070];
    beam(M, root, tip, 0.015, 0.008, SHELL);
    cyl(M, [tip[0], ym + 0.008, tip[2]], 0.0115, 0.013, 18, BELL, 'y', DARK);
    cyl(M, [tip[0], ym + 0.0155, tip[2]], 0.0038, 0.004, 10, DARK);
    // nav lights under the arm tips (front white, rear red) and little feet
    box(M, [tip[0], ym - 0.0045, tip[2]], [0.0035, 0.0015, 0.0035], front ? LED_W : LED_R);
  }
  return M.v;
}

// 5-inch freestyle quad: true-X carbon frame, motors at +/-0.078 m, battery on top, FPV camera tilted up 25 deg
function fiveInch() {
  const M = Mesh();
  const yb = -0.025;
  // bottom plate arms (5 mm carbon), centre plate
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    beam(M, [sx * 0.012, yb, sz * 0.012], [sx * 0.086, yb, sz * 0.086], 0.015, 0.005, CARBON);
    const mx = sx * 0.078, mz = sz * 0.078;
    cyl(M, [mx, yb + 0.0095, mz], 0.0135, 0.014, 20, BELL, 'y', ANOD);
    cyl(M, [mx, yb + 0.0185, mz], 0.0035, 0.005, 10, DARK);
    box(M, [sx * 0.050, yb - 0.004, sz * 0.050], [0.004, 0.0015, 0.004], sz < 0 ? LED_W : LED_R);
  }
  box(M, [0, yb, 0], [0.024, 0.0025, 0.050], CARBON);
  // standoffs and top plate
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(M, [sx * 0.016, yb + 0.016, sz * 0.032], 0.0026, 0.028, 8, STANDOFF);
  box(M, [0, yb + 0.031, 0], [0.020, 0.0015, 0.046], CARBON);
  // stack (flight controller / ESC) seen between the plates
  box(M, [0, yb + 0.010, 0.004], [0.015, 0.006, 0.015], DARK);
  // battery and strap
  box(M, [0, yb + 0.049, 0.004], [0.017, 0.016, 0.037], BATT);
  box(M, [0, yb + 0.049, 0.004], [0.0185, 0.0172, 0.006], STRAP);
  // FPV camera (25 deg up) between the plates at the front
  const c = Math.cos(25 * Math.PI / 180), s = Math.sin(25 * Math.PI / 180);
  box(M, [0, yb + 0.016, -0.040], [0.0095, 0.0095, 0.0095], DARK, [1, 0, 0], [0, c, s]);
  cyl(M, [0, yb + 0.016 + 0.0105 * s, -0.040 - 0.0105 * c], 0.0055, 0.006, 14, DARK, 'z', LENS);
  // antenna at the rear
  beam(M, [0, yb + 0.012, 0.050], [0, yb + 0.040, 0.075], 0.003, 0.003, DARK);
  return M.v;
}

export function init(ctx) {
  const a = cameraDrone(), b = fiveInch();
  const all = new Float32Array(a.length + b.length);
  all.set(a, 0); all.set(b, a.length);
  meshRange = [0, a.length / 7, a.length / 7, b.length / 7];
  const mbuf = G.device.createBuffer({ size: all.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true, label: 'droneMesh' });
  new Float32Array(mbuf.getMappedRange()).set(all); mbuf.unmap();
  const bl2 = bgl('ur', 'drone2');
  bg2 = bindGroup(bl2, [FX.buf, mbuf]);
  const mod = shader(CLIP + SKY + FXU + DRONE, 'drone');
  pBody = pipeline({ label: 'droneBody', module: mod, vs: 'vsBody', fs: 'fsBody', layouts: [ctx.bgl0, clip.bgl, bl2],
    targets: [{ format: 'rgba16float' }, { format: 'r16float' }], samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
}

// opaque pass (before the terrain so it fills depth first)
export function drawBody(ctx, pass, view) {
  if (FX.u[FXO.drone + 3] < 0.5) return;
  pass.setPipeline(pBody);
  pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, clip.bg); pass.setBindGroup(2, bg2);
  const k = FX.u[FXO.dinfo] > 0.5 ? 2 : 0;
  pass.draw(meshRange[k + 1], 1, meshRange[k], 0);
}

// effects pass: blob shadow, props, nav lights (bind groups are set by rings.js)
export function drawFx(pass) {
  if (FX.u[FXO.drone + 3] < 0.5) return;
  pass.setPipeline(FX.pShadow); pass.draw(36);
  pass.setPipeline(FX.pProp); pass.draw(6, 4);
  pass.setPipeline(FX.pLed); pass.draw(6, 4);
}

// per frame: drone pose, motors, prop angles, height above ground. visible: 0 hides it (FPV)
export function update(sim, visible) {
  const u = FX.u, d = sim.drone, dt = CLK[C_DT], timeS = CLK[C_TIME];
  const five = sim.flightMode === 2 ? 1 : 0;
  u[FXO.drone] = d[0]; u[FXO.drone + 1] = d[1]; u[FXO.drone + 2] = d[2]; u[FXO.drone + 3] = visible;
  u[FXO.dq] = d[3]; u[FXO.dq + 1] = d[4]; u[FXO.dq + 2] = d[5]; u[FXO.dq + 3] = d[6];
  const rps = five ? 450 : 300;
  for (let i = 0; i < 4; i++) {
    const m = d[10 + i];
    u[FXO.motors + i] = m;
    // CW props (m0, m3) turn clockwise seen from above = negative about +Y
    const dir = i === 0 || i === 3 ? -1 : 1;
    let a = propAng[i] + dir * m * rps * 6.283185307179586 * dt;
    a -= 6.283185307179586 * Math.floor(a / 6.283185307179586);
    propAng[i] = a;
    u[FXO.props + i] = a;
  }
  u[FXO.dinfo] = five; u[FXO.dinfo + 1] = 1 / 120; // 180-degree shutter at 60 Hz
  u[FXO.dinfo + 2] = sim.info[0] + (five ? 0.03 : 0.05);
  u[FXO.dinfo + 3] = timeS;
  S[0] = timeS;
}
