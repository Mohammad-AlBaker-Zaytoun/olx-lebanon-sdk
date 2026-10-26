/**
 * Second review round: product-lifecycle defects. One test per finding.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OlxClient } from '../src/client.js';
import { parseEndpoints } from '../src/endpoints.js';
import { ForgetConflictError, LinkConflictError, UncertainWriteError } from '../src/errors.js';
import type { Transport } from '../src/http/HttpClient.js';
import type { CreateHooks, ListingsPort } from '../src/listings/ListingsApi.js';
import type { ListingInput, OlxAd } from '../src/listings/types.js';
import { JobQueue } from '../src/server/queue.js';
import { MemorySessionStore } from '../src/session/storage.js';
import { SyncService } from '../src/sync/SyncService.js';
import { JsonFileSyncStore, MemorySyncStore } from '../src/sync/SyncStore.js';
import { catalog, fakeClock, jsonResponse, session } from './helpers.js';

const product: ListingInput = {
  title: 'Pixel 9',
  description: 'New',
  price: 650,
  categoryKey: 'phones',
  locationKey: 'beirut',
  attributes: { brand: 'Google' },
  images: [{ url: 'https://cdn.zaytoon.test/p.jpg' }],
};

function client(transport: Transport) {
  const syncStore = new MemorySyncStore();
  const c = new OlxClient({
    baseUrl: 'https://www.olx.com.lb',
    endpoints: parseEndpoints({
      createAd: { method: 'POST', path: '/api/ads' },
      updateAd: { method: 'PUT', path: '/api/ads/{id}' },
      uploadImage: { method: 'POST', path: '/api/images' },
    }),
    catalog,
    sessionStore: new MemorySessionStore(session),
    syncStore,
    writeLimits: { minIntervalMs: 0, jitterMs: 0, maxPerHour: 100 },
    clock: fakeClock(),
    transport,
    imageFetch: (async () => new Response('x', { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch,
    allowedImageHosts: ['zaytoon.test'],
  });
  return { c, syncStore };
}

/** A 201 whose body stream dies half-way (connection reset / timeout while reading). */
function brokenBody201(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":"ad-'));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status: 201, headers: { 'content-type': 'application/json' } });
}

describe('round 2: create outcomes that must park, not repost', () => {
  it('a 2xx create whose body cannot be read is uncertain (parked), not "not created"', async () => {
    const transport = vi.fn<Transport>(async (url) => (url.endsWith('/api/images') ? jsonResponse({ id: 'i' }) : brokenBody201()));
    const { c, syncStore } = client(transport);
    await expect(c.sync.upsert('P1', product)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await syncStore.get('P1'))?.syncState).toBe('needs_reconcile');
    await expect(c.sync.upsert('P1', product)).rejects.toThrow();
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/api/ads'))).toHaveLength(1);
  });

  it('a bare 3xx (no Location) on a create is uncertain, not an auth failure', async () => {
    const transport = vi.fn<Transport>(async (url) =>
      url.endsWith('/api/images') ? jsonResponse({ id: 'i' }) : new Response(null, { status: 303 }),
    );
    const { c, syncStore } = client(transport);
    await expect(c.sync.upsert('P2', product)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await syncStore.get('P2'))?.syncState).toBe('needs_reconcile');
  });
});

