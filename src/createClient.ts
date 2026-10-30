import type { WriteLimits } from './config.js';
import type { EndpointMap } from './endpoints.js';
import type { OlxSdkError } from './errors.js';
import { OlxClient, type OlxClientOptions } from './client.js';
import type { OlxAdapter } from './listings/adapter.js';
import { OLX_LB_ENDPOINTS } from './listings/olxLebanon.js';
import type { ContactSettings } from './listings/types.js';
import { silentLogger, type Logger, type RequestLog } from './logger.js';
import { refreshOlxTokens } from './session/refresh.js';
import { parseCatalog, type CatalogInput } from './mapping/CatalogMapper.js';
import type { RefreshedSession } from './session/SessionManager.js';
import {
  MemorySessionStore,
  TokenSourceStore,
  sessionFromAccessToken,
  type SessionData,
  type SessionStore,
} from './session/storage.js';
import { MemorySyncStore, type SyncStore } from './sync/SyncStore.js';

export const OLX_LB_BASE_URL = 'https://www.olx.com.lb';

/** Human-paced defaults: at least 60 s between writes, up to 15 s jitter, 20 writes per hour. */
export const DEFAULT_WRITE_LIMITS: WriteLimits = { minIntervalMs: 60_000, jitterMs: 15_000, maxPerHour: 20 };

/** An access token, or a function that returns the current one (called before each request). */
export type AccessTokenSource = string | (() => string | Promise<string>);
/** A refresh token, or a function that returns the current one. */
export type RefreshTokenSource = string | (() => string | null | undefined | Promise<string | null | undefined>);

export interface CreateOlxClientOptions {
  /**
   * Your OLX access token (a bearer token, valid about a year). Get it once with
   * `npx olx-lb login`, then keep it in an environment variable, never in client-side code.
   *
   * Or a function returning the current token, called before each request, so a long-lived
   * client picks up a token saved elsewhere (cache inside it if it reads a database).
   */
  accessToken?: AccessTokenSource;
  /**
   * The refresh token that came with the access token (OLX Connect and `olx-lb token --json`
   * give it). With it the client renews the access token itself: see `onSessionRefreshed`.
   */
  refreshToken?: RefreshTokenSource;
  /**
   * A full saved session (as `olx-lb login` writes it), or `{ accessToken, refreshToken }`.
   */
  session?: SessionData | { accessToken: string; refreshToken?: string };
  /** Where the session lives, if you manage it yourself (e.g. a secrets store). */
  sessionStore?: SessionStore;
  /**
   * Called after the client renews the access token, with the new pair: save both (OLX may
   * replace the refresh token, and then the old one stops working). Awaited; if it throws,
   * it is called again on the next request.
   */
  onSessionRefreshed?: (session: RefreshedSession) => void | Promise<void>;
  /**
   * When to renew. By default the client renews within 30 days of the access token's expiry,
   * and after OLX rejects it (HTTP 401), once per call. `false` turns renewal off.
   */
  refresh?:
    | false
    | {
        /** Renew when the access token expires within this many days. Default 30. */
        beforeExpiryDays?: number;
        /** Also renew once the access token is this many days old. Off by default. */
        afterDays?: number;
        /** Called when a renewal fails (the client keeps using the current token while it works). */
        onFailed?: (error: OlxSdkError) => void;
        /** OLX's sign-in service; defaults to OLX_LB_AUTH_URL. */
        authUrl?: string;
      };
  /** Who buyers contact. Empty fields come from your OLX profile. */
  contact?: ContactSettings;
  /**
   * Optional: your own names for categories and locations (`categoryKey`, `locationKey`),
   * with attribute renames, value maps, defaults and price limits. A parsed object or raw JSON.
   */
  catalog?: CatalogInput;
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
  if (options.refreshToken !== undefined && options.accessToken === undefined) {
    throw new TypeError('createOlxClient: refreshToken goes with accessToken');
  }
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const { accessToken, refreshToken } = options;
    if (typeof accessToken === 'function') {
      sessionStore = new TokenSourceStore(
        accessToken,
        typeof refreshToken === 'function' ? refreshToken : refreshToken !== undefined ? () => refreshToken : undefined,
      );
    } else if (accessToken !== undefined) {
      if (typeof refreshToken === 'function') {
        throw new TypeError('createOlxClient: refreshToken can be a function only when accessToken is one');
      }
      sessionStore = new MemorySessionStore(tokenSession(accessToken, refreshToken));
    } else if (options.session && 'accessToken' in options.session) {
      sessionStore = new MemorySessionStore(tokenSession(options.session.accessToken, options.session.refreshToken));
    } else {
      sessionStore = new MemorySessionStore(options.session ?? null);
    }
  }
  const refresh = options.refresh;
  const transport = options.fetch;
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
    transport,
    imageFetch: options.imageFetch,
    allowedImageHosts: options.allowedImageHosts,
    http: options.http,
    images: options.images,
    catalogApi: options.fetch ? { fetch: options.fetch } : undefined,
    refresh:
      refresh === false
        ? false
        : {
            beforeExpiryDays: refresh?.beforeExpiryDays,
            afterDays: refresh?.afterDays,
            onFailed: refresh?.onFailed,
            onRefreshed: options.onSessionRefreshed,
            refresher: (token: string) => refreshOlxTokens(token, { fetch: transport, authUrl: refresh?.authUrl }),
          },
  });
}

function tokenSession(accessToken: string, refreshToken?: string): SessionData {
  try {
    return sessionFromAccessToken(accessToken, refreshToken);
  } catch {
    throw new TypeError('createOlxClient: accessToken looks empty or malformed');
  }
}
