import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  OlxSdkError,
  createOlxClient,
  inspectAccessToken,
  refreshOlxTokens,
  type RefreshedSession,
} from '../src/index.js';
import { isFreshJwt } from '../src/session/token.js';
import { jsonResponse } from './helpers.js';

const DAY = 86_400;
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
/** A JWT shaped like OLX's (RS256, signature not checked by the SDK). */
function jwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
const token = (expInDays: number, extra: Record<string, unknown> = {}) =>
  jwt({ sub: 'user-1', iat: nowSec() - 300 * DAY, exp: nowSec() + expInDays * DAY, ...extra });

describe('inspectAccessToken', () => {
  it('reads expiry, issue date, account id and name from an OLX token', () => {
    const t = jwt({
      sub: 'a1b2c3',
      username: '+96170000000',
      first_name: 'محمد',
      last_name: 'Zaytoun',
      iss: 'auth-bridge-service',
      aud: 'prod-api',
      iat: 1_792_983_458,
      exp: 1_824_541_058,
    });
    const info = inspectAccessToken(t);
    expect(info).toEqual({
      wellFormed: true,
      expiresAt: new Date(1_824_541_058_000),
      issuedAt: new Date(1_792_983_458_000),
      subject: 'a1b2c3',
      name: 'محمد Zaytoun',
    });
    expect(inspectAccessToken(`Bearer ${t}`).expiresAt).toEqual(info.expiresAt);
    expect(inspectAccessToken(`  ${t}\n`).subject).toBe('a1b2c3');
  });

  it('gives null fields, not an error, for anything malformed', () => {
    const empty = { expiresAt: null, issuedAt: null, subject: null, name: null };
    expect(inspectAccessToken('')).toEqual({ wellFormed: false, ...empty });
    expect(inspectAccessToken('short')).toEqual({ wellFormed: false, ...empty });
    expect(inspectAccessToken('not a token at all, with spaces')).toEqual({ wellFormed: false, ...empty });
    expect(inspectAccessToken('aaaa.%%%%.bbbb-padding-to-twenty')).toEqual({ wellFormed: true, ...empty });
    expect(inspectAccessToken(`x.${b64url([1, 2])}.y-padding-to-twenty`)).toEqual({ wellFormed: true, ...empty });
    expect(inspectAccessToken(`x.${b64url({ exp: 'soon', iat: -1 })}.y-padding-twenty`)).toEqual({ wellFormed: true, ...empty });
    expect(inspectAccessToken('an-opaque-token-of-thirty-chars')).toEqual({ wellFormed: true, ...empty });
    expect(inspectAccessToken(undefined as unknown as string)).toEqual({ wellFormed: false, ...empty });
    expect(inspectAccessToken(42 as unknown as string)).toEqual({ wellFormed: false, ...empty });
  });

  it('isFreshJwt accepts only a readable token that has not expired', () => {
    expect(isFreshJwt(token(10))).toBe(true);
    expect(isFreshJwt(token(-1))).toBe(false);
    expect(isFreshJwt('an-opaque-token-of-thirty-chars')).toBe(false);
    expect(isFreshJwt(token(10), Date.now(), 11 * DAY * 1000)).toBe(false);
  });
});

