import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OlxConfig, WriteLimits } from './config.js';
import { endpointStatus, loadEndpointOverrides, loadEndpoints, type EndpointMap, type EndpointName } from './endpoints.js';
import { OlxHttpClient, type HttpClientOptions, type Transport } from './http/HttpClient.js';
import { WriteRateLimiter, type RateLimiterClock } from './http/rateLimiter.js';
import { placeholderAdapter, type OlxAdapter } from './listings/adapter.js';
import { OlxCatalog, type OlxCatalogOptions } from './catalog/OlxCatalog.js';
import { AccountApi } from './account/AccountApi.js';
import { AdsApi } from './listings/AdsApi.js';
import { OrdersApi } from './orders/OrdersApi.js';
import { OLX_LB_ENDPOINTS, olxLebanonAdapter } from './listings/olxLebanon.js';
import type { ContactSettings } from './listings/types.js';
import { ImageUploader, type ImageUploaderOptions } from './listings/images.js';
import { ListingsApi } from './listings/ListingsApi.js';
import { FileRequestLog, createLogger, silentLogger, type Logger, type RequestLog } from './logger.js';
import { CatalogMapper, loadCatalog, type Catalog } from './mapping/CatalogMapper.js';
import { DEFAULT_CAPTURED_HEADERS, SessionManager } from './session/SessionManager.js';
import { FileSessionStore, MemorySessionStore, sessionFromAccessToken, type SessionStore } from './session/storage.js';
import { SyncService } from './sync/SyncService.js';
import { JsonFileSyncStore, type SyncStore } from './sync/SyncStore.js';

export interface OlxClientOptions {
  baseUrl: string;
  endpoints: EndpointMap;
  catalog: Catalog;
  sessionStore: SessionStore;
  syncStore: SyncStore;
  writeLimits: WriteLimits;
  /** Wire format. Defaults to the built-in OLX Lebanon adapter. */
  adapter?: OlxAdapter;
  /** Who buyers contact; empty fields fall back to the account profile. */
  contact?: ContactSettings;
  logger?: Logger;
  requestLog?: RequestLog;
  transport?: Transport;
  clock?: RateLimiterClock;
  allowedImageHosts?: string[];
  imageFetch?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  /** Non-OLX hosts whose requests are watched for auth headers at login. */
  extraHosts?: string[];
  /** Header names captured at login, in addition to the defaults. */
  captureHeaders?: string[];
  /** Tuning for calls to OLX. */
  http?: Pick<HttpClientOptions, 'timeoutMs' | 'maxReadRetries' | 'retryBaseMs' | 'maxRetryDelayMs'>;
  /** Tuning for product image downloads. */
  images?: Pick<ImageUploaderOptions, 'maxBytes' | 'timeoutMs' | 'totalTimeoutMs' | 'maxRedirects'>;
  /** Options for `client.catalog` (public category and location data). */
  catalogApi?: OlxCatalogOptions;
}

/**
 * Everything wired together. Most apps need three parts:
 * - `ads`: create, edit, delete and list your ads by OLX id;
 * - `sync`: keep one ad per product of your store (create once, edit in place, skip unchanged);
 * - `catalog`: OLX's categories, their fields, and locations.
 * Create one with `createOlxClient()`.
 */
export class OlxClient {
  readonly ads: AdsApi;
  /** Your account: profile, wallet, package offers (read only). */
  readonly account: AccountApi;
  /** OLX delivery orders on your listings (experimental). */
  readonly orders: OrdersApi;
  readonly catalog: OlxCatalog;
  readonly session: SessionManager;
  readonly http: OlxHttpClient;
  readonly listings: ListingsApi;
  readonly sync: SyncService;
  readonly syncStore: SyncStore;
  readonly mapper: CatalogMapper;
  readonly limiter: WriteRateLimiter;
  readonly adapter: OlxAdapter;
  private readonly endpoints: EndpointMap;