describe('round 2: the creating marker is written only right before createAd is sent', () => {
  it('no marker during images / write-slot wait; marker present when createAd leaves', async () => {
    const seen: Array<[string, string | undefined]> = [];
    let store!: MemorySyncStore;
    const transport = vi.fn<Transport>(async (url) => {
      seen.push([url.endsWith('/api/images') ? 'image' : 'createAd', (await store.get('P3'))?.syncState]);
      return url.endsWith('/api/images') ? jsonResponse({ id: 'i' }) : jsonResponse({ id: 'ad-3' }, 201);
    });
    const built = client(transport);
    store = built.syncStore;
    await built.c.sync.upsert('P3', product);
    expect(seen).toEqual([
      ['image', undefined],
      ['createAd', 'creating'],
    ]);
  });

  it('a create that fails before sending leaves no record at all', async () => {
    const ports: ListingsPort = {
      create: vi.fn(async () => {
        throw new Error('rate limiter interrupted');
      }),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const store = new MemorySyncStore();
    await expect(new SyncService({ listings: ports, store }).upsert('P4', product)).rejects.toThrow();
    expect(await store.all()).toEqual([]);
  });
});

describe('round 2: forget / link guards', () => {
  const ad: OlxAd = { id: 'ad-1', status: 'active', raw: {} };

  it('forget refuses a healthy link unless forced', async () => {
    const store = new MemorySyncStore();
    const sync = new SyncService({
      listings: { create: async () => ad, update: async () => ad, delete: async () => {} },
      store,
    });
    await sync.upsert('P5', product);
    await expect(sync.forget('P5')).rejects.toBeInstanceOf(ForgetConflictError);
    expect(await sync.forget('P5', { force: true })).toBe(true);
  });

  it('a forget sent while the create is running is checked against the result (no orphan)', async () => {
    let release!: () => void;
    const listings: ListingsPort = {
      create: async (_input, hooks?: CreateHooks) => {
        await hooks?.beforeSend?.();
        await new Promise<void>((r) => (release = r));
        return ad;
      },
      update: async () => ad,
      delete: async () => {},
    };
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings, store });
    const creating = sync.upsert('P6', product);
    await vi.waitFor(() => expect(sync.isBusy('P6')).toBe(true));
    const forgetting = sync.forget('P6'); // operator saw "creating" and hit forget
    release();
    await creating;
    await expect(forgetting).rejects.toBeInstanceOf(ForgetConflictError);
    expect((await store.get('P6'))?.adId).toBe('ad-1');
  });

  it('link refuses an ad already linked to another product, unless replace moves it', async () => {
    const store = new MemorySyncStore();
    const sync = new SyncService({
      listings: { create: async () => ad, update: async () => ad, delete: async () => {} },
      store,
    });
    await sync.link('P-A', 'ad-777');
    const err = await sync.link('P-B', 'ad-777').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LinkConflictError);
    expect((err as LinkConflictError).otherProductId).toBe('P-A');
    await sync.link('P-B', 'ad-777', { replace: true });
    expect(await store.get('P-A')).toBeUndefined();
    expect((await store.get('P-B'))?.adId).toBe('ad-777');
  });
});