describe('refreshOlxTokens', () => {
  it('posts the refresh token to the OLX sign-in service and returns the new pair', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ data: { token: 'new-access-token-123456789', refreshToken: 'new-refresh', externalID: 'u' } }),
    );
    expect(await refreshOlxTokens(' old-refresh ', { fetch })).toEqual({
      accessToken: 'new-access-token-123456789',
      refreshToken: 'new-refresh',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://auth-bridge-prod.olx-dubizzle.com/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'old-refresh' });
  });

  it('keeps the old refresh token when OLX returns none, and reads a top-level token', async () => {
    const fetch = async () => jsonResponse({ token: 'new-access-token-123456789' });
    expect(await refreshOlxTokens('old-refresh', { fetch })).toEqual({
      accessToken: 'new-access-token-123456789',
      refreshToken: 'old-refresh',
    });
  });

  it('throws auth_failed when OLX refuses, and a plain SDK error when OLX is down', async () => {
    const refused = refreshOlxTokens('r', { fetch: async () => jsonResponse({ message: 'invalid' }, 401) });
    await expect(refused).rejects.toBeInstanceOf(AuthError);
    await expect(refused).rejects.toMatchObject({ code: 'auth_failed', status: 401 });
    await expect(refreshOlxTokens('r', { fetch: async () => jsonResponse({ data: {} }) })).rejects.toMatchObject({
      code: 'auth_failed',
    });
    const down = refreshOlxTokens('r', { fetch: async () => new Response('bad gateway', { status: 502 }) });
    await expect(down).rejects.toBeInstanceOf(OlxSdkError);
    await expect(down).rejects.not.toBeInstanceOf(AuthError);
    await expect(
      refreshOlxTokens('r', {
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    ).rejects.toMatchObject({ code: 'sdk_error' });
    await expect(refreshOlxTokens('  ')).rejects.toMatchObject({ code: 'auth_failed' });
    await expect(refreshOlxTokens('r', { authUrl: 'http://example.com' })).rejects.toThrow(/https/);
  });
});

/** A fake OLX: `/api/v1/user` answers for the accepted tokens; `/auth/refresh` hands out new ones. */
function fakeOlx(opts: {
  accepted: Set<string>;
  issue?: () => { token: string; refreshToken?: string };
  refreshStatus?: number;
}) {
  const seen: string[] = [];
  let refreshes = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/refresh') {
      refreshes++;
      await new Promise((r) => setTimeout(r, 5));
      if (opts.refreshStatus) return jsonResponse({ message: 'no' }, opts.refreshStatus);
      const next = opts.issue!();
      opts.accepted.add(next.token);
      return jsonResponse({ data: next });
    }
    const auth = String((init.headers as Record<string, string>).authorization ?? '').replace(/^Bearer /, '');
    seen.push(auth);
    if (!opts.accepted.has(auth)) return jsonResponse({ message: 'Unauthorized' }, 401);
    if (u.pathname === '/api/v1/user') return jsonResponse({ data: { externalID: 'user-1', name: { en: 'Shop' } } });
    if (u.pathname === '/api/v1/user/wallet') return jsonResponse({ data: { balance: 0 } });
    return jsonResponse({}, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen, refreshes: () => refreshes };
}

