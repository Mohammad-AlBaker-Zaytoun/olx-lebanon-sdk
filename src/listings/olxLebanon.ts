/**
 * OLX Lebanon's wire format, mapped from a capture of the web app (October 2026).
 *
 * The web app at www.olx.com.lb talks to Dubizzle Group's shared backend:
 *   - ads:     api-prod.olx-dubizzle.com/api/v1/{post-ad, edit-ad/{id}, ads/{id}/delete, user/my-ads}
 *   - account: api-prod.olx-dubizzle.com/api/v1/user
 *   - photos:  www.olx.com.lb/api/images/get-signed-url → PUT to S3 → served from images-prod
 *
 * Ad ids are the 9-digit `externalID` (the one in the ad's public URL), not the internal `id`.
 */
import { randomUUID } from 'node:crypto';
import { parseEndpoints, type EndpointMap } from '../endpoints.js';
import { OlxSdkError } from '../errors.js';
import { normalizeStatus, type OlxAdapter } from './adapter.js';
import type { SessionData } from '../session/storage.js';
import type { AccountInfo, OlxAd } from './types.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;

const API = 'https://api-prod.olx-dubizzle.com/api/v1';

/**
 * OLX Lebanon's endpoints, built in. The ad API is on Dubizzle Group's backend, so those
 * entries send the session there (the web app sends its bearer token there itself).
 */
export const OLX_LB_ENDPOINTS: EndpointMap = parseEndpoints({
  createAd: { method: 'POST', path: `${API}/post-ad`, sendSessionToForeignHost: true },
  updateAd: { method: 'PATCH', path: `${API}/edit-ad/{id}`, sendSessionToForeignHost: true },
  deleteAd: { method: 'POST', path: `${API}/ads/{id}/delete`, sendSessionToForeignHost: true },
  getAd: null,
  listMyAds: { method: 'GET', path: `${API}/user/my-ads`, sendSessionToForeignHost: true },
  currentUser: { method: 'GET', path: `${API}/user`, sendSessionToForeignHost: true },
  signImageUpload: { method: 'GET', path: '/api/images/get-signed-url/' },
  uploadImage: null,
  deactivateAd: { method: 'POST', path: `${API}/ads/{id}/deactivate`, sendSessionToForeignHost: true },
  activateAd: { method: 'POST', path: `${API}/ads/{id}/activate`, sendSessionToForeignHost: true },
  markAdSold: { method: 'POST', path: `${API}/ads/{id}/mark-as-sold`, sendSessionToForeignHost: true },
  republishAd: { method: 'PATCH', path: `${API}/republish-ad/{id}`, sendSessionToForeignHost: true },
  adRejectionReason: { method: 'GET', path: `${API}/ads/{id}/rejection-reason`, sendSessionToForeignHost: true },
  adMetrics: { method: 'GET', path: `${API}/user/ads-analytics`, sendSessionToForeignHost: true },
  wallet: { method: 'GET', path: `${API}/user/wallet`, sendSessionToForeignHost: true },
  postingLimitOffers: { method: 'GET', path: `${API}/package-offers/posting/limit/{categoryId}`, sendSessionToForeignHost: true },
  sellingOrders: { method: 'GET', path: `${API}/selling-orders`, sendSessionToForeignHost: true },
  sellingOrdersByAd: { method: 'GET', path: `${API}/selling-orders/{id}`, sendSessionToForeignHost: true },
  updateDeliveryOrder: {
    method: 'POST',
    path: `${API}/delivery-orders/{id}/update-status/{action}`,
    sendSessionToForeignHost: true,
  },
});

/** The web app's default contact option (as captured). Override with OLX_CONTACT_METHOD. */
export const OLX_LB_DEFAULT_CONTACT_METHOD = 'allow_chat_communication';

/** Where OLX serves a freshly uploaded photo, by its upload name. */
export const OLX_LB_IMAGE_BASE = 'https://images-prod.olx-dubizzle.com/temp/';

/**
 * The stored file name: the last segment of the signed upload URL. OLX adds `.jpg` there
 * whatever the format (`temp/<name>.jpg`), and the photo is then served under that name.
 */
function uploadedFileName(uploadUrl: string, name: string): string {
  try {
    const last = decodeURIComponent(new URL(uploadUrl).pathname.split('/').pop() ?? '');
    if (last.startsWith(name) && /^[\w.-]+$/.test(last)) return last;
  } catch {
    /* fall through */
  }
  return `${name}.jpg`;
}

/** OLX Lebanon's own upload bucket and folder, as captured. */
export const OLX_LB_UPLOAD_HOST = 'olx-lb-prod.s3.eu-central-1.amazonaws.com';
export const OLX_LB_UPLOAD_PREFIX = '/temp/';

/** Values that are not real attributes and must not be sent inside `extra_fields`. */
const RESERVED_EXTRA = new Set(['price', 'secondary_price']);

