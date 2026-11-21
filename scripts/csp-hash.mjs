// The import map in web/index.html is an inline script, so the Content-Security-Policy must list its hash.
// Run after editing the import map:  node scripts/csp-hash.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = new URL('../web/index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1];
const hash = createHash('sha256').update(map, 'utf8').digest('base64');
html = html.replace(/'sha256-[^']*'/, `'sha256-${hash}'`);
writeFileSync(file, html);
console.log('import map hash:', hash);
