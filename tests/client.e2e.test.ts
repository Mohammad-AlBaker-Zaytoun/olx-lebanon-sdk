import { placeholderAdapter } from '../src/listings/adapter.js';
import { describe, expect, it, vi } from 'vitest';
import { OlxClient } from '../src/client.js';
import { parseEndpoints } from '../src/endpoints.js';
import { AuthError, ImageUploadError, ReconcileRequiredError, UncertainWriteError } from '../src/errors.js';
import type { Transport } from '../src/http/HttpClient.js';
import { MemorySessionStore } from '../src/session/storage.js';
import { MemorySyncStore } from '../src/sync/SyncStore.js';
import { catalog, fakeClock, jsonResponse, session } from './helpers.js';

const endpoints = parseEndpoints({
  createAd: { method: 'POST', path: '/api/ads' },
  updateAd: { method: 'PUT', path: '/api/ads/{id}' },
  deleteAd: { method: 'DELETE', path: '/api/ads/{id}' },
  uploadImage: { method: 'POST', path: 'https://img.olx.com.lb/upload' },
});

const product = {
  title: 'Pixel 9',
  description: 'Brand new, 1 year warranty',
  price: 650,
  categoryKey: 'phones',
  locationKey: 'beirut',
  attributes: { brand: 'Google' },
  images: [{ url: 'https://cdn.zaytoon.test/pixel.jpg' }],
};

function makeClient(sessionData = session) {
  const transport = vi.fn<Transport>(async (url, init) => {
    if (url.startsWith('https://img.olx.com.lb')) return jsonResponse({ id: 'img-1' });
    if (init.method === 'POST') return jsonResponse({ data: { id: 'ad-55', status: 'pending' } }, 201);
    if (init.method === 'PUT') return new Response(null, { status: 204 });
    return new Response(null, { status: 204 });
  });
  const imageFetch = vi.fn(
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
  ) as unknown as typeof fetch;
  const client = new OlxClient({
    adapter: placeholderAdapter,
    baseUrl: 'https://www.olx.com.lb',
    endpoints,
    catalog,
    sessionStore: new MemorySessionStore(sessionData),
    syncStore: new MemorySyncStore(),
    writeLimits: { minIntervalMs: 0, jitterMs: 0, maxPerHour: 100 },
    clock: fakeClock(),
    transport,
    imageFetch,
    allowedImageHosts: ['zaytoon.test'],
  });
  return { client, transport };
}

describe('OlxClient end to end (mocked OLX)', () => {
  it('an adapter that does not keep photos gets them re-uploaded on every edit', async () => {
    const { client, transport } = makeClient();
    await client.sync.upsert('P-1', product);
    await client.sync.upsert('P-1', { ...product, price: 599 }); // same photos
    expect(transport.mock.calls.filter(([url]) => url.startsWith('https://img.olx.com.lb'))).toHaveLength(2);
  });

  it('uploads images, creates the ad, then edits it in place', async () => {
    const { client, transport } = makeClient();

    const created = await client.sync.upsert('P-1', product);
    expect(created.action).toBe('created');
    expect(created.record).toMatchObject({ adId: 'ad-55', status: 'pending_review' });

    const [uploadUrl, uploadInit] = transport.mock.calls[0]!;
    expect(uploadUrl).toBe('https://img.olx.com.lb/upload');
    expect(uploadInit.body).toBeInstanceOf(FormData);

    const [createUrl, createInit] = transport.mock.calls[1]!;
    expect(createUrl).toBe('https://www.olx.com.lb/api/ads');
    expect(JSON.parse(String(createInit.body))).toEqual({
      title: 'Pixel 9',
      description: 'Brand new, 1 year warranty',
      price: { value: 650, currency: 'USD' },
      category_id: '123',
      location_id: 'loc-1',
      attributes: { make: 'Google', condition: 'new' },
      images: ['img-1'],
    });

    const updated = await client.sync.upsert('P-1', { ...product, price: 599 });
    expect(updated.action).toBe('updated');
    expect(transport.mock.calls.at(-1)![0]).toBe('https://www.olx.com.lb/api/ads/ad-55');

    expect(await client.sync.remove('P-1')).toEqual({ action: 'deleted', adId: 'ad-55' });
    expect(client.endpointStatus()).toMatchObject({ createAd: true, getAd: false });
  });

  it('parks the product when OLX accepts a create but the response has no readable id', async () => {
    const { client, transport } = makeClient();
    transport.mockImplementation(async (url) =>
      url.startsWith('https://img.olx.com.lb') ? jsonResponse({ id: 'img-1' }) : jsonResponse({ ok: true }, 201),
    );
    await expect(client.sync.upsert('P-9', product)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await client.syncStore.get('P-9'))?.syncState).toBe('needs_reconcile');
    await expect(client.sync.upsert('P-9', product)).rejects.toBeInstanceOf(ReconcileRequiredError);
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/api/ads'))).toHaveLength(1);
  });

  it('does not park the product when only an image upload failed (no ad was sent)', async () => {
    const { client, transport } = makeClient();
    transport.mockImplementation(async (url) =>
      url.startsWith('https://img.olx.com.lb') ? jsonResponse({ error: 'busy' }, 503) : jsonResponse({ id: 'ad-1' }),
    );
    await expect(client.sync.upsert('P-8', product)).rejects.toBeInstanceOf(ImageUploadError);
    expect(await client.syncStore.get('P-8')).toBeUndefined();
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/api/ads'))).toHaveLength(0);

    // Once the image host recovers, the next sync simply creates the ad.
    transport.mockImplementation(async (url) =>
      url.startsWith('https://img.olx.com.lb') ? jsonResponse({ id: 'img-1' }) : jsonResponse({ id: 'ad-1' }, 201),
    );
    expect((await client.sync.upsert('P-8', product)).action).toBe('created');
  });

  it('parks the product when a create is answered with a non-login redirect', async () => {
    const { client, transport } = makeClient();
    transport.mockImplementation(async (url) =>
      url.startsWith('https://img.olx.com.lb')
        ? jsonResponse({ id: 'img-1' })
        : new Response(null, { status: 303, headers: { location: '/ad/ID123.html' } }),
    );
    await expect(client.sync.upsert('P-7', product)).rejects.toBeInstanceOf(UncertainWriteError);
    expect((await client.syncStore.get('P-7'))?.syncState).toBe('needs_reconcile');
  });

  it('rejects image hosts outside the allowlist before touching OLX', async () => {
    const { client, transport } = makeClient();
    await expect(
      client.sync.upsert('P-2', { ...product, images: [{ url: 'https://evil.test/x.jpg' }] }),
    ).rejects.toThrow(/not in OLX_IMAGE_HOSTS/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('asks you to log in when there is no session', async () => {
    const { client } = makeClient(null as never);
    await expect(client.sync.upsert('P-3', product)).rejects.toBeInstanceOf(AuthError);
  });
});