/** Seconds since the epoch at which a JWT expires, or undefined if it isn't a readable JWT. */
function jwtExpiry(token: string): number | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Rec).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's bearer token: the `Bearer` authorization header captured at login, or else the
 * `accessToken` cookie the web app sets on olx.com.lb (it holds the same token).
 */
export function olxLebanonBearer(session: SessionData, nowSeconds = Date.now() / 1000): string | undefined {
  const header = session.headers.authorization;
  if (header && /^bearer\s+\S/i.test(header)) return header.replace(/^bearer\s+/i, '');
  const cookie = session.cookies.find(
    (c) => c.name === 'accessToken' && /(^|\.)olx\.com\.lb$/i.test(c.domain.replace(/^\./, '')),
  );
  if (!cookie?.value) return undefined;
  const exp = jwtExpiry(cookie.value);
  if (exp !== undefined && exp <= nowSeconds) return undefined;
  return cookie.value;
}

export interface OlxLebanonAdapterOptions {
  /** `source` sent with new ads; the web app sends "nova". */
  source?: string;
  /** Upload bucket host; only this host is ever sent photos. */
  uploadHost?: string;
  /** Path prefix upload URLs must start with. */
  uploadPathPrefix?: string;
}

/**
 * OLX Lebanon's ad states (the web app's `virtualState`), as the website's own code lists them,
 * mapped to the SDK's status plus any boost or rejection detail.
 */
const OLX_LB_STATES: Record<string, Pick<OlxAd, 'status' | 'promotion' | 'rejection'>> = {
  active: { status: 'active' },
  featured: { status: 'active', promotion: { type: 'featured', pending: false } },
  elite: { status: 'active', promotion: { type: 'elite', pending: false } },
  featured_pending: { status: 'active', promotion: { type: 'featured', pending: true } },
  elite_pending: { status: 'active', promotion: { type: 'elite', pending: true } },
  limited: { status: 'limited' },
  expired: { status: 'expired' },
  disabled: { status: 'inactive' },
  sold: { status: 'sold' },
  moderation_pending: { status: 'pending_review' },
  moderation_soft_reject: { status: 'rejected', rejection: 'soft' },
  moderation_hard_reject: { status: 'rejected', rejection: 'hard' },
  moderation_critical_reject: { status: 'rejected', rejection: 'hard' },
};

/** Reads an ad's state into status, promotion and rejection. Unknown states fall back to a best guess. */
export function olxLebanonState(state: string | undefined): Pick<OlxAd, 'status' | 'promotion' | 'rejection'> {
  const known = state ? OLX_LB_STATES[state.toLowerCase()] : undefined;
  return known ? { ...known } : { status: normalizeStatus(state) };
}

/** OLX sends dates as unix seconds (sometimes with a fraction) or ISO strings. */
function isoDate(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return undefined;
}

