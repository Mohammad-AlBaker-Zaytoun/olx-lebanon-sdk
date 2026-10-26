import type { ListingsApi } from './ListingsApi.js';
import { adActions } from './actions.js';
import type { ActivateResult, AdAction, AdMetrics, AdStatus, ListingInput, OlxAd, RejectionReason, SoldOn } from './types.js';

/** An ad's content for `client.ads`: the same as a listing, usually with OLX ids. */
export type AdInput = ListingInput;

export interface AdPage {
  ads: OlxAd[];
  /** Whether `list({ page: page + 1 })` has more. */
  hasMore: boolean;
}

/**
 * Direct access to your ads by their OLX id: no product tracking, no stored links. Use
 * `client.sync` instead to keep one ad per product of your store.
 */
export class AdsApi {
  constructor(private readonly listings: ListingsApi) {}

  /**
   * Posts a new ad and returns it with its id. `status` is read from "My ads" right after
   * posting: `active`, `pending_review`, or `limited` (needs a paid OLX package to be shown).
   */
  async create(ad: AdInput): Promise<OlxAd> {
    const created = await this.listings.create(ad);
    if (created.status !== 'unknown') return created;
    const status = await this.listings.lookupStatus(created.id);
    return status ? { ...created, status } : created;
  }

  /**
   * Replaces an ad's content. OLX edits need the whole ad, not only the changed fields.
   * Photos: leave `images` out to keep the ad's current photos; pass `images` to replace them.
   */
  async update(adId: string, ad: AdInput): Promise<OlxAd> {
    const keepPhotos = ad.images === undefined;
    const updated = await this.listings.update(adId, ad, { photosUnchanged: keepPhotos });
    if (updated.status !== 'unknown') return updated;
    const status = await this.listings.lookupStatus(adId);
    return status ? { ...updated, status } : updated;
  }

  /** Removes an ad. */
  delete(adId: string): Promise<void> {
    return this.listings.delete(adId);
  }

  /** One page of your ads, newest first. */
  async list(opts: { page?: number; perPage?: number } = {}): Promise<AdPage> {
    const page = opts.page ?? 1;
    const perPage = Math.min(Math.max(opts.perPage ?? 20, 1), 50);
    const ads = await this.listings.listMine({ page, per_page: perPage });
    return { ads, hasMore: ads.length >= perPage };
  }

  /** Finds one of your ads by id in "My ads" (searches up to `maxPages` pages of 20). */
  find(adId: string, opts: { maxPages?: number } = {}): Promise<OlxAd | undefined> {
    return this.listings.findMine(adId, opts.maxPages ?? 50);
  }

  /** The ad's current state, or undefined if it isn't in your newest ads. */
  async status(adId: string, opts: { maxPages?: number } = {}): Promise<AdStatus | undefined> {
    return (await this.find(adId, opts))?.status;
  }

  /** Takes the ad offline without deleting it. `republish` brings it back. A paced write. */
  deactivate(adId: string): Promise<void> {
    return this.listings.deactivate(adId);
  }

  /**
   * Puts a `limited` ad live with a free slot, if the account has one left in its category:
   * `activated`, `needs_package` (buy a package on OLX; the SDK never buys) or `not_limited`.
   * A paced write.
   */
  activate(adId: string): Promise<ActivateResult> {
    return this.listings.activate(adId);
  }

  /** Marks the ad as sold, on OLX or elsewhere. After that it can only be deleted. A paced write. */
  markSold(adId: string, opts: { soldOn: SoldOn }): Promise<void> {
    if (opts?.soldOn !== 'olx' && opts?.soldOn !== 'elsewhere') {
      return Promise.reject(new TypeError("markSold: pass { soldOn: 'olx' } or { soldOn: 'elsewhere' }"));
    }
    return this.listings.markSold(adId, opts.soldOn);
  }

  /**
   * Brings back an expired or deactivated ad with this content (the whole ad, as for `update`).
   * Leave `images` out to keep the ad's photos. A paced write.
   */
  async republish(adId: string, ad: AdInput): Promise<OlxAd> {
    const republished = await this.listings.update(adId, ad, { photosUnchanged: ad.images === undefined, republish: true });
    if (republished.status !== 'unknown') return republished;
    const status = await this.listings.lookupStatus(adId);
    return status ? { ...republished, status } : republished;
  }

  /** Why OLX's review refused the ad, or undefined when there is no reason on file. */
  rejectionReason(adId: string): Promise<RejectionReason | undefined> {
    return this.listings.rejectionReason(adId);
  }

  /** Views and leads per ad id. Ads OLX has no numbers for are left out. */
  metrics(adIds: readonly string[]): Promise<Record<string, AdMetrics>> {
    return this.listings.metrics(adIds);
  }

  /** What can be done with an ad in its status: see `adActions`. */
  actions(ad: Pick<OlxAd, 'status' | 'rejection'>): AdAction[] {
    return adActions(ad);
  }
}
