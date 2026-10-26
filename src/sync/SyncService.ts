import { createHash } from 'node:crypto';
import { isSafePathParam } from '../endpoints.js';
import {
  LinkConflictError,
  OlxHttpError,
  OlxSdkError,
  ReconcileRequiredError,
  UncertainWriteError,
} from '../errors.js';
import type { ListingsPort } from '../listings/ListingsApi.js';
import type { ImageSource, ListingInput, OlxAd } from '../listings/types.js';
import { silentLogger, type Logger } from '../logger.js';
import type { MappedListing } from '../mapping/CatalogMapper.js';
import type { SyncRecord, SyncStore } from './SyncStore.js';

export type UpsertResult =
  | { action: 'created' | 'updated'; record: SyncRecord; ad: OlxAd }
  | { action: 'unchanged'; record: SyncRecord };

export type RemoveResult = { action: 'deleted'; adId: string; alreadyGone?: boolean } | { action: 'not_found' };

export interface UpsertOptions {
  /** Push even if the content fingerprint is unchanged (e.g. after changing your adapter). */
  force?: boolean;
}

function imageKey(img: ImageSource): string {
  if ('url' in img) return `url:${img.url}`;
  if ('path' in img) return `path:${img.path}`;
  return `data:${createHash('sha256').update(img.data).digest('hex')}`;
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Stable fingerprint of everything that would end up on the ad. When `mapped` is given
 * (the client always passes it), catalog changes — a corrected category id, a renamed
 * attribute, a new default — also change the fingerprint, so existing ads get fixed.
 */
export function hashListing(input: ListingInput, mapped?: MappedListing): string {
  const canonical = {
    title: input.title.trim(),
    description: input.description.trim(),
    price: input.price,
    currency: input.currency ?? 'USD',
    categoryKey: input.categoryKey,
    locationKey: input.locationKey,
    attributes: sortKeys(input.attributes ?? {}),
    images: (input.images ?? []).map(imageKey),
    mapped: mapped ? { ...mapped, attributes: sortKeys(mapped.attributes) } : undefined,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const isGone = (err: unknown): boolean =>
  err instanceof OlxHttpError && (err.status === 404 || err.status === 410);

export interface SyncServiceDeps {
  listings: ListingsPort;
  store: SyncStore;
  /** Used to include the mapped OLX fields in the fingerprint. */
  mapper?: { resolve(input: ListingInput): MappedListing };
  logger?: Logger;
  now?: () => Date;
}

/**
 * Keeps one OLX ad per store product: the first sync creates it, later syncs edit it in
 * place (never repost), and identical content is skipped.
 *
 * Duplicate protection: a `creating` marker is saved before every create. If the create's
 * outcome is unknown (timeout, 5xx, unreadable response) the product is parked as
 * `needs_reconcile` and is NOT posted again until you `link` or `forget` it.
 */
export class SyncService {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly d: SyncServiceDeps) {
    this.logger = d.logger ?? silentLogger;
    this.now = d.now ?? (() => new Date());
  }

  upsert(productId: string, input: ListingInput, opts: UpsertOptions = {}): Promise<UpsertResult> {
    return this.withLock(productId, () => this.doUpsert(productId, input, opts));
  }

  remove(productId: string): Promise<RemoveResult> {
    return this.withLock(productId, () => this.doRemove(productId));
  }

  /**
   * Resolve a parked product (you found its ad on OLX), or adopt an ad you posted by hand.
   * The next upsert will edit that ad. Refuses to silently replace a healthy link to a
   * different ad unless `replace` is set.
   */
  link(productId: string, adId: string, opts: { replace?: boolean } = {}): Promise<SyncRecord> {
    return this.withLock(productId, async () => {
      if (!isSafePathParam(adId)) throw new OlxSdkError(`Invalid ad id "${adId}"`);
      const existing = await this.d.store.get(productId);
      if (existing && !existing.syncState && existing.adId !== adId && !opts.replace) {
        throw new LinkConflictError(productId, existing.adId);
      }
      const ts = this.now().toISOString();
      const record: SyncRecord = {
        productId,
        adId,
        status: 'unknown',
        contentHash: '', // forces the next upsert to push current content to this ad
        createdAt: existing?.createdAt ?? ts,
        lastSyncedAt: ts,
      };
      await this.d.store.set(record);
      this.logger.info('Linked product to OLX ad', { productId, adId });
      return record;
    });
  }

  /** Resolve a parked product: no ad exists (or you deleted it). The next upsert will create one. */
  forget(productId: string): Promise<boolean> {
    return this.withLock(productId, async () => {
      const existed = (await this.d.store.get(productId)) !== undefined;
      await this.d.store.delete(productId);
      if (existed) this.logger.info('Forgot product link', { productId });
      return existed;
    });
  }

  private fingerprint(input: ListingInput): string {
    return hashListing(input, this.d.mapper?.resolve(input));
  }

  private async doUpsert(productId: string, input: ListingInput, opts: UpsertOptions): Promise<UpsertResult> {
    const contentHash = this.fingerprint(input); // also validates the mapping up front
    const existing = await this.d.store.get(productId);

    if (existing?.syncState) {
      throw new ReconcileRequiredError(productId, existing.syncState === 'gone' ? 'ad_gone' : 'uncertain_create');
    }
    if (existing && !opts.force && existing.contentHash === contentHash) {
      this.logger.debug('Listing unchanged; skipping', { productId, adId: existing.adId });
      return { action: 'unchanged', record: existing };
    }
    if (!existing) return this.create(productId, input, contentHash);

    let ad: OlxAd;
    try {
      ad = await this.d.listings.update(existing.adId, input);
    } catch (err) {
      if (isGone(err)) {
        await this.d.store.set({
          ...existing,
          status: 'deleted',
          syncState: 'gone',
          lastError: (err as Error).message,
          lastSyncedAt: this.now().toISOString(),
        });
        throw new ReconcileRequiredError(productId, 'ad_gone');
      }
      throw err;
    }
    const record: SyncRecord = {
      ...existing,
      adUrl: ad.url ?? existing.adUrl,
      status: ad.status === 'unknown' ? existing.status : ad.status,
      contentHash,
      lastSyncedAt: this.now().toISOString(),
      lastError: undefined,
    };
    await this.d.store.set(record);
    this.logger.info('Updated OLX ad', { productId, adId: existing.adId });
    return { action: 'updated', record, ad };
  }

  private async create(productId: string, input: ListingInput, contentHash: string): Promise<UpsertResult> {
    const ts = this.now().toISOString();
    const marker: SyncRecord = {
      productId,
      adId: '',
      status: 'unknown',
      syncState: 'creating',
      contentHash,
      createdAt: ts,
      lastSyncedAt: ts,
    };
    // Saved BEFORE calling OLX: if the process dies mid-create, the product stays parked
    // instead of being posted a second time on the next sync.
    await this.d.store.set(marker);

    let ad: OlxAd;
    try {
      ad = await this.d.listings.create(input);
    } catch (err) {
      if (err instanceof UncertainWriteError) {
        this.logger.error('Create outcome unknown; product parked for reconciliation', {
          productId,
          error: err.message,
        });
        await this.d.store
          .set({ ...marker, syncState: 'needs_reconcile', lastError: err.message })
          .catch((e) => this.logger.error('Could not save reconcile marker', { productId, error: (e as Error).message }));
        throw err;
      }
      // Definitely not created (validation, auth, 4xx, image failure…): clear the marker.
      await this.d.store
        .delete(productId)
        .catch((e) => this.logger.error('Could not clear create marker', { productId, error: (e as Error).message }));
      throw err;
    }

    const record: SyncRecord = {
      productId,
      adId: ad.id,
      adUrl: ad.url,
      status: ad.status,
      contentHash,
      createdAt: ts,
      lastSyncedAt: this.now().toISOString(),
    };
    try {
      await this.d.store.set(record);
    } catch (err) {
      // The `creating` marker is still on disk, so the product stays parked rather than duplicated.
      this.logger.error('CRITICAL: ad created on OLX but its link could not be saved', { productId, adId: ad.id });
      throw new OlxSdkError(
        `Ad ${ad.id} was created on OLX for product "${productId}" but the link could not be saved. ` +
          `Link it manually (adId ${ad.id}) once storage works again.`,
        { cause: err },
      );
    }
    this.logger.info('Created OLX ad', { productId, adId: ad.id });
    return { action: 'created', record, ad };
  }

  private async doRemove(productId: string): Promise<RemoveResult> {
    const existing = await this.d.store.get(productId);
    if (!existing) return { action: 'not_found' };
    if (existing.syncState === 'creating' || existing.syncState === 'needs_reconcile') {
      throw new ReconcileRequiredError(productId, 'uncertain_create');
    }

    let alreadyGone = existing.syncState === 'gone';
    if (!alreadyGone) {
      try {
        await this.d.listings.delete(existing.adId);
      } catch (err) {
        if (!isGone(err)) throw err;
        alreadyGone = true;
      }
    }
    await this.d.store.delete(productId);
    this.logger.info(alreadyGone ? 'OLX ad was already gone; link removed' : 'Deleted OLX ad', {
      productId,
      adId: existing.adId,
    });
    return alreadyGone ? { action: 'deleted', adId: existing.adId, alreadyGone } : { action: 'deleted', adId: existing.adId };
  }

  /** Serialises all operations for one product, so concurrent SDK calls can't create two ads. */
  private withLock<T>(productId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(productId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(productId, tail);
    void tail.then(() => {
      if (this.locks.get(productId) === tail) this.locks.delete(productId);
    });
    return run;
  }
}
