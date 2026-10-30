import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChromeApi, MessageSender, Port } from '../extension/src/chrome.js';
import { OLX_SIGN_IN_URL, createConnectService } from '../extension/src/core.js';
import { buildExtension, extensionIdFromKey, iconPng, normalizePublicKey, parseOrigins } from '../scripts/build-extension.js';
import { OLX_CONNECT_EXTENSION_ID, isOlxConnectAvailable, requestOlxToken } from '../src/connect/index.js';
import { readResult } from '../src/connect/protocol.js';

const SITE = 'https://www.zaytounsolutions.com';
const EXT = 'chrome-extension://ext-id/';
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.c2ln`;
const freshToken = () =>
  jwt({ sub: 'acc-1', first_name: 'Zaytoun', last_name: 'Store', exp: Math.floor(Date.now() / 1000) + 365 * 86_400 });
const expiredToken = () => jwt({ sub: 'acc-1', exp: Math.floor(Date.now() / 1000) - 60 });

type Listener<A extends unknown[]> = (...args: A) => void;

/** One end of a message channel, shaped like Chrome's Port. */
class FakePort implements Port {
  other!: FakePort;
  connected = true;
  posted: unknown[] = [];
  private messageListeners: Array<Listener<[unknown, Port]>> = [];
  private disconnectListeners: Array<Listener<[Port]>> = [];
  constructor(
    public name: string,
    public sender?: MessageSender,
  ) {}
  onMessage = { addListener: (cb: Listener<[unknown, Port]>) => void this.messageListeners.push(cb) };
  onDisconnect = { addListener: (cb: Listener<[Port]>) => void this.disconnectListeners.push(cb) };
  postMessage(message: unknown): void {
    if (!this.connected) throw new Error('Attempting to use a disconnected port object');
    this.posted.push(message);
    const target = this.other;
    queueMicrotask(() => {
      if (target.connected) for (const cb of target.messageListeners) cb(structuredClone(message), target);
    });
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    const target = this.other;
    queueMicrotask(() => {
      if (!target.connected) return;
      target.connected = false;
      for (const cb of target.disconnectListeners) cb(target);
    });
  }
}

function channel(name: string, origin: string): { page: FakePort; ext: FakePort } {
  const page = new FakePort(name);
  const ext = new FakePort(name, { origin, url: `${origin}/admin` });
  page.other = ext;
  ext.other = page;
  return { page, ext };
}

/** A fake browser around one OLX Connect service. */
function fakeBrowser(allowedOrigins = [SITE]) {
  const cookies = new Map<string, string>();
  const windows = new Map<number, string>();
  let nextWindow = 1;
  const created: string[] = [];
  const chrome: ChromeApi = {
    runtime: {
      id: 'ext-id',
      getURL: (p) => EXT + p,
      getManifest: () => ({ version: '9.9.9' }),
      onMessage: { addListener: () => {} },
      onMessageExternal: { addListener: () => {} },
      onConnectExternal: { addListener: () => {} },
    },
    cookies: {
      get: async ({ name }) => {
        const value = cookies.get(name);
        return value === undefined ? null : { name, value, domain: 'www.olx.com.lb', path: '/' };
      },
      onChanged: { addListener: () => {} },
    },
    windows: {
      create: async ({ url }) => {
        const id = nextWindow++;
        windows.set(id, url);
        created.push(url);
        return { id };
      },
      remove: async (id) => {
        if (!windows.delete(id)) throw new Error('No window with id');
        queueMicrotask(() => service.onWindowRemoved(id));
      },
      onRemoved: { addListener: () => {} },
    },
  };
  // `chrome.windows.remove` above calls back into the service, as Chrome does.
  const service = createConnectService({ chrome, allowedOrigins, settleMs: 50 });

  const browser = {
    service,
    cookies,
    windows,
    created,
    /** The page opens a port, as `chrome.runtime.connect` does. */
    connect(origin = SITE, name = 'olx-connect') {
      const { page, ext } = channel(name, origin);
      service.onConnectExternal(ext);
      return page;
    },
    /** The person clicks in the confirmation window. */
    decide(allow: boolean, sender: MessageSender = { id: 'ext-id', url: EXT + 'confirm.html#x' }) {
      const reply = vi.fn();
      const id = service.activeRequest?.id ?? 'none';
      service.onMessage({ type: 'olx-connect/decision', requestId: id, allow }, sender, reply);
      return reply;
    },
    /** The person signs in to OLX: OLX sets its cookies. */
    signIn(token = freshToken(), refresh = 'refresh-1') {
      cookies.set('accessToken', token);
      cookies.set('refreshToken', refresh);
      for (const name of ['accessToken', 'refreshToken']) {
        service.onCookieChanged({
          removed: false,
          cause: 'explicit',
          cookie: { name, value: '', domain: 'www.olx.com.lb', path: '/' },
        });
      }
    },
    /** The person closes a window. */
    close(id: number) {
      windows.delete(id);
      service.onWindowRemoved(id);
    },
    /** `chrome.runtime` as a web page on `origin` sees it. */
    pageRuntime(origin = SITE) {
      const runtime = {
        lastError: undefined as { message: string } | undefined,
        sendMessage(extensionId: string, message: unknown, callback: (r: unknown) => void) {
          queueMicrotask(() => {
            if (extensionId !== 'ext-id') {
              runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
              callback(undefined);
              runtime.lastError = undefined;
              return;
            }
            service.onMessageExternal(message, { origin, url: origin + '/' }, (r) => callback(r));
          });
        },
        connect(extensionId: string, info: { name: string }) {
          if (extensionId !== 'ext-id') throw new Error('Could not establish connection');
          return browser.connect(origin, info.name);
        },
      };
      return runtime;
    },
  };
  return browser;
}

const tick = () => vi.advanceTimersByTimeAsync(0);
const request = (port: FakePort, nonce = 'nonce-123456', timeoutMs?: number) =>
  port.postMessage({ type: 'olx-connect/request', v: 1, nonce, timeoutMs });
const results = (port: FakePort) => port.other.posted;

describe('OLX Connect extension', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the person, opens OLX, waits for the sign-in, answers with the tokens and closes the pop-up', async () => {
    const b = fakeBrowser();
    const page = b.connect();
    request(page);
    await tick();
    expect(b.created).toHaveLength(1);
    expect(b.created[0]).toBe(`${EXT}confirm.html#id=${b.service.activeRequest!.id}&origin=${encodeURIComponent(SITE)}`);
    expect(b.decide(true)).toHaveBeenCalledWith({ ok: true });
    await tick();
    expect(b.created[1]).toBe(OLX_SIGN_IN_URL);
    expect(b.windows.size).toBe(1); // the confirmation window was closed
    expect(results(page)).toEqual([]);

    const token = freshToken();
    b.signIn(token, 'refresh-1');
    await vi.advanceTimersByTimeAsync(60);
    expect(results(page)).toEqual([
      {
        type: 'olx-connect/result',
        v: 1,
        nonce: 'nonce-123456',
        ok: true,
        token,
        refreshToken: 'refresh-1',
        expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        account: { id: 'acc-1', name: 'Zaytoun Store' },
      },
    ]);
    expect(b.windows.size).toBe(0);
    expect(b.service.activeRequest).toBeNull();
  });

  it('uses a valid sign-in that already exists, after the confirmation, without opening OLX', async () => {
    const b = fakeBrowser();
    b.cookies.set('accessToken', freshToken());
    const page = b.connect();
    request(page);
    await tick();
    expect(results(page)).toEqual([]); // nothing before the person allows it
    b.decide(true);
    await tick();
    expect(b.created).toHaveLength(1);
    expect(results(page)).toMatchObject([{ ok: true, refreshToken: null, nonce: 'nonce-123456' }]);
  });

  it('never hands over an expired or malformed token', async () => {
    const b = fakeBrowser();
    b.cookies.set('accessToken', expiredToken());
    const page = b.connect();
    request(page);
    await tick();
    b.decide(true);
    await tick();
    expect(b.created[1]).toBe(OLX_SIGN_IN_URL);
    b.signIn('not-a-jwt-but-long-enough-to-pass', 'r');
    await vi.advanceTimersByTimeAsync(60);
    expect(results(page)).toEqual([]);
    b.close(2);
    await tick();
    expect(results(page)).toMatchObject([{ ok: false, reason: 'not_signed_in' }]);
  });

  it('declining, or closing either window, answers cancelled', async () => {
    let b = fakeBrowser();
    let page = b.connect();
    request(page);
    await tick();
    b.decide(false);
    await tick();
    expect(results(page)).toMatchObject([{ ok: false, reason: 'cancelled' }]);
    expect(b.windows.size).toBe(0);

    b = fakeBrowser();
    page = b.connect();
    request(page);
    await tick();
    b.close(1);
    await tick();
    expect(results(page)).toMatchObject([{ ok: false, reason: 'cancelled' }]);

    b = fakeBrowser();
    page = b.connect();
    request(page);
    await tick();
    b.decide(true);
    await tick();
    b.close(2);
    await tick();
    expect(results(page)).toMatchObject([{ ok: false, reason: 'cancelled' }]);
  });

  it('closing the pop-up right after signing in still answers with the token', async () => {
    const b = fakeBrowser();
    const page = b.connect();
    request(page);
    await tick();
    b.decide(true);
    await tick();
    b.signIn();
    b.close(2); // before the settle delay
    await tick();
    expect(results(page)).toMatchObject([{ ok: true }]);
  });

  it('times out after the requested time (default 5 minutes) and closes its windows', async () => {
    const b = fakeBrowser();
    const page = b.connect();
    request(page);
    await tick();
    b.decide(true);
    await tick();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(results(page)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(results(page)).toMatchObject([{ ok: false, reason: 'timeout' }]);
    expect(b.windows.size).toBe(0);

    const b2 = fakeBrowser();
    const p2 = b2.connect();
    request(p2, 'nonce-abcdefgh', 1); // below the 5 s minimum
    await vi.advanceTimersByTimeAsync(4_999);
    expect(results(p2)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(results(p2)).toMatchObject([{ reason: 'timeout' }]);
  });

  it('handles one request at a time: a second one gets busy', async () => {
    const b = fakeBrowser();
    const first = b.connect();
    request(first);
    await tick();
    const second = b.connect();
    request(second, 'nonce-second-1');
    await tick();
    expect(results(second)).toEqual([{ type: 'olx-connect/result', v: 1, nonce: 'nonce-second-1', ok: false, reason: 'busy' }]);
    expect(b.created).toHaveLength(1);
    expect(results(first)).toEqual([]);
  });

  it('answers not_allowed to any other origin, and opens nothing', async () => {
    const b = fakeBrowser();
    for (const origin of [
      'https://evil.example',
      'https://zaytounsolutions.com.evil.example',
      'http://www.zaytounsolutions.com',
    ]) {
      const page = b.connect(origin);
      request(page);
      await tick();
      expect(results(page)).toMatchObject([{ ok: false, reason: 'not_allowed', nonce: 'nonce-123456' }]);
      expect(page.connected).toBe(false);
    }
    expect(b.created).toEqual([]);
    const reply = vi.fn();
    b.service.onMessageExternal({ type: 'olx-connect/ping', v: 1 }, { origin: 'https://evil.example' }, reply);
    expect(reply).toHaveBeenCalledWith({ ok: false, reason: 'not_allowed' });
    b.service.onMessageExternal({ type: 'olx-connect/ping', v: 1 }, { origin: SITE }, reply);
    expect(reply).toHaveBeenLastCalledWith({ ok: true, version: '9.9.9' });
  });

  it('ignores decisions that are not from its own confirmation page or not for the current request', async () => {
    const b = fakeBrowser();
    b.cookies.set('accessToken', freshToken());
    const page = b.connect();
    request(page);
    await tick();
    b.decide(true, { id: 'other-extension', url: EXT + 'confirm.html' });
    b.decide(true, { id: 'ext-id', url: 'https://www.zaytounsolutions.com/' });
    const stale = vi.fn();
    b.service.onMessage(
      { type: 'olx-connect/decision', requestId: 'old-request', allow: true },
      { id: 'ext-id', url: EXT + 'confirm.html' },
      stale,
    );
    await tick();
    expect(stale).toHaveBeenCalledWith({ ok: false });
    expect(results(page)).toEqual([]);
    expect(b.service.activeRequest?.stage).toBe('confirm');
  });

  it('stops quietly when the page goes away, and ignores malformed requests and other ports', async () => {
    const b = fakeBrowser();
    const page = b.connect();
    request(page);
    await tick();
    page.disconnect();
    await tick();
    expect(b.service.activeRequest).toBeNull();
    expect(b.windows.size).toBe(0);

    const bad = b.connect();
    bad.postMessage({ type: 'olx-connect/request', v: 1, nonce: 'short' });
    bad.postMessage({ type: 'olx-connect/request', v: 2, nonce: 'nonce-123456' });
    await tick();
    expect(b.created).toHaveLength(1);
    expect(b.service.activeRequest).toBeNull();

    const other = b.connect(SITE, 'something-else');
    await tick();
    expect(other.connected).toBe(false);
  });

  it('ignores cookies of other sites and removals', async () => {
    const b = fakeBrowser();
    const page = b.connect();
    request(page);
    await tick();
    b.decide(true);
    await tick();
    b.cookies.set('accessToken', freshToken());
    b.service.onCookieChanged({
      removed: false,
      cause: 'x',
      cookie: { name: 'accessToken', value: '', domain: 'olx.com.lb.evil.example', path: '/' },
    });
    b.service.onCookieChanged({
      removed: true,
      cause: 'x',
      cookie: { name: 'accessToken', value: '', domain: 'www.olx.com.lb', path: '/' },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(results(page)).toEqual([]);
  });
});

describe('olx-lebanon-sdk/connect', () => {
  const g = globalThis as { chrome?: unknown };
  afterEach(() => {
    delete g.chrome;
    vi.useRealTimers();
  });

  it('reports not installed when the page has no extension runtime', async () => {
    expect(await isOlxConnectAvailable()).toEqual({ installed: false });
    expect(await requestOlxToken()).toEqual({ ok: false, reason: 'not_installed' });
  });

  it('reports not installed when the extension does not answer', async () => {
    const b = fakeBrowser();
    g.chrome = { runtime: b.pageRuntime() };
    expect(await isOlxConnectAvailable()).toEqual({ installed: false }); // the default id is not 'ext-id'
    expect(await requestOlxToken({ extensionId: 'missing' })).toEqual({ ok: false, reason: 'not_installed' });
  });

  it('gets a token end to end, and detects the extension', async () => {
    const b = fakeBrowser();
    g.chrome = { runtime: b.pageRuntime() };
    expect(await isOlxConnectAvailable({ extensionId: 'ext-id' })).toEqual({ installed: true, version: '9.9.9' });
    const pending = requestOlxToken({ extensionId: 'ext-id' });
    await vi.waitFor(() => expect(b.service.activeRequest?.stage).toBe('confirm'));
    b.decide(true);
    await vi.waitFor(() => expect(b.service.activeRequest?.stage).toBe('signin'));
    const token = freshToken();
    b.signIn(token);
    await expect(pending).resolves.toEqual({
      ok: true,
      token,
      refreshToken: 'refresh-1',
      expiresAt: expect.any(String),
      account: { id: 'acc-1', name: 'Zaytoun Store' },
    });
  });

  it('passes the extension’s failure reasons through, and not_allowed from another origin', async () => {
    const b = fakeBrowser();
    g.chrome = { runtime: b.pageRuntime() };
    const pending = requestOlxToken({ extensionId: 'ext-id' });
    await vi.waitFor(() => expect(b.service.activeRequest).not.toBeNull());
    b.decide(false);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });

    g.chrome = { runtime: b.pageRuntime('https://evil.example') };
    await expect(requestOlxToken({ extensionId: 'ext-id' })).resolves.toEqual({ ok: false, reason: 'not_allowed' });
    expect(b.created).toHaveLength(1);
  });

  it('cancels when the signal aborts, and the extension closes its windows', async () => {
    const b = fakeBrowser();
    g.chrome = { runtime: b.pageRuntime() };
    const ctl = new AbortController();
    const pending = requestOlxToken({ extensionId: 'ext-id', signal: ctl.signal });
    await vi.waitFor(() => expect(b.service.activeRequest).not.toBeNull());
    ctl.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' });
    await vi.waitFor(() => expect(b.service.activeRequest).toBeNull());
    expect(b.windows.size).toBe(0);
  });

  it('sends keepalives while waiting, and gives up a little after the timeout', async () => {
    vi.useFakeTimers();
    const b = fakeBrowser();
    g.chrome = { runtime: b.pageRuntime() };
    const pending = requestOlxToken({ extensionId: 'ext-id', timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(b.service.activeRequest).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('readResult accepts only a well-formed result for its own nonce', () => {
    const base = { type: 'olx-connect/result', v: 1, nonce: 'n-12345678' };
    expect(readResult({ ...base, ok: false, reason: 'busy' }, 'n-12345678')).toEqual({ ok: false, reason: 'busy' });
    expect(readResult({ ...base, ok: false, reason: 'weird' }, 'n-12345678')).toEqual({ ok: false, reason: 'cancelled' });
    expect(readResult({ ...base, ok: false, reason: 'busy' }, 'other-nonce')).toBeNull();
    expect(readResult({ ...base, ok: true, token: '' }, 'n-12345678')).toBeNull();
    expect(readResult({ ...base, ok: true, token: 'x'.repeat(30), account: { id: 1 } }, 'n-12345678')).toEqual({
      ok: true,
      token: 'x'.repeat(30),
      refreshToken: null,
      expiresAt: null,
      account: null,
    });
  });

  it('the browser entry imports nothing from Node.js', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const [, spec] of src.matchAll(/from\s+'([^']+)'/g)) {
        expect(spec).not.toMatch(/^node:|^(fs|path|crypto|os|url|zlib|buffer)$/);
        if (spec!.startsWith('.')) visit(join(file, '..', spec!.replace(/\.js$/, '.ts')));
      }
    };
    visit(join(import.meta.dirname, '../src/connect/index.ts'));
    expect(seen.size).toBe(3);
  });
});

