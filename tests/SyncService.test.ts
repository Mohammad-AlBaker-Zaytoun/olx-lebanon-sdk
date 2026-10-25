import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ListingsPort } from '../src/listings/ListingsApi.js';
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
  images: [{ url: 'https://cdn.zaytoon.test/router.jpg' }],
};

function fakeListings(): ListingsPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: vi.fn(async () => {
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
