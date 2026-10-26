/**
 * Records what the OLX web app does while you post (or edit / delete) an ad by hand,
 * into a HAR file under captures/, then prints the API calls worth mapping.
 *
 * Only OLX hosts (plus any in OLX_EXTRA_HOSTS) are recorded, so third-party logins
 * (Google, Facebook…) don't end up in the file. The HAR still contains your OLX password,
 * cookies and tokens: it is git-ignored and owner-only; never share it.
 */
import 'dotenv/config';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { FileSessionStore } from '../src/session/storage.js';
import { formatHarSummary, formatHostActivity, summarizeHar, tallyHosts, type HarLike } from '../src/tools/har.js';

const config = loadConfig();
const domains = [new URL(config.baseUrl).hostname.toLowerCase().replace(/^www\./, ''), ...config.extraHosts];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Anchored on the URL's host, so `https://accounts.google.com/?redirect_uri=https://www.olx.com.lb` is NOT recorded.
const hostPattern = new RegExp(`^https?://([^/?#@]+\\.)?(${domains.map(escape).join('|')})(:\\d+)?([/?#]|$)`, 'i');
const isRecordedHost = (host: string) => domains.some((d) => host === d || host.endsWith('.' + d));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const harPath = join('captures', `olx-flow-${stamp}.har`);
await mkdir('captures', { recursive: true, mode: 0o700 });
await chmod('captures', 0o700).catch(() => {}); // no-op on Windows

// Start signed in when a session was saved by `npm run login` (OLX cookies and storage only).
const saved = await new FileSessionStore(config.sessionFile).load().catch(() => null);
const storageState = saved
  ? {
      cookies: saved.cookies.map((c) => ({
        ...c,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        sameSite: (['Strict', 'Lax', 'None'].find((v) => v.toLowerCase() === (c.sameSite ?? '').toLowerCase()) ?? 'Lax') as
          | 'Strict'
          | 'Lax'
          | 'None',
      })),
      origins: Object.entries(saved.localStorage ?? {}).map(([origin, kv]) => ({
        origin,
        localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })),
      })),
    }
  : undefined;

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
  locale: 'en-US',
  recordHar: { path: harPath, content: 'embed', urlFilter: hostPattern },
  ...(storageState ? { storageState } : {}),
});
// Hostname + method of every request, so a call sent to an unrecorded host is still visible.
const seen: Array<{ method: string; url: string }> = [];
context.on('request', (req) => seen.push({ method: req.method(), url: req.url() }));
const page = await context.newPage();
await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

console.log(`Recording requests to: ${domains.join(', ')}`);
console.log('If the summary is missing a call (e.g. image upload to another host), add that host to');
console.log('OLX_EXTRA_HOSTS and capture again. In the browser window:');
console.log(saved ? '  1. You should already be signed in (saved session); log in if not' : '  1. Log in to your account');
console.log('  2. Post one real ad by hand (with at least one photo)');
console.log('  3. Optionally edit it, then delete it');
const rl = createInterface({ input: stdin, output: stdout });
await rl.question('\nPress Enter here when you are done… ');
rl.close();

await context.close(); // flushes the HAR
await browser.close();
await chmod(harPath, 0o600).catch(() => {});

const har = JSON.parse(await readFile(harPath, 'utf8')) as HarLike;
const others = formatHostActivity(tallyHosts(seen, isRecordedHost));
const summary =
  formatHarSummary(summarizeHar(har, (host) => isRecordedHost(host.toLowerCase()))) +
  '\n\nOther hosts the page contacted (NOT recorded; hostnames and counts only):\n' +
  'Hosts with POST/PUT/PATCH/DELETE are the likely API or upload hosts: add them to OLX_EXTRA_HOSTS.\n\n' +
  others;
const summaryPath = harPath.replace(/\.har$/, '.summary.txt');
await writeFile(summaryPath, summary + '\n', { mode: 0o600 });

console.log(`\nSaved ${harPath}\nCandidate API calls (writes first), then other hosts:\n`);
console.log(summary);
console.log(`\nSummary written to ${summaryPath}. Next: docs/ENDPOINT-CAPTURE.md, step 2.`);
