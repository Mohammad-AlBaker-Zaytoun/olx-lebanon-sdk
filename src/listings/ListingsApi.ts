import { ImageUploadError, OlxSdkError, UncertainWriteError } from '../errors.js';
import type { OlxHttpClient } from '../http/HttpClient.js';
import type { Logger } from '../logger.js';
import type { SessionProvider } from '../session/SessionManager.js';
import type { CatalogMapper } from '../mapping/CatalogMapper.js';
import type { OlxAdapter, PayloadContext } from './adapter.js';
import type { ImageUploader } from './images.js';
import type { AccountInfo, AdStatus, ContactSettings, ListingInput, OlxAd, UploadedImage } from './types.js';

export interface CreateHooks {
  /**
   * Called (and awaited) immediately before the createAd request is sent — after mapping,
   * the rate-limit wait and image uploads. If it throws, nothing is sent. SyncService uses it
   * to persist its duplicate-protection marker; custom ListingsPort implementations must call it.
   */
  beforeSend?: () => Promise<void>;
}

export interface UpdateOptions {
  /**
   * The product's photos are the same as at the last sync. If the adapter keeps existing
   * photos when none are sent, they aren't uploaded again (so they don't pile up on OLX).
   */
  photosUnchanged?: boolean;
}

export interface ListingsPort {
  create(input: ListingInput, hooks?: CreateHooks): Promise<OlxAd>;
  update(adId: string, input: ListingInput, opts?: UpdateOptions): Promise<OlxAd>;
  delete(adId: string): Promise<void>;
  /**
   * Optional, best effort: the ad's current state, for writes whose response had none.
   * Called after the result is saved; must never throw for a missing ad (return undefined).
   */
  lookupStatus?(adId: string): Promise<AdStatus | undefined>;
}

export interface ListingsApiDeps {
  http: OlxHttpClient;
  mapper: CatalogMapper;
  adapter: OlxAdapter;
  images: ImageUploader;
  /** Contact settings from configuration; empty fields fall back to the account profile. */
  contact?: ContactSettings;
  /** The session, so the cached account follows a new login. */
  session?: SessionProvider;
  logger?: Logger;
}

/**
 * "My ads" lookups are best effort: newest pages only (a freshly written ad is near the
 * top), no retries and a short timeout, so they stay cheap and never hold up a job.
 */
const LOOKUP_PAGES = 3;
const LOOKUP_PAGE_SIZE = 20; // the web app's own page size
const LOOKUP_TIMEOUT_MS = 10_000;
/** Pages of "My ads" searched for an ad's current photos before an edit that replaces them. */
const PHOTO_LOOKUP_PAGES = 50;

/** Create, edit, delete and read ads on your own OLX account. */
export class ListingsApi implements ListingsPort {
  private account?: { key: string | undefined; value: Promise<AccountInfo> };

  constructor(private readonly d: ListingsApiDeps) {}

  /**
   * The logged-in account, read from OLX (`currentUser`) and cached per saved session: after
   * `npm run login` it is read again. A failed read is not cached.
   */
  async getAccount(): Promise<AccountInfo> {
    const parse = this.d.adapter.parseAccount?.bind(this.d.adapter);
    if (!parse) throw new OlxSdkError('This adapter does not read account details');
    const key = this.d.session ? (await this.d.session.getSession()).savedAt : undefined;
    if (this.account && this.account.key === key) return this.account.value;
    const entry = { key, value: this.d.http.call('currentUser').then(parse) };
    this.account = entry;
    entry.value.catch(() => {
      if (this.account === entry) this.account = undefined;
    });
    return entry.value;
  }

  private async context(mode: PayloadContext['mode']): Promise<PayloadContext> {
    const account = this.d.adapter.parseAccount ? await this.getAccount() : undefined;
    const c = this.d.contact ?? {};
    return {
      mode,
      account,
      contact: { name: c.name || account?.name, phone: c.phone || account?.phone, method: c.method },
      images: [],
    };
  }

  private payload(mapped: ReturnType<CatalogMapper['resolve']>, images: UploadedImage[], ctx: PayloadContext): unknown {
    return this.d.adapter.buildAdPayload(
      mapped,
      images.map((i) => i.id),
      { ...ctx, images },
    );
  }