/** Turns a raw ad from any of OLX's responses into an `OlxAd`. */
function toAd(o: Rec, raw: unknown): OlxAd {
  const id = str(o.externalID) ?? str(o.external_id);
  if (!id) throw new OlxSdkError('No externalID in the OLX ad data; the response format may have changed');
  const state = str(o.virtualState) ?? str(o.state);
  const expiresAt = isoDate(o.expiresAt);
  return {
    id,
    ...olxLebanonState(state),
    title: str(o.title),
    ...(state ? { state } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    raw,
  };
}

export function createOlxLebanonAdapter(opts: OlxLebanonAdapterOptions = {}): OlxAdapter {
  return {
    requiredEndpoints: ['createAd', 'updateAd', 'deleteAd', 'listMyAds', 'signImageUpload', 'currentUser'],
    // Verified live: an edit with `images: []` and `order_photos: []` keeps the ad's photos.
    keepsPhotosWhenNoneSent: true,

    readPhotoIds(rawAd) {
      const photos = rec(rawAd).photos;
      return Array.isArray(photos) ? photos.map((p) => str(rec(p).id)).filter((id): id is string => !!id) : [];
    },

    // Sent only where the session is sent: the OLX domain and endpoints flagged
    // `sendSessionToForeignHost` (the Dubizzle ad API).
    requestHeaders(session) {
      const token = olxLebanonBearer(session);
      return { 'accept-language': 'en', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    },

    buildAdPayload(l, _imageIds, ctx) {
      const images = ctx.images;
      const extra: Rec = {};
      for (const [k, v] of Object.entries(l.attributes)) if (!RESERVED_EXTRA.has(k)) extra[k] = v;
      // OLX keeps the USD price in `price` and the Lebanese-pound price in `secondary_price`.
      if (l.currency === 'LBP') extra.secondary_price = l.price;
      else extra.price = l.price;
      extra.price_type ??= 'price';

      const contact_person = {
        name: ctx.contact.name ?? '',
        mobile_phone_number: ctx.contact.phone ?? '',
        contact_method: ctx.contact.method ?? OLX_LB_DEFAULT_CONTACT_METHOD,
      };
      const photos = images.map((img, i) => ({
        id: null,
        external_id: img.id,
        image_name: img.id,
        order_index: i,
        is_main: i === 0,
        url: img.url ?? `${OLX_LB_IMAGE_BASE}${img.id}.jpg`,
        width: img.width,
        height: img.height,
      }));

      if (ctx.mode === 'update') {
        // As the web app's edit form sends it: new uploads in `images` ({image_name,
        // order_index, url}), the final photo order in `order_photos` ("img_<id>" for photos
        // already on the ad, "tmp_<image name>" for new ones), and the ids of removed photos
        // in `deleted_photos`. Leaving a photo out of order_photos does NOT remove it.
        const replace = ctx.photos?.mode === 'replace' ? ctx.photos : undefined;
        const body: Rec = {
          extra_fields: extra,
          contact_person,
          title: l.title,
          description: l.description,
          images: images.map((img, i) => ({
            image_name: img.id,
            order_index: i,
            url: img.url ?? `${OLX_LB_IMAGE_BASE}${img.id}.jpg`,
          })),
          order_photos: images.map((img) => `tmp_${img.id}`),
          category_id: l.categoryId,
          videos: [],
          location_id: l.locationId,
        };
        const deleted = (replace?.existingPhotoIds ?? []).map(Number).filter((n) => Number.isSafeInteger(n));
        if (deleted.length > 0) body.deleted_photos = deleted;
        return body;
      }

      if (!ctx.account?.externalId) {
        throw new OlxSdkError('The OLX account id is unknown; check the session with `npm run login`');
      }
      return {
        extra_fields: extra,
        contact_person,
        area: 0,
        user_external_id: ctx.account.externalId,
        state: 'pending',
        source: opts.source ?? 'nova',
        category_id: l.categoryId,
        images: photos,
        description: l.description,
        videos: [],
        title: l.title,
        location_id: l.locationId,
      };
    },

    parseAd(raw) {
      const data = rec(rec(raw).data);
      const ad = rec(data.ad);
      const parsed = toAd(Object.keys(ad).length ? ad : rec(raw), raw);
      // edit-ad also reports the state next to the ad.
      if (parsed.status === 'unknown' && str(data.state))
        Object.assign(parsed, olxLebanonState(str(data.state)), { state: str(data.state) });
      return parsed;
    },

    parseAdList(raw) {
      const results = rec(raw).results;
      if (!Array.isArray(results)) throw new OlxSdkError('No `results` list in the OLX my-ads response');
      return results.map((item) => toAd(rec(item), item));
    },

    hasNextPage: (raw) => {
      const next = rec(raw).next;
      return next !== null && next !== undefined && next !== false && next !== '';
    },

    parseImageUpload() {
      throw new OlxSdkError('OLX Lebanon uploads photos by signed URL, not multipart');
    },

    signedUpload: {
      // The web app names photos "<account externalID>-<random uuid>".
      newImageName: (account) => `${account?.externalId ?? randomUUID()}-${randomUUID()}`,
      signQuery: (name) => ({ imageName: name }),
      parseSignedUrl(raw) {
        const url = str(rec(rec(raw).data).url);
        if (!url) throw new OlxSdkError('No upload URL in the OLX signed-URL response');
        return url;
      },
      // Only OLX's own bucket and folder: a tampered response must not send photos elsewhere.
      isAllowedUploadUrl: (url) =>
        url.protocol === 'https:' &&
        url.hostname.toLowerCase() === (opts.uploadHost ?? OLX_LB_UPLOAD_HOST) &&
        !url.port &&
        url.pathname.startsWith(opts.uploadPathPrefix ?? OLX_LB_UPLOAD_PREFIX) &&
        !url.pathname.includes('..') &&
        !/%2f|%5c/i.test(url.pathname),
      toUploadedImage: (name, info) => ({
        id: name,
        url: OLX_LB_IMAGE_BASE + uploadedFileName(info.uploadUrl, name),
        width: info.width,
        height: info.height,
        contentType: info.contentType,
      }),
    },

    parseAccount(raw): AccountInfo {
      const d = rec(rec(raw).data);
      const externalId = str(d.externalID);
      if (!externalId) throw new OlxSdkError('No externalID in the OLX account response; is the session valid?');
      const full = [str(d.first_name), str(d.last_name)].filter(Boolean).join(' ');
      const nameObj = rec(d.name);
      // `name` is { ar, en } on /api/v1/user and a string elsewhere.
      const name = str(d.name) ?? str(nameObj.en) ?? str(nameObj.ar) ?? (full || undefined);
      return { externalId, name, phone: str(d.phoneNumber) };
    },
  };
}

export const olxLebanonAdapter: OlxAdapter = createOlxLebanonAdapter();
