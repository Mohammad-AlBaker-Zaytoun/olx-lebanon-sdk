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
import { OlxSdkError } from '../errors.js';
import { normalizeStatus, type OlxAdapter } from './adapter.js';
import type { SessionData } from '../session/storage.js';
import type { AccountInfo, OlxAd } from './types.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;

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

/** S3 hosts only (`<bucket>.s3.<region>.amazonaws.com` or `s3.<region>.amazonaws.com`). */
const S3_HOST = /^([a-z0-9][a-z0-9.-]*\.)?s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/;

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
  const cookie = session.cookies.find((c) => c.name === 'accessToken' && /(^|\.)olx\.com\.lb$/i.test(c.domain.replace(/^\./, '')));
  if (!cookie?.value) return undefined;
  const exp = jwtExpiry(cookie.value);
  if (exp !== undefined && exp <= nowSeconds) return undefined;
  return cookie.value;
}

export interface OlxLebanonAdapterOptions {
  /** `source` sent with new ads; the web app sends "nova". */
  source?: string;
}

/** Turns a raw ad from any of OLX's responses into an `OlxAd`. */
function toAd(o: Rec, raw: unknown): OlxAd {
  const id = str(o.externalID) ?? str(o.external_id);
  if (!id) throw new OlxSdkError('No externalID in the OLX ad data; the response format may have changed');
  return {
    id,
    status: normalizeStatus(str(o.virtualState) ?? str(o.state)),
    title: str(o.title),
    raw,
  };
}

export function createOlxLebanonAdapter(opts: OlxLebanonAdapterOptions = {}): OlxAdapter {
  return {
    requiredEndpoints: ['createAd', 'updateAd', 'deleteAd', 'listMyAds', 'signImageUpload', 'currentUser'],

    // Sent only where the session is sent: the OLX domain and endpoints flagged
    // `sendSessionToForeignHost` (the Dubizzle ad API).
    requestHeaders(session) {
      const token = olxLebanonBearer(session);
      return { 'accept-language': 'en', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    },

    buildAdPayload(l, images, ctx) {
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
        // Photos already on the ad are listed in `order_photos` as "img_<photo id>"; new
        // uploads go in `images`. The SDK re-uploads the product's photos on every edit.
        return {
          extra_fields: extra,
          contact_person,
          title: l.title,
          description: l.description,
          images: photos,
          order_photos: [],
          category_id: l.categoryId,
          videos: [],
          location_id: l.locationId,
        };
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
      if (parsed.status === 'unknown' && str(data.state)) parsed.status = normalizeStatus(str(data.state));
      return parsed;
    },

    parseAdList(raw) {
      const results = rec(raw).results;
      if (!Array.isArray(results)) throw new OlxSdkError('No `results` list in the OLX my-ads response');
      return results.map((item) => toAd(rec(item), item));
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
      isAllowedUploadHost: (host) => S3_HOST.test(host),
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
