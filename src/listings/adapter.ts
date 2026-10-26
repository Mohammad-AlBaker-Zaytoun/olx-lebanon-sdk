import type { EndpointName } from '../endpoints.js';
import { OlxSdkError } from '../errors.js';
import type { MappedListing } from '../mapping/CatalogMapper.js';
import type { SessionData } from '../session/storage.js';
import type { AccountInfo, AdStatus, ContactSettings, OlxAd, UploadedImage } from './types.js';

/** What the adapter knows besides the listing itself when it builds a request body. */
export interface PayloadContext {
  /** `create` for a new ad, `update` for an edit of an existing one. */
  mode: 'create' | 'update';
  /** The logged-in account, when the adapter reads it (`parseAccount`). */
  account?: AccountInfo;
  /** Contact settings from configuration, already merged with the account profile. */
  contact: ContactSettings;
  /** The uploaded photos in full (url, size), in the same order as `imageIds`. */
  images: UploadedImage[];
  /**
   * Edits only: what to do with the photos already on the ad. `keep` leaves them as they
   * are (no new photos are sent); `replace` removes `existingPhotoIds` and adds `images`.
   */
  photos?: { mode: 'keep' } | { mode: 'replace'; existingPhotoIds: string[] };
}

/**
 * Upload by signed URL: ask OLX for a one-time upload address, then PUT the file there.
 * Your session is never sent to the upload host.
 */
export interface SignedUploadFlow {
  /** A fresh name for the photo; sent to `signImageUpload`. */
  newImageName(account?: AccountInfo): string;
  /** Query parameters for the `signImageUpload` call. */
  signQuery(name: string): Record<string, string>;
  /** Reads the upload URL out of the `signImageUpload` response. */
  parseSignedUrl(raw: unknown): string;
  /** Whether the upload URL is OLX's own storage (host and path); anything else is refused. */
  isAllowedUploadUrl(url: URL): boolean;
  /** How the ad body refers to the uploaded photo. `uploadUrl` is where it was PUT. */
  toUploadedImage(name: string, info: { width: number; height: number; contentType: string; uploadUrl: string }): UploadedImage;
}

/**
 * The one place that knows OLX's wire format. The SDK ships `olxLebanonAdapter` (the
 * default), mapped from a real capture; pass your own to `OlxClient` if OLX changes.
 */
export interface OlxAdapter {
  /**
   * The request body for createAd / updateAd. `imageIds` are the uploaded photos' ids; the
   * full photo details are in `ctx.images`.
   */
  buildAdPayload(listing: MappedListing, imageIds: string[], ctx: PayloadContext): unknown;
  parseAd(raw: unknown): OlxAd;
  parseAdList(raw: unknown): OlxAd[];
  /** Whether a listMyAds response has another page; without it, a short page means the end. */
  hasNextPage?(raw: unknown): boolean;
  /** Multipart uploads (`uploadImage`): reads the photo id from the response. */
  parseImageUpload(raw: unknown): string;
  /** Multipart field name OLX expects for the image file. */
  imageFieldName?: string;
  /** Set to upload photos by signed URL instead of multipart. */
  signedUpload?: SignedUploadFlow;
  /** Reads the account from the `currentUser` response; set if the body needs account data. */
  parseAccount?(raw: unknown): AccountInfo;
  /**
   * True when an edit sent with no photos leaves the ad's existing photos as they are. The
   * SDK then skips re-uploading photos that haven't changed. Leave unset if an empty photo
   * list would remove them.
   */
  keepsPhotosWhenNoneSent?: boolean;
  /**
   * Reads the ids of the photos on an ad from a listMyAds item. With it, an edit that
   * changes photos removes the old ones instead of adding to them.
   */
  readPhotoIds?(rawAd: unknown): string[];
  /** Endpoints this adapter needs; the service warns at start-up about any that are missing. */
  requiredEndpoints?: EndpointName[];
  /**
   * Extra headers for calls to the OLX domain, built from the saved session — e.g. a
   * bearer token the web app keeps in localStorage (`session.localStorage[origin][key]`).
   */
  requestHeaders?(session: SessionData): Record<string, string>;
}

type Rec = Record<string, unknown>;

const AD_ID_KEYS = ['id', 'ad_id', 'adId', 'external_id', 'externalID', 'uuid'];

const asRecord = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});

function pick(o: Rec, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Unwraps the common `{ data: … }` / `{ ad: … }` / `{ result: … }` envelopes. */
function unwrap(raw: unknown): Rec {
  const o = asRecord(raw);
  for (const key of ['data', 'ad', 'result', 'item']) {
    const inner = o[key];
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) return inner as Rec;
  }
  return o;
}

export function normalizeStatus(value?: string): AdStatus {
  const s = (value ?? '').toLowerCase();
  // Final states first: "rejected_by_moderator" must not read as "in moderation".
  if (/reject|declin|refus/.test(s)) return 'rejected';
  // Negated positives ("not_approved", "not_active", "unpublished", "inactive") are not active,
  // and their exact meaning varies, so don't guess.
  if (/(^|[^a-z])(not|non)([^a-z]|$)|(^|[^a-z])(un|in)(active|approved|published|live)/.test(s)) return 'unknown';
  if (/delet|remov|archiv|deactiv|disabled/.test(s)) return 'deleted';
  if (/limit/.test(s)) return 'limited';
  if (/expir|outdated/.test(s)) return 'expired';
  if (/pending|moderat|review|waiting/.test(s)) return 'pending_review';
  if (/(^|_)(active|live|published|approved)/.test(s)) return 'active';
  return 'unknown';
}

/**
 * Best-guess adapter used until the real format is captured.
 * TODO(capture): replace `buildAdPayload` with the exact JSON the OLX web app sends when
 * you post an ad by hand, and tighten the parsers to the real response fields.
 */
export const placeholderAdapter: OlxAdapter = {
  imageFieldName: 'file',
  requiredEndpoints: ['createAd', 'updateAd', 'deleteAd', 'uploadImage'],

  buildAdPayload(l, imageIds) {
    return {
      title: l.title,
      description: l.description,
      price: { value: l.price, currency: l.currency },
      category_id: l.categoryId,
      location_id: l.locationId,
      attributes: l.attributes,
      images: imageIds,
    };
  },

  parseAd(raw) {
    // Look at the top level first: `{ id, data: { images } }` must not lose the top-level id.
    const top = asRecord(raw);
    const inner = unwrap(raw);
    const read = (keys: string[]) => pick(top, keys) ?? pick(inner, keys);
    const id = read(AD_ID_KEYS);
    if (!id) {
      throw new OlxSdkError('Could not find an ad id in the OLX response; update parseAd in your adapter');
    }
    return {
      id,
      status: normalizeStatus(read(['status', 'state'])),
      url: read(['url', 'permalink', 'share_url', 'shareURL']),
      title: read(['title']),
      raw,
    };
  },

  parseAdList(raw) {
    const o = asRecord(raw);
    const list = Array.isArray(raw)
      ? raw
      : ([o.data, o.ads, o.results, o.items, o.hits].find(Array.isArray) as unknown[] | undefined);
    if (!list) throw new OlxSdkError('Could not find a list of ads in the OLX response; update parseAdList');
    return list.map((item) => placeholderAdapter.parseAd(item));
  },

  parseImageUpload(raw) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    const id = pick(unwrap(raw), ['id', 'image_id', 'imageId', 'uuid', 'key', 'url']);
    if (!id) throw new OlxSdkError('Could not find an image id in the upload response; update parseImageUpload');
    return id;
  },
};
