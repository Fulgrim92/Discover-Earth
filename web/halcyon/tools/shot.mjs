// tools/shot.mjs: headless Chromium (SwiftShader WebGPU) captures from a step list.
// Usage: node tools/shot.mjs tools/shots/realms.json [--only name1,name2] [--set k=v,...] [--out dir]
// Step list: { "defaults": { url params }, "shots": [ { "name": "...", "params": { ... } } ] }
// Fails (exit 1) on __halcyon.error, page errors, console errors or a timeout.
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(require.resolve('playwright', { paths: [process.cwd(), '/usr/lib/node_modules', '/usr/local/lib/node_modules'] })); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLAGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'];

export async function launch() { return playwright.chromium.launch({ headless: true, args: FLAGS }); }

// Load one capture; returns { ok, error, state, ms }
export async function capture(browser, params, outPng, timeoutMs = 600000) {
  const w = +params.w || 960, h = +params.h || 540;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); else if (params.verbose) console.log('  [page] ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const q = new URLSearchParams();
  q.set('shot', '1');
  for (const k in params) q.set(k, String(params[k]));
  const url = pathToFileURL(path.join(root, 'dist/index.html')).href + '?' + q.toString();
  const t0 = Date.now();
  await page.goto(url);
  let state = null;
  try {
    await page.waitForFunction(() => window.__halcyon && (window.__halcyon.ready || window.__halcyon.error), null, { timeout: timeoutMs, polling: 250 });
    state = await page.evaluate(() => JSON.parse(JSON.stringify(window.__halcyon)));
  } catch (e) { errors.push('timeout: ' + e.message.split('\n')[0]); }
  if (state && state.error) errors.push('halcyon: ' + state.error);
  if (!errors.length && outPng) await page.locator('#c').screenshot({ path: outPng });
  await page.close();
  return { ok: errors.length === 0, error: errors.join('\n'), state, ms: Date.now() - t0 };
}

async function main() {
  const args = process.argv.slice(2);
  const list = args.find((a) => !a.startsWith('--') && a.endsWith('.json')) || path.join(root, 'tools/shots/realms.json');
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const only = opt('--only') ? opt('--only').split(',') : null;
  const extra = {};
  if (opt('--set')) for (const kv of opt('--set').split(';')) { const i = kv.indexOf('='); extra[kv.slice(0, i)] = kv.slice(i + 1); }
  const out = path.resolve(opt('--out') || path.join(root, 'out/shots'));
  await mkdir(out, { recursive: true });
  const spec = JSON.parse(await readFile(list, 'utf8'));
  const browser = await launch();
  let failed = 0;
  for (const s of spec.shots) {
    if (only && !only.includes(s.name)) continue;
    const params = Object.assign({}, spec.defaults || {}, s.params || {}, extra);
    const png = path.join(out, s.name + '.png');
    const r = await capture(browser, params, png);
    if (r.ok) console.log('ok   ' + s.name + '  ' + (r.ms / 1000).toFixed(1) + ' s  ' + png + (r.state && r.state.heightcheck ? '  heightcheck ' + JSON.stringify(r.state.heightcheck) : ''));
    else { failed++; console.log('FAIL ' + s.name + '\n' + r.error); }
  }
  await browser.close();
  if (failed) { console.log(failed + ' shot(s) failed'); process.exit(1); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
