// tools/build.mjs: esbuild bundle of src/main.js (WGSL imported as minified text) -> dist/index.html, one file.
// Usage: node tools/build.mjs [--dev]   (--dev: no JS minification, for readable stack traces)
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');

export function minifyWGSL(s) {
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  s = s.replace(/\s+/g, ' ');
  // drop spaces next to punctuation that can never merge into another token
  s = s.replace(/ ?([{}();,:\[\]]) ?/g, '$1');
  s = s.replace(/(?<=[\w)\]]) ?= ?(?=[\w(.])/g, '=');
  return s.trim();
}

const wgslPlugin = {
  name: 'wgsl',
  setup(b) {
    b.onLoad({ filter: /\.wgsl$/ }, async (a) => {
      const src = await readFile(a.path, 'utf8');
      return { contents: 'export default ' + JSON.stringify(dev ? src : minifyWGSL(src)) + ';', loader: 'js' };
    });
  },
};

const r = await esbuild.build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true, format: 'esm', write: false, minify: !dev, target: 'es2022', legalComments: 'none',
  plugins: [wgslPlugin],
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>HALCYON</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>' +
  '</head><body><canvas id="c"></canvas><script type="module">' + js + '</script></body></html>';
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/index.html'), html);
console.log('dist/index.html ' + Buffer.byteLength(html) + ' bytes' + (dev ? ' (dev)' : ''));