describe('round 2: security', () => {
  const API_KEY = 'test-key-0123456789abcdef';
  const auth = { 'x-api-key': API_KEY };
  const restBody = { title: 't', description: 'd', price: 1, categoryKey: 'c', locationKey: 'l' };

  async function server(handler: ConstructorParameters<typeof JobQueue>[0], maxQueued?: number) {
    const { buildServer } = await import('../src/server/app.js');
    const queue = new JobQueue(handler, { maxQueued });
    const app = buildServer({
      apiKey: API_KEY,
      queue,
      store: new MemorySyncStore(),
      resolve: { link: vi.fn(), forget: vi.fn() },
      status: async () => ({}),
    });
    return { app, queue };
  }

  it('GET /jobs/:id never returns raw OLX responses', async () => {
    const { app, queue } = await server(async () => ({
      action: 'created',
      ad: { id: 'ad-1', raw: { seller: { access_token: 'SECRET-TOKEN-FROM-OLX', phone: '70123456' } } },
    }));
    const put = await app.inject({ method: 'PUT', url: '/products/P1/listing', headers: auth, payload: restBody });
    await queue.idle();
    const job = await app.inject({ method: 'GET', url: `/jobs/${put.json<{ jobId: string }>().jobId}`, headers: auth });
    expect(job.json()).toMatchObject({ status: 'succeeded', result: { ad: { id: 'ad-1' } } });
    expect(job.body).not.toContain('SECRET-TOKEN-FROM-OLX');
    expect(job.body).not.toContain('70123456');
    await app.close();
  });

  it('rejects image URLs with embedded credentials (REST and SDK)', async () => {
    const { app } = await server(async () => undefined);
    const res = await app.inject({
      method: 'PUT',
      url: '/products/P1/listing',
      headers: auth,
      payload: { ...restBody, images: [{ url: 'https://user:pa55@cdn.example/a.png' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('pa55');
    await app.close();

    const { ImageUploader } = await import('../src/listings/images.js');
    const { placeholderAdapter } = await import('../src/listings/adapter.js');
    const up = new ImageUploader({
      http: {} as never,
      adapter: placeholderAdapter,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    });
    await expect(up.upload({ url: 'https://user:pa55@cdn.example/a.png' })).rejects.toThrow(/credentials/);
  });

  it('fetch errors never leak the full image URL', async () => {
    const { ImageUploader } = await import('../src/listings/images.js');
    const { placeholderAdapter } = await import('../src/listings/adapter.js');
    const up = new ImageUploader({
      http: {} as never,
      adapter: placeholderAdapter,
      fetchImpl: (async (u: URL) => {
        throw new TypeError(`fetch failed: ${u.href}`);
      }) as unknown as typeof fetch,
      resolveHost: async () => ['93.184.216.34'],
    });
    const err = await up.upload({ url: 'https://cdn.example/a.png?sig=QUERYSECRET' }).catch((e: Error) => e);
    expect((err as Error).message).toContain('https://cdn.example/a.png');
    expect((err as Error).message).not.toContain('QUERYSECRET');
  });

  it('caps the queue (REST answers 429)', async () => {
    let release!: () => void;
    const { app } = await server(() => new Promise<void>((r) => (release = r)), 2);
    const put = (id: string) => app.inject({ method: 'PUT', url: `/products/${id}/listing`, headers: auth, payload: restBody });
    await put('running'); // taken by the worker
    expect((await put('A')).statusCode).toBe(202);
    expect((await put('B')).statusCode).toBe(202);
    expect((await put('A')).statusCode).toBe(202); // coalesces, no new slot
    const full = await put('C');
    expect(full.statusCode).toBe(429);
    expect(full.headers['retry-after']).toBe('60');
    release();
    await app.close();
  });

  it('session state keeps only OLX cookies and storage', async () => {
    const { scopeStorageState } = await import('../src/session/SessionManager.js');
    const scoped = scopeStorageState(
      {
        cookies: [
          { name: 'sid', value: '1', domain: '.olx.com.lb', path: '/', expires: -1 },
          { name: 'SID', value: 'google', domain: '.google.com', path: '/', expires: -1 },
          { name: 'c_user', value: 'fb', domain: '.facebook.com', path: '/', expires: -1 },
          { name: 'img', value: '2', domain: 'img.cdn-example.com', path: '/', expires: -1 },
        ],
        origins: [
          { origin: 'https://www.olx.com.lb', localStorage: [{ name: 'token', value: 't' }] },
          { origin: 'https://accounts.google.com', localStorage: [{ name: 'g', value: 'x' }] },
        ],
      },
      ['olx.com.lb', 'cdn-example.com'],
    );
    expect(scoped.cookies.map((c) => c.name)).toEqual(['sid', 'img']);
    expect(Object.keys(scoped.localStorage)).toEqual(['https://www.olx.com.lb']);
  });

  it('HAR summary collapses tokens, emails and phone numbers in paths', async () => {
    const { isSensitiveSegment, summarizeHar } = await import('../src/tools/har.js');
    for (const seg of [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      '+96170123456',
      'mohammad%40example.com',
      'aZ9kQ2mN8pL4xR7tV1',
      '123456',
    ]) {
      expect(isSensitiveSegment(seg)).toBe(true);
    }
    for (const seg of ['api', 'ads', 'my-ads', 'upload', 'v2', 'listing.json']) expect(isSensitiveSegment(seg)).toBe(false);
    const [call] = summarizeHar({
      log: {
        entries: [
          {
            request: { method: 'POST', url: 'https://www.olx.com.lb/api/users/+96170123456/magic/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' },
            response: { status: 200 },
          },
        ],
      },
    });
    expect(call!.pattern).toBe('https://www.olx.com.lb/api/users/{id}/magic/{id}');
  });

  it('refunds the write slot when images fail before anything is sent to OLX', async () => {
    const transport = vi.fn<Transport>(async () => jsonResponse({ id: 'x' }));
    const { c } = client(transport);
    const failing = { ...product, images: [{ url: 'https://evil.example/x.jpg' }] }; // not allowlisted
    await expect(c.sync.upsert('P9', failing)).rejects.toThrow(/OLX_IMAGE_HOSTS/);
    expect(c.limiter.recentCount).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('round 2: docs-driven fixes', () => {
  it('accepts PHP-shaped listings: decimal-string price and [] attributes', async () => {
    const { RestListingSchema } = await import('../src/listings/types.js');
    const parsed = RestListingSchema.parse({
      title: 't',
      description: 'd',
      price: '799.00',
      categoryKey: 'c',
      locationKey: 'l',
      attributes: [],
    });
    expect(parsed.price).toBe(799);
    expect(parsed.attributes).toEqual({});
    expect(RestListingSchema.safeParse({ ...parsed, price: '79x' }).success).toBe(false);
    expect(RestListingSchema.safeParse({ ...parsed, price: '-1' }).success).toBe(false);
    expect(RestListingSchema.safeParse({ ...parsed, attributes: ['a'] }).success).toBe(false);
  });

  it('answers 503 shutting_down after the queue is stopped', async () => {
    const { buildServer } = await import('../src/server/app.js');
    const queue = new JobQueue(async () => undefined);
    const app = buildServer({
      apiKey: 'test-key-0123456789abcdef',
      queue,
      store: new MemorySyncStore(),
      resolve: { link: vi.fn(), forget: vi.fn() },
      status: async () => ({}),
    });
    queue.stop();
    const res = await app.inject({
      method: 'DELETE',
      url: '/products/P1/listing',
      headers: { 'x-api-key': 'test-key-0123456789abcdef' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'shutting_down' });
    await app.close();
  });

  it('fromConfig logs by default (missing config files are reported)', async () => {
    const { loadConfig } = await import('../src/config.js');
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'olx-cfg-'));
      OlxClient.fromConfig(
        loadConfig({
          OLX_ENDPOINTS_FILE: join(dir, 'missing-endpoints.json'),
          OLX_CATALOG_FILE: join(dir, 'missing-catalog.json'),
          OLX_REQUEST_LOG_FILE: join(dir, 'r.jsonl'),
        }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(lines.join('')).toMatch(/Catalog file not found/);
  });

  it('warns when a custom ListingsPort ignores beforeSend', async () => {
    const warn = vi.fn();
    const sync = new SyncService({
      listings: { create: async () => ({ id: 'ad-1', status: 'active', raw: {} }), update: vi.fn(), delete: vi.fn() },
      store: new MemorySyncStore(),
      logger: { debug() {}, info() {}, warn, error() {} },
    });
    await sync.upsert('P', product);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/beforeSend/), expect.anything());
  });
});

describe('round 2: shutdown and storage', () => {
  it('queue.stop() cancels queued jobs so shutdown waits only for the running one', async () => {
    let release!: () => void;
    const ran: string[] = [];
    const settled: string[] = [];
    const queue = new JobQueue(
      async (job) => {
        ran.push(job.productId);
        if (job.productId === 'A') await new Promise<void>((r) => (release = r));
      },
      { onSettled: (j) => settled.push(`${j.productId}:${j.status}`) },
    );
    queue.enqueue('remove', 'A');
    const b = queue.enqueue('remove', 'B');
    queue.enqueue('remove', 'C');
    await vi.waitFor(() => expect(ran).toEqual(['A']));
    expect(queue.stop().map((j) => j.productId)).toEqual(['B', 'C']);
    release();
    await queue.idle();
    expect(ran).toEqual(['A']);
    expect(queue.get(b.id)?.status).toBe('cancelled');
    expect(settled).toEqual(['B:cancelled', 'C:cancelled', 'A:succeeded']);
    expect(() => queue.enqueue('remove', 'D')).toThrow(/shutting down/);
  });

  it('JsonFileSyncStore rolls back memory when the write fails', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'olx-rb-')), 'data');
    const st = new JsonFileSyncStore(join(dir, 'store.json'));
    expect(await st.all()).toEqual([]); // loads fine (no file yet)
    writeFileSync(dir, 'x'); // now a FILE sits where the data folder should be → the save fails
    const rec = { productId: 'P', adId: '', status: 'unknown' as const, syncState: 'creating' as const, contentHash: 'h', createdAt: 't', lastSyncedAt: 't' };
    await expect(st.set(rec)).rejects.toThrow();
    expect(await st.get('P')).toBeUndefined();
  });
});
