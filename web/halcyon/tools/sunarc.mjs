// node tools/sunarc.mjs: the key sun elevation and azimuth of every realm across the time of day (tod), exactly as
// main.js skyTime() feeds realms.js skyTick(). Use it to check that the sun arc visibly moves before judging lighting.
import { skyTick, SKY_IN, TABLE, F, REALM_NAMES, ROWF } from '../src/realms.js';

const tods = [0.02, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.95];
const rows = [];
for (const tod of tods) {
  SKY_IN[0] = -Math.sin(tod * 2 * Math.PI);
  skyTick();
  const r = { tod, s: +SKY_IN[0].toFixed(3) };
  REALM_NAMES.forEach((n, i) => {
    const o = i * ROWF + F.S0 * 4;
    r[n] = `${TABLE[o].toFixed(1)} / ${TABLE[o + 1].toFixed(1)}`;
  });
  rows.push(r);
}
console.log('sun elevation / azimuth in degrees per realm');
console.table(rows);
