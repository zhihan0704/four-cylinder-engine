import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const minify = process.argv.includes('--minify');
const dev = !minify;

const result = await build({
  entryPoints: [path.join(src, 'main.js')],
  bundle: true,
  write: false,
  format: 'iife',
  target: ['es2020'],
  minify,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
let js = result.outputFiles[0].text;
js = js.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(src, 'style.css'), 'utf8');
const template = fs.readFileSync(path.join(src, 'index.template.html'), 'utf8');
const bgmPath = path.join(root, 'assets', 'bgm.mp3');
if (!fs.existsSync(bgmPath)) throw new Error(`Missing background music: ${bgmPath}`);
const bgmSrc = `data:audio/mpeg;base64,${fs.readFileSync(bgmPath).toString('base64')}`;
const html = template
  .replace('__BGM_SRC__', () => bgmSrc)
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js);
const outName = dev ? 'index.dev.html' : '四冲程柴油机-3D交互仿真.html';
const out = path.join(root, outName);
fs.writeFileSync(out, html);
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`${outName}: ${(html.length / 1024 / 1024).toFixed(2)} MB`);
