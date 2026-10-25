import { createHash } from 'node:crypto';
import type { ListingsPort } from '../listings/ListingsApi.js';
import type { ImageSource, ListingInput, OlxAd } from '../listings/types.js';
import { silentLogger, type Logger } from '../logger.js';
import type { SyncRecord, SyncStore } from './SyncStore.js';

export type UpsertResult =
  | { action: 'created' | 'updated'; record: SyncRecord; ad: OlxAd }
  | { action: 'unchanged'; record: SyncRecord };

export type RemoveResult = { action: 'deleted'; adId: string } | { action: 'not_found' };

function imageKey(img: ImageSource): string {
  if ('url' in img) return `url:${img.url}`;
  if ('path' in img) return `path:${img.path}`;
  return `data:${createHash('sha256').update(img.data).digest('hex')}`;
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** Stable fingerprint of everything that would end up on the ad. */
export function hashListing(input: ListingInput): string {
  const canonical = {
    title: input.title.trim(),
    description: input.description.trim(),
    price: input.price,
    currency: input.currency ?? 'USD',
    categoryKey: input.categoryKey,
    locationKey: input.locationKey,
    attributes: sortKeys(input.attributes ?? {}),
    images: (input.images ?? []).map(imageKey),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface SyncServiceDeps {
  listings: ListingsPort;
  store: SyncStore;
  logger?: Logger;
  now?: () => Date;
}

/**
 * Keeps one OLX ad per store product: first sync creates it, later syncs edit it in
 * place (never repost), and identical content is skipped entirely.
 */
export class SyncService {
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly d: SyncServiceDeps) {
    this.logger = d.logger ?? silentLogger;
    this.now = d.now ?? (() => new Date());
  }

  async upsert(productId: string, input: ListingInput): Promise<UpsertResult> {
    const contentHash = hashListing(input);
    const existing = await this.d.store.get(productId);
    const ts = this.now().toISOString();

    if (existing && existing.contentHash === contentHash) {
      this.logger.debug('Listing unchanged; skipping', { productId, adId: existing.adId });
      return { action: 'unchanged', record: existing };
    }

    if (!existing) {
      const ad = await this.d.listings.create(input);
      const record: SyncRecord = {
        productId,
        adId: ad.id,
        adUrl: ad.url,
        status: ad.status,
        contentHash,
        createdAt: ts,
        lastSyncedAt: ts,
      };
      // Persist immediately: losing this link is what would cause a duplicate ad later.
      await this.d.store.set(record);
      this.logger.info('Created OLX ad', { productId, adId: ad.id });
      return { action: 'created', record, ad };
    }

    const ad = await this.d.listings.update(existing.adId, input);
    const record: SyncRecord = {
      ...existing,
      adUrl: ad.url ?? existing.adUrl,
      status: ad.status === 'unknown' ? existing.status : ad.status,
      contentHash,
      lastSyncedAt: ts,
    };
    await this.d.store.set(record);
    this.logger.info('Updated OLX ad', { productId, adId: existing.adId });
    return { action: 'updated', record, ad };
  }

  async remove(productId: string): Promise<RemoveResult> {
    const existing = await this.d.store.get(productId);
    if (!existing) return { action: 'not_found' };
    await this.d.listings.delete(existing.adId);
    await this.d.store.delete(productId);
    this.logger.info('Deleted OLX ad', { productId, adId: existing.adId });
    return { action: 'deleted', adId: existing.adId };
  }
}
