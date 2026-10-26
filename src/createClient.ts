import type { WriteLimits } from './config.js';
import type { EndpointMap } from './endpoints.js';
import { OlxClient, type OlxClientOptions } from './client.js';
import type { Transport } from './http/HttpClient.js';
import type { OlxAdapter } from './listings/adapter.js';
import { OLX_LB_ENDPOINTS } from './listings/olxLebanon.js';
import type { ContactSettings } from './listings/types.js';
import { silentLogger, type Logger, type RequestLog } from './logger.js';
import { parseCatalog, type Catalog } from './mapping/CatalogMapper.js';
import { MemorySessionStore, sessionFromAccessToken, type SessionData, type SessionStore } from './session/storage.js';
import { MemorySyncStore, type SyncStore } from './sync/SyncStore.js';

export const OLX_LB_BASE_URL = 'https://www.olx.com.lb';

/** Human-paced defaults: at least 60 s between writes, up to 15 s jitter, 20 writes per hour. */
export const DEFAULT_WRITE_LIMITS: WriteLimits = { minIntervalMs: 60_000, jitterMs: 15_000, maxPerHour: 20 };

export interface CreateOlxClientOptions {
  /**
   * Your OLX access token (a bearer token, valid about a year). Get it once with
   * `npx olx-lb login`, then keep it in an environment variable, never in client-side code.
   */
  accessToken?: string;
  /** A full saved session instead of a token (as `olx-lb login` writes it). */
  session?: SessionData;
  /** Where the session lives, if you manage it yourself (e.g. a secrets store). */
  sessionStore?: SessionStore;
  /** Who buyers contact. Empty fields come from your OLX profile. */
  contact?: ContactSettings;
  /**
   * Optional: your own names for categories and locations (`categoryKey`, `locationKey`),
   * with attribute renames, value maps, defaults and price limits. A parsed object or raw JSON.
   */
  catalog?: Catalog | unknown;
  /**
   * Where `client.sync` keeps each product's link to its ad. Defaults to memory, which is
   * lost on restart (and per serverless invocation): use a database-backed store in production.
   */
  store?: SyncStore;
  /** Pace of writes (create, edit, delete). Defaults to `DEFAULT_WRITE_LIMITS`. */
  writeLimits?: Partial<WriteLimits>;
  /** Only download product photos from these hosts (and trust them). */
  allowedImageHosts?: string[];
  logger?: Logger;
  requestLog?: RequestLog;
  /** Replaces fetch for calls to OLX (tests, proxies). */
  fetch?: typeof fetch;
  /** Replaces fetch for downloading product photos. */
  imageFetch?: typeof fetch;
  /** Override individual endpoints if OLX moves one. */
  endpoints?: Partial<EndpointMap>;
  /** Replace the wire format (advanced). */
  adapter?: OlxAdapter;
  baseUrl?: string;
  http?: OlxClientOptions['http'];
  images?: OlxClientOptions['images'];
}

/**
 * Creates a client configured entirely in code: no files or environment variables needed.
 *
 * ```ts
 * const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN });
 * const ad = await olx.ads.create({ title, description, price, categoryId: '175', locationId: '47' });
 * ```
 */
export function createOlxClient(options: CreateOlxClientOptions = {}): OlxClient {
  const given = [options.accessToken, options.session, options.sessionStore].filter((v) => v !== undefined);
  if (given.length > 1) throw new TypeError('createOlxClient: pass only one of accessToken, session or sessionStore');
  let tokenSession: SessionData | undefined;
  if (options.accessToken !== undefined) {
    try {
      tokenSession = sessionFromAccessToken(options.accessToken);
    } catch {
      throw new TypeError('createOlxClient: accessToken looks empty or malformed');
    }
  }
  const sessionStore = options.sessionStore ?? new MemorySessionStore(options.session ?? tokenSession ?? null);
  return new OlxClient({
    baseUrl: options.baseUrl ?? OLX_LB_BASE_URL,
    endpoints: { ...OLX_LB_ENDPOINTS, ...options.endpoints },
    catalog: parseCatalog(options.catalog ?? {}),
    sessionStore,
    syncStore: options.store ?? new MemorySyncStore(),
    writeLimits: { ...DEFAULT_WRITE_LIMITS, ...options.writeLimits },
    adapter: options.adapter,
    contact: options.contact,
    logger: options.logger ?? silentLogger,
    requestLog: options.requestLog,
    transport: options.fetch as Transport | undefined,
    imageFetch: options.imageFetch,
    allowedImageHosts: options.allowedImageHosts,
    http: options.http,
    images: options.images,
    catalogApi: options.fetch ? { fetch: options.fetch } : undefined,
  });
}
