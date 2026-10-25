import type { OlxConfig, WriteLimits } from './config.js';
import { endpointStatus, loadEndpoints, type EndpointMap, type EndpointName } from './endpoints.js';
import { OlxHttpClient, type Transport } from './http/HttpClient.js';
import { WriteRateLimiter, type RateLimiterClock } from './http/rateLimiter.js';
import { placeholderAdapter, type OlxAdapter } from './listings/adapter.js';
import { ImageUploader } from './listings/images.js';
import { ListingsApi } from './listings/ListingsApi.js';
import { FileRequestLog, silentLogger, type Logger, type RequestLog } from './logger.js';
import { CatalogMapper, loadCatalog, type Catalog } from './mapping/CatalogMapper.js';
import { SessionManager } from './session/SessionManager.js';
import { FileSessionStore, type SessionStore } from './session/storage.js';
import { SyncService } from './sync/SyncService.js';
import { JsonFileSyncStore, type SyncStore } from './sync/SyncStore.js';

export interface OlxClientOptions {
  baseUrl: string;
  endpoints: EndpointMap;
  catalog: Catalog;
  sessionStore: SessionStore;
  syncStore: SyncStore;
  writeLimits: WriteLimits;
  adapter?: OlxAdapter;
  logger?: Logger;
  requestLog?: RequestLog;
  transport?: Transport;
  clock?: RateLimiterClock;
  allowedImageHosts?: string[];
  imageFetch?: typeof fetch;
}

/** Everything wired together. Most users only need `client.sync` (or `client.listings`). */
export class OlxClient {
  readonly session: SessionManager;
  readonly http: OlxHttpClient;
  readonly listings: ListingsApi;
  readonly sync: SyncService;
  readonly syncStore: SyncStore;
  readonly mapper: CatalogMapper;
  readonly limiter: WriteRateLimiter;
  private readonly endpoints: EndpointMap;

  constructor(opts: OlxClientOptions) {
    const logger = opts.logger ?? silentLogger;
    const adapter = opts.adapter ?? placeholderAdapter;
    this.endpoints = opts.endpoints;
    this.session = new SessionManager({ baseUrl: opts.baseUrl, store: opts.sessionStore, logger });
    this.limiter = new WriteRateLimiter(opts.writeLimits, opts.clock);
    this.http = new OlxHttpClient({
      baseUrl: opts.baseUrl,
      endpoints: opts.endpoints,
      session: this.session,
      limiter: this.limiter,
      logger,
      requestLog: opts.requestLog,
      transport: opts.transport,
    });
    this.mapper = new CatalogMapper(opts.catalog);
    const images = new ImageUploader({
      http: this.http,
      adapter,
      allowedHosts: opts.allowedImageHosts,
      fetchImpl: opts.imageFetch,
    });
    this.listings = new ListingsApi({ http: this.http, mapper: this.mapper, adapter, images });
    this.syncStore = opts.syncStore;
    this.sync = new SyncService({ listings: this.listings, store: opts.syncStore, logger });
  }

  /** Builds a client from `loadConfig()` output, using file-based stores. */
  static fromConfig(
    config: OlxConfig,
    overrides: Partial<Omit<OlxClientOptions, 'baseUrl' | 'writeLimits'>> = {},
  ): OlxClient {
    return new OlxClient({
      baseUrl: config.baseUrl,
      writeLimits: config.writeLimits,
      allowedImageHosts: config.allowedImageHosts,
      endpoints: overrides.endpoints ?? loadEndpoints(config.endpointsFile),
      catalog: overrides.catalog ?? loadCatalog(config.catalogFile),
      sessionStore: overrides.sessionStore ?? new FileSessionStore(config.sessionFile),
      syncStore: overrides.syncStore ?? new JsonFileSyncStore(config.syncStoreFile),
      requestLog: overrides.requestLog ?? new FileRequestLog(config.requestLogFile),
      ...overrides,
    });
  }

  /** Which endpoints have been mapped so far. */
  endpointStatus(): Record<EndpointName, boolean> {
    return endpointStatus(this.endpoints);
  }
}
