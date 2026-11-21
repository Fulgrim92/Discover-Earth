// tools/map.mjs: top-down hillshade of world.heightAt (CPU) for tuning landforms quickly.
// Usage: node tools/map.mjs <cx> <cz> <size m> <px> <out.png>   (water < 0 drawn blue, realm borders tinted)
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { heightAt } from '../src/world.js';
import { realmWeights, W_NEAR } from '../src/realms.js';

const [cx, cz, size, px, out] = [+process.argv[2] || 0, +process.argv[3] || 0, +process.argv[4] || 6000, +process.argv[5] || 512, process.argv[6] || 'out/map.png'];
const hs = new Float64Array((px + 1) * (px + 1));
const step = size / px;
for (let j = 0; j <= px; j++) for (let i = 0; i <= px; i++) hs[j * (px + 1) + i] = heightAt(cx - size / 2 + i * step, cz - size / 2 + j * step);
const tint = [[0.45, 0.6, 0.3], [0.8, 0.45, 0.3], [0.9, 0.9, 0.9], [0.35, 0.55, 0.35], [0.7, 0.8, 0.95], [0.55, 0.4, 0.8], [0.4, 0.85, 0.8], [0.9, 0.55, 0.25], [0.75, 0.75, 0.8]];
const raw = Buffer.alloc((px * 3 + 1) * px);
let mn = 1e9, mx = -1e9;
for (let j = 0; j < px; j++) {
  raw[j * (px * 3 + 1)] = 0;
  for (let i = 0; i < px; i++) {
    const h = hs[j * (px + 1) + i];
    mn = Math.min(mn, h); mx = Math.max(mx, h);
    const dx = (hs[j * (px + 1) + i + 1] - h) / step, dz = (hs[(j + 1) * (px + 1) + i] - h) / step;
    const l = Math.max(0, (-dx * -0.6 + -dz * -0.6 + 1) / Math.sqrt(dx * dx + dz * dz + 1) / 1.53);
    realmWeights(cx - size / 2 + i * step, cz - size / 2 + j * step);
    const t = tint[W_NEAR[2]];
    let c;
    if (h < 0) c = [0.1, 0.25 + 0.1 * Math.max(0, 1 + h / 50), 0.5];
    else { const e = Math.min(1, h / 900); c = [t[0] * (0.5 + e), t[1] * (0.5 + e), t[2] * (0.5 + e)].map((v) => v * (0.25 + 0.85 * l)); }
    const o = j * (px * 3 + 1) + 1 + i * 3;
    raw[o] = Math.min(255, c[0] * 255); raw[o + 1] = Math.min(255, c[1] * 255); raw[o + 2] = Math.min(255, c[2] * 255);
  }
}
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(px, 0); ihdr.writeUInt32BE(px, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(out + ' height ' + mn.toFixed(0) + '..' + mx.toFixed(0) + ' m');
