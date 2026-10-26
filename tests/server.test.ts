import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server/app.js';
import { JobQueue } from '../src/server/queue.js';
import { MemorySyncStore } from '../src/sync/SyncStore.js';

const API_KEY = 'test-key-0123456789abcdef';
const body = {
  title: 'Router AX3000',
  description: 'Wi-Fi 6 router',
  price: 89,
  categoryKey: 'networking',
  locationKey: 'beirut',
  images: [{ url: 'https://cdn.zaytoon.test/router.jpg' }],
};

let app: FastifyInstance;

function setup() {
  const handled: string[] = [];
  const queue = new JobQueue(async (job, payload) => {
    handled.push(`${job.type}:${job.productId}:${payload?.currency ?? '-'}`);
    return { ok: true };
  });
  const store = new MemorySyncStore();
  const resolved: string[] = [];
  app = buildServer({
    apiKey: API_KEY,
    queue,
    store,
    resolve: {
      link: async (productId, adId) => {
        resolved.push(`link:${productId}:${adId}`);
        return { productId, adId, status: 'unknown', contentHash: '', createdAt: 't', lastSyncedAt: 't' };
      },
      forget: async (productId) => {
        resolved.push(`forget:${productId}`);
        return true;
      },
    },
    status: async () => {
      throw new Error('secret internal detail');
    },
  });
  return { queue, store, handled, resolved };
}

const auth = { 'x-api-key': API_KEY };

afterEach(async () => {
  await app?.close();
});

describe('REST server', () => {
  it('serves /health without a key but protects everything else', async () => {
    setup();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/status', headers: { 'x-api-key': 'wrong' } })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/listings', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/health' })).statusCode).toBe(401);
  });

  it('hides internal error details', async () => {
    setup();
    const res = await app.inject({ method: 'GET', url: '/status', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
  });

  it('passes ?force=true through to the job', async () => {
    const { queue } = setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/products/P-9/listing?force=true',
      headers: auth,
      payload: body,
    });
    await queue.idle();
    expect(queue.get(res.json<{ jobId: string }>().jobId)?.force).toBe(true);
  });

  it('resolves parked products by linking or forgetting', async () => {
    const { resolved } = setup();
    const link = await app.inject({
      method: 'POST',
      url: '/products/P-5/listing/resolve',
      headers: auth,
      payload: { action: 'link', adId: 'ad-77' },
    });
    expect(link.json()).toMatchObject({ adId: 'ad-77' });
    const forget = await app.inject({
      method: 'POST',
      url: '/products/P-6/listing/resolve',
      headers: auth,
      payload: { action: 'forget' },
    });
    expect(forget.json()).toEqual({ forgotten: true });
    const bad = await app.inject({
      method: 'POST',
      url: '/products/P-6/listing/resolve',
      headers: auth,
      payload: { action: 'link' },
    });
    expect(bad.statusCode).toBe(400);
    const traversal = await app.inject({
      method: 'POST',
      url: '/products/P-6/listing/resolve',
      headers: auth,
      payload: { action: 'link', adId: '..' },
    });
    expect(traversal.statusCode).toBe(400);
    expect(resolved).toEqual(['link:P-5:ad-77', 'forget:P-6']);
  });

  it('accepts an upsert, applies schema defaults, and exposes the job', async () => {
    const { queue, handled } = setup();
    const res = await app.inject({ method: 'PUT', url: '/products/P-100/listing', headers: auth, payload: body });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json<{ jobId: string }>();
    await queue.idle();
    expect(handled).toEqual(['upsert:P-100:USD']);
    const job = await app.inject({ method: 'GET', url: `/jobs/${jobId}`, headers: auth });
    expect(job.json()).toMatchObject({ status: 'succeeded', result: { ok: true } });
  });

  it('validates listings and product ids', async () => {
    setup();
    const bad = await app.inject({
      method: 'PUT',
      url: '/products/P-1/listing',
      headers: auth,
      payload: { ...body, price: -5 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_listing' });

    const localPath = await app.inject({
      method: 'PUT',
      url: '/products/P-1/listing',
      headers: auth,
      payload: { ...body, images: [{ path: '/etc/passwd' }] },
    });
    expect(localPath.statusCode).toBe(400);

    const badId = await app.inject({ method: 'DELETE', url: '/products/a%20b/listing', headers: auth });
    expect(badId.statusCode).toBe(400);
  });

  it('returns stored sync records', async () => {
    const { store } = setup();
    await store.set({
      productId: 'P-7',
      adId: 'ad-7',
      status: 'active',
      contentHash: 'h',
      createdAt: 't',
      lastSyncedAt: 't',
    });
    const one = await app.inject({ method: 'GET', url: '/products/P-7/listing', headers: auth });
    expect(one.json()).toMatchObject({ adId: 'ad-7' });
    const missing = await app.inject({ method: 'GET', url: '/products/nope/listing', headers: auth });
    expect(missing.statusCode).toBe(404);
    const all = await app.inject({ method: 'GET', url: '/listings', headers: auth });
    expect(all.json<{ listings: unknown[] }>().listings).toHaveLength(1);
  });
});
