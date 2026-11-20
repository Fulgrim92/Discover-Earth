// tools/heightcheck.mjs: DESIGN section 6 gate. For each view in a step list, bake the clipmap, read back levels
// 0,2,4,6,8 and compare 256 texels with world.heightAt (max error < 0.15 m), then 260 heights as the shaders sample
// them (clip.wgsl clipH) with an f64 bilinear of those texels (max error < 0.15 m). Every view runs on both paths:
// f32=0 (no float32-filterable, the target RX 6650 XT / D3D12) and f32=1. Exit 1 on failure.
// Usage: node tools/heightcheck.mjs [tools/shots/realms.json] [--f32 0|1|both]
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch, capture } from './shot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const list = args.find((a) => a.endsWith('.json')) || path.join(root, 'tools/shots/realms.json');
const fi = args.indexOf('--f32');
const PATHS = fi >= 0 && args[fi + 1] !== 'both' ? [+args[fi + 1]] : [0, 1];
const spec = JSON.parse(await readFile(list, 'utf8'));
const browser = await launch();
let bad = 0, worst = 0;
let worstS = 0;
for (const f32 of PATHS) for (const s of spec.shots) {
  if (s.params && s.params.stereo) continue;
  const params = Object.assign({}, spec.defaults || {}, s.params, { heightcheck: 1, w: 160, h: 90, quality: 'low', f32 });
  const r = await capture(browser, params, null);
  const hc = r.state && r.state.heightcheck;
  const tag = s.name + ' f32=' + f32;
  if (!r.ok || !hc || !hc.pass) { bad++; console.log('FAIL ' + tag + ' ' + (r.error || JSON.stringify(hc))); continue; }
  worst = Math.max(worst, hc.maxErr); worstS = Math.max(worstS, hc.sampled.maxErr);
  console.log('ok   ' + tag + '  texels n=' + hc.n + ' max ' + hc.maxErr.toFixed(4) + ' m  mean ' + hc.meanErr.toFixed(5) +
    ' m  sampled n=' + hc.sampled.n + ' max ' + hc.sampled.maxErr.toFixed(5) + ' m');
}
await browser.close();
console.log((bad ? 'FAILED ' + bad : 'PASS') + '  worst max error ' + worst.toFixed(4) + ' m, sampled ' + worstS.toFixed(5) + ' m');
process.exit(bad ? 1 : 0);
