// fx/xrfx.js: VR-only drawing. Controllers (opaque pass, so hands are lit, fogged and depth-tested like the drone)
// and the in-world HUD panel (end of the effects pass): mode, view, speed, height and both sticks, on a small glass
// panel that rides above the left controller and turns to face the eyes (head-locked low in view when no left
// controller is tracked). Both are drawn per eye from world positions, so they have true parallax.
// Per frame: update() fills one uniform block from xr.js's world poses and the sim; nothing allocates.
import { G, shader, bgl, bindGroup, buffer, pipeline } from '../gpu.js';
import SKY from '../wgsl/sky.wgsl';
import XRW from '../wgsl/xr.wgsl';
import { WGRIP, WHEAD } from '../xr.js';

const U = new Float32Array(48);
const UO = { g: 0, hp: 16, hq: 20, hs: 24, v0: 28, v1: 32, v2: 36 };
let ubuf, bg, pCtl, pHud, nVerts = 0;
const B = new Float64Array(16);

// ---- mesh (grip space of a right controller, metres: -Z along the handle out of the fist, +Y up the thumb side)
function mesh() {
  const v = [];
  const push = (p, n, m) => v.push(p[0], p[1], p[2], n[0], n[1], n[2], m);
  // a tube between two points with radii r0, r1 (closed with caps), seg sides
  const tube = (a, b, r0, r1, seg, m) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
    const z = [d[0] / L, d[1] / L, d[2] / L];
    const t = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let x = [t[1] * z[2] - t[2] * z[1], t[2] * z[0] - t[0] * z[2], t[0] * z[1] - t[1] * z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]); x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const P = (c, ang, r) => [c[0] + (x[0] * Math.cos(ang) + y[0] * Math.sin(ang)) * r, c[1] + (x[1] * Math.cos(ang) + y[1] * Math.sin(ang)) * r, c[2] + (x[2] * Math.cos(ang) + y[2] * Math.sin(ang)) * r];
    const Nn = (ang) => [x[0] * Math.cos(ang) + y[0] * Math.sin(ang), x[1] * Math.cos(ang) + y[1] * Math.sin(ang), x[2] * Math.cos(ang) + y[2] * Math.sin(ang)];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p00 = P(a, a0, r0), p01 = P(b, a0, r1), p10 = P(a, a1, r0), p11 = P(b, a1, r1);
      push(p00, Nn(a0), m); push(p11, Nn(a1), m); push(p01, Nn(a0), m);
      push(p00, Nn(a0), m); push(p10, Nn(a1), m); push(p11, Nn(a1), m);
      const nz = [-z[0], -z[1], -z[2]];
      push(a, nz, m); push(p10, nz, m); push(p00, nz, m);
      push(b, z, m); push(p01, z, m); push(p11, z, m);
    }
  };
  // a torus: centre c, axis n, ring radius R, tube radius r
  const torus = (c, n, R, r, seg, sides, m) => {
    const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let x = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
    const xl = Math.hypot(x[0], x[1], x[2]); x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    const pt = (u, w) => {
      const cu = Math.cos(u), su = Math.sin(u), cw = Math.cos(w), sw = Math.sin(w);
      const rd = [x[0] * cu + y[0] * su, x[1] * cu + y[1] * su, x[2] * cu + y[2] * su];
      const nn = [rd[0] * cw + n[0] * sw, rd[1] * cw + n[1] * sw, rd[2] * cw + n[2] * sw];
      return [[c[0] + rd[0] * R + nn[0] * r, c[1] + rd[1] * R + nn[1] * r, c[2] + rd[2] * R + nn[2] * r], nn];
    };
    for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
      const u0 = (i / seg) * Math.PI * 2, u1 = ((i + 1) / seg) * Math.PI * 2, w0 = (j / sides) * Math.PI * 2, w1 = ((j + 1) / sides) * Math.PI * 2;
      const a = pt(u0, w0), b = pt(u1, w0), cc = pt(u1, w1), d = pt(u0, w1);
      push(a[0], a[1], m); push(b[0], b[1], m); push(cc[0], cc[1], m);
      push(a[0], a[1], m); push(cc[0], cc[1], m); push(d[0], d[1], m);
    }
  };
  tube([0, -0.004, 0.05], [0, 0.004, -0.03], 0.016, 0.019, 14, 0);       // handle
  tube([0, -0.006, -0.03], [0, 0.022, -0.056], 0.026, 0.024, 18, 0);     // head (thumb face on top)
  tube([0, 0.022, -0.05], [0, 0.03, -0.05], 0.008, 0.007, 12, 2);        // thumbstick
  tube([0.014, 0.022, -0.064], [0.014, 0.026, -0.064], 0.0042, 0.0042, 8, 3); // a lit button
  tube([0, -0.018, -0.032], [0, -0.03, -0.05], 0.007, 0.006, 8, 2);       // trigger
  torus([0, 0.012, -0.06], [0, 0.82, -0.57], 0.046, 0.0045, 32, 6, 1);   // tracking ring
  return new Float32Array(v);
}

