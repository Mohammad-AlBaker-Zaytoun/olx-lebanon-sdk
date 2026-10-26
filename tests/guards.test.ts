/**
 * Guard tests: each one fails if a specific safety property is weakened. They were written
 * against a mutation run (deliberately broken copies of the code that the earlier suite
 * still passed). The mutation id from that run is noted on each test.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OlxClient } from '../src/client.js';
import { buildUrl, parseEndpoints, type EndpointMap } from '../src/endpoints.js';
import {
  AuthError,
  OlxHttpError,
  OlxSdkError,
  ReconcileRequiredError,
  UncertainWriteError,
} from '../src/errors.js';
import { OlxHttpClient, sessionDomain, type Transport } from '../src/http/HttpClient.js';
import { WriteRateLimiter } from '../src/http/rateLimiter.js';
import { placeholderAdapter } from '../src/listings/adapter.js';
import { ImageUploader } from '../src/listings/images.js';
import type { CreateHooks, ListingsPort } from '../src/listings/ListingsApi.js';
import type { ListingInput, OlxAd } from '../src/listings/types.js';
import { buildServer } from '../src/server/app.js';
import { JobQueue } from '../src/server/queue.js';
import { createWebhookNotifier } from '../src/server/webhook.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { cookieHeaderFor, FileSessionStore, MemorySessionStore } from '../src/session/storage.js';
import { hashListing, SyncService } from '../src/sync/SyncService.js';
import { MemorySyncStore, type SyncRecord } from '../src/sync/SyncStore.js';
import { catalog, fakeClock, jsonResponse, session } from './helpers.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const product: ListingInput = {
  title: 'Pixel 9',
  description: 'New',
  price: 650,
  categoryKey: 'phones',
  locationKey: 'beirut',
  attributes: { brand: 'Google' },
};

function http(transport: Transport, endpoints: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return new OlxHttpClient({
    baseUrl: 'https://www.olx.com.lb',
    endpoints: parseEndpoints(endpoints),
    session: { getSession: async () => session, invalidate: () => {} },
    limiter: new WriteRateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerHour: 100 }, fakeClock()),
    transport,
    retryBaseMs: 1,
    sleep: async () => {},
    ...extra,
  });
}

// ---------------------------------------------------------------- HTTP client
describe('guards: HTTP client', () => {
  it('[M1] session is not sent to a look-alike domain (evilolx.com.lb)', async () => {
    const t = vi.fn<Transport>(async () => jsonResponse({}));
    await http(t, { getAd: { method: 'GET', path: 'https://evilolx.com.lb/ads/{id}' } }).call('getAd', {
      params: { id: '1' },
    });
    const h = t.mock.calls[0]![1].headers as Record<string, string>;
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
  });

  it('[M2] the session domain drops "www." so OLX subdomains (api.) get the session', async () => {
    expect(sessionDomain('https://www.olx.com.lb')).toBe('olx.com.lb');
    const t = vi.fn<Transport>(async () => jsonResponse({}));
    await http(t, { getAd: { method: 'GET', path: 'https://api.olx.com.lb/ads/{id}' } }).call('getAd', {
      params: { id: '1' },
    });
    expect((t.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });

  it('[M3] a write is sent exactly once on a network error', async () => {
    const t = vi.fn<Transport>(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(http(t, { createAd: { method: 'POST', path: '/api/ads' } }).call('createAd', { json: {} })).rejects.toBeInstanceOf(
      UncertainWriteError,
    );
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('[M4] a write is sent exactly once on 429', async () => {
    const t = vi.fn<Transport>(async () => jsonResponse({}, 429));
    await expect(http(t, { createAd: { method: 'POST', path: '/api/ads' } }).call('createAd', { json: {} })).rejects.toBeInstanceOf(
      OlxHttpError,
    );
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('[M30] reads do not follow redirects either', async () => {
    const t = vi.fn<Transport>(async () => new Response(null, { status: 302, headers: { location: '/login' } }));
    await expect(
      http(t, { getAd: { method: 'GET', path: '/ads/{id}' } }).call('getAd', { params: { id: '1' } }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(t.mock.calls[0]![1].redirect).toBe('manual');
  });

  it('[M33] an HTML page from a read is an error, not data', async () => {
    const t = vi.fn<Transport>(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    await expect(
      http(t, { getAd: { method: 'GET', path: '/ads/{id}' } }, { maxReadRetries: 0 }).call('getAd', { params: { id: '1' } }),
    ).rejects.toBeInstanceOf(OlxSdkError);
  });

  it('[M62] beforeSend runs once even when a read is retried', async () => {
    const t = vi.fn<Transport>().mockResolvedValueOnce(jsonResponse({}, 503)).mockResolvedValueOnce(jsonResponse({ id: '1' }));
    const beforeSend = vi.fn(async () => {});
    await http(t, { getAd: { method: 'GET', path: '/ads/{id}' } }).call('getAd', { params: { id: '1' }, beforeSend });
    expect(t).toHaveBeenCalledTimes(2);
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });

  it('[M28][M29] cookies respect domain suffix and path', () => {
    const s = { ...session, cookies: [{ name: 'a', value: '1', domain: 'olx.com.lb', path: '/api', expires: -1 }] };
    expect(cookieHeaderFor(s, 'https://evilolx.com.lb/api/x')).toBe('');
    expect(cookieHeaderFor(s, 'https://www.olx.com.lb/other')).toBe('');
    expect(cookieHeaderFor(s, 'https://www.olx.com.lb/api/x')).toBe('a=1');
  });

  it('[M22] path params are length-limited', () => {
    expect(() => buildUrl('https://x.test', { method: 'GET', path: '/a/{id}' }, { id: 'a'.repeat(129) })).toThrow(/Unsafe/);
    expect(buildUrl('https://x.test', { method: 'GET', path: '/a/{id}' }, { id: 'a'.repeat(128) })).toContain('a'.repeat(128));
  });
});

// ---------------------------------------------------------------- rate limiter
describe('guards: rate limiter', () => {
  it('[M5][M6] create and update each take exactly one write slot', async () => {
    const t = vi.fn<Transport>(async (_u, init) => (init.method === 'POST' ? jsonResponse({ id: 'ad-1' }, 201) : new Response(null, { status: 204 })));
    const c = new OlxClient({
    adapter: placeholderAdapter,
      baseUrl: 'https://www.olx.com.lb',
      endpoints: parseEndpoints({
        createAd: { method: 'POST', path: '/api/ads' },
        updateAd: { method: 'PUT', path: '/api/ads/{id}' },
      }) as EndpointMap,
      catalog,
      sessionStore: new MemorySessionStore(session),
      syncStore: new MemorySyncStore(),
      writeLimits: { minIntervalMs: 0, jitterMs: 0, maxPerHour: 100 },
      clock: fakeClock(),
      transport: t,
    });
    await c.sync.upsert('P1', product);
    expect(c.limiter.recentCount).toBe(1);
    await c.sync.upsert('P1', { ...product, price: 600 });
    expect(c.limiter.recentCount).toBe(2);
  });

  it('[M25] a write exactly one hour old no longer counts', async () => {
    const clock = fakeClock();
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerHour: 1 }, clock);
    await limiter.acquire();
    await limiter.acquire(); // waits exactly one hour
    expect(limiter.recentCount).toBe(1);
  });

  it('[M66] refunding the same slot twice only returns one slot', async () => {
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerHour: 10 }, fakeClock());
    const refundA = await limiter.acquire();
    await limiter.acquire(); // same timestamp as A on the fake clock
    refundA();
    refundA();
    expect(limiter.recentCount).toBe(1);
  });
});

// ---------------------------------------------------------------- images
describe('guards: image downloads', () => {
  const dummy = {} as OlxHttpClient;
  const ok = () => new Response('x', { headers: { 'content-type': 'image/jpeg' } });

  it('[M7] blocked if ANY resolved address is private', async () => {
    const up = new ImageUploader({ http: dummy, adapter: placeholderAdapter, fetchImpl: vi.fn() as never, resolveHost: async () => ['93.184.216.34', '10.0.0.1'] });
    await expect(up.upload({ url: 'https://cdn.example/a.jpg' })).rejects.toThrow(/private/);
  });

  it('[M8] blocked if DNS returns no addresses', async () => {
    const up = new ImageUploader({ http: dummy, adapter: placeholderAdapter, fetchImpl: vi.fn() as never, resolveHost: async () => [] });
    await expect(up.upload({ url: 'https://cdn.example/a.jpg' })).rejects.toThrow(/private/);
  });

  it('[M42] the allowlist does not match look-alike hosts (evilstore.example)', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const up = new ImageUploader({ http: dummy, adapter: placeholderAdapter, allowedHosts: ['store.example'], fetchImpl: fetchImpl as never });
    await expect(up.upload({ url: 'https://evilstore.example/a.jpg' })).rejects.toThrow(/not in OLX_IMAGE_HOSTS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('[M9][M10] image fetches never auto-follow redirects, and hops are capped', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again.jpg' } }));
    const up = new ImageUploader({ http: dummy, adapter: placeholderAdapter, allowedHosts: ['store.example'], fetchImpl: fetchImpl as never });
    await expect(up.upload({ url: 'https://store.example/a.jpg' })).rejects.toThrow(/redirects/);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // first request + 3 hops
    for (const call of fetchImpl.mock.calls as unknown as Array<[URL, RequestInit]>) expect(call[1].redirect).toBe('manual');
  });

  it('[M43] the per-request timeout applies, not just the overall budget', async () => {
    const fetchImpl = vi.fn(
      (_u: URL, init: RequestInit) =>
        new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    const up = new ImageUploader({
      http: dummy,
      adapter: placeholderAdapter,
      allowedHosts: ['store.example'],
      fetchImpl: fetchImpl as never,
      timeoutMs: 30,
      totalTimeoutMs: 60_000,
    });
    const started = Date.now();
    await expect(up.upload({ url: 'https://store.example/a.jpg' })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('[M40][M41] size and type are checked for in-memory and file images too', async () => {
    const up = new ImageUploader({ http: dummy, adapter: placeholderAdapter, maxBytes: 10 });
    await expect(up.upload({ data: new Uint8Array(20), filename: 'a.jpg' })).rejects.toThrow(/larger than 10/);
    await expect(up.upload({ data: new Uint8Array(5), filename: 'a.txt', contentType: 'text/plain' })).rejects.toThrow(/not an image/);
  });
});

// ---------------------------------------------------------------- webhook format (receivers depend on it)
describe('guards: webhook signature format', () => {
  afterEach(() => vi.useRealTimers());

  it('[M11][M12] signs "unixSeconds.body" with HMAC-SHA256', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_123 });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const n = createWebhookNotifier({ url: 'https://hooks.example/x', secret: 'webhook-secret-0123456789' }, silent, fetchImpl as never);
    n.send({ id: 'j', type: 'remove', productId: 'P', status: 'succeeded', createdAt: 't' });
    await n.flush();
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-olx-sdk-timestamp']).toBe('1700000000');
    const expected = createHmac('sha256', 'webhook-secret-0123456789').update(`1700000000.${String(init.body)}`).digest('hex');
    expect(headers['x-olx-sdk-signature']).toBe(`sha256=${expected}`);
  });
});

// ---------------------------------------------------------------- sync state machine
function fakeListings(over: Partial<ListingsPort> = {}): ListingsPort {
  const ad: OlxAd = { id: 'ad-1', status: 'active', raw: {} };
  return {
    // Honours the beforeSend contract like the real ListingsApi does.
    create: async (_i: ListingInput, hooks?: CreateHooks) => {
      await hooks?.beforeSend?.();
      return ad;
    },
    update: async (id: string) => ({ ...ad, id }),
    delete: async () => {},
    ...over,
  };
}

const rec = (over: Partial<SyncRecord>): SyncRecord => ({
  productId: 'P',
  adId: 'ad-1',
  status: 'active',
  contentHash: 'h',
  createdAt: 't',
  lastSyncedAt: 't',
  ...over,
});

describe('guards: sync state machine', () => {
  it('[M16] a gone link blocks upsert (no silent repost)', async () => {
    const store = new MemorySyncStore();
    await store.set(rec({ syncState: 'gone' }));
    const create = vi.fn();
    const err = await new SyncService({ listings: fakeListings({ create }), store }).upsert('P', product).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReconcileRequiredError);
    expect((err as ReconcileRequiredError).reason).toBe('ad_gone');
    expect(create).not.toHaveBeenCalled();
  });

  it('[M17] remove refuses a product whose create may be in flight / unknown', async () => {
    const store = new MemorySyncStore();
    await store.set(rec({ adId: '', syncState: 'creating' }));
    const del = vi.fn();
    await expect(new SyncService({ listings: fakeListings({ delete: del }), store }).remove('P')).rejects.toBeInstanceOf(
      ReconcileRequiredError,
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('[M19] 410 Gone on update marks the link gone', async () => {
    const store = new MemorySyncStore();
    const sync = new SyncService({
      listings: fakeListings({ update: async () => Promise.reject(new OlxHttpError('updateAd', 410, {})) }),
      store,
    });
    await sync.upsert('P', product);
    await expect(sync.upsert('P', { ...product, price: 1 })).rejects.toBeInstanceOf(ReconcileRequiredError);
    expect((await store.get('P'))?.syncState).toBe('gone');
  });

  it('[M63] a definite failure after the marker was written clears it', async () => {
    const store = new MemorySyncStore();
    const sync = new SyncService({
      listings: fakeListings({
        create: async (_i, hooks) => {
          await hooks?.beforeSend?.();
          throw new OlxHttpError('createAd', 422, {});
        },
      }),
      store,
    });
    await expect(sync.upsert('P', product)).rejects.toBeInstanceOf(OlxHttpError);
    expect(await store.get('P')).toBeUndefined();
  });

  it('[M36] if the link cannot be saved after a create, the caller is told (with the ad id)', async () => {
    const store = new MemorySyncStore();
    let sets = 0;
    const flaky = Object.assign(Object.create(store) as MemorySyncStore, {
      set: async (r: SyncRecord) => {
        sets++;
        if (sets === 2) throw new Error('disk full'); // 1st = marker, 2nd = final link
        return store.set(r);
      },
    });
    const err = await new SyncService({ listings: fakeListings(), store: flaky }).upsert('P', product).catch((e: Error) => e);
    expect(err).toBeInstanceOf(OlxSdkError);
    expect((err as Error).message).toContain('ad-1');
    expect((await store.get('P'))?.syncState).toBe('creating'); // stays parked, never reposted
  });

  it('[M50][M51] changing images or currency changes the fingerprint', () => {
    expect(hashListing({ ...product, images: [{ url: 'https://a/1.jpg' }] })).not.toBe(hashListing(product));
    expect(hashListing({ ...product, currency: 'LBP' })).not.toBe(hashListing(product));
  });

  it('[M13] remove waits for a running create (and then deletes the new ad)', async () => {
    let release!: () => void;
    const del = vi.fn(async () => {});
    const sync = new SyncService({
      listings: fakeListings({
        create: async (_i, hooks) => {
          await hooks?.beforeSend?.();
          await new Promise<void>((r) => (release = r));
          return { id: 'ad-1', status: 'active', raw: {} };
        },
        delete: del,
      }),
      store: new MemorySyncStore(),
    });
    const up = sync.upsert('P', product);
    await vi.waitFor(() => expect(sync.isBusy('P')).toBe(true));
    const rm = sync.remove('P');
    release();
    await up;
    expect(await rm).toEqual({ action: 'deleted', adId: 'ad-1' });
    expect(del).toHaveBeenCalledWith('ad-1');
  });

  it('[M14] link waits for a running create and then refuses to replace its ad', async () => {
    let release!: () => void;
    const store = new MemorySyncStore();
    const sync = new SyncService({
      listings: fakeListings({
        create: async (_i, hooks) => {
          await hooks?.beforeSend?.();
          await new Promise<void>((r) => (release = r));
          return { id: 'ad-1', status: 'active', raw: {} };
        },
      }),
      store,
    });
    const up = sync.upsert('P', product);
    await vi.waitFor(() => expect(sync.isBusy('P')).toBe(true));
    const linking = sync.link('P', 'ad-other');
    release();
    await up;
    await expect(linking).rejects.toThrow(/already linked/);
    expect((await store.get('P'))?.adId).toBe('ad-1');
  });
});

// ---------------------------------------------------------------- queue
describe('guards: queue', () => {
  it('[M59] a request arriving while that product is running is queued, not merged into the running job', async () => {
    let release!: () => void;
    const seen: Array<number | undefined> = [];
    const q = new JobQueue(async (_job, payload) => {
      seen.push(payload?.price);
      if (seen.length === 1) await new Promise<void>((r) => (release = r));
    });
    const first = q.enqueue('upsert', 'P', { ...product, price: 1 });
    await vi.waitFor(() => expect(seen).toEqual([1]));
    const second = q.enqueue('upsert', 'P', { ...product, price: 2 });
    expect(second.id).not.toBe(first.id);
    release();
    await q.idle();
    expect(seen).toEqual([1, 2]);
  });

  it('[M24][M67] coalescing keeps an earlier force for upserts and drops it for removes', async () => {
    let release!: () => void;
    const q = new JobQueue(async () => new Promise<void>((r) => (release = r)));
    q.enqueue('remove', 'busy'); // occupies the worker
    const a = q.enqueue('upsert', 'P', product, { force: true });
    expect(q.enqueue('upsert', 'P', product).force).toBe(true);
    expect(q.enqueue('remove', 'P').force).toBeUndefined();
    expect(a.type).toBe('remove');
    release();
  });
});

// ---------------------------------------------------------------- REST server
describe('guards: REST server', () => {
  const KEY = 'test-key-0123456789abcdef';
  const auth = { 'x-api-key': KEY };

  function app(sync?: SyncService) {
    const store = new MemorySyncStore();
    const s = sync ?? new SyncService({ listings: fakeListings(), store });
    return {
      sync: s,
      app: buildServer({
        apiKey: KEY,
        queue: new JobQueue(async () => undefined),
        store,
        resolve: { link: (p, a, o) => s.link(p, a, o), forget: (p, o) => s.forget(p, o) },
        status: async () => ({ ok: true }),
      }),
    };
  }

  it('[M38] empty or prefix API keys are rejected', async () => {
    const { app: a } = app();
    for (const key of ['', KEY.slice(0, 4), KEY + 'x']) {
      expect((await a.inject({ method: 'GET', url: '/v1/status', headers: { 'x-api-key': key } })).statusCode).toBe(401);
    }
  });

  it('[M52] only exactly /health skips auth', async () => {
    const { app: a } = app();
    for (const url of ['/v1/healthz', '/v1/health/', '/v1/health-check']) {
      expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('[M20][M21] product ids are validated on PUT and resolve', async () => {
    const { app: a } = app();
    const body = { title: 't', description: 'd', price: 1, categoryKey: 'c', locationKey: 'l' };
    expect((await a.inject({ method: 'PUT', url: '/v1/products/a%20b/listing', headers: auth, payload: body })).statusCode).toBe(400);
    expect(
      (await a.inject({ method: 'POST', url: '/v1/products/a%20b/listing/resolve', headers: auth, payload: { action: 'forget' } })).statusCode,
    ).toBe(400);
  });

  it('[M54][M55][M57][M58] resolve conflicts answer 409 and replace/force are honoured', async () => {
    const { app: a, sync } = app();
    await sync.upsert('P', product); // healthy link to ad-1
    const post = (payload: object) => a.inject({ method: 'POST', url: '/v1/products/P/listing/resolve', headers: auth, payload });

    const conflict = await post({ action: 'link', adId: 'ad-2' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'link_conflict', details: { adId: 'ad-1' } } });
    expect((await post({ action: 'link', adId: 'ad-2', replace: true })).json()).toMatchObject({ adId: 'ad-2' });

    const healthy = await post({ action: 'forget' });
    expect(healthy.statusCode).toBe(409);
    expect(healthy.json()).toMatchObject({ error: { code: 'healthy_link' } });
    expect((await post({ action: 'forget', force: true })).json()).toEqual({ forgotten: true });
  });
});

// ---------------------------------------------------------------- session reload
describe('guards: session reload', () => {
  it('[M27] a same-size session rewrite (token refresh) is still picked up', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'olx-g-')), 's.json');
    writeFileSync(file, JSON.stringify({ ...session, headers: { authorization: 'Bearer AAAA' } }));
    utimesSync(file, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const mgr = new SessionManager({ baseUrl: 'https://www.olx.com.lb', store: new FileSessionStore(file) });
    expect((await mgr.getSession()).headers.authorization).toBe('Bearer AAAA');
    writeFileSync(file, JSON.stringify({ ...session, headers: { authorization: 'Bearer BBBB' } })); // same length
    utimesSync(file, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
    expect((await mgr.getSession()).headers.authorization).toBe('Bearer BBBB');
  });
});
