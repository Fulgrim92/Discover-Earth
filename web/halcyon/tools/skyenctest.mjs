// skyenctest.mjs (sky programmer): drives the encounter director and skyenc.js in node for one forced sky encounter
// and prints what the sky gets (FR.ske before the realm weight, the realm's sun / sky / stars, the pinned squall).
// node tools/skyenctest.mjs <name> <seconds into it>
import * as E from '../src/encounters.js';
import { skyTick, SKY_IN, TABLE, F, ROWF } from '../src/realms.js';
import { skyEncRows, SKE } from '../src/skyenc.js';
import { WX_PIN, WX_ENC } from '../src/weather.js';
import { CLK, C_TIME } from '../src/clock.js';

const name = process.argv[2] || 'eclipse', et = +(process.argv[3] || 30);
const q = new URLSearchParams(`enc=${name}&et=${et}`);
E.init(q, 1);
const t = 20;
E.IN[0] = t; E.IN[1] = 0; E.IN[2] = 100; E.IN[3] = 0; E.IN[4] = 0; E.IN[5] = -1; E.IN[8] = 0.7;
E.update();
CLK[C_TIME] = t; SKY_IN[0] = -Math.sin(t / 900 * 2 * Math.PI);
skyTick(); skyEncRows();
const r = { lunar: 4, eclipse: 5, milkyway: 2, aurora: 4, brocken: 3 }[name] ?? 0, o = r * ROWF;
const v = (f) => Array.from(TABLE.subarray(o + F[f] * 4, o + F[f] * 4 + 4)).map((x) => +x.toPrecision(4));
console.log('slot0', Array.from(E.ENC.subarray(0, 8)), 'PH', Array.from(E.PH.subarray(0, 4)));
console.log('SKE', Array.from(SKE), 'S0', v('S0'), 'S2', v('S2'), 'S5', v('S5'), 'S8', v('S8'), 'G0', v('G0'));
console.log('C1', v('C1'), 'C2', v('C2'));
console.log('PIN', Array.from(WX_PIN), 'BOLT', Array.from(WX_ENC));
