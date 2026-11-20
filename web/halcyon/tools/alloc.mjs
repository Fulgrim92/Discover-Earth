// tools/alloc.mjs: the zero-allocation gate (DESIGN section 9).
//
// Runs the real frame loop (sim + scripted input + HUD + audio + renderer + GPU timer) headless for N frames after a
// warm-up, between two forced GCs, with V8's --trace-gc on and the CDP sampling heap profiler recording every
// allocation (including objects a scavenge would have collected). Prints:
//   - the GCs inside the measured window (scavenges, mark-compacts) and the heap before/after,
//   - the sampling heap profile grouped by function, split into PAGE code (ours: must be zero) and PLATFORM
//     allocations we cannot remove (WebGPU encoders/command buffers, getCurrentTexture().createView(), rAF
//     timestamps, navigator.getGamepads() snapshots, WebAudio AudioParam calls, timer readback promises),
// and fails (exit 1) when page code allocates in the steady state, when the retained heap grows, or when there
// are scavenges that the platform allocations do not explain.
//
// The default warm-up (5400 frames: two laps of the 44 s tour, which loops) is JIT warm-up: until V8 has optimised a
// function, and seen every branch the flight takes, its baseline code boxes every double it touches, so the steady
// state starts once every path of the lap is compiled. The measured window is then the third lap.
//
// Usage: node tools/alloc.mjs [--frames 1800] [--warm 5400] [--script tour] [--interval 128] [--keep] [--set k=v;...]
//        [--jsflags '--trace-deopt'] (prints the V8 trace lines inside the measured window) [--gclog] [--noprofile]
//        [--xrmock [1|2]] runs the VR frame loop instead (xr.js on the src/xrmock.js stand-in, texture-array layer or
//        side by side, scripted head and sticks): xrFrame, readFrame, the controllers and the HUD, two views per frame.
//        The XR objects a real UA hands out per frame are listed under XR_PLATFORM below; the mock reuses its own.
// It builds an unminified bundle (out/alloc/index.html) so functions keep their names.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(require.resolve('playwright', { paths: [process.cwd(), '/usr/lib/node_modules', '/usr/local/lib/node_modules', '/opt/node-tools/node_modules'] })); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FRAMES = +opt('--frames', 1800), WARM = +opt('--warm', 5400), SCRIPT = opt('--script', 'tour');
const INTERVAL = +opt('--interval', 128);

