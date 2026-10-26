/**
 * Writes a redacted "shapes" report for a capture, so the real wire format can be mapped
 * without sharing the HAR:
 *
 *   npm run capture:shapes                 (latest capture)
 *   npm run capture:shapes -- captures/olx-flow-….har
 *
 * Output, next to the HAR:
 *   <name>.shapes.txt  request/response structure with personal values masked
 *   <name>.public/     verbatim responses of public catalog calls (categories, fields, locations)
 *
 * Skim both before sharing them. The HAR itself must never be shared.
 */
import 'dotenv/config';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildShapeReport, type HarFull } from '../src/tools/harShapes.js';

const config = loadConfig();
const hosts = [new URL(config.baseUrl).hostname.toLowerCase().replace(/^www\./, ''), ...config.extraHosts];

let harPath = process.argv[2];
if (!harPath) {
  const hars = (await readdir('captures')).filter((f) => f.endsWith('.har')).sort();
  if (!hars.length) throw new Error('No .har files in captures/. Run `npm run capture` first.');
  harPath = join('captures', hars[hars.length - 1]!);
}

const har = JSON.parse(await readFile(harPath, 'utf8')) as HarFull;
const { text, publicData } = buildShapeReport(har, {
  hosts,
  isPublic: (u) =>
    /\/api\/v\d+\/(categories|categoryFields)\/?$/i.test(u.pathname) ||
    (/^search-/.test(u.hostname) && /locations/i.test(u.pathname)),
});

const base = harPath.replace(/\.har$/, '');
await writeFile(`${base}.shapes.txt`, text, { mode: 0o600 });
await mkdir(`${base}.public`, { recursive: true });
for (const [name, calls] of Object.entries(publicData)) {
  await writeFile(join(`${base}.public`, `${name}.json`), JSON.stringify(calls, null, 2), { mode: 0o600 });
}
console.log(`Wrote ${base}.shapes.txt`);
console.log(`Wrote ${Object.keys(publicData).length} public catalog file(s) to ${base}.public/`);
console.log('Skim them before sharing. Never share the .har.');
