import { OlxSdkError } from '../errors.js';
import type { MappedListing } from '../mapping/CatalogMapper.js';
import type { AdStatus, OlxAd } from './types.js';

/**
 * The one place that knows OLX's wire format. Request bodies and response shapes come
 * from your captured traffic (docs/ENDPOINT-CAPTURE.md); pass your own adapter to
 * `OlxClient` instead of editing SDK code.
 */
export interface OlxAdapter {
  buildAdPayload(listing: MappedListing, imageIds: string[]): unknown;
  parseAd(raw: unknown): OlxAd;
  parseAdList(raw: unknown): OlxAd[];
  parseImageUpload(raw: unknown): string;
  /** Multipart field name OLX expects for the image file. */
  imageFieldName?: string;
}

type Rec = Record<string, unknown>;

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
  if (/delet|remov|archiv|deactiv|disabled/.test(s)) return 'deleted';
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
    const o = unwrap(raw);
    const id = pick(o, ['id', 'ad_id', 'adId', 'external_id', 'externalID', 'uuid']);
    if (!id) {
      throw new OlxSdkError('Could not find an ad id in the OLX response; update parseAd in your adapter');
    }
    return {
      id,
      status: normalizeStatus(pick(o, ['status', 'state'])),
      url: pick(o, ['url', 'permalink', 'share_url', 'shareURL']),
      title: pick(o, ['title']),
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
