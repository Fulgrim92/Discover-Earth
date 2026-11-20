// tools/play.mjs: capture frames of a scripted flight (?script=<name>, src/script.js) into a contact sheet, so the
// flight, the cameras, the drone, the rings and the HUD can be judged without a GPU.
// Usage:
//   node tools/play.mjs <script> [--every 3] [--at 2,5,9] [--w 960 --h 540] [--set k=v;k=v] [--out dir] [--hud 0]
//   node tools/play.mjs <script> --dry          (no browser: run the sim in node and print a state line per second)
//   node tools/play.mjs --list
// Output: out/play/<script>/<script>_<t>.png and out/play/<script>.sheet.png (tools/sheet.py), and a state line per
// frame (position, height above ground, speed, mode, camera, rings).
import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const { SCRIPTS } = await import(path.join(root, 'src/script.js'));
if (args.includes('--list')) { for (const k in SCRIPTS) console.log(k); process.exit(0); }
const name = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))) || 'tour';
if (!SCRIPTS[name]) { console.error('unknown script ' + name + '; have: ' + Object.keys(SCRIPTS).join(' ')); process.exit(2); }
const fps = +opt('--fps', 60);

function stateLine(s) {
  return `t ${s.t.toFixed(1).padStart(5)}  ${['gps', 'angle', 'acro'][s.fm]}/${['fpv', 'chase', 'los'][s.cam]}  pos ${s.pos.map((v) => v.toFixed(0)).join(',')}  agl ${s.agl.toFixed(1)}  spd ${s.spd.toFixed(1)}  vz ${s.vz.toFixed(1)}  tilt ${s.tilt.toFixed(0)}  thr ${s.thr.toFixed(2)}  rings ${s.rings}  crashes ${s.crashes}  realm ${s.realm}`;
}

if (args.includes('--dry')) {
  const { createSim } = await import(path.join(root, 'src/sim/index.js'));
  const W = await import(path.join(root, 'src/world.js'));
  const { createPlayer, simState } = await import(path.join(root, 'src/script.js'));
  const sim = createSim({ heightAt: W.heightAt, heightBatch: W.heightBatch, CURATED: W.CURATED }, { hud: false });
  const p = createPlayer(sim, name);
  console.log(name + ': ' + p.duration.toFixed(1) + ' s at ' + fps + ' fps');
  const dt = 1 / fps;
  let f = 0;
  while (!p.done) {
    p.update(dt); sim.step(dt); f++;
    if (f % Math.round(fps * +opt('--every', 1)) === 0) console.log(stateLine(simState(sim, p)));
  }
  process.exit(0);
}

const { launch, FLAGS } = await import(path.join(root, 'tools/shot.mjs'));
const w = +opt('--w', 960), h = +opt('--h', 540);
const out = path.resolve(opt('--out', path.join(root, 'out/play')));
const dir = path.join(out, name);
await mkdir(dir, { recursive: true });
let times;
if (opt('--at')) times = opt('--at').split(',').map(Number);
else {
  const every = +opt('--every', 3);
  // duration from the script table (same arithmetic as createPlayer)
  const dur = SCRIPTS[name].reduce((a, s) => a + s.d, 0);
  times = [];
  for (let t = Math.min(1, dur); t <= dur + 1e-6; t += every) times.push(+t.toFixed(3));
}
const params = { shot: 1, script: name, w, h, fps, hud: opt('--hud', 1), quality: opt('--quality', 1) };
if (opt('--set')) for (const kv of opt('--set').split(';')) { const i = kv.indexOf('='); params[kv.slice(0, i)] = kv.slice(i + 1); }
const q = new URLSearchParams(); for (const k in params) q.set(k, String(params[k]));
const url = 'file://' + path.join(root, 'dist/index.html') + '?' + q.toString();

const browser = await launch(args.includes('--headed'));
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (args.includes('--verbose')) console.log('  [page] ' + m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => window.__halcyon && (window.__halcyon.scriptReady || window.__halcyon.error), null, { timeout: 600000, polling: 250 });
const files = [];
const t0 = Date.now();
for (const t of times) {
  const s = await page.evaluate((tt) => window.__halcyon.capture(tt), t);
  const err = await page.evaluate(() => window.__halcyon.error);
  if (err || errors.length) { console.log('FAIL ' + (err || errors.join('\n'))); await browser.close(); process.exit(1); }
  const png = path.join(dir, name + '_' + String(t.toFixed(1)).padStart(5, '0') + '.png');
  await page.screenshot({ path: png });
  files.push(png);
  console.log(stateLine(s) + '   ' + path.relative(root, png) + '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
}
await browser.close();
const sheet = path.join(out, name + '.sheet.png');
execFileSync('python3', [path.join(root, 'tools/sheet.py'), sheet, ...files]);
console.log('sheet ' + sheet);
