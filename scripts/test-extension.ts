/**
 * End-to-end check of the OLX Connect extension in a real Chromium, with OLX replaced by a stub
 * (no network, no OLX account). Needs Playwright's Chromium and a build of the package:
 *
 *   npm run build && npm run test:extension
 *
 * It loads the extension built for a local test origin, serves a page that uses
 * `olx-lebanon-sdk/connect`, and checks: detection, a full sign-in, an existing sign-in,
 * declining, closing the pop-up, busy, timeout, and that another origin gets nothing.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import { loadPlaywright } from '../src/session/playwright.js';
import { buildExtension } from './build-extension.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OLX = 'https://www.olx.com.lb';

function serve(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><title>test</title><script type="module">import * as c from '/dist/connect/index.js'; window.olxConnect = c; document.title = 'ready';</script>`,
      );
      return;
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(join(ROOT, 'dist'))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok({ server, port: (server.address() as { port: number }).port })),
  );
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const fakeToken = (expInSec: number) =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    sub: 'stub-account',
    first_name: 'Test',
    last_name: 'Store',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expInSec,
  })}.c3R1Yg`;

async function signIn(context: BrowserContext, token = fakeToken(365 * 86_400), refresh = 'stub-refresh-token') {
  await context.addCookies([
    { name: 'accessToken', value: token, url: OLX + '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'refreshToken', value: refresh, url: OLX + '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
}

function check(ok: boolean, what: string, got?: { ok: boolean; reason?: string }): void {
  if (!ok) throw new Error(`FAILED: ${what}${got ? ` (got ${got.ok ? 'ok: true' : `reason: ${got.reason}`})` : ''}`);
  console.log(`  ok  ${what}`);
}

type Result = {
  ok: boolean;
  reason?: string;
  token?: string;
  refreshToken?: string | null;
  account?: unknown;
  expiresAt?: string | null;
};

async function main(): Promise<void> {
  const { chromium } = await loadPlaywright();
  const { server, port } = await serve();
  const allowed = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'olx-connect-e2e-'));
  const extDir = join(dir, 'extension');
  const { id } = await buildExtension({
    origins: [allowed],
    publicKey: readFileSync(join(ROOT, 'extension/key.pub'), 'utf8'),
    outDir: extDir,
  });
  const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    await context.route(`${OLX}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>OLX stub</title><h1>OLX (stub)</h1>' }),
    );
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    check(worker.url() === `chrome-extension://${id}/background.js`, `extension loaded with the fixed id ${id}`);

    const open = async (origin: string): Promise<Page> => {
      const page = await context.newPage();
      await page.goto(origin + '/');
      await page.waitForFunction(() => document.title === 'ready');
      return page;
    };
    const ask = (page: Page, timeoutMs = 30_000) =>
      page.evaluate(
        ([extensionId, t]) =>
          (window as unknown as { olxConnect: { requestOlxToken(o: object): Promise<unknown> } }).olxConnect.requestOlxToken({
            extensionId,
            timeoutMs: t,
          }),
        [id, timeoutMs] as const,
      ) as Promise<Result>;
    const nextPage = (prefix: string) =>
      context.waitForEvent('page', { predicate: (p) => p.url().startsWith(prefix), timeout: 10_000 });
    const confirmUrl = `chrome-extension://${id}/confirm.html`;

    const site = await open(allowed);
    const available = (await site.evaluate(
      (extensionId) =>
        (
          window as unknown as { olxConnect: { isOlxConnectAvailable(o: object): Promise<unknown> } }
        ).olxConnect.isOlxConnectAvailable({
          extensionId,
        }),
      id,
    )) as { installed: boolean; version?: string };
    check(
      available.installed && typeof available.version === 'string',
      `detected from ${allowed} (version ${available.version})`,
    );

    // 1. Full flow: confirm, OLX pop-up, sign-in, answer, pop-up closed.
    let confirm = nextPage(confirmUrl);
    let pending = ask(site);
    let win = await confirm;
    await win.waitForLoadState();
    check((await win.textContent('#origin')) === allowed, 'the confirmation names the asking origin');
    const popup = nextPage(OLX);
    await win.click('#allow');
    const olx = await popup;
    check(olx.url().startsWith(`${OLX}/?login=true`), 'OLX opens in a pop-up on its sign-in dialog');
    const token = fakeToken(365 * 86_400);
    await signIn(context, token);
    let result = await pending;
    check(
      result.ok && result.token === token && result.refreshToken === 'stub-refresh-token',
      'answers with the signed-in tokens',
    );
    check(
      JSON.stringify(result.account) === JSON.stringify({ id: 'stub-account', name: 'Test Store' }),
      'answers with the account',
    );
    if (!olx.isClosed()) await olx.waitForEvent('close', { timeout: 5_000 });
    check(olx.isClosed(), 'closes the OLX pop-up');

    // 2. Already signed in: no pop-up after the confirmation.
    confirm = nextPage(confirmUrl);
    pending = ask(site);
    win = await confirm;
    await win.click('#allow');
    result = await pending;
    check(result.ok && result.token === token, 'uses the existing sign-in after the confirmation');

    // 3. Declined.
    confirm = nextPage(confirmUrl);
    pending = ask(site);
    await (await confirm).click('#deny');
    result = await pending;
    check(!result.ok && result.reason === 'cancelled', 'declining answers cancelled');

    // 4. Pop-up closed without signing in (and a stale token is never handed over).
    // The stale cookie is set once the pop-up is open: loading an OLX page can clear it.
    await context.clearCookies();
    confirm = nextPage(confirmUrl);
    pending = ask(site);
    const popup2 = nextPage(OLX);
    await (await confirm).click('#allow');
    const stale = await popup2;
    await signIn(context, fakeToken(-60));
    await new Promise((r) => setTimeout(r, 1_000));
    await stale.close();
    result = await pending;
    check(
      !result.ok && result.reason === 'not_signed_in',
      'closing the pop-up with an expired sign-in answers not_signed_in',
      result,
    );
    await context.clearCookies();
    confirm = nextPage(confirmUrl);
    pending = ask(site);
    const popup3 = nextPage(OLX);
    await (await confirm).click('#allow');
    await (await popup3).close();
    result = await pending;
    check(!result.ok && result.reason === 'cancelled', 'closing the pop-up without a sign-in answers cancelled');

    // 5. Busy, then timeout.
    const site2 = await open(allowed);
    confirm = nextPage(confirmUrl);
    pending = ask(site, 6_000);
    win = await confirm;
    const second = await ask(site2);
    check(!second.ok && second.reason === 'busy', 'a second request meanwhile answers busy');
    const started = Date.now();
    result = await pending;
    check(!result.ok && result.reason === 'timeout' && Date.now() - started < 8_000, 'times out after the requested time');
    check(
      win.isClosed() || (await win.waitForEvent('close', { timeout: 3_000 }).then(() => true)),
      'closes its window on timeout',
    );

    // 6. Another origin gets nothing and no window opens.
    const stranger = await open(other);
    const before = context.pages().length;
    result = await ask(stranger);
    check(!result.ok && (result.reason === 'not_installed' || result.reason === 'not_allowed'), `${other} gets ${result.reason}`);
    await new Promise((r) => setTimeout(r, 1_000));
    check(context.pages().length === before, 'no window opens for another origin');
    console.log('\nOLX Connect end-to-end: all checks passed');
  } finally {
    await context.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