// Platform allocation sites. The sampling profiler attributes an allocation to the innermost JS function on the
// stack; Blink-created objects (pass encoders, command buffers, texture views, promises, gamepad snapshots,
// rAF timestamps) therefore land on the JS function that made the platform call. Each entry is keyed by source
// module and function name (found from the esbuild "// src/<module>" markers in the dev bundle, so a same-named
// function elsewhere still counts as page code); those functions do no other allocating work, so what they
// allocate is the platform's.
const PLATFORM = {
  'main.js:renderFrame': 'GPUCommandEncoder, GPUCommandBuffer (+ getCurrentTexture().createView() on the canvas path)',
  'main.js:renderView': 'GPURenderPassEncoder (opaque pass)',
  'main.js:frame': 'requestAnimationFrame callback registration + its DOMHighResTimeStamp',
  'fx/composite.js:draw': 'GPURenderPassEncoder (composite)',
  'fx/terrain.js:shade': 'GPURenderPassEncoder (deferred terrain shading)',
  'fx/post.js:draw': 'GPURenderPassEncoder x12 (bloom chain, final)',
  'fx/rings.js:upload': 'queue.writeBuffer() x2 (effect uniforms, ring instances)',
  'fx/flora.js:placePass': 'GPUComputePassEncoder (flora placement prepass, once per frame) + queue.writeBuffer() (layer mask)',
  'fx/particles.js:draw': 'GPURenderPassEncoder (motes + transparent fauna), when it runs',
  'fx/rings.js:pass': 'GPURenderPassEncoder (effects pass)',
  'fx/clipmap.js:bakeLevel': 'GPURenderPassEncoder x2 when a clip level re-bakes',
  'fx/clipmap.js:bakeStale': 'GPURenderPassEncoder x2 when a clip level re-bakes (bakeLevel inlined into its caller)',
  'fx/clipmap.js:bakeRealm': 'GPUComputePassEncoder + queue.writeBuffer() when the realm map recentres (every 8 km)',
  'fx/atmo.js:bake': 'GPUComputePassEncoder (atmosphere LUT bake, once per frame)',
  'fx/clouds.js:draw': 'GPUComputePassEncoder (weather window, first view) + GPURenderPassEncoder (cloud march)',
  'gpu.js:tsFrameOpen': 'GPUComputePassEncoder (empty pass: whole-frame GPU timer begin)',
  'gpu.js:tsFrameClose': 'GPUComputePassEncoder (empty pass: whole-frame GPU timer end)',
  'gpu.js:tsOpen': 'GPUComputePassEncoder (empty pass: clip bake timer begin), when a clip level bakes',
  'gpu.js:tsClose': 'GPUComputePassEncoder (empty pass: clip bake timer end), when a clip level bakes',
  'perf.js:frameEnd': 'resolveQuerySet / copyBufferToBuffer argument wrappers',
  'perf.js:afterSubmit': 'mapAsync() promise + then() promise, once per 16 frames (GPU timer readback)',
  'perf.js:onMapped': 'getMappedRange() ArrayBuffer + Uint32Array view, once per 16 frames (GPU timer readback)',
  'sim/hud.js:drawStick': 'Canvas 2D arc()/moveTo() calls (number arguments into the platform); only when a HUD stick moves a pixel',
  'sim/input.js:pollPad': 'navigator.getGamepads() snapshot array',
  'sim/audio.js:update': 'WebAudio AudioParam.setTargetAtTime(value, ctx.currentTime): boxed doubles into the platform, 30 Hz',
  // VR (--xrmock): what a real browser allocates per XR frame, at the call that receives it (the mock reuses its
  // objects, so on the mock these sites stay near zero; on a headset they are the XR platform's)
  'main.js:xrFrame': 'XRSession.requestAnimationFrame() registration; the XRFrame and its DOMHighResTimeStamp',
  'xr.js:readFrame': 'XRViewerPose, its views array, 2 XRView, XRRigidTransform + 2 DOMPointReadOnly per pose, ' +
    'projectionMatrix Float32Array per view, XRGPUSubImage + XRViewport + getViewDescriptor() dictionary per view, and ' +
    'colorTexture.createView() whenever the UA hands out a new texture (every frame on a real device)',
  'xr.js:readInputs': 'XRInputSourceArray access, XRPose (+ transform, 2 DOMPointReadOnly) per grip, Gamepad axes/buttons arrays',
  'fx/xrfx.js:upload': 'queue.writeBuffer() (VR controllers + HUD uniforms)',
  'fx/xrfx.js:drawHud': 'draw() argument wrapper',
  'xrmock.js:onRaf': 'the mock UA: page requestAnimationFrame registration that stands in for the XR frame loop',
  'xrmock.js:deliver': 'the mock UA: calls the XR frame callback',
  '(V8 API)': 'objects created by the browser outside any JS frame',
  '(BYTECODE_COMPILER)': 'lazy compilation', '(PARSER)': 'lazy compilation', '(IDLE)': 'idle-time tasks', '(program)': 'runtime',
  '(garbage collector)': 'runtime', '(root)': 'runtime',
};

