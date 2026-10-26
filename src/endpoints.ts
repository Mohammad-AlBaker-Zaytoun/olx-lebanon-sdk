import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { EndpointNotConfiguredError, OlxSdkError } from './errors.js';

/**
 * Every OLX operation the SDK performs. The real method/path for each one is NOT
 * hard-coded: OLX Lebanon has no public API, so you record them from your own
 * browser session (`npm run capture`) and put them in config/endpoints.json.
 */
export const ENDPOINT_NAMES = [
  'createAd',
  'updateAd',
  'deleteAd',
  'getAd',
  'listMyAds',
  'uploadImage',
  /** Signed-URL uploads: asks OLX for a one-time upload address for a photo. */
  'signImageUpload',
  /** The logged-in account (id, name, phone), for wire formats that need it. */
  'currentUser',
  /** Takes an ad offline without deleting it. */
  'deactivateAd',
  /** Puts a `limited` ad live, using a free slot if one is left. */
  'activateAd',
  'markAdSold',
  /** Brings back an expired or deactivated ad; the body is the same as an edit. */
  'republishAd',
  'adRejectionReason',
  /** Views and leads for one or more ads. */
  'adMetrics',
  'wallet',
  /** Package offers for posting past the free limit in a category. */
  'postingLimitOffers',
  /** OLX delivery: listings with orders, the orders of one listing, and order status changes. */
  'sellingOrders',
  'sellingOrdersByAd',
  'updateDeliveryOrder',
] as const;

export type EndpointName = (typeof ENDPOINT_NAMES)[number];

const SpecSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Relative to OLX_BASE_URL, or an absolute URL. `{id}`-style placeholders are filled from params. */
  path: z.string().min(1),
  /**
   * Your session (cookies + auth headers) is only ever sent to the OLX domain and its
   * subdomains. Set this to true ONLY if the capture shows the web app itself sending
   * its auth headers to this endpoint's other host.
   */
  sendSessionToForeignHost: z.boolean().optional(),
});

export type EndpointSpec = z.infer<typeof SpecSchema>;
export type EndpointMap = Record<EndpointName, EndpointSpec | null>;

export function emptyEndpoints(): EndpointMap {
  return Object.fromEntries(ENDPOINT_NAMES.map((n) => [n, null])) as EndpointMap;
}

/** Validates a parsed endpoints file. Keys starting with `_` are treated as comments. */
export function parseEndpoints(raw: unknown): EndpointMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OlxSdkError('Endpoints config must be a JSON object');
  }
  const out = emptyEndpoints();
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    if (!(ENDPOINT_NAMES as readonly string[]).includes(key)) {
      throw new OlxSdkError(`Unknown endpoint "${key}". Known endpoints: ${ENDPOINT_NAMES.join(', ')}`);
    }
    if (value === null) continue;
    const parsed = SpecSchema.safeParse(value);
    if (!parsed.success) {
      throw new OlxSdkError(`Invalid spec for endpoint "${key}": ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    out[key as EndpointName] = parsed.data;
  }
  return out;
}

export function loadEndpoints(file: string): EndpointMap {
  if (!existsSync(file)) return emptyEndpoints();
  return parseEndpoints(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Only the endpoints a file actually lists (an entry set to `null` switches one off), to lay
 * over the built-in map. New endpoints in later SDK versions then work without editing the file.
 */
export function loadEndpointOverrides(file: string): Partial<EndpointMap> {
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const parsed = parseEndpoints(raw);
  return Object.fromEntries(ENDPOINT_NAMES.filter((n) => n in raw).map((n) => [n, parsed[n]]));
}

export function requireEndpoint(map: EndpointMap, name: EndpointName): EndpointSpec {
  const spec = map[name];
  if (!spec) throw new EndpointNotConfiguredError(name);
  return spec;
}

export function endpointStatus(map: EndpointMap): Record<EndpointName, boolean> {
  return Object.fromEntries(ENDPOINT_NAMES.map((n) => [n, map[n] !== null])) as Record<EndpointName, boolean>;
}

/** Ad ids and similar: letters, digits, `_` and `-`, optionally with inner dots; never `.`/`..`. */
const SAFE_PARAM = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
export const isSafePathParam = (value: string): boolean => value.length <= 128 && SAFE_PARAM.test(value);

export function buildUrl(
  baseUrl: string,
  spec: EndpointSpec,
  params: Record<string, string> = {},
  query?: Record<string, string | number | boolean | undefined | ReadonlyArray<string | number>>,
): string {
  const path = spec.path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new OlxSdkError(`Missing path parameter "${key}" for ${spec.path}`);
    // encodeURIComponent leaves "." and ".." intact, which would let an id walk up the path
    // (e.g. DELETE /api/ads/.. → DELETE /api/). Only plain id-like values are allowed.
    if (!isSafePathParam(value)) throw new OlxSdkError(`Unsafe value for path parameter "${key}"`);
    return encodeURIComponent(value);
  });
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}