describe('client token renewal', () => {
  it('renews a token close to expiry before the call, once, and reports the new pair', async () => {
    const old = token(10);
    const fresh = token(365);
    const olx = fakeOlx({ accepted: new Set([old]), issue: () => ({ token: fresh, refreshToken: 'r2' }) });
    const saved: RefreshedSession[] = [];
    const client = createOlxClient({
      accessToken: old,
      refreshToken: 'r1',
      fetch: olx.fetch,
      onSessionRefreshed: (s) => {
        saved.push(s);
      },
    });
    await Promise.all([client.account.profile(), client.account.wallet(), client.account.wallet()]);
    expect(olx.refreshes()).toBe(1);
    expect(olx.seen.every((t) => t === fresh)).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accessToken: fresh, refreshToken: 'r2' });
    expect(saved[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 300 * DAY * 1000);
    await client.account.wallet();
    expect(olx.refreshes()).toBe(1);
  });

  it('does not renew a token far from expiry, unless it is older than afterDays', async () => {
    const t = token(200);
    const olx = fakeOlx({ accepted: new Set([t]), issue: () => ({ token: token(365) }) });
    const client = createOlxClient({ accessToken: t, refreshToken: 'r1', fetch: olx.fetch });
    await client.account.wallet();
    expect(olx.refreshes()).toBe(0);
    const weekly = createOlxClient({ accessToken: t, refreshToken: 'r1', fetch: olx.fetch, refresh: { afterDays: 7 } });
    await weekly.account.wallet();
    expect(olx.refreshes()).toBe(1);
  });

  it('after a 401, renews once and retries the request with the new token', async () => {
    const rejected = token(200);
    const fresh = token(365);
    const olx = fakeOlx({ accepted: new Set(), issue: () => ({ token: fresh, refreshToken: 'r2' }) });
    const onSessionRefreshed = vi.fn();
    const client = createOlxClient({ accessToken: rejected, refreshToken: 'r1', fetch: olx.fetch, onSessionRefreshed });
    await expect(client.account.wallet()).resolves.toBeDefined();
    expect(olx.seen).toEqual([rejected, fresh]);
    expect(olx.refreshes()).toBe(1);
    expect(onSessionRefreshed).toHaveBeenCalledOnce();
  });

  it('retries a write after a 401 only once, and gives up with auth_failed if the new token fails too', async () => {
    const olx = fakeOlx({ accepted: new Set(), issue: () => ({ token: 'still-not-accepted-token-xx' }) });
    // The renewed token is added to `accepted` by the fake, so reject it explicitly.
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const res = await olx.fetch(url, init);
      return String(url).includes('/auth/refresh') ? res : jsonResponse({ message: 'Unauthorized' }, 401);
    });
    const client = createOlxClient({
      accessToken: token(200),
      refreshToken: 'r1',
      fetch: fetch as unknown as typeof globalThis.fetch,
      writeLimits: { minIntervalMs: 0, jitterMs: 0, maxPerHour: 1000 },
    });
    await expect(client.ads.deactivate('117000001')).rejects.toMatchObject({ code: 'auth_failed' });
    expect(olx.refreshes()).toBe(1);
    const writes = fetch.mock.calls.filter(([u]) => String(u).includes('/deactivate'));
    expect(writes).toHaveLength(2);
  });

  it('without a refresh token, a 401 is an auth error and nothing is renewed', async () => {
    const olx = fakeOlx({ accepted: new Set(), issue: () => ({ token: token(365) }) });
    const client = createOlxClient({ accessToken: token(5), fetch: olx.fetch });
    await expect(client.account.wallet()).rejects.toMatchObject({ code: 'auth_failed' });
    expect(olx.refreshes()).toBe(0);
  });

  it('refresh: false turns renewal off', async () => {
    const olx = fakeOlx({ accepted: new Set(), issue: () => ({ token: token(365) }) });
    const client = createOlxClient({ accessToken: token(5), refreshToken: 'r1', fetch: olx.fetch, refresh: false });
    await expect(client.account.wallet()).rejects.toMatchObject({ code: 'auth_failed' });
    expect(olx.refreshes()).toBe(0);
  });

  it('an early renewal that fails keeps using the current token, reports it, and waits before trying again', async () => {
    const t = token(10);
    const olx = fakeOlx({ accepted: new Set([t]), refreshStatus: 401 });
    const onFailed = vi.fn();
    const client = createOlxClient({ accessToken: t, refreshToken: 'r1', fetch: olx.fetch, refresh: { onFailed } });
    await client.account.wallet();
    await client.account.wallet();
    expect(olx.refreshes()).toBe(1);
    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ code: 'auth_failed' });
    expect(olx.seen).toEqual([t, t]);
  });

  it('an expired token whose renewal fails is an auth error', async () => {
    const olx = fakeOlx({ accepted: new Set(), refreshStatus: 400 });
    const client = createOlxClient({ accessToken: token(-1), refreshToken: 'r1', fetch: olx.fetch });
    await expect(client.account.wallet()).rejects.toMatchObject({ code: 'auth_failed' });
    expect(olx.seen).toEqual([]);
  });

  it('calls onSessionRefreshed again on the next request if saving failed', async () => {
    const old = token(10);
    const olx = fakeOlx({ accepted: new Set([old]), issue: () => ({ token: token(365), refreshToken: 'r2' }) });
    const onSessionRefreshed = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const client = createOlxClient({ accessToken: old, refreshToken: 'r1', fetch: olx.fetch, onSessionRefreshed });
    await client.account.wallet();
    await client.account.wallet();
    await client.account.wallet();
    expect(olx.refreshes()).toBe(1);
    expect(onSessionRefreshed).toHaveBeenCalledTimes(2);
    expect(onSessionRefreshed.mock.calls[1]![0]).toEqual(onSessionRefreshed.mock.calls[0]![0]);
  });

  it('client.session.refresh() renews on demand', async () => {
    const t = token(200);
    const fresh = token(365);
    const olx = fakeOlx({ accepted: new Set([t]), issue: () => ({ token: fresh, refreshToken: 'r2' }) });
    const client = createOlxClient({ accessToken: t, refreshToken: 'r1', fetch: olx.fetch });
    await expect(client.session.refresh()).resolves.toMatchObject({ accessToken: fresh, refreshToken: 'r2' });
    await client.account.wallet();
    expect(olx.seen).toEqual([fresh]);
  });

  it('accepts session: { accessToken, refreshToken }', async () => {
    const old = token(10);
    const fresh = token(365);
    const olx = fakeOlx({ accepted: new Set([old]), issue: () => ({ token: fresh }) });
    const client = createOlxClient({ session: { accessToken: old, refreshToken: 'r1' }, fetch: olx.fetch });
    await client.account.wallet();
    expect(olx.seen).toEqual([fresh]);
  });

  it('rejects a refresh token without an access token, and a malformed pair', () => {
    expect(() => createOlxClient({ refreshToken: 'r1' })).toThrow(/goes with accessToken/);
    expect(() => createOlxClient({ session: { accessToken: 'x' } })).toThrow(/malformed/);
    expect(() => createOlxClient({ accessToken: token(5), refreshToken: () => 'r' })).toThrow(/function only/);
  });
});