  async create(input: ListingInput, hooks: CreateHooks = {}): Promise<OlxAd> {
    // Map first so a bad product fails before anything is sent.
    const mapped = this.d.mapper.resolve(input);
    // Account details too: a missing session fails here, before any photo is uploaded.
    const ctx = await this.context('create');
    // Take the write slot before uploading, so images aren't uploaded long before the ad that uses them.
    const refund = await this.d.http.acquireWriteSlot();
    const images = await this.uploadImages(input, refund, ctx);
    const raw = await this.d.http.call('createAd', {
      json: this.payload(mapped, images, ctx),
      rateLimit: false,
      beforeSend: hooks.beforeSend,
    });
    let ad: OlxAd;
    try {
      ad = this.d.adapter.parseAd(raw);
    } catch (err) {
      // OLX accepted the request, but we can't tell which ad it made: never treat this as "not created".
      throw new UncertainWriteError(
        'createAd',
        `OLX accepted the ad but the response could not be read: ${(err as Error).message}`,
        {
          cause: err,
          body: raw,
        },
      );
    }
    return ad;
  }

  async update(adId: string, input: ListingInput, opts: UpdateOptions = {}): Promise<OlxAd> {
    const mapped = this.d.mapper.resolve(input);
    const ctx = await this.context('update');
    const keepPhotos = opts.photosUnchanged === true && this.d.adapter.keepsPhotosWhenNoneSent === true;
    if (keepPhotos) {
      ctx.photos = { mode: 'keep' };
    } else if (this.d.adapter.readPhotoIds) {
      // Read the ad's current photos BEFORE taking a write slot or uploading anything: if
      // they can't be found, nothing is sent (an edit would otherwise pile photos up).
      const current = await this.findMine(adId, PHOTO_LOOKUP_PAGES);
      if (!current) {
        throw new OlxSdkError(`Ad ${adId} was not found in "My ads", so its current photos are unknown; the edit was not sent`);
      }
      ctx.photos = { mode: 'replace', existingPhotoIds: this.d.adapter.readPhotoIds(current.raw) };
    }
    const refund = await this.d.http.acquireWriteSlot();
    const images = keepPhotos ? [] : await this.uploadImages(input, refund, ctx);
    const raw = await this.d.http.call('updateAd', {
      params: { id: adId },
      json: this.payload(mapped, images, ctx),
      rateLimit: false,
    });
    // Some edit endpoints answer 204/empty; the ad id doesn't change on edit.
    let ad: OlxAd;
    if (raw === undefined || raw === '') {
      ad = { id: adId, status: 'unknown', raw };
    } else {
      try {
        ad = this.d.adapter.parseAd(raw);
      } catch {
        ad = { id: adId, status: 'unknown', raw };
      }
    }
    return ad;
  }

  /**
   * The ad's state from "My ads" (OLX's post-ad answers with ids only, so an ad that went
   * straight to `limited` shows up here). Best effort: errors give undefined.
   */
  async lookupStatus(adId: string): Promise<AdStatus | undefined> {
    try {
      return (await this.findMine(adId))?.status;
    } catch (err) {
      this.d.logger?.warn('Could not look up the ad state', { adId, error: (err as Error).message });
      return undefined;
    }
  }

  /** Looks an ad up in the newest pages of "My ads". Returns undefined if it isn't there. */
  async findMine(adId: string, maxPages = LOOKUP_PAGES): Promise<OlxAd | undefined> {
    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.d.http.call('listMyAds', {
        query: { page, per_page: LOOKUP_PAGE_SIZE },
        retries: 0,
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      const ads = this.d.adapter.parseAdList(raw);
      const hit = ads.find((a) => a.id === adId);
      if (hit) return hit;
      const more = this.d.adapter.hasNextPage ? this.d.adapter.hasNextPage(raw) : ads.length >= LOOKUP_PAGE_SIZE;
      if (!more) return undefined;
    }
    return undefined;
  }

  /**
   * An image upload with an unknown outcome is not an uncertain *ad*: no ad request has been
   * sent yet, so at worst an orphan image exists on OLX. Report it as a plain failure so
   * the product isn't parked for manual reconciliation. The write slot is refunded, since no
   * ad write happened.
   */
  private async uploadImages(input: ListingInput, refundSlot: () => void, ctx: PayloadContext): Promise<UploadedImage[]> {
    try {
      return await this.d.images.uploadAll(input.images ?? [], ctx.account);
    } catch (err) {
      refundSlot();
      if (err instanceof UncertainWriteError) {
        throw new ImageUploadError(`Image upload failed before the ad was sent: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  async delete(adId: string): Promise<void> {
    await this.d.http.call('deleteAd', { params: { id: adId } });
  }

  async get(adId: string): Promise<OlxAd> {
    return this.d.adapter.parseAd(await this.d.http.call('getAd', { params: { id: adId } }));
  }

  async listMine(query?: Record<string, string | number | boolean | undefined>): Promise<OlxAd[]> {
    return this.d.adapter.parseAdList(await this.d.http.call('listMyAds', { query }));
  }
}