describe('extension build', () => {
  const official = readFileSync(join(import.meta.dirname, '../extension/key.pub'), 'utf8');

  it('the committed public key gives the published extension id', () => {
    expect(extensionIdFromKey(normalizePublicKey(official))).toBe(OLX_CONNECT_EXTENSION_ID);
  });

  it('accepts exact https origins only (http for localhost)', () => {
    expect(parseOrigins('https://www.zaytounsolutions.com, https://zaytounsolutions.com/')).toEqual([
      'https://www.zaytounsolutions.com',
      'https://zaytounsolutions.com',
    ]);
    expect(parseOrigins(['http://localhost:3000'])).toEqual(['http://localhost:3000']);
    expect(() => parseOrigins('')).toThrow(/at least one/);
    expect(() => parseOrigins('https://*.example.com')).toThrow(/Wildcards/);
    expect(() => parseOrigins('http://example.com')).toThrow(/https/);
    expect(() => parseOrigins('https://example.com/admin')).toThrow(/origin only/);
    expect(() => parseOrigins('example.com')).toThrow();
  });

  it('builds a Manifest V3 extension with minimal permissions and the fixed key', async () => {
    const out = mkdtempSync(join(tmpdir(), 'olx-connect-'));
    try {
      const { id } = await buildExtension({ origins: [SITE, 'http://localhost:3000'], publicKey: official, outDir: out });
      expect(id).toBe(OLX_CONNECT_EXTENSION_ID);
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({
        manifest_version: 3,
        name: 'OLX Connect',
        permissions: ['cookies'],
        host_permissions: ['https://*.olx.com.lb/*'],
        background: { service_worker: 'background.js', type: 'module' },
        externally_connectable: { matches: [`${SITE}/*`, 'http://localhost:3000/*'] },
        key: normalizePublicKey(official),
      });
      expect(Object.keys(manifest)).not.toContain('content_scripts');
      expect(Object.keys(manifest)).not.toContain('web_accessible_resources');
      expect(readdirSync(out).sort()).toEqual([
        'background.js',
        'confirm.css',
        'confirm.html',
        'confirm.js',
        'icons',
        'manifest.json',
      ]);
      const background = readFileSync(join(out, 'background.js'), 'utf8');
      expect(background).toMatch(
        /define_OLX_CONNECT_ALLOWED_ORIGINS_default = \[\s*"https:\/\/www\.zaytounsolutions\.com",\s*"http:\/\/localhost:3000"\s*\]/,
      );
      expect(background).not.toMatch(/console\.|localStorage|chrome\.storage/);

      const store = await buildExtension({ origins: [SITE], publicKey: official, store: true, outDir: out });
      expect(store.id).toBeNull();
      expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).key).toBeUndefined();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('draws valid PNG icons', () => {
    const png = iconPng(16);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(16);
  });
});