  constructor(opts: OlxClientOptions) {
    const logger = opts.logger ?? silentLogger;
    const adapter = opts.adapter ?? olxLebanonAdapter;
    this.adapter = adapter;
    this.endpoints = opts.endpoints;
    this.session = new SessionManager({
      baseUrl: opts.baseUrl,
      store: opts.sessionStore,
      logger,
      extraHosts: opts.extraHosts,
      captureHeaders: [...DEFAULT_CAPTURED_HEADERS, ...(opts.captureHeaders ?? [])],
    });
    this.limiter = new WriteRateLimiter(opts.writeLimits, opts.clock);
    this.http = new OlxHttpClient({
      baseUrl: opts.baseUrl,
      endpoints: opts.endpoints,
      session: this.session,
      limiter: this.limiter,
      logger,
      requestLog: opts.requestLog,
      transport: opts.transport,
      extraHeaders: adapter.requestHeaders?.bind(adapter),
      ...opts.http,
    });
    this.mapper = new CatalogMapper(opts.catalog);
    const images = new ImageUploader({
      http: this.http,
      adapter,
      allowedHosts: opts.allowedImageHosts,
      fetchImpl: opts.imageFetch,
      resolveHost: opts.resolveHost,
      ...opts.images,
    });
    this.listings = new ListingsApi({
      http: this.http,
      mapper: this.mapper,
      adapter,
      images,
      contact: opts.contact,
      session: this.session,
      logger,
    });
    this.ads = new AdsApi(this.listings);
    this.account = new AccountApi(this.http, this.listings);
    this.orders = new OrdersApi(this.http);
    this.catalog = new OlxCatalog(opts.catalogApi);
    this.syncStore = opts.syncStore;
    this.sync = new SyncService({ listings: this.listings, store: opts.syncStore, mapper: this.mapper, logger });
  }

  /**
   * Builds a client from `loadConfig()` output, using file-based stores. Logs to stderr at
   * LOG_LEVEL unless you pass your own `logger` (pass `silentLogger` to mute it).
   */
  static fromConfig(config: OlxConfig, overrides: Partial<Omit<OlxClientOptions, 'baseUrl' | 'writeLimits'>> = {}): OlxClient {
    const logger = overrides.logger ?? createLogger(config.logLevel);
    // Both files are optional: the endpoints are built in, and ads can use OLX ids directly.
    if (!overrides.catalog && !existsSync(config.catalogFile)) {
      logger.debug('No catalog file; categoryKey / locationKey are unavailable (OLX ids still work)', {
        path: resolve(config.catalogFile),
      });
    }
    const endpoints =
      overrides.endpoints ??
      (config.adapter === 'placeholder'
        ? loadEndpoints(config.endpointsFile)
        : // An endpoints file only overrides what it lists; the rest stay built in.
          { ...OLX_LB_ENDPOINTS, ...loadEndpointOverrides(config.endpointsFile) });
    return new OlxClient({
      baseUrl: config.baseUrl,
      writeLimits: config.writeLimits,
      allowedImageHosts: config.allowedImageHosts,
      extraHosts: config.extraHosts,
      captureHeaders: config.captureHeaders,
      adapter: config.adapter === 'placeholder' ? placeholderAdapter : olxLebanonAdapter,
      contact: config.contact,
      endpoints,
      catalog: overrides.catalog ?? loadCatalog(config.catalogFile),
      sessionStore:
        overrides.sessionStore ??
        (config.accessToken
          ? new MemorySessionStore(sessionFromAccessToken(config.accessToken))
          : new FileSessionStore(config.sessionFile)),
      syncStore: overrides.syncStore ?? new JsonFileSyncStore(config.syncStoreFile),
      requestLog: overrides.requestLog ?? new FileRequestLog(config.requestLogFile),
      ...overrides,
      logger,
    });
  }

  /** Which endpoints have been mapped so far. */
  endpointStatus(): Record<EndpointName, boolean> {
    return endpointStatus(this.endpoints);
  }

  /** Endpoints the adapter needs that aren't in the endpoints file. */
  missingEndpoints(): EndpointName[] {
    const status = this.endpointStatus();
    return (this.adapter.requiredEndpoints ?? []).filter((n) => !status[n]);
  }
}
