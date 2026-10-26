import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OlxConfig, WriteLimits } from './config.js';
import { endpointStatus, loadEndpoints, type EndpointMap, type EndpointName } from './endpoints.js';
import { OlxHttpClient, type Transport } from './http/HttpClient.js';
import { WriteRateLimiter, type RateLimiterClock } from './http/rateLimiter.js';
import { placeholderAdapter, type OlxAdapter } from './listings/adapter.js';
import { ImageUploader } from './listings/images.js';
import { ListingsApi } from './listings/ListingsApi.js';
import { FileRequestLog, silentLogger, type Logger, type RequestLog } from './logger.js';
import { CatalogMapper, loadCatalog, type Catalog } from './mapping/CatalogMapper.js';
import { DEFAULT_CAPTURED_HEADERS, SessionManager } from './session/SessionManager.js';
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
  resolveHost?: (host: string) => Promise<string[]>;
  /** Non-OLX hosts whose requests are watched for auth headers at login. */
  extraHosts?: string[];
  /** Header names captured at login, in addition to the defaults. */
  captureHeaders?: string[];
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
    });
    this.mapper = new CatalogMapper(opts.catalog);
    const images = new ImageUploader({
      http: this.http,
      adapter,
      allowedHosts: opts.allowedImageHosts,
      fetchImpl: opts.imageFetch,
      resolveHost: opts.resolveHost,
    });
    this.listings = new ListingsApi({ http: this.http, mapper: this.mapper, adapter, images });
    this.syncStore = opts.syncStore;
    this.sync = new SyncService({ listings: this.listings, store: opts.syncStore, mapper: this.mapper, logger });
  }

  /** Builds a client from `loadConfig()` output, using file-based stores. */
  static fromConfig(
    config: OlxConfig,
    overrides: Partial<Omit<OlxClientOptions, 'baseUrl' | 'writeLimits'>> = {},
  ): OlxClient {
    const logger = overrides.logger ?? silentLogger;
    for (const [label, file, provided] of [
      ['Endpoints file', config.endpointsFile, overrides.endpoints],
      ['Catalog file', config.catalogFile, overrides.catalog],
    ] as const) {
      if (!provided && !existsSync(file)) {
        logger.warn(`${label} not found; continuing with an empty one`, {
          path: resolve(file),
          hint: 'Copy the matching config/*.example.json, or check the working directory / env path',
        });
      }
    }
    return new OlxClient({
      baseUrl: config.baseUrl,
      writeLimits: config.writeLimits,
      allowedImageHosts: config.allowedImageHosts,
      extraHosts: config.extraHosts,
      captureHeaders: config.captureHeaders,
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
