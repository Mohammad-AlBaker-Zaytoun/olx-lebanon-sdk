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
] as const;

export type EndpointName = (typeof ENDPOINT_NAMES)[number];

const SpecSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  /** Relative to OLX_BASE_URL, or an absolute URL. `{id}`-style placeholders are filled from params. */
  path: z.string().min(1),
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
      throw new OlxSdkError(
        `Invalid spec for endpoint "${key}": ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    out[key as EndpointName] = parsed.data;
  }
  return out;
}

export function loadEndpoints(file: string): EndpointMap {
  if (!existsSync(file)) return emptyEndpoints();
  return parseEndpoints(JSON.parse(readFileSync(file, 'utf8')));
}

export function requireEndpoint(map: EndpointMap, name: EndpointName): EndpointSpec {
  const spec = map[name];
  if (!spec) throw new EndpointNotConfiguredError(name);
  return spec;
}

export function endpointStatus(map: EndpointMap): Record<EndpointName, boolean> {
  return Object.fromEntries(ENDPOINT_NAMES.map((n) => [n, map[n] !== null])) as Record<EndpointName, boolean>;
}

export function buildUrl(
  baseUrl: string,
  spec: EndpointSpec,
  params: Record<string, string> = {},
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const path = spec.path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new OlxSdkError(`Missing path parameter "${key}" for ${spec.path}`);
    return encodeURIComponent(value);
  });
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}
