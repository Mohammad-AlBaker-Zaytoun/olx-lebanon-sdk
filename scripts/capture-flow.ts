/**
 * Records everything the OLX web app does while you post (or edit / delete) an ad by hand,
 * into a HAR file under captures/, then prints the API calls worth mapping.
 *
 * The HAR contains your password, cookies and tokens. It is git-ignored; never share it.
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { formatHarSummary, summarizeHar, type HarLike } from '../src/tools/har.js';

const config = loadConfig();
const olxHost = new URL(config.baseUrl).hostname.replace(/^www\./, '');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const harPath = join('captures', `olx-flow-${stamp}.har`);
await mkdir('captures', { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  locale: 'en-US',
  recordHar: { path: harPath, content: 'embed', urlFilter: new RegExp(olxHost.replace(/\./g, '\\.')) },
});
const page = await context.newPage();
await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

console.log('Recording. In the browser window:');
console.log('  1. Log in to your account');
console.log('  2. Post one real ad by hand (with at least one photo)');
console.log('  3. Optionally edit it, then delete it');
const rl = createInterface({ input: stdin, output: stdout });
await rl.question('\nPress Enter here when you are done… ');
rl.close();

await context.close(); // flushes the HAR
await browser.close();

const har = JSON.parse(await readFile(harPath, 'utf8')) as HarLike;
const summary = formatHarSummary(
  summarizeHar(har, (host) => host === olxHost || host.endsWith('.' + olxHost)),
);
const summaryPath = harPath.replace(/\.har$/, '.summary.txt');
await writeFile(summaryPath, summary + '\n');

console.log(`\nSaved ${harPath}\nCandidate API calls (writes first):\n`);
console.log(summary);
console.log(`\nSummary written to ${summaryPath}. Next: docs/ENDPOINT-CAPTURE.md, step 3.`);
