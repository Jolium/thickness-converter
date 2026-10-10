// Fold the built JS and CSS into one HTML file that works offline (double-click to open).
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../dist/', import.meta.url);
const read = (p: string) => readFileSync(new URL('.' + p, dir), 'utf8');
const html = readFileSync(new URL('index.html', dir), 'utf8')
  .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/,
    (_, src) => `<script type="module">${read(src).replace(/<\/script/gi, '<\/script')}</script>`)
  .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/, (_, href) => `<style>${read(href)}</style>`);
if (/src="\/|href="\/assets/.test(html)) throw new Error('inline: an asset reference was not inlined');
writeFileSync(new URL('../thickness_tool.html', dir), html);
console.log('thickness_tool.html');
