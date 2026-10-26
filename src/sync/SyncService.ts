import { createHash } from 'node:crypto';
import { isSafePathParam } from '../endpoints.js';
import {
  ForgetConflictError,
  LinkConflictError,
  OlxHttpError,
  OlxSdkError,
  ReconcileRequiredError,
  UncertainWriteError,
} from '../errors.js';
import type { ListingsPort } from '../listings/ListingsApi.js';
import type { ActivateResult, AdStatus, ImageSource, ListingInput, OlxAd, SoldOn } from '../listings/types.js';
import { silentLogger, type Logger } from '../logger.js';
import type { MappedListing } from '../mapping/CatalogMapper.js';
import type { SyncRecord, SyncStore } from './SyncStore.js';

/**
 * `republished`: the ad was deactivated or expired, so it was brought back with the current
 * content (OLX's republish), instead of edited.
 */
export type UpsertResult =
  { action: 'created' | 'updated' | 'republished'; record: SyncRecord; ad: OlxAd } | { action: 'unchanged'; record: SyncRecord };

/** What `sync.refresh` found: links whose status changed, and products whose ad isn't in My ads. */
export interface RefreshResult {
  updated: SyncRecord[];
  /** Product ids whose ad wasn't found in the pages searched (deleted on OLX, or too old to reach). */
  missing: string[];
  checked: number;
}

/** Statuses an upsert brings back with a republish instead of an edit. */
const REPUBLISHABLE = new Set(['inactive', 'expired']);

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
    categoryId: input.categoryId === undefined ? undefined : String(input.categoryId),
    locationKey: input.locationKey,
    locationId: input.locationId === undefined ? undefined : String(input.locationId),
    attributes: sortKeys(input.attributes ?? {}),
    images: (input.images ?? []).map(imageKey),
    mapped: mapped ? { ...mapped, attributes: sortKeys(mapped.attributes) } : undefined,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Fingerprint of a product's photo list (order matters). */
export function hashImages(images: ImageSource[] | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify((images ?? []).map(imageKey)))
    .digest('hex');
}

/**
 * The ad itself is gone only when the edit or delete request answers 404/410. A 404 from another
 * call in the same operation (the account, the photo lookup, a photo upload) says nothing about
 * the ad, and treating it as "gone" would invite posting a duplicate of a live ad.
 */
const isGone = (
  err: unknown,
  endpoint: 'updateAd' | 'republishAd' | 'deleteAd' | 'deactivateAd' | 'activateAd' | 'markAdSold',
): boolean => err instanceof OlxHttpError && err.endpoint === endpoint && (err.status === 404 || err.status === 410);

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
 * Duplicate protection: a `creating` marker is saved immediately before every createAd
 * request (via the ListingsPort `beforeSend` hook — custom ports must call it). If the
 * create's outcome is unknown (timeout, 5xx, redirect, unreadable response) the product is
 * parked as `needs_reconcile` and is NOT posted again until you `link` or `forget` it.
 */
export class SyncService {
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Set<string>();

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
   * Takes the product's ad offline without deleting it (out of stock, say). The link stays, and
   * the next `upsert` brings the ad back with a republish.
   */
  deactivate(productId: string): Promise<SyncRecord> {
    return this.withLock(productId, async () => {
      const existing = await this.healthyLink(productId);
      const deactivate = this.capability('deactivate');
      await this.onAd(existing, 'deactivateAd', () => deactivate(existing.adId));
      return this.saveStatus(existing, 'inactive', 'Deactivated OLX ad');
    });
  }

  /**
   * Puts the product's `limited` ad live with a free slot, if one is left: `activated`,
   * `needs_package` or `not_limited`. The stored status follows OLX's answer.
   */
  activate(productId: string): Promise<{ result: ActivateResult; record: SyncRecord }> {
    return this.withLock(productId, async () => {
      const existing = await this.healthyLink(productId);
      const activate = this.capability('activate');
      const result = await this.onAd(existing, 'activateAd', () => activate(existing.adId));
      const status =
        result === 'activated' ? ((await this.d.listings.lookupStatus?.(existing.adId)) ?? 'active') : existing.status;
      return { result, record: await this.saveStatus(existing, status, 'Activated OLX ad') };
    });
  }

