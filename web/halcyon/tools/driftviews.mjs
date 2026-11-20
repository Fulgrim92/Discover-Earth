// tools/driftviews.mjs: find the curated realm borders and write tools/shots/drift.json (DESIGN 11.1 test views):
// for each border, the points along the line between the two realm centres where the second realm's weight is
// 0.25, 0.5 and 0.75, each seen from 5 m and from 150 m above the ground, looking along the border crossing;
// plus a short time sequence (t stepping 4 s) at the midpoint of the first border, to check the skin flows.
// Usage: node tools/driftviews.mjs   (deterministic; rerun after changing realm sites or the blend)
import { writeFileSync } from 'node:fs';
import { CURATED, CELL, realmWeights, W_ID, W_W, REALM_NAMES } from '../src/realms.js';
import { heightAt } from '../src/world.js';

const wOf = (id) => { for (let s = 0; s < 4; s++) if (W_ID[s] === id) return W_W[s]; return 0; };
const shots = [];
const n = CURATED.length / 3;
let first = null;
for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
  const ax = CURATED[a * 3], az = CURATED[a * 3 + 1], ia = CURATED[a * 3 + 2];
  const bx = CURATED[b * 3], bz = CURATED[b * 3 + 1], ib = CURATED[b * 3 + 2];
  if (ia === ib || Math.hypot(bx - ax, bz - az) > 1.5 * CELL) continue;
  // march A -> B; record the first crossing of each target weight of B (relative to A + B)
  const want = [0.25, 0.5, 0.75], got = [null, null, null];
  let ok = true;
  for (let k = 0; k <= 400; k++) {
    const t = k / 400, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    realmWeights(x, z);
    const wa = wOf(ia), wb = wOf(ib);
    const r = wb / Math.max(wa + wb, 1e-6);
    for (let q = 0; q < 3; q++) if (!got[q] && r >= want[q]) got[q] = [x, z, wa + wb];
  }
  if (got.some((g) => !g)) continue;
  if (got[1][2] < 0.85) ok = false; // a third realm dominates the middle: not a clean border
  if (!ok) continue;
  const yaw = Math.round((Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI + 360) % 360;
  const short = (id) => REALM_NAMES[id].split(' ')[0].toLowerCase();
  let name = short(ia) + '_' + short(ib);
  while (shots.some((s) => s.name.startsWith('drift_' + name + '_'))) name += 'b'; // a realm can own two cells
  const tag = ['q1', 'mid', 'q3'];
  for (let q = 0; q < 3; q++) {
    const [x, z] = got[q];
    const rx = Math.round(x - ax), rz = Math.round(z - az);
    const g = Math.max(heightAt(x, z), 0);
    // side-on to the crossing direction at 5 m, so both realms are in frame; along it from 150 m
    shots.push({ name: 'drift_' + name + '_' + tag[q] + '_5', params: { realm: ia, pos: rx + ',' + (g + 5).toFixed(0) + ',' + rz, yaw: (yaw + 90) % 360, pitch: -2 } });
    shots.push({ name: 'drift_' + name + '_' + tag[q] + '_150', params: { realm: ia, pos: rx + ',' + (g + 150).toFixed(0) + ',' + rz, yaw, pitch: -14 } });
  }
  if (!first) first = { ia, rx: Math.round(got[1][0] - ax), rz: Math.round(got[1][1] - az), g: Math.max(heightAt(got[1][0], got[1][1]), 0), yaw, name };
}
if (first) for (let k = 0; k < 6; k++) {
  shots.push({ name: 'drift_seq_' + first.name + '_' + k, params: { realm: first.ia, pos: first.rx + ',' + (first.g + 150).toFixed(0) + ',' + first.rz, yaw: first.yaw, pitch: -30, t: 20 + 4 * k } });
}
const body = shots.map((s) => '    ' + JSON.stringify(s).replace(/,"/g, ', "').replace(/":/g, '": ')).join(',\n');
writeFileSync(new URL('./shots/drift.json', import.meta.url),
  '{\n  "defaults": { "w": 960, "h": 540, "t": 20, "hud": 0, "fov": 62 },\n  "shots": [\n' + body + '\n  ]\n}\n');
console.log(shots.length + ' views, ' + (shots.length - 6) / 6 + ' borders');