// line -> source module, from the "// src/<module>" comments esbuild writes in a dev bundle
let MODULES = [];
function loadModules(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  MODULES = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\/\/ src\/(\S+\.js)$/);
    if (m) MODULES.push([i + 1, m[1]]);
  }
}
function moduleAt(line) {
  let r = '';
  for (const [l, m] of MODULES) { if (l <= line) r = m; else break; }
  return r;
}
// esbuild renames clashing top-level names (draw -> draw3); undo that for the lookup
const siteKey = (g) => (g.module ? g.module + ':' + g.name.replace(/\d+$/, '') : g.name);

function buildDev() {
  const out = path.join(root, 'out/alloc/index.html');
  execFileSync(process.execPath, [path.join(root, 'tools/build.mjs'), '--dev', '--out', out], { stdio: 'inherit' });
  loadModules(out);
}

function launchChrome() {
  const exe = playwright.chromium.executablePath();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'halcyon-alloc-'));
  const flags = ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader',
    '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required',
    '--js-flags=--expose-gc --trace-gc' + (opt('--jsflags') ? ' ' + opt('--jsflags') : ''), '--no-first-run', '--no-default-browser-check', 'about:blank'];
  // V8 prints --trace-gc from the renderer through stdio; stdbuf (inherited by child processes) makes it line
  // buffered so the end-of-window lines arrive before we read them
  const ch = existsSync('/usr/bin/stdbuf') ? spawn('/usr/bin/stdbuf', ['-oL', '-eL', exe, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(exe, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  const gc = [];
  let buf = '';
  ch.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { gc.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const ws = new Promise((res, rej) => {
    let e = '';
    ch.stderr.on('data', (d) => {
      e += d.toString();
      const m = e.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) res(m[1]);
    });
    ch.on('exit', (c) => rej(new Error('chrome exited ' + c + '\n' + e.slice(-2000))));
  });
  return { ch, gc, ws, dir };
}

// "[pid:0xisolate]    1234 ms: Scavenge 3.1 (4.2) -> 2.9 (5.2) MB, ... reason" -> {iso, ms, kind, before, after, reason}
// (kinds: Scavenge, Minor Mark-Sweep, Mark-Compact, Incremental Mark-Compact, Mark-Compact (reduce))
function parseGC(line) {
  const m = line.match(/^\[(\d+:0x[0-9a-f]+)\]\s+(\d+)\s+ms:\s+((?:Incremental |Minor )?[A-Za-z-]+(?: \([a-z ]+\))?)\s+([\d.]+)\s+\(([\d.]+)\)\s+->\s+([\d.]+)\s+\(([\d.]+)\)\s+MB(.*)$/);
  if (!m) return null;
  return { iso: m[1], ms: +m[2], kind: m[3], before: +m[4], after: +m[6], rest: m[8], line };
}

function groupProfile(profile) {
  const byFn = new Map();
  const walk = (n, stack) => {
    const cf = n.callFrame;
    const name = cf.functionName || (cf.url ? '(anonymous)' : '(root)');
    const line = cf.lineNumber + 1;
    const module = cf.url && /index\.html/.test(cf.url) ? moduleAt(line) : '';
    const where = cf.url ? (module || path.basename(cf.url.split('?')[0])) + ':' + line : '';
    const st = stack.concat(name);
    if (n.selfSize > 0) {
      const k = name + '|' + where;
      const e = byFn.get(k) || { name, where, module, bytes: 0, stacks: new Map() };
      e.bytes += n.selfSize;
      const sk = st.slice(-4).join(' < ');
      e.stacks.set(sk, (e.stacks.get(sk) || 0) + n.selfSize);
      byFn.set(k, e);
    }
    for (const c of n.children) walk(c, st);
  };
  walk(profile.head, []);
  return [...byFn.values()].sort((a, b) => b.bytes - a.bytes);
}

async function main() {
  buildDev();
  const C = launchChrome();
  let browser;
  const fail = [];
  try {
    const ws = await C.ws;
    browser = await playwright.chromium.connectOverCDP(ws);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.setViewportSize({ width: 320, height: 180 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // the page reports its start/end marks through a binding installed before it loads: evaluating script in the
    // page during the run would change the global object and deoptimise the frame loop (the measurement would see
    // the baseline tiers boxing doubles while it re-optimises)
    const marks = {};
    const markP = (w) => new Promise((r) => { marks[w] = r; });
    const startP = markP('start'), endP = markP('end');
    await page.exposeFunction('__halcyonAllocMark', (w) => { if (marks[w]) marks[w](); });
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    const q = new URLSearchParams({ script: SCRIPT, alloc: 1, warm: WARM, frames: FRAMES, w: 320, h: 180, quality: 'low', present: 0, inflight: 0, dynres: 0, audio: 1, hud: 1 });
    if (args.includes('--xrmock')) {
      const v = opt('--xrmock', '1');
      q.set('xrmock', v === '2' ? '2' : '1'); q.set('xrscript', '1'); q.set('xrw', '288'); q.set('xrh', '300');
    }
    if (opt('--set')) for (const kv of opt('--set').split(';')) { const i = kv.indexOf('='); q.set(kv.slice(0, i), kv.slice(i + 1)); }
    const url = pathToFileURL(path.join(root, 'out/alloc/index.html')).href + '?' + q.toString();
    if (q.has('xrmock')) console.log('VR loop on the mock (xrmock=' + q.get('xrmock') + '): two 288x300 eyes per frame');
    console.log('alloc gate: ' + FRAMES + ' frames after ' + WARM + ' warm-up frames, script ' + SCRIPT + ', 320x180 quality=low, sampling every ' + INTERVAL + ' B');
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => window.__halcyon && (window.__halcyon.running || window.__halcyon.error), null, { timeout: 600000, polling: 500 });
    let st = await page.evaluate(() => ({ error: window.__halcyon.error, timer: window.__halcyon.timer }));
    if (st.error) throw new Error('page error: ' + st.error);
    // no polling from here on: one promise per phase, resolved by the page
    await startP;
    const PROFILE = !args.includes('--noprofile');
    if (PROFILE) await cdp.send('HeapProfiler.startSampling', { samplingInterval: INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const tStart = Date.now();
    console.log('warm-up done in ' + ((tStart - t0) / 1000).toFixed(0) + ' s; measuring');
    await endP;
    const { profile } = PROFILE ? await cdp.send('HeapProfiler.stopSampling') : { profile: { head: { callFrame: {}, selfSize: 0, children: [] } } };
    const secs = (Date.now() - tStart) / 1000;
    const res = await page.evaluate(() => window.__halcyon.alloc);
    st = await page.evaluate(() => ({ error: window.__halcyon.error, frame: window.__halcyon.frame }));
    if (st.error) errors.push(st.error);
    await new Promise((r) => setTimeout(r, 2500)); // let stdout drain

    // ---- GC trace inside the window
    if (args.includes('--gclog')) for (const l of C.gc) console.log('GC| ' + l);
    // --jsflags '--trace-deopt' etc.: print the renderer's V8 trace lines that fall inside the measured window
    if (opt('--jsflags')) {
      let on = 0;
      for (const l of C.gc) {
        if (/testing/.test(l)) { on++; continue; }
        if (on >= 2 && on < 3 && !parseGC(l)) console.log('V8| ' + l.slice(0, 240));
      }
    }
    const gcs = C.gc.map(parseGC).filter(Boolean);
    const testing = gcs.filter((g) => /testing/.test(g.rest));
    const iso = testing.length ? testing[testing.length - 1].iso : null;
    const mine = gcs.filter((g) => g.iso === iso);
    const idx = mine.map((g, i) => (/testing/.test(g.rest) ? i : -1)).filter((i) => i >= 0);
    // two forced GCs at start, two at the end
    const a = idx.length >= 4 ? idx[1] : -1, b = idx.length >= 4 ? idx[2] : -1;
    const win = a >= 0 ? mine.slice(a + 1, b) : [];
    const scav = win.filter((g) => /Scavenge|Minor/.test(g.kind));
    const major = win.filter((g) => /Mark/.test(g.kind));
    const frames = res.end.frame - res.start.frame;
    console.log('\n== GC inside the window (' + frames + ' frames, ' + secs.toFixed(0) + ' s wall, renderer isolate ' + iso + ')');
    if (a < 0) console.log('   (could not find the forced-GC markers in the --trace-gc output; ' + gcs.length + ' GC lines seen)');
    for (const g of win) console.log('   ' + g.line.replace(/^\[[^\]]+\]\s+/, ''));
    console.log('   scavenges: ' + scav.length + ', mark-compacts: ' + major.length);
    const grow = res.end.heap - res.start.heap;
    console.log('   used JS heap after forced GC: start ' + (res.start.heap / 1024).toFixed(1) + ' KB, end ' + (res.end.heap / 1024).toFixed(1) + ' KB, growth ' + (grow / 1024).toFixed(1) + ' KB');

    // ---- sampling profile
    const groups = groupProfile(profile);
    let pageB = 0, platB = 0;
    const pageRows = [], platRows = [];
    for (const g of groups) {
      const ours = !!g.module;
      const plat = !ours || PLATFORM[siteKey(g)] !== undefined;
      if (plat) { platB += g.bytes; platRows.push(g); } else { pageB += g.bytes; pageRows.push(g); }
    }
    const per = (b) => (b / frames).toFixed(1) + ' B/frame';
    const show = (rows, label) => {
      console.log('\n== ' + label);
      if (!rows.length) { console.log('   (none)'); return; }
      for (const g of rows.slice(0, 25)) {
        console.log('   ' + (g.bytes / 1024).toFixed(1).padStart(9) + ' KB  ' + per(g.bytes).padStart(14) + '  ' + g.name + (g.where ? '  (' + g.where + ')' : '') + (PLATFORM[siteKey(g)] ? '  -- ' + PLATFORM[siteKey(g)] : ''));
        const top = [...g.stacks.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2);
        for (const [s, v] of top) console.log('              ' + (v / 1024).toFixed(1).padStart(7) + ' KB  ' + s);
      }
    };
    show(pageRows, 'PAGE allocations (our code; must be empty)');
    show(platRows, 'PLATFORM allocations (browser objects created by WebGPU / rAF / gamepad / WebAudio calls)');
    console.log('\n   page ' + (pageB / 1024).toFixed(1) + ' KB (' + per(pageB) + '), platform ' + (platB / 1024).toFixed(1) + ' KB (' + per(platB) + '), sampled every ' + INTERVAL + ' B');

    // ---- verdict
    // page code: tolerate sampling noise from one-off event paths (mode switches, teleports): < 1 B/frame
    if (pageB / frames >= 1) fail.push('page code allocates ' + per(pageB));
    if (grow > 64 * 1024) fail.push('retained heap grew by ' + (grow / 1024).toFixed(1) + ' KB');
    // scavenges must be explained by platform allocation volume (young generation >= 1 MB per scavenge)
    const explained = Math.floor(platB / (1024 * 1024)) + 1;
    if (scav.length > explained) fail.push(scav.length + ' scavenges but platform allocations explain at most ' + explained);
    if (a < 0) fail.push('no GC trace (--trace-gc output not captured)');
    if (errors.length) fail.push('page errors: ' + errors.join(' | '));
    console.log('\n== ' + (fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: no page allocations in the steady state; ' + scav.length + ' scavenge(s) in ' + frames + ' frames, all from platform objects (' + per(platB) + ')'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    C.ch.kill('SIGKILL');
    // the killed browser may still be flushing its profile: retry, and never let cleanup fail the gate
    if (!args.includes('--keep')) try { rmSync(C.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log('(could not remove ' + C.dir + ': ' + e.code + ')'); }
  }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