  /**
   * Marks the product's ad as sold, on OLX or elsewhere. A sold ad can't be edited: to sell the
   * product again, `forget` the link (a new ad is posted on the next upsert) or `remove` it.
   */
  markSold(productId: string, soldOn: SoldOn): Promise<SyncRecord> {
    return this.withLock(productId, async () => {
      const existing = await this.healthyLink(productId);
      const markSold = this.capability('markSold');
      await this.onAd(existing, 'markAdSold', () => markSold(existing.adId, soldOn));
      return this.saveStatus(existing, 'sold', 'Marked OLX ad as sold');
    });
  }

  /**
   * Re-reads every linked ad's status from "My ads" (reads only, not paced) and stores the ones
   * that changed: ads that expired, got rejected, went live after review… `missing` lists products
   * whose ad wasn't found in the pages searched.
   */
  async refresh(opts: { maxPages?: number } = {}): Promise<RefreshResult> {
    const listPage = this.capability('listPage');
    const records = (await this.d.store.all()).filter((r) => r.adId && !r.syncState);
    const byAd = new Map(records.map((r) => [r.adId, r]));
    const seen = new Set<string>();
    const updated: SyncRecord[] = [];
    const maxPages = opts.maxPages ?? 50;
    for (let page = 1; page <= maxPages && seen.size < byAd.size; page++) {
      const { ads, hasMore } = await listPage(page, 20);
      for (const ad of ads) {
        const record = byAd.get(ad.id);
        if (!record || seen.has(ad.id)) continue;
        seen.add(ad.id);
        if (ad.status === 'unknown' || ad.status === record.status) continue;
        const saved = await this.withLock(record.productId, async () => {
          const current = await this.d.store.get(record.productId);
          // Skip a link that changed while we were reading (a sync moved or removed it).
          if (!current || current.adId !== ad.id || current.syncState) return undefined;
          return this.saveStatus(current, ad.status, 'Refreshed OLX ad status');
        });
        if (saved) updated.push(saved);
      }
      if (!hasMore) break;
    }
    const missing = records.filter((r) => !seen.has(r.adId)).map((r) => r.productId);
    return { updated, missing, checked: seen.size };
  }

  private async healthyLink(productId: string): Promise<SyncRecord> {
    const existing = await this.d.store.get(productId);
    if (!existing) throw new OlxSdkError(`Product "${productId}" has no OLX ad linked`);
    if (existing.syncState) {
      throw new ReconcileRequiredError(productId, existing.syncState === 'gone' ? 'ad_gone' : 'uncertain_create');
    }
    return existing;
  }

  private capability<K extends 'deactivate' | 'activate' | 'markSold' | 'listPage'>(name: K): NonNullable<ListingsPort[K]> {
    const fn = this.d.listings[name];
    if (!fn) throw new OlxSdkError(`This ListingsPort has no ${name}()`);
    return fn.bind(this.d.listings) as NonNullable<ListingsPort[K]>;
  }

