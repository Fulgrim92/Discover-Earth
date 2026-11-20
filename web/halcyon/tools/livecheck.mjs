// tools/livecheck.mjs: live mode must look like shot mode. For each case, run the real frame loop (no shot=1,
// grab=<frames>: clip levels baked and re-baked by the per-frame scheduler, real dt, the sim flying or hovering),
// read back the last frame, then render the same camera pose and time as a static shot (shot=1, campose=, t=:
// every clip level baked fresh around the camera) and compare. Fails when they differ by more than the limits after
// settling: mean |diff| > MEAN_MAX (1/255 units) or more than P_MAX of pixels off by more than 8/255.
// The sim-driven layers (drone, rings, particles, fauna) and the clouds (weather is integrated frame by frame) are
// switched off in both, so what is compared is terrain, flora, water, sky and light.
// Usage: node tools/livecheck.mjs [--frames 150] [--w 320 --h 180] [--out dir] [--only name] [--set k=v;k=v]
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch, capture } from './shot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FRAMES = +opt('--frames', 150), W = +opt('--w', 320), H = +opt('--h', 180);
const out = path.resolve(opt('--out', path.join(root, 'out/livecheck')));
const only = opt('--only', null);
const extra = {};
if (opt('--set', null)) for (const kv of opt('--set').split(';')) { const i = kv.indexOf('='); extra[kv.slice(0, i)] = kv.slice(i + 1); }
const MEAN_MAX = 2.0, P_MAX = 0.01;
const OFF = 'drone,rings,particles,fauna,clouds,cloudshadow';

// hover at a realm's spawn (the PC screenshots: drone behind the start overlay) and fly the bench route
const CASES = [
  { name: 'hover_home', params: { realm: 0 } },
  { name: 'hover_stone', params: { realm: 3 } },
  { name: 'tour', params: { script: 'bench', stride: 1 } },
];

await mkdir(out, { recursive: true });
const browser = await launch();
let bad = 0;
for (const c of CASES) {
  if (only && c.name !== only) continue;
  const base = Object.assign({ w: W, h: H, hud: 0, off: OFF, dynres: 0, quality: 'normal' }, extra);
  const live = await capture(browser, Object.assign({}, base, c.params, { shot: 0, grab: FRAMES, __pixels: 1 }), path.join(out, c.name + '.live.png'), 3600000);
  if (!live.ok) { bad++; console.log('FAIL ' + c.name + ' live: ' + live.error); continue; }
  const st = live.state;
  const shot = await capture(browser, Object.assign({}, base, { campose: st.campose, t: st.time, __pixels: 1 }), path.join(out, c.name + '.shot.png'), 3600000);
  if (!shot.ok) { bad++; console.log('FAIL ' + c.name + ' shot: ' + shot.error); continue; }
  const a = live.pixels, b = shot.pixels;
  let sum = 0, over = 0;
  const n = (a.length / 4) | 0;
  const heat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(a[i * 4] - b[i * 4]), Math.abs(a[i * 4 + 1] - b[i * 4 + 1]), Math.abs(a[i * 4 + 2] - b[i * 4 + 2]));
    sum += d; if (d > 8) over++;
    heat[i] = Math.min(255, d * 8);
  }
  await writeFile(path.join(out, c.name + '.diff.pgm'), Buffer.concat([Buffer.from('P5\n' + W + ' ' + H + '\n255\n'), Buffer.from(heat)]));
  const mean = sum / n, frac = over / n;
  const ok = mean <= MEAN_MAX && frac <= P_MAX;
  if (!ok) bad++;
  console.log((ok ? 'ok   ' : 'FAIL ') + c.name + '  mean ' + mean.toFixed(3) + '/255  >8/255: ' + (100 * frac).toFixed(3) + '%  bakes ' +
    JSON.stringify(st.bakes) + (ok ? '' : '  (see ' + path.join(out, c.name) + '.{live,shot}.png, .diff.pgm)'));
}
await browser.close();
console.log(bad ? 'FAILED ' + bad : 'PASS');
process.exit(bad ? 1 : 0);
