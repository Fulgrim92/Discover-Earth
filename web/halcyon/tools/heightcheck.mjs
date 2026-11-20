// tools/heightcheck.mjs: DESIGN section 6 gate. For each view in a step list, bake the clipmap, read back levels
// 0,2,4,6,8 and compare 256 texels with world.heightAt (max error < 0.15 m). Exit 1 on failure.
// Usage: node tools/heightcheck.mjs [tools/shots/realms.json]
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch, capture } from './shot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = process.argv[2] || path.join(root, 'tools/shots/realms.json');
const spec = JSON.parse(await readFile(list, 'utf8'));
const browser = await launch();
let bad = 0, worst = 0;
for (const s of spec.shots) {
  if (s.params && s.params.stereo) continue;
  const params = Object.assign({}, spec.defaults || {}, s.params, { heightcheck: 1, w: 160, h: 90, quality: 'low' });
  const r = await capture(browser, params, null);
  const hc = r.state && r.state.heightcheck;
  if (!r.ok || !hc || !hc.pass) { bad++; console.log('FAIL ' + s.name + ' ' + (r.error || JSON.stringify(hc))); continue; }
  worst = Math.max(worst, hc.maxErr);
  console.log('ok   ' + s.name + '  n=' + hc.n + '  max ' + hc.maxErr.toFixed(4) + ' m  mean ' + hc.meanErr.toFixed(5) + ' m');
}
await browser.close();
console.log((bad ? 'FAILED ' + bad : 'PASS') + '  worst max error ' + worst.toFixed(4) + ' m');
process.exit(bad ? 1 : 0);
