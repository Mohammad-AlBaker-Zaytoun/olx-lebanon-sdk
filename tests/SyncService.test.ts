import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OlxHttpError } from '../src/errors.js';
import type { CreateHooks, ListingsPort } from '../src/listings/ListingsApi.js';
import type { ListingInput } from '../src/listings/types.js';
import { hashListing, SyncService } from '../src/sync/SyncService.js';
import { JsonFileSyncStore, MemorySyncStore } from '../src/sync/SyncStore.js';

const product: ListingInput = {
  title: 'Router AX3000',
  description: 'Wi-Fi 6 router',
  price: 89,
  categoryKey: 'networking',
  locationKey: 'beirut',
  attributes: { brand: 'TP-Link', condition: 'new' },
  images: [{ url: 'https://cdn.example-store.test/router.jpg' }],
};

function fakeListings(): ListingsPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: vi.fn(async (_input: ListingInput, hooks?: CreateHooks) => {
      await hooks?.beforeSend?.();
      calls.push('create');
      return { id: 'ad-1', status: 'pending_review' as const, url: 'https://olx.test/ad-1', raw: {} };
    }),
    update: vi.fn(async (adId: string) => {
      calls.push(`update:${adId}`);
      return { id: adId, status: 'unknown' as const, raw: undefined };
    }),
    delete: vi.fn(async (adId: string) => {
      calls.push(`delete:${adId}`);
    }),
  };
}

describe('hashListing', () => {
  it('ignores attribute order and surrounding whitespace', () => {
    const reordered = { ...product, title: '  Router AX3000 ', attributes: { condition: 'new', brand: 'TP-Link' } };
    expect(hashListing(reordered)).toBe(hashListing(product));
  });

  it('changes when the price changes', () => {
    expect(hashListing({ ...product, price: 79 })).not.toBe(hashListing(product));
  });
});

describe('SyncService', () => {
  it('creates once, skips unchanged content, edits on change, then deletes', async () => {
    const listings = fakeListings();
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings, store });

    const created = await sync.upsert('P-100', product);
    expect(created.action).toBe('created');
    expect(created.record).toMatchObject({ productId: 'P-100', adId: 'ad-1', status: 'pending_review' });

    expect((await sync.upsert('P-100', product)).action).toBe('unchanged');

    const updated = await sync.upsert('P-100', { ...product, price: 79 });
    expect(updated.action).toBe('updated');
    expect(updated.record.status).toBe('pending_review'); // unknown status from edit keeps the previous one
    expect(updated.record.adUrl).toBe('https://olx.test/ad-1');

    expect(await sync.remove('P-100')).toEqual({ action: 'deleted', adId: 'ad-1' });
    expect(await sync.remove('P-100')).toEqual({ action: 'not_found' });
    expect(listings.calls).toEqual(['create', 'update:ad-1', 'delete:ad-1']);
  });

  it('does not record anything when OLX rejects the create', async () => {
    const listings = fakeListings();
    vi.mocked(listings.create).mockRejectedValueOnce(new Error('rejected'));
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings, store });
    await expect(sync.upsert('P-1', product)).rejects.toThrow('rejected');
    expect(await store.all()).toEqual([]);
  });
});

describe('JsonFileSyncStore', () => {
  it('persists records across instances', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'olx-sync-')), 'store.json');
    const a = new JsonFileSyncStore(file);
    await a.set({
      productId: 'P-1',
      adId: 'ad-9',
      status: 'active',
      contentHash: 'h',
      createdAt: 't',
      lastSyncedAt: 't',
    });
    const b = new JsonFileSyncStore(file);
    expect(await b.get('P-1')).toMatchObject({ adId: 'ad-9' });
    await b.delete('P-1');
    expect(await new JsonFileSyncStore(file).all()).toEqual([]);
  });
});

describe('upsert with force', () => {
  it('re-sends the photos too, so a new picture behind the same URL reaches OLX', async () => {
    const listings = fakeListings();
    const sync = new SyncService({ listings, store: new MemorySyncStore() });
    await sync.upsert('P1', product);
    await sync.upsert('P1', { ...product, price: 99 });
    await sync.upsert('P1', { ...product, price: 99 }, { force: true });
    const opts = vi.mocked(listings.update).mock.calls.map((c) => c[2]);
    expect(opts).toEqual([{ photosUnchanged: true }, { photosUnchanged: false }]);
  });
});

describe('an ad is "gone" only when the edit or delete itself says so', () => {
  it.each(['signImageUpload', 'signedUpload', 'currentUser', 'listMyAds'])(
    'a 404 from %s leaves the link healthy and reports olx_rejected',
    async (endpoint) => {
      const listings = fakeListings();
      const store = new MemorySyncStore();
      const sync = new SyncService({ listings, store });
      await sync.upsert('P1', product);
      vi.mocked(listings.update).mockRejectedValueOnce(new OlxHttpError(endpoint, 404, {}));
      await expect(sync.upsert('P1', { ...product, price: 99 })).rejects.toMatchObject({ code: 'olx_rejected' });
      const record = await store.get('P1');
      expect(record?.adId).toBe('ad-1');
      expect(record?.syncState).toBeUndefined();
      vi.mocked(listings.delete).mockRejectedValueOnce(new OlxHttpError(endpoint, 404, {}));
      await expect(sync.remove('P1')).rejects.toMatchObject({ code: 'olx_rejected' });
      expect(await store.get('P1')).toMatchObject({ adId: 'ad-1' });
    },
  );

  it('a 404 from the edit itself marks the link gone; from the delete, removes it', async () => {
    const listings = fakeListings();
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings, store });
    await sync.upsert('P1', product);
    vi.mocked(listings.update).mockRejectedValueOnce(new OlxHttpError('updateAd', 404, {}));
    await expect(sync.upsert('P1', { ...product, price: 99 })).rejects.toMatchObject({ code: 'reconcile_required' });
    expect(await store.get('P1')).toMatchObject({ syncState: 'gone' });

    await sync.upsert('P2', product);
    vi.mocked(listings.delete).mockRejectedValueOnce(new OlxHttpError('deleteAd', 410, {}));
    expect(await sync.remove('P2')).toMatchObject({ action: 'deleted', alreadyGone: true });
  });
});

describe('link with replace while the holder is syncing', () => {
  it('waits for the holder, so the ad ends up with one product only', async () => {
    const listings = fakeListings();
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings, store });
    await sync.upsert('P1', product); // P1 → ad-1
    let release!: () => void;
    vi.mocked(listings.update).mockImplementationOnce(
      (adId: string) =>
        new Promise((resolve) => {
          release = () => resolve({ id: adId, status: 'active', raw: {} });
        }),
    );
    const editing = sync.upsert('P1', { ...product, price: 99 }); // in flight
    await new Promise((r) => setTimeout(r, 10));
    const linking = sync.link('P2', 'ad-1', { replace: true });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await editing;
    await linking;
    expect((await store.all()).map((r) => `${r.productId}->${r.adId}`)).toEqual(['P2->ad-1']);
  });

  it('two links that swap ads do not wait on each other', async () => {
    const listings = fakeListings();
    const store = new MemorySyncStore();
    const sync = new SyncService({ listings, store });
    await sync.link('A', 'ad-a');
    await sync.link('B', 'ad-b');
    await Promise.all([sync.link('A', 'ad-b', { replace: true }), sync.link('B', 'ad-a', { replace: true })]);
    const links = (await store.all()).map((r) => r.adId).sort();
    expect(new Set(links).size).toBe(links.length); // never two products on one ad
  });
});