  /** Runs a write on the product's ad; a 404/410 from that request marks the link gone. */
  private async onAd<T>(
    existing: SyncRecord,
    endpoint: 'deactivateAd' | 'activateAd' | 'markAdSold',
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isGone(err, endpoint)) {
        await this.d.store.set({
          ...existing,
          status: 'deleted',
          syncState: 'gone',
          lastError: (err as Error).message,
          lastSyncedAt: this.now().toISOString(),
        });
        throw new ReconcileRequiredError(existing.productId, 'ad_gone');
      }
      throw err;
    }
  }

  private async saveStatus(existing: SyncRecord, status: AdStatus, message: string): Promise<SyncRecord> {
    const record: SyncRecord = { ...existing, status, lastSyncedAt: this.now().toISOString(), lastError: undefined };
    await this.d.store.set(record);
    this.logger.info(message, { productId: existing.productId, adId: existing.adId, status });
    return record;
  }

  /** True while a create for this product is in progress in this process (its marker is expected). */
  isBusy(productId: string): boolean {
    return this.inFlight.has(productId);
  }

  /**
   * Resolve a parked product (you found its ad on OLX), or adopt an ad you posted by hand.
   * The next upsert will edit that ad. Without `replace`, refuses to (a) replace a healthy
   * link to a different ad, or (b) take an ad that another product is already linked to —
   * both would leave an ad live but unmanaged, or two products editing one ad.
   */
  link(productId: string, adId: string, opts: { replace?: boolean } = {}): Promise<SyncRecord> {
    if (!isSafePathParam(adId)) return Promise.reject(new OlxSdkError(`Invalid ad id "${adId}"`));
    return this.linkLocked(productId, adId, opts, 0);
  }

  /**
   * Runs under the locks of both this product and the product currently holding the ad, so an
   * upsert of the holder that is in flight can't write its link back after it was moved here.
   */
  private async linkLocked(productId: string, adId: string, opts: { replace?: boolean }, attempt: number): Promise<SyncRecord> {
    const holderNow = await this.holderOf(adId, productId);
    const ids = holderNow ? [productId, holderNow] : [productId];
    const result = await this.withLocks(ids, async () => {
      const holder = await this.holderOf(adId, productId);
      // Another product took the ad while we waited for the locks: start over with that one.
      if (holder !== holderNow) return undefined;
      const existing = await this.d.store.get(productId);
      if (existing && !existing.syncState && existing.adId !== adId && !opts.replace) {
        throw new LinkConflictError(productId, existing.adId);
      }
      if (holder) {
        if (!opts.replace) throw new LinkConflictError(productId, adId, holder);
        await this.d.store.delete(holder);
        this.logger.warn('Moved ad link from another product', { adId, from: holder, to: productId });
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
    if (result) return result;
    if (attempt >= 5) throw new OlxSdkError(`Ad ${adId} kept changing hands while linking; try again`);
    return this.linkLocked(productId, adId, opts, attempt + 1);
  }

  private async holderOf(adId: string, except: string): Promise<string | undefined> {
    return (await this.d.store.all()).find((r) => r.productId !== except && r.adId === adId)?.productId;
  }

  /** Locks several products, always in the same order, so two calls can't wait on each other. */
  private withLocks<T>(productIds: string[], fn: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...new Set(productIds)].sort();
    if (first === undefined) return fn();
    return this.withLock(first, () => this.withLocks(rest, fn));
  }

  /**
   * Resolve a parked product: no ad exists (or you deleted it). The next upsert will create one.
   * A healthy link is refused unless `force` is set, because forgetting it leaves that ad live
   * on OLX but unmanaged, and the next sync would post a second one. (Runs under the product
   * lock, so a forget sent while a create is running is checked against the create's result.)
   */
  forget(productId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    return this.withLock(productId, async () => {
      const existing = await this.d.store.get(productId);
      // A sold or deleted ad isn't live, so forgetting it can't leave a live ad unmanaged.
      const live = existing && !existing.syncState && existing.status !== 'sold' && existing.status !== 'deleted';
      if (live && !opts.force) {
        throw new ForgetConflictError(productId, existing.adId);
      }
      await this.d.store.delete(productId);
      if (existing) this.logger.info('Forgot product link', { productId, adId: existing.adId || undefined });
      return existing !== undefined;
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
    if (existing?.status === 'sold') throw new ReconcileRequiredError(productId, 'ad_sold');
    const republish = existing !== undefined && REPUBLISHABLE.has(existing.status);
    if (existing && !opts.force && !republish && existing.contentHash === contentHash) {
      this.logger.debug('Listing unchanged; skipping', { productId, adId: existing.adId });
      return { action: 'unchanged', record: existing };
    }
    if (!existing) return this.create(productId, input, contentHash);

    let ad: OlxAd;
    try {
      ad = await this.d.listings.update(existing.adId, input, {
        // `force` re-sends everything, photos included (e.g. a new picture behind the same URL).
        photosUnchanged: !opts.force && existing.imagesHash !== undefined && existing.imagesHash === hashImages(input.images),
        ...(republish ? { republish: true } : {}),
      });
    } catch (err) {
      if (isGone(err, republish ? 'republishAd' : 'updateAd')) {
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
      imagesHash: hashImages(input.images),
      lastSyncedAt: this.now().toISOString(),
      lastError: undefined,
    };
    if (republish && ad.status === 'unknown') record.status = 'unknown'; // no longer inactive/expired; looked up below
    await this.d.store.set(record);
    this.logger.info(republish ? 'Republished OLX ad' : 'Updated OLX ad', { productId, adId: existing.adId });
    return { action: republish ? 'republished' : 'updated', record: await this.withLookedUpStatus(record, ad), ad };
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
    let markerSaved = false;
    // Saved right BEFORE the createAd request leaves (after the rate-limit wait and image
    // uploads): if the process dies mid-create the product stays parked instead of being
    // posted twice, and a crash while merely waiting for a write slot parks nothing.
    const beforeSend = async () => {
      await this.d.store.set(marker);
      markerSaved = true;
    };

    let ad: OlxAd;
    this.inFlight.add(productId);
    try {
      ad = await this.d.listings.create(input, { beforeSend });
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
      if (markerSaved) {
        await this.d.store
          .delete(productId)
          .catch((e) => this.logger.error('Could not clear create marker', { productId, error: (e as Error).message }));
      }
      throw err;
    } finally {
      this.inFlight.delete(productId);
    }
    if (!markerSaved) {
      // The ListingsPort didn't call beforeSend: no crash protection for this create.
      this.logger.warn('ListingsPort.create did not call hooks.beforeSend; duplicate protection is degraded', {
        productId,
      });
    }

    const record: SyncRecord = {
      productId,
      adId: ad.id,
      adUrl: ad.url,
      status: ad.status,
      contentHash,
      imagesHash: hashImages(input.images),
      createdAt: ts,
      lastSyncedAt: this.now().toISOString(),
    };
    try {
      await this.d.store.set(record);
    } catch (err) {
      // The `creating` marker (saved before sending) is what remains in the store, so the
      // product stays parked rather than being posted again.
      this.logger.error('CRITICAL: ad created on OLX but its link could not be saved', { productId, adId: ad.id });
      throw new OlxSdkError(
        `Ad ${ad.id} was created on OLX for product "${productId}" but the link could not be saved. ` +
          `Link it manually (adId ${ad.id}) once storage works again.`,
        { cause: err },
      );
    }
    this.logger.info('Created OLX ad', { productId, adId: ad.id });
    return { action: 'created', record: await this.withLookedUpStatus(record, ad), ad };
  }

  /**
   * After the result is saved: when the write's response had no state (OLX's post-ad gives
   * ids only), ask OLX for it, so an ad that went straight to `limited` is recorded as such.
   * Best effort and only after saving, so a slow or failing lookup can't lose a create.
   */
  private async withLookedUpStatus(record: SyncRecord, ad: OlxAd): Promise<SyncRecord> {
    if (ad.status !== 'unknown' || !this.d.listings.lookupStatus) return record;
    let status: AdStatus | undefined;
    try {
      status = await this.d.listings.lookupStatus(record.adId);
    } catch (err) {
      this.logger.warn('Could not look up the ad state', { productId: record.productId, error: (err as Error).message });
      return record;
    }
    if (!status || status === 'unknown' || status === record.status) return record;
    const updated = { ...record, status };
    try {
      await this.d.store.set(updated);
    } catch (err) {
      this.logger.warn('Could not save the looked-up ad state', { productId: record.productId, error: (err as Error).message });
      return record;
    }
    if (status === 'limited') {
      this.logger.warn('OLX ad is limited: it needs a paid package to be visible', {
        productId: record.productId,
        adId: record.adId,
      });
    }
    return updated;
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
        if (!isGone(err, 'deleteAd')) throw err;
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
