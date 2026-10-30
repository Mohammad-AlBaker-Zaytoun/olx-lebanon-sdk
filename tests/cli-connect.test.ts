import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectCommand, pairUrl, pairingCode, sendToSite } from '../src/cli/commands/connect.js';
import { main } from '../src/cli/index.js';
import type { CliContext } from '../src/cli/util.js';
import type { SessionData } from '../src/session/storage.js';
import { jsonResponse } from './helpers.js';

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt = (expInDays: number) =>
  `${b64url({ alg: 'RS256' })}.${b64url({ sub: 'acc-1', exp: Math.floor(Date.now() / 1000) + expInDays * 86_400 })}.c2ln`;

function ctx(answers: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const c: CliContext = {
    cwd: mkdtempSync(join(tmpdir(), 'olx-cli-')),
    debug: false,
    out: (l = '') => out.push(l),
    err: (l = '') => err.push(l),
    ask: async () => answers.shift() ?? '',
  };
  return { c, out, err };
}

const signedIn = (token = jwt(365)): SessionData => ({
  cookies: [
    { name: 'accessToken', value: token, domain: 'www.olx.com.lb', path: '/', expires: -1, httpOnly: true },
    { name: 'refreshToken', value: 'refresh-1', domain: 'www.olx.com.lb', path: '/', expires: -1, httpOnly: true },
  ],
  headers: { authorization: `Bearer ${token}` },
  savedAt: new Date().toISOString(),
});

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('olx-lb connect', () => {
  it('signs in, sends { code, token, refreshToken } to the site and prints its answer', async () => {
    const token = jwt(365);
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ ok: true, account: { name: 'Zaytoun Store' } }),
    );
    const cmd = createConnectCommand({ signIn: async () => signedIn(token), fetch });
    const t = ctx(['y']);
    expect(await cmd.run(['https://www.zaytounsolutions.com/', '--code', 'AB12CD34'], t.c)).toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://www.zaytounsolutions.com/api/admin/olx-connection/pair');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(JSON.parse(init.body as string)).toEqual({ code: 'AB12CD34', token, refreshToken: 'refresh-1' });
    expect(t.out.join('\n')).toMatch(/Connected the OLX account "Zaytoun Store" to www\.zaytounsolutions\.com/);
    expect(t.out.join('\n')).not.toContain(token);
  });

  it('prints why a code was refused', async () => {
    for (const [reason, message] of [
      ['code_invalid', /wrong or was already used/],
      ['code_expired', /expired \(codes last 10 minutes\)/],
      ['token_rejected', /could not use this OLX sign-in/],
      ['something_new', /refused the sign-in \(something_new\)/],
    ] as const) {
      const cmd = createConnectCommand({
        signIn: async () => signedIn(),
        fetch: async () => jsonResponse({ ok: false, reason }, 400),
      });
      await expect(cmd.run(['https://example.com', '--code', 'AB12CD34', '--yes'], ctx().c)).rejects.toThrow(message);
    }
  });

  it('asks first, and signs in only after a yes', async () => {
    const signIn = vi.fn(async () => signedIn());
    const cmd = createConnectCommand({ signIn, fetch: async () => jsonResponse({ ok: true }) });
    expect(await cmd.run(['https://example.com', '--code', 'AB12CD34'], ctx(['n']).c)).toBe(1);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('refuses http (except localhost), bad codes and missing arguments before signing in', async () => {
    const signIn = vi.fn(async () => signedIn());
    const t = ctx();
    const run = (args: string[]) => main(['connect', ...args, '--env-file', join(t.c.cwd, '.env')], t.c);
    writeFileSync(join(t.c.cwd, '.env'), '');
    expect(await run(['http://example.com', '--code', 'AB12CD34', '--yes'])).toBe(2);
    expect(await run(['https://example.com', '--yes'])).toBe(2);
    expect(await run(['https://example.com', '--code', 'AB 12', '--yes'])).toBe(2);
    expect(await run(['--code', 'AB12CD34'])).toBe(2);
    expect(await run(['https://example.com?x=1', '--code', 'AB12CD34'])).toBe(2);
    expect(t.err.join('\n')).toMatch(/must start with https/);
    expect(signIn).not.toHaveBeenCalled();
    expect(pairUrl('http://localhost:3000').toString()).toBe('http://localhost:3000/api/admin/olx-connection/pair');
    expect(pairUrl('https://example.com/shop/').toString()).toBe('https://example.com/shop/api/admin/olx-connection/pair');
    expect(pairingCode(' AB12CD34 ')).toBe('AB12CD34');
  });

  it('does not send anything if the sign-in has no token or an expired one', async () => {
    const fetch = vi.fn();
    const none = createConnectCommand({ signIn: async () => ({ cookies: [], headers: {}, savedAt: '' }), fetch });
    await expect(none.run(['https://example.com', '--code', 'AB12CD34', '--yes'], ctx().c)).rejects.toThrow(/No OLX sign-in/);
    const old = createConnectCommand({ signIn: async () => signedIn(jwt(-1)), fetch });
    await expect(old.run(['https://example.com', '--code', 'AB12CD34', '--yes'], ctx().c)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never follows a redirect, and explains odd answers', async () => {
    const url = pairUrl('https://example.com');
    const payload = { code: 'AB12CD34', token: 't'.repeat(30), refreshToken: null };
    await expect(
      sendToSite(url, payload, async () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } })),
    ).rejects.toThrow(/redirect to https:\/\/evil\.example\/; nothing was sent there/);
    await expect(sendToSite(url, payload, async () => new Response('<html>', { status: 404 }))).rejects.toThrow(
      /HTTP 404 without a pairing answer/,
    );
    await expect(
      sendToSite(url, payload, async () => {
        throw new TypeError('getaddrinfo ENOTFOUND');
      }),
    ).rejects.toThrow(/Could not reach https:\/\/example\.com/);
  });

  it('is listed in the help', async () => {
    const t = ctx();
    expect(await main(['help'], t.c)).toBe(0);
    expect(t.out.join('\n')).toMatch(/connect\s+Sign in to OLX and send the sign-in straight to your website/);
  });
});

describe('olx-lb token --json', () => {
  it('prints the access token, refresh token and expiry', async () => {
    const t = ctx();
    const token = jwt(300);
    const file = join(t.c.cwd, 'session.json');
    writeFileSync(file, JSON.stringify(signedIn(token)));
    writeFileSync(join(t.c.cwd, '.env'), `OLX_SESSION_FILE=${file.replace(/\\/g, '/')}\n`);
    expect(await main(['token', '--json', '--yes'], t.c)).toBe(0);
    const printed = JSON.parse(t.out.join('\n'));
    expect(printed).toEqual({ accessToken: token, refreshToken: 'refresh-1', expiresAt: expect.stringMatching(/^\d{4}-/) });
  });
});