export function init(ctx) {
  const m = mesh();
  nVerts = m.length / 7;
  const mbuf = G.device.createBuffer({ size: m.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true, label: 'xrCtlMesh' });
  new Float32Array(mbuf.getMappedRange()).set(m); mbuf.unmap();
  ubuf = buffer(U.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'xrU');
  const bl = bgl('ur', 'xr1');
  bg = bindGroup(bl, [ubuf, mbuf]);
  const mod = shader(SKY + XRW, 'xr');
  pCtl = pipeline({ label: 'xrControllers', module: mod, vs: 'vsCtl', fs: 'fsCtl', layouts: [ctx.bgl0, bl],
    targets: [{ format: 'rgba16float' }, { format: 'rg16float' }], samples: ctx.msaa,
    depth: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
  const over = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
  pHud = pipeline({ label: 'xrHud', module: mod, vs: 'vsHud', fs: 'fsHud', layouts: [ctx.bgl0, bl], targets: [{ format: 'rgba16float', blend: over }] });
}

// quaternion from an orthonormal basis (columns x, y, z) in B[0..8] -> B[9..12]
function quatFromBasis() {
  const m00 = B[0], m10 = B[1], m20 = B[2], m01 = B[3], m11 = B[4], m21 = B[5], m02 = B[6], m12 = B[7], m22 = B[8];
  const tr = m00 + m11 + m22;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; B[12] = 0.25 * s; B[9] = (m21 - m12) / s; B[10] = (m02 - m20) / s; B[11] = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; B[12] = (m21 - m12) / s; B[9] = 0.25 * s; B[10] = (m01 + m10) / s; B[11] = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; B[12] = (m02 - m20) / s; B[9] = (m01 + m10) / s; B[10] = 0.25 * s; B[11] = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; B[12] = (m10 - m01) / s; B[9] = (m02 + m20) / s; B[10] = (m12 + m21) / s; B[11] = 0.25 * s; }
}

// per frame (XR only): poses from xr.js (world), values from the sim. phys: sim._dbg.IN.phys (merged sticks)
export function update(sim, phys, viewMode, vignetteOn) {
  for (let h = 0; h < 2; h++) {
    const g = h * 8, o = UO.g + h * 8;
    U[o] = WGRIP[g]; U[o + 1] = WGRIP[g + 1]; U[o + 2] = WGRIP[g + 2]; U[o + 3] = WGRIP[g + 7];
    U[o + 4] = WGRIP[g + 3]; U[o + 5] = WGRIP[g + 4]; U[o + 6] = WGRIP[g + 5]; U[o + 7] = WGRIP[g + 6];
  }
  // HUD centre: 13 cm above the left grip, or low ahead of the head
  let cx, cy, cz;
  if (WGRIP[7] > 0.5) { cx = WGRIP[0]; cy = WGRIP[1] + 0.13; cz = WGRIP[2]; }
  else {
    // head forward, flattened
    const qx = WHEAD[3], qy = WHEAD[4], qz = WHEAD[5], qw = WHEAD[6];
    let fx = -2 * (qx * qz + qw * qy), fz = -(1 - 2 * (qx * qx + qy * qy));
    const fl = Math.sqrt(fx * fx + fz * fz) || 1; fx /= fl; fz /= fl;
    cx = WHEAD[0] + fx * 0.55; cy = WHEAD[1] - 0.3; cz = WHEAD[2] + fz * 0.55;
  }
  // face the head: z toward the eyes, x level
  let zx = WHEAD[0] - cx, zy = WHEAD[1] - cy, zz = WHEAD[2] - cz;
  const zl = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = zz, xz = -zx; // up x z
  const xl = Math.sqrt(xx * xx + xz * xz) || 1; xx /= xl; xz /= xl;
  const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx; // z x x
  B[0] = xx; B[1] = 0; B[2] = xz; B[3] = yx; B[4] = yy; B[5] = yz; B[6] = zx; B[7] = zy; B[8] = zz;
  quatFromBasis();
  U[UO.hp] = cx; U[UO.hp + 1] = cy; U[UO.hp + 2] = cz; U[UO.hp + 3] = 1;
  U[UO.hq] = B[9]; U[UO.hq + 1] = B[10]; U[UO.hq + 2] = B[11]; U[UO.hq + 3] = B[12];
  U[UO.hs] = 0.075; U[UO.hs + 1] = 0.048;
  U[UO.v0] = sim.flightMode; U[UO.v0 + 1] = viewMode; U[UO.v0 + 2] = sim.info[2]; U[UO.v0 + 3] = sim.info[0];
  U[UO.v1] = phys[0]; U[UO.v1 + 1] = phys[1]; U[UO.v1 + 2] = phys[2]; U[UO.v1 + 3] = phys[3];
  U[UO.v2] = sim.sport; U[UO.v2 + 1] = sim.info[4]; U[UO.v2 + 2] = sim.info[12]; U[UO.v2 + 3] = vignetteOn;
}
export function upload() { G.queue.writeBuffer(ubuf, 0, U); }

// opaque pass (group 0 = view, group 1 = ours)
export function drawControllers(pass, view) {
  if (U[UO.g + 3] < 0.5 && U[UO.g + 11] < 0.5) return;
  pass.setPipeline(pCtl); pass.setBindGroup(0, view.bg0); pass.setBindGroup(1, bg);
  pass.draw(nVerts, 2);
}
// last thing in the effects pass (replaces its group 1)
export function drawHud(pass) {
  pass.setPipeline(pHud); pass.setBindGroup(1, bg);
  pass.draw(6);
}