describe('accessToken as a function', () => {
  it('reads the current token before each request', async () => {
    const a = token(200, { sub: 'a' });
    const b = token(200, { sub: 'b' });
    const olx = fakeOlx({ accepted: new Set([a, b]) });
    let current = a;
    const client = createOlxClient({ accessToken: async () => current, fetch: olx.fetch });
    await client.account.wallet();
    current = b;
    await client.account.wallet();
    expect(olx.seen).toEqual([a, b]);
  });

  it('keeps a renewed token until the function returns the saved one', async () => {
    const old = token(10);
    const fresh = token(365);
    const olx = fakeOlx({ accepted: new Set([old]), issue: () => ({ token: fresh, refreshToken: 'r2' }) });
    const db = { accessToken: old, refreshToken: 'r1' };
    let saves = 0;
    const client = createOlxClient({
      accessToken: () => db.accessToken,
      refreshToken: () => db.refreshToken,
      fetch: olx.fetch,
      onSessionRefreshed: async (s) => {
        saves++;
        if (saves > 1) Object.assign(db, { accessToken: s.accessToken, refreshToken: s.refreshToken });
        else throw new Error('not saved yet');
      },
    });
    await client.account.wallet(); // renews; the save fails, the function still returns the old token
    await client.account.wallet(); // the renewed token is still used, and the save is retried
    await client.account.wallet(); // the function now returns the saved token
    expect(olx.refreshes()).toBe(1);
    expect(olx.seen).toEqual([fresh, fresh, fresh]);
    expect(db).toEqual({ accessToken: fresh, refreshToken: 'r2' });
  });

  it('an empty token from the function is a missing session', async () => {
    const olx = fakeOlx({ accepted: new Set() });
    const client = createOlxClient({ accessToken: () => '', fetch: olx.fetch });
    await expect(client.account.wallet()).rejects.toMatchObject({ code: 'auth_failed' });
  });
});
