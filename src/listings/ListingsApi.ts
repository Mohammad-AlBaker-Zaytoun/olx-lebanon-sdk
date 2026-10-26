import { ImageUploadError, OlxSdkError, UncertainWriteError } from '../errors.js';
import type { OlxHttpClient } from '../http/HttpClient.js';
import type { Logger } from '../logger.js';
import type { CatalogMapper } from '../mapping/CatalogMapper.js';
import type { OlxAdapter, PayloadContext } from './adapter.js';
import type { ImageUploader } from './images.js';
import type { AccountInfo, ContactSettings, ListingInput, OlxAd, UploadedImage } from './types.js';

export interface CreateHooks {
  /**
   * Called (and awaited) immediately before the createAd request is sent — after mapping,
   * the rate-limit wait and image uploads. If it throws, nothing is sent. SyncService uses it
   * to persist its duplicate-protection marker; custom ListingsPort implementations must call it.
   */
  beforeSend?: () => Promise<void>;
}

export interface ListingsPort {
  create(input: ListingInput, hooks?: CreateHooks): Promise<OlxAd>;
  update(adId: string, input: ListingInput): Promise<OlxAd>;
  delete(adId: string): Promise<void>;
}

export interface ListingsApiDeps {
  http: OlxHttpClient;
  mapper: CatalogMapper;
  adapter: OlxAdapter;
  images: ImageUploader;
  /** Contact settings from configuration; empty fields fall back to the account profile. */
  contact?: ContactSettings;
  /** After a write whose response has no state, look the ad up in "My ads" (default true). */
  lookupStatusAfterWrite?: boolean;
  logger?: Logger;
}

/** Pages of "My ads" scanned when looking an ad up by id. */
const LOOKUP_PAGES = 5;
const LOOKUP_PAGE_SIZE = 50;

/** Create, edit, delete and read ads on your own OLX account. */
export class ListingsApi implements ListingsPort {
  private account?: Promise<AccountInfo>;

  constructor(private readonly d: ListingsApiDeps) {}

  /**
   * The logged-in account, read once from OLX (`currentUser`) and cached. A failed read is
   * not cached, so the next call tries again (for example after `npm run login`).
   */
  getAccount(): Promise<AccountInfo> {
    const parse = this.d.adapter.parseAccount?.bind(this.d.adapter);
    if (!parse) return Promise.reject(new OlxSdkError('This adapter does not read account details'));
    this.account ??= this.d.http.call('currentUser').then(parse);
    this.account.catch(() => {
      this.account = undefined;
    });
    return this.account;
  }

  private async context(mode: PayloadContext['mode']): Promise<PayloadContext> {
    const account = this.d.adapter.parseAccount ? await this.getAccount() : undefined;
    const c = this.d.contact ?? {};
    return {
      mode,
      account,
      contact: { name: c.name || account?.name, phone: c.phone || account?.phone, method: c.method },
    };
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
      json: this.d.adapter.buildAdPayload(mapped, images, ctx),
      rateLimit: false,
      beforeSend: hooks.beforeSend,
    });
    let ad: OlxAd;
    try {
      ad = this.d.adapter.parseAd(raw);
    } catch (err) {
      // OLX accepted the request, but we can't tell which ad it made: never treat this as "not created".
      throw new UncertainWriteError('createAd', `OLX accepted the ad but the response could not be read: ${(err as Error).message}`, {
        cause: err,
        body: raw,
      });
    }
    return this.withLookedUpStatus(ad);
  }

  async update(adId: string, input: ListingInput): Promise<OlxAd> {
    const mapped = this.d.mapper.resolve(input);
    const ctx = await this.context('update');
    const refund = await this.d.http.acquireWriteSlot();
    const images = await this.uploadImages(input, refund, ctx);
    const raw = await this.d.http.call('updateAd', {
      params: { id: adId },
      json: this.d.adapter.buildAdPayload(mapped, images, ctx),
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
    return this.withLookedUpStatus(ad);
  }

  /**
   * A write response without a state (OLX's post-ad answers only with ids) is completed from
   * "My ads", so an ad that went straight to `limited` is reported as such. Best effort: a
   * failed lookup never fails the write that already succeeded.
   */
  private async withLookedUpStatus(ad: OlxAd): Promise<OlxAd> {
    if (ad.status !== 'unknown' || this.d.lookupStatusAfterWrite === false) return ad;
    try {
      const found = await this.findMine(ad.id);
      return found ? { ...ad, status: found.status, url: ad.url ?? found.url, title: ad.title ?? found.title } : ad;
    } catch (err) {
      this.d.logger?.warn('Could not look up the ad state after a write', { adId: ad.id, error: (err as Error).message });
      return ad;
    }
  }

  /** Looks an ad up in "My ads" (first pages only). Returns undefined if it isn't there. */
  async findMine(adId: string): Promise<OlxAd | undefined> {
    for (let page = 1; page <= LOOKUP_PAGES; page++) {
      const ads = await this.listMine({ page, per_page: LOOKUP_PAGE_SIZE });
      const hit = ads.find((a) => a.id === adId);
      if (hit) return hit;
      if (ads.length < LOOKUP_PAGE_SIZE) return undefined;
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
