/**
 * One test per defect found in review, so each fix stays fixed.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parseEndpoints, type EndpointMap } from '../src/endpoints.js';
import {
  AuthError,
  LinkConflictError,
  MappingError,
  OlxHttpError,
  OlxSdkError,
  ReconcileRequiredError,
  UncertainWriteError,
} from '../src/errors.js';
import { OlxHttpClient, type Transport } from '../src/http/HttpClient.js';
import { WriteRateLimiter } from '../src/http/rateLimiter.js';
import { normalizeStatus, placeholderAdapter } from '../src/listings/adapter.js';
import { ImageUploader, isPrivateAddress } from '../src/listings/images.js';
import type { CreateHooks, ListingsPort } from '../src/listings/ListingsApi.js';
import type { ListingInput, OlxAd } from '../src/listings/types.js';
import type { RequestLog } from '../src/logger.js';
import { CatalogMapper, parseCatalog } from '../src/mapping/CatalogMapper.js';
import { createWebhookNotifier, signWebhook } from '../src/server/webhook.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { FileSessionStore, MemorySessionStore } from '../src/session/storage.js';
import { hashListing, SyncService } from '../src/sync/SyncService.js';
import { JsonFileSyncStore, MemorySyncStore } from '../src/sync/SyncStore.js';
import { catalog, fakeClock, jsonResponse, session } from './helpers.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function http(
  transport: Transport,
  endpoints: EndpointMap = parseEndpoints({
    createAd: { method: 'POST', path: '/api/ads' },
    deleteAd: { method: 'DELETE', path: '/api/ads/{id}' },
    getAd: { method: 'GET', path: '/api/ads/{id}' },
    uploadImage: { method: 'POST', path: 'https://img.cdn-example.com/upload' },
  }),
  extra: Partial<ConstructorParameters<typeof OlxHttpClient>[0]> = {},
) {
  const invalidate = vi.fn();
  const client = new OlxHttpClient({
    baseUrl: 'https://www.olx.com.lb',
    endpoints,
    session: { getSession: async () => session, invalidate },
    limiter: new WriteRateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerHour: 100 }, fakeClock()),
    transport,
    retryBaseMs: 1,
    sleep: async () => {},
    ...extra,
  });
  return { client, invalidate };
}

// ---------------------------------------------------------------- HTTP client
describe('HTTP client hardening', () => {
  it('never sends session cookies or auth headers to a non-OLX host', async () => {
    const transport = vi.fn<Transport>(async () => jsonResponse({ id: 'img' }));
    const { client } = http(transport, undefined, { extraHeaders: () => ({ 'x-extra': 'SECRET' }) });
    await client.call('uploadImage', { form: new FormData(), rateLimit: false });
    const headers = transport.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-extra']).toBeUndefined();
  });

  it('sends the session to a foreign host only when the endpoint opts in', async () => {
    const transport = vi.fn<Transport>(async () => jsonResponse({ id: 'img' }));
    const { client } = http(
      transport,
      parseEndpoints({
        uploadImage: { method: 'POST', path: 'https://img.cdn-example.com/u', sendSessionToForeignHost: true },
      }),
    );
    await client.call('uploadImage', { form: new FormData(), rateLimit: false });
    expect((transport.mock.calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer test-token');
  });

  it('does not follow redirects: 3xx becomes AuthError and drops the cached session', async () => {
    const transport = vi.fn<Transport>(async () => new Response(null, { status: 302, headers: { location: '/login?next=/x' } }));
    const { client, invalidate } = http(transport);
    await expect(client.call('deleteAd', { params: { id: '1' } })).rejects.toBeInstanceOf(AuthError);
    expect(transport.mock.calls[0]![1].redirect).toBe('manual');
    expect(transport.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(invalidate).toHaveBeenCalled();
  });

  it('treats a non-login redirect after a write (post/redirect/get) as uncertain, not "not created"', async () => {
    const { client, invalidate } = http(
      async () => new Response(null, { status: 303, headers: { location: '/ad/iphone-15-ID123.html' } }),
    );
    await expect(client.call('createAd', { json: {} })).rejects.toBeInstanceOf(UncertainWriteError);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('treats a redirect to a login page after a write as an auth failure', async () => {
    const { client } = http(
      async () => new Response(null, { status: 302, headers: { location: 'https://www.olx.com.lb/login?next=/post' } }),
    );
    await expect(client.call('createAd', { json: {} })).rejects.toBeInstanceOf(AuthError);
  });

  it('treats an HTML page from a write as an uncertain outcome, not success', async () => {
    const { client } = http(
      async () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(client.call('deleteAd', { params: { id: '1' } })).rejects.toBeInstanceOf(UncertainWriteError);
  });

  it('reports network errors on writes as uncertain', async () => {
    const { client } = http(async () => {
      throw new Error('socket hang up');
    });
    await expect(client.call('createAd', { json: {} })).rejects.toBeInstanceOf(UncertainWriteError);
  });

  it('invalidates the session on 401', async () => {
    const { client, invalidate } = http(async () => jsonResponse({}, 401));
    await expect(client.call('getAd', { params: { id: '1' } })).rejects.toBeInstanceOf(AuthError);
    expect(invalidate).toHaveBeenCalled();
  });

  it('refuses plain-http endpoints', async () => {
    const { client } = http(
      async () => jsonResponse({}),
      parseEndpoints({ getAd: { method: 'GET', path: 'http://www.olx.com.lb/api/ads/{id}' } }),
    );
    await expect(client.call('getAd', { params: { id: '1' } })).rejects.toThrow(/https/);
  });

  it('a failing request log never turns a successful create into a failure', async () => {
    const brokenLog: RequestLog = {
      write() {
        throw new Error('disk full');
      },
    };
    const { client } = http(async () => jsonResponse({ id: 'ad-1' }), undefined, { requestLog: brokenLog });
    await expect(client.call('createAd', { json: {} })).resolves.toEqual({ id: 'ad-1' });
  });

  it('caps a server-requested Retry-After', async () => {
    const sleeps: number[] = [];
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '86400' }))
      .mockResolvedValueOnce(jsonResponse({ id: '1' }));
    const { client } = http(transport, undefined, { sleep: async (ms) => void sleeps.push(ms) });
    await client.call('getAd', { params: { id: '1' } });
    expect(sleeps).toEqual([60_000]);
  });
});

// ---------------------------------------------------------------- session
describe('session reloading', () => {
  it('picks up a re-login written by another process', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'olx-sess-')), 's.json');
    writeFileSync(file, JSON.stringify({ ...session, headers: { authorization: 'Bearer OLD' } }));
    const mgr = new SessionManager({ baseUrl: 'https://www.olx.com.lb', store: new FileSessionStore(file) });
    expect((await mgr.getSession()).headers.authorization).toBe('Bearer OLD');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, JSON.stringify({ ...session, headers: { authorization: 'Bearer NEW-TOKEN' } }));
    expect((await mgr.getSession()).headers.authorization).toBe('Bearer NEW-TOKEN');
  });

  it('re-reads the store after invalidate()', async () => {
    const store = new MemorySessionStore({ ...session });
    const mgr = new SessionManager({ baseUrl: 'https://www.olx.com.lb', store });
    await mgr.getSession();
    await store.save({ ...session, savedAt: 'later' });
    mgr.invalidate();
    expect((await mgr.getSession()).savedAt).toBe('later');
  });
});

// ---------------------------------------------------------------- adapter + mapper
describe('adapter and mapper', () => {
  it('prefers a top-level id over an envelope without one', () => {
    expect(placeholderAdapter.parseAd({ id: 'AD1', data: { images: [] } }).id).toBe('AD1');
  });

  it.each(['not_approved', 'not_active', 'not_published', 'inactive', 'unpublished'])('does not read %s as active', (s) =>
    expect(normalizeStatus(s)).toBe('unknown'),
  );

  it('does not resolve Object.prototype names as catalog keys', () => {
    const mapper = new CatalogMapper(catalog);
    const base = { title: 't', description: 'd', price: 1, attributes: { brand: 'x' } };
    expect(() => mapper.resolve({ ...base, categoryKey: 'phones', locationKey: 'toString' })).toThrow(MappingError);
    expect(() => mapper.resolve({ ...base, categoryKey: 'constructor', locationKey: 'beirut' })).toThrow(MappingError);
  });

  it('refuses placeholder ids copied from the example catalog', () => {
    const mapper = new CatalogMapper(
      parseCatalog({
        categories: { phones: { olxCategoryId: 'TODO' } },
        locations: { beirut: { olxLocationId: 'TODO' } },
      }),
    );
    expect(() =>
      mapper.resolve({ title: 't', description: 'd', price: 1, categoryKey: 'phones', locationKey: 'beirut' }),
    ).toThrow(/placeholder olxCategoryId/);
  });
});

// ---------------------------------------------------------------- sync service
const product: ListingInput = {
  title: 'Pixel 9',
  description: 'New',
  price: 650,
  categoryKey: 'phones',
  locationKey: 'beirut',
  attributes: { brand: 'Google' },
};

function listings(overrides: Partial<ListingsPort> = {}) {
  const ad: OlxAd = { id: 'ad-1', status: 'active', raw: {} };
  return {
    // Honours the beforeSend contract, like the real ListingsApi.
    create: vi.fn(async (_input: ListingInput, hooks?: CreateHooks) => {
      await hooks?.beforeSend?.();
      return ad;
    }),
    update: vi.fn(async (id: string) => ({ ...ad, id })),
    delete: vi.fn(async () => {}),
    ...overrides,
  } satisfies ListingsPort;
}

describe('SyncService duplicate protection', () => {
  it('parks an uncertain create and never re-posts it until resolved', async () => {
    const l = listings({
      create: vi.fn(async (_i: ListingInput, hooks?: CreateHooks) => {
        await hooks?.beforeSend?.();
        throw new UncertainWriteError('createAd', 'timeout');
      }),
    });
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings: l, store });

    await expect(sync.upsert('P1', product)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await store.get('P1'))?.syncState).toBe('needs_reconcile');
    await expect(sync.upsert('P1', product)).rejects.toBeInstanceOf(ReconcileRequiredError);
    await expect(sync.remove('P1')).rejects.toBeInstanceOf(ReconcileRequiredError);
    expect(l.create).toHaveBeenCalledTimes(1);

    await sync.link('P1', 'ad-found');
    const after = await sync.upsert('P1', product);
    expect(after.action).toBe('updated'); // pushes current content to the linked ad
    expect(l.update).toHaveBeenCalledWith('ad-found', product, { photosUnchanged: false }); // linked ad: photos unknown
  });

  it('refuses unsafe ad ids and will not silently replace a healthy link', async () => {
    const l = listings();
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings: l, store });
    await expect(sync.link('P1', '..')).rejects.toThrow(/Invalid ad id/);
    await expect(sync.link('P1', 'a/b')).rejects.toThrow(/Invalid ad id/);

    await sync.upsert('P1', product); // healthy link to ad-1
    await expect(sync.link('P1', 'ad-other')).rejects.toBeInstanceOf(LinkConflictError);
    expect((await sync.link('P1', 'ad-other', { replace: true })).adId).toBe('ad-other');
    expect((await sync.link('P1', 'ad-other')).adId).toBe('ad-other'); // same id: idempotent
  });

  it('forget() lets a parked product be created again', async () => {
    const l = listings({
      create: vi
        .fn<ListingsPort['create']>()
        .mockRejectedValueOnce(new UncertainWriteError('createAd', 'timeout'))
        .mockResolvedValueOnce({ id: 'ad-2', status: 'active', raw: {} }),
    });
    const sync = new SyncService({ listings: l, store: new MemorySyncStore() });
    await expect(sync.upsert('P1', product)).rejects.toThrow();
    expect(await sync.forget('P1')).toBe(true);
    expect((await sync.upsert('P1', product)).action).toBe('created');
  });

  it('clears the marker when a create definitely failed', async () => {
    let markerDuringSend: string | undefined;
    const store = new MemorySyncStore();
    const l = listings({
      create: vi.fn(async (_i: ListingInput, hooks?: CreateHooks) => {
        await hooks?.beforeSend?.();
        markerDuringSend = (await store.get('P1'))?.syncState;
        throw new OlxHttpError('createAd', 422, {});
      }),
    });
    const sync = new SyncService({ listings: l, store });
    await expect(sync.upsert('P1', product)).rejects.toBeInstanceOf(OlxHttpError);
    expect(markerDuringSend).toBe('creating'); // the marker really was written…
    expect(await store.get('P1')).toBeUndefined(); // …and then cleared
  });

  it('a create interrupted by a crash leaves the product parked', async () => {
    const store = new MemorySyncStore();
    await store.set({
      productId: 'P1',
      adId: '',
      status: 'unknown',
      syncState: 'creating',
      contentHash: 'x',
      createdAt: 't',
      lastSyncedAt: 't',
    });
    const l = listings();
    await expect(new SyncService({ listings: l, store }).upsert('P1', product)).rejects.toBeInstanceOf(ReconcileRequiredError);
    expect(l.create).not.toHaveBeenCalled();
  });

  it('serialises concurrent upserts for one product (one create, not two)', async () => {
    const l = listings({
      create: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { id: 'ad-1', status: 'active' as const, raw: {} };
      }),
    });
    const sync = new SyncService({ listings: l, store: new MemorySyncStore() });
    const results = await Promise.all([sync.upsert('P2', product), sync.upsert('P2', product)]);
    expect(l.create).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.action).sort()).toEqual(['created', 'unchanged']);
  });

  it('marks the link gone when OLX says the ad no longer exists on update', async () => {
    const l = listings({
      update: vi.fn(async () => {
        throw new OlxHttpError('updateAd', 404, {});
      }),
    });
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings: l, store });
    await sync.upsert('P3', product);
    await expect(sync.upsert('P3', { ...product, price: 1 })).rejects.toBeInstanceOf(ReconcileRequiredError);
    expect((await store.get('P3'))?.syncState).toBe('gone');
    // Removing a gone ad just drops the link without calling OLX.
    expect(await sync.remove('P3')).toEqual({ action: 'deleted', adId: 'ad-1', alreadyGone: true });
    expect(l.delete).not.toHaveBeenCalled();
  });

  it('treats a 404 on delete as already deleted', async () => {
    const l = listings({
      delete: vi.fn(async () => {
        throw new OlxHttpError('deleteAd', 404, {});
      }),
    });
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings: l, store });
    await sync.upsert('P4', product);
    expect(await sync.remove('P4')).toEqual({ action: 'deleted', adId: 'ad-1', alreadyGone: true });
    expect(await store.get('P4')).toBeUndefined();
  });

  it('re-pushes ads when the catalog mapping changes, and on force', async () => {
    const before = new CatalogMapper(catalog);
    const after = new CatalogMapper(
      parseCatalog({
        ...catalog,
        categories: { phones: { ...catalog.categories.phones!, olxCategoryId: '999' } },
      }),
    );
    expect(hashListing(product, before.resolve(product))).not.toBe(hashListing(product, after.resolve(product)));

    const l = listings();
    const sync = new SyncService({ listings: l, store: new MemorySyncStore(), mapper: before });
    await sync.upsert('P5', product);
    expect((await sync.upsert('P5', product)).action).toBe('unchanged');
    expect((await sync.upsert('P5', product, { force: true })).action).toBe('updated');
  });
});

describe('JsonFileSyncStore', () => {
  it('does not lose a write made during the first concurrent load', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'olx-store-')), 's.json');
    const st = new JsonFileSyncStore(file);
    const rec = { productId: 'A', adId: 'a', status: 'active' as const, contentHash: 'h', createdAt: 't', lastSyncedAt: 't' };
    await Promise.all([st.set(rec), st.all()]);
    expect(await st.get('A')).toBeDefined();
    expect(await new JsonFileSyncStore(file).get('A')).toBeDefined();
  });
});

// ---------------------------------------------------------------- images
describe('image downloads', () => {
  const dummyHttp = { call: vi.fn(async () => ({ id: 'img' })) } as unknown as OlxHttpClient;
  const img = (headers: Record<string, string> = { 'content-type': 'image/jpeg' }, body: BodyInit = 'x') =>
    new Response(body, { headers });

  it('re-checks the allowlist on every redirect hop', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal.jpg' } }),
    ) as unknown as typeof fetch;
    const up = new ImageUploader({ http: dummyHttp, adapter: placeholderAdapter, allowedHosts: ['store.example'], fetchImpl });
    await expect(up.upload({ url: 'https://store.example/a.jpg' })).rejects.toThrow(/not in OLX_IMAGE_HOSTS/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('without an allowlist, blocks private addresses and plain http', async () => {
    const fetchImpl = vi.fn(async () => img()) as unknown as typeof fetch;
    const up = new ImageUploader({
      http: dummyHttp,
      adapter: placeholderAdapter,
      fetchImpl,
      resolveHost: async () => ['169.254.169.254'],
    });
    await expect(up.upload({ url: 'https://metadata.example/x.jpg' })).rejects.toThrow(/private or internal/);
    await expect(up.upload({ url: 'http://public.example/x.jpg' })).rejects.toThrow(/only https/);
    await expect(up.upload({ url: 'https://[::1]/x.jpg' })).rejects.toThrow(/private or internal/);
    // Every photo problem has one stable code, so callers can tell it from other failures.
    await expect(up.upload({ url: 'http://public.example/x.jpg' })).rejects.toMatchObject({ code: 'image_upload_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts an oversized download while streaming', async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const fetchImpl = vi.fn(async () => img({ 'content-type': 'image/jpeg' }, big)) as unknown as typeof fetch;
    const up = new ImageUploader({
      http: dummyHttp,
      adapter: placeholderAdapter,
      fetchImpl,
      maxBytes: 4096,
      resolveHost: async () => ['93.184.216.34'],
    });
    await expect(up.upload({ url: 'https://cdn.example/huge.jpg' })).rejects.toThrow(/larger than 4096/);
  });

  it('keeps query strings out of error messages', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    const up = new ImageUploader({
      http: dummyHttp,
      adapter: placeholderAdapter,
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
    });
    const err = await up.upload({ url: 'https://cdn.example/a.jpg?sig=SECRET' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(OlxSdkError);
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('enforces an overall download budget per listing', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return img();
    }) as unknown as typeof fetch;
    const up = new ImageUploader({
      http: dummyHttp,
      adapter: placeholderAdapter,
      fetchImpl,
      totalTimeoutMs: 50,
      resolveHost: async () => ['93.184.216.34'],
    });
    const urls = [1, 2, 3, 4].map((i) => ({ url: `https://cdn.example/${i}.jpg` }));
    await expect(up.uploadAll(urls)).rejects.toThrow(/took too long/);
    expect(vi.mocked(fetchImpl).mock.calls.length).toBeLessThan(4);
  });

  it.each([
    ['64:ff9b::a9fe:a9fe', true],
    ['2002:a9fe:a9fe::1', true],
    ['fec0::1', true],
    ['10.1.2.3', true],
    ['172.20.0.1', true],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['::ffff:127.0.0.1', true],
    ['fd00::1', true],
    ['8.8.8.8', false],
    ['2606:4700::1111', false],
  ])('isPrivateAddress(%s) = %s', (addr, expected) => {
    expect(isPrivateAddress(addr)).toBe(expected);
  });
});

// ---------------------------------------------------------------- webhook + config
describe('webhook', () => {
  it('signs the body with its own secret, strips raw OLX data and refuses redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const notifier = createWebhookNotifier(
      { url: 'https://hooks.example/olx', secret: 'webhook-secret-0123456789' },
      silent,
      fetchImpl,
    );
    notifier.send({
      id: 'j1',
      type: 'upsert',
      productId: 'P1',
      status: 'succeeded',
      createdAt: 't',
      result: { ad: { id: 'ad-1', raw: { seller_phone: '70123456' } } },
    });
    await notifier.flush();
    const [, init] = vi.mocked(fetchImpl).mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(init.redirect).toBe('error');
    expect(headers['x-api-key']).toBeUndefined();
    expect(String(init.body)).not.toContain('70123456');
    expect(headers['x-olx-sdk-signature']).toBe(
      `sha256=${signWebhook('webhook-secret-0123456789', headers['x-olx-sdk-timestamp']!, String(init.body))}`,
    );
  });
});

describe('config validation', () => {
  it('rejects an http base URL, except a localhost test server', () => {
    expect(() => loadConfig({ OLX_BASE_URL: 'http://www.olx.com.lb' })).toThrow(/https/);
    expect(loadConfig({ OLX_BASE_URL: 'http://localhost:8080' }).baseUrl).toBe('http://localhost:8080');
  });

  it('requires a separate webhook secret and https for remote webhooks', () => {
    expect(() => loadConfig({ WEBHOOK_URL: 'https://hooks.example/x' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ WEBHOOK_URL: 'http://hooks.example/x', WEBHOOK_SECRET: 'webhook-secret-0123456789' })).toThrow(
      /https/,
    );
    expect(() =>
      loadConfig({
        WEBHOOK_URL: 'https://hooks.example/x',
        WEBHOOK_SECRET: 'same-key-0123456789',
        SERVER_API_KEY: 'same-key-0123456789',
      }),
    ).toThrow(/different/);
    expect(loadConfig({ WEBHOOK_URL: 'http://localhost/hook', WEBHOOK_SECRET: 'webhook-secret-0123456789' }).webhook).toEqual({
      url: 'http://localhost/hook',
      secret: 'webhook-secret-0123456789',
    });
  });
});
