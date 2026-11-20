// tools/readytest.mjs: __halcyon.ready outside shot mode (start overlay, tour, bench), and the start overlay
// while the pipelines compile (it shows progress and does not dismiss before they are ready).
// Usage: node tools/readytest.mjs [--nobuild]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { FLAGS } from './shot.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(require.resolve('playwright', { paths: [process.cwd(), '/usr/lib/node_modules', '/usr/local/lib/node_modules'] })); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--nobuild')) execFileSync('node', [path.join(root, 'tools/build.mjs')], { stdio: 'inherit' });

const CASES = [
  ['start overlay', 'w=320&h=180'],
  ['start overlay, offscreen', 'w=320&h=180&present=0'],
  ['tour script', 'w=320&h=180&present=0&script=tour'],
  ['bench', 'w=320&h=180&present=0&bench=1&stride=48'],
];
const browser = await playwright.chromium.launch({ headless: true, args: FLAGS });
let bad = 0;
for (const [name, q] of CASES) {
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  const errors = [];
  // headless SwiftShader cannot present a WebGPU canvas (the reason shots render offscreen): ignore its swap-chain error
  const SWAP = /external Instance reference/;
  page.on('pageerror', (e) => { if (!SWAP.test(e.message)) errors.push(e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !SWAP.test(m.text())) errors.push(m.text()); });
  await page.goto(pathToFileURL(path.join(root, 'dist/index.html')).href + '?' + q, { waitUntil: 'commit', timeout: 120000 });
  const cta = () => { const m = document.body.innerText.match(/preparing[^\n]*|click or press[^\n]*/); return m ? m[0] : '(no overlay)'; };
  await page.waitForFunction(() => window.__halcyon, null, { timeout: 120000, polling: 50 });
  const early = await page.evaluate(cta);
  const t0 = Date.now();
  let ok = true;
  try {
    await page.waitForFunction(() => window.__halcyon && (window.__halcyon.ready || window.__halcyon.error), null, { timeout: 300000, polling: 200 });
  } catch { ok = false; }
  const s = await page.evaluate(() => ({ ready: __halcyon.ready, error: __halcyon.error, frame: __halcyon.frame, compileMs: __halcyon.compileMs }));
  const late = await page.evaluate(cta);
  if (s.error && s.error.split('\n').every((l) => SWAP.test(l))) s.error = null;
  ok = ok && s.ready && !s.error && !errors.length;
  if (!ok) bad++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + `  ready after ${Date.now() - t0} ms, frame ${s.frame}, pipelines ${s.compileMs} ms` +
    `\n        overlay at load: "${early}"\n        overlay when ready: "${late}"` + (s.error || errors.length ? '\n        ' + (s.error || errors.join(' | ')) : ''));
  await page.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
