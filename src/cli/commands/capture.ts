import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../config.js';
import { loadPlaywright } from '../../session/SessionManager.js';
import { FileSessionStore } from '../../session/storage.js';
import { formatHarSummary, formatHostActivity, summarizeHar, tallyHosts, type HarLike } from '../../tools/har.js';
import { buildShapeReport, type HarFull } from '../../tools/harShapes.js';
import type { Command } from '../index.js';
import { CliError, parseFlags, resolveFrom, type CliContext } from '../util.js';

async function shapes(ctx: CliContext, harArg?: string): Promise<void> {
  const config = loadConfig();
  const hosts = [new URL(config.baseUrl).hostname.toLowerCase().replace(/^www\./, ''), ...config.extraHosts];
  const dir = resolveFrom(ctx, 'captures');
  let harPath = harArg ? resolveFrom(ctx, harArg) : undefined;
  if (!harPath) {
    const hars = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.har')).sort();
    if (!hars.length) throw new CliError('No .har files in captures/. Run `olx-lb capture` first.');
    harPath = join(dir, hars[hars.length - 1]!);
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
  ctx.out(`Wrote ${base}.shapes.txt`);
  ctx.out(`Wrote ${Object.keys(publicData).length} public catalog file(s) to ${base}.public/`);
  ctx.out('Skim them before sharing. Never share the .har.');
}

async function record(ctx: CliContext): Promise<void> {
  const config = loadConfig();
  const { chromium } = await loadPlaywright();
  const domains = [new URL(config.baseUrl).hostname.toLowerCase().replace(/^www\./, ''), ...config.extraHosts];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Anchored on the URL's host, so `https://accounts.google.com/?redirect_uri=https://www.olx.com.lb` is NOT recorded.
  const hostPattern = new RegExp(`^https?://([^/?#@]+\\.)?(${domains.map(escape).join('|')})(:\\d+)?([/?#]|$)`, 'i');
  const isRecordedHost = (host: string) => domains.some((d) => host === d || host.endsWith('.' + d));

  const dir = resolveFrom(ctx, 'captures');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {}); // no-op on Windows
  const harPath = join(dir, `olx-flow-${new Date().toISOString().replace(/[:.]/g, '-')}.har`);

  // Start signed in with the session saved by `olx-lb login` (OLX cookies and storage only).
  const saved = await new FileSessionStore(resolveFrom(ctx, config.sessionFile)).load().catch(() => null);
  const storageState = saved
    ? {
        cookies: saved.cookies.map((c) => ({
          ...c,
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? false,
          sameSite: (['Strict', 'Lax', 'None'].find((v) => v.toLowerCase() === (c.sameSite ?? '').toLowerCase()) ?? 'Lax') as
            'Strict' | 'Lax' | 'None',
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

  ctx.out(`Recording requests to: ${domains.join(', ')}`);
  ctx.out('In the browser window, do by hand what you want recorded (e.g. post, edit or delete an ad).');
  ctx.out(saved ? 'You should already be signed in; sign in if not.' : 'Sign in first.');
  await ctx.ask('\nPress Enter here when you are done… ');

  await context.close(); // flushes the HAR
  await browser.close();
  await chmod(harPath, 0o600).catch(() => {});

  const har = JSON.parse(await readFile(harPath, 'utf8')) as HarLike;
  const summary =
    formatHarSummary(summarizeHar(har, (host) => isRecordedHost(host.toLowerCase()))) +
    '\n\nOther hosts the page contacted (NOT recorded; hostnames and counts only):\n' +
    'Hosts with POST/PUT/PATCH/DELETE are the likely API or upload hosts: add them to OLX_EXTRA_HOSTS.\n\n' +
    formatHostActivity(tallyHosts(seen, isRecordedHost));
  const summaryPath = harPath.replace(/\.har$/, '.summary.txt');
  await writeFile(summaryPath, summary + '\n', { mode: 0o600 });
  ctx.out(`\nSaved ${harPath} (secret: never share it)\n\n${summary}\n\nSummary: ${summaryPath}`);
  ctx.out('Next: `olx-lb capture shapes` for request and response bodies with personal values masked.');
}

export const capture: Command = {
  summary: 'Record the OLX website while you use it, to map a format OLX has changed',
  usage: `Usage:
  olx-lb capture                 open a browser and record what the OLX website sends
  olx-lb capture shapes [file]   write a redacted report of the latest (or given) capture

For maintainers: when OLX changes its website and posting starts failing, this shows the
new requests. Files go to captures/. The .har holds your password and tokens: never share
it. The .summary.txt, .shapes.txt and .public/ files are redacted and meant to be shared.
See docs/ENDPOINT-CAPTURE.md.`,

  async run(args, ctx) {
    const { positionals } = parseFlags(args, {});
    if (positionals[0] === 'shapes') return void (await shapes(ctx, positionals[1]));
    if (positionals.length) throw new CliError(`Unknown capture step "${positionals[0]}"`, 2);
    await record(ctx);
  },
};
