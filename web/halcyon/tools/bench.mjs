// tools/bench.mjs: headless smoke test of ?bench=1 (DESIGN section 9, frame pacing).
// Loads dist/index.html?bench=1 in headless Chromium (SwiftShader WebGPU), flies the scripted bench route (Home
// rings, boost transit, Stone Forest rings, Lumen Deep rings, FPV) through the real frame loop, and prints the report
// the page puts on window.__halcyon.bench: avg / p50 / p99 / max frame, CPU and GPU time, per-pass GPU ms from the
// timestamp queries, timer readback counts and the dynamic-resolution state.
// SwiftShader numbers say nothing about a real GPU: this checks that the bench runs end to end, that the GPU timer
// resolves and reads back, and that the report has the right shape. Run it on the reference machine (a real
// browser, ?bench=1) for numbers that mean something.
// SwiftShader renders a 320x180 frame in about a second, so the smoke test flies the whole 72 s route with
// stride=48 (48 fixed sim steps per rendered frame: 90 frames, all three realms) and at most 2 frames in flight.
//
// Usage: node tools/bench.mjs [--stride 48] [--frames N] [--w 320 --h 180] [--quality low] [--set k=v;k=v] [--nobuild]
// Output: the JSON on stdout, out/bench/bench.json and out/bench/bench.png (the on-screen summary).
// Exit 1 when the page errors, the report is missing or malformed, or (with a timer) no pass timings came back.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { FLAGS } from './shot.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(require.resolve('playwright', { paths: [process.cwd(), '/usr/lib/node_modules', '/usr/local/lib/node_modules'] })); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('--w', 320), H = +opt('--h', 180);
const FRAMES = +opt('--frames', 0), STRIDE = +opt('--stride', 48);
const outDir = path.join(root, opt('--out', 'out/bench'));

if (!args.includes('--nobuild')) execFileSync(process.execPath, [path.join(root, 'tools/build.mjs')], { stdio: 'inherit' });
const q = new URLSearchParams({ bench: 1, w: W, h: H, quality: opt('--quality', 'low'), present: 0, hud: 1, stride: STRIDE });
if (FRAMES > 0) q.set('frames', FRAMES);
if (opt('--set')) for (const kv of opt('--set').split(';')) { const i = kv.indexOf('='); q.set(kv.slice(0, i), kv.slice(i + 1)); }
const url = pathToFileURL(path.join(root, 'dist/index.html')).href + '?' + q.toString();

const fail = [];
const browser = await playwright.chromium.launch({ headless: true, args: FLAGS });
let r = null;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  console.error('bench: ' + (FRAMES ? FRAMES + ' frames' : 'full route') + ', stride ' + STRIDE + ', ' + W + 'x' + H + ' ' + q.get('quality'));
  await page.goto(url);
  // poll (the bench is not an allocation test, so evaluating in the page is fine); report progress every ~10 s
  for (let i = 0; ; i++) {
    const p = await page.evaluate(() => { const H = window.__halcyon || {}; return { s: H.benchState, e: H.error, f: H.frame }; });
    if (p.e || p.s === 'done') break;
    if (i % 10 === 9) console.error('bench: frame ' + p.f + (p.s ? ' (' + p.s + ')' : ''));
    if (Date.now() - t0 > 1800000) { fail.push('timeout'); break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const st = await page.evaluate(() => ({ error: window.__halcyon.error, bench: window.__halcyon.bench }));
  if (st.error) errors.push(st.error);
  r = st.bench;
  await mkdir(outDir, { recursive: true });
  // the summary panel is DOM over the canvas; give it a viewport it fits in
  await page.setViewportSize({ width: Math.max(W, 720), height: Math.max(H, 420) });
  await page.screenshot({ path: path.join(outDir, 'bench.png') });
  console.error('bench: done in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s wall');
  if (errors.length) fail.push('page errors: ' + errors.join(' | '));
} finally {
  await browser.close();
}

const num = (v) => typeof v === 'number' && isFinite(v);
const statOk = (s) => s && num(s.avg) && num(s.p50) && num(s.p99) && num(s.max) && s.p50 <= s.p99 + 1e-9 && s.p99 <= s.max + 1e-9;
if (!r) fail.push('no report on window.__halcyon.bench');
else {
  if (!(r.frames > 0)) fail.push('no frames recorded');
  if (!statOk(r.frameMs)) fail.push('frameMs malformed');
  if (!statOk(r.cpuMs)) fail.push('cpuMs malformed');
  if (r.timer) {
    if (!statOk(r.gpuFrameMs)) fail.push('gpuFrameMs malformed');
    if (!r.timerOk) fail.push('GPU timer: ' + (r.timerErrors || ['timerOk false']).join('; '));
    for (const p of ['opaque', 'tshade', 'composite', 'fx', 'bloom', 'final', 'atmo']) if (!r.gpuPassMs || !statOk(r.gpuPassMs[p])) fail.push('no GPU timings for pass ' + p);
    if (!(r.timerReadbacks > 0)) fail.push('timer never read back');
  }
  await writeFile(path.join(outDir, 'bench.json'), JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify(r, null, 2));
}
console.error(fail.length ? 'bench: FAIL: ' + fail.join('; ') : 'bench: ok (' + r.frames + ' frames, ' + (r.timer ? 'GPU timer on' : 'no GPU timer: frame delta only') + '); out/bench/bench.json, out/bench/bench.png');
process.exit(fail.length ? 1 : 0);
