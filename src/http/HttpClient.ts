import { isSecureOrLocal } from '../config.js';
import { buildUrl, requireEndpoint, type EndpointMap, type EndpointName } from '../endpoints.js';
import { AuthError, OlxHttpError, OlxSdkError, UncertainWriteError } from '../errors.js';
import { silentLogger, type Logger, type RequestLog, type RequestLogEntry } from '../logger.js';
import type { SessionProvider } from '../session/SessionManager.js';
import { cookieHeaderFor, type SessionData } from '../session/storage.js';
import type { WriteRateLimiter } from './rateLimiter.js';

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  params?: Record<string, string>;
  /** Arrays repeat the key: `{ 'ads_ids[]': ['1', '2'] }` → `?ads_ids[]=1&ads_ids[]=2`. */
  query?: Record<string, string | number | boolean | undefined | ReadonlyArray<string | number>>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /**
   * Defaults to true for non-GET calls. Pass false when the caller already holds a write
   * slot (see `acquireWriteSlot`), e.g. the createAd that follows its image uploads.
   */
  rateLimit?: boolean;
  /** Awaited right before the request is first sent; if it throws, nothing is sent. */
  beforeSend?: () => Promise<void>;
  /** Overrides the client's read retries for this call (best-effort lookups use 0). */
  retries?: number;
  /** Overrides the client's timeout for this call. */
  timeoutMs?: number;
}

export interface HttpClientOptions {
  baseUrl: string;
  endpoints: EndpointMap;
  session: SessionProvider;
  limiter: WriteRateLimiter;
  logger?: Logger;
  requestLog?: RequestLog;
  transport?: Transport;
  /** Extra attempts for GET calls on network errors, 429 and 5xx. Writes are never retried automatically. */
  maxReadRetries?: number;
  retryBaseMs?: number;
  /** Upper bound for a server-requested Retry-After wait. */
  maxRetryDelayMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Extra headers derived from the session (adapter hook), sent only where the session is sent. */
  extraHeaders?: (session: SessionData) => Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_DELAY_MS = 60_000;
/** Redirect targets that mean "you're not logged in" (so a write was definitely not processed). */
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|auth|authenticate|account\/login|sso)(\/|$|\.)/i;
const DEFAULT_TIMEOUT_MS = 30_000;

/** `www.olx.com.lb` → `olx.com.lb`; the session is only valid for that domain and its subdomains. */
export function sessionDomain(baseUrl: string): string {
  return new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '');
}

export function isWithinDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || h.endsWith('.' + domain);
}

/**
 * Replays OLX web-app calls with your saved session.
 *
 * - The session (cookies and auth headers) is only attached to the OLX domain.
 * - Redirects are never followed: on OLX a redirect almost always means "go log in",
 *   and following it could forward credentials to another host.
 * - Writes are never auto-retried. When a write's outcome is unknown (timeout, network
 *   error, 5xx) an `UncertainWriteError` is thrown so the caller can avoid a duplicate ad.
 */
export class OlxHttpClient {
  private readonly logger: Logger;
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly domain: string;

  constructor(private readonly o: HttpClientOptions) {
    this.logger = o.logger ?? silentLogger;
    this.transport = o.transport ?? ((url, init) => fetch(url, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.domain = sessionDomain(o.baseUrl);
  }

  /** Waits for one write slot from the rate limiter; the resolved function refunds it. */
  acquireWriteSlot(): Promise<() => void> {
    return this.o.limiter.acquire();
  }

  async call<T = unknown>(name: EndpointName, opts: CallOptions = {}): Promise<T> {
    const spec = requireEndpoint(this.o.endpoints, name);
    const url = buildUrl(this.o.baseUrl, spec, opts.params, opts.query);
    const target = new URL(url);
    if (!isSecureOrLocal(target)) {
      throw new OlxSdkError(`Refusing to call "${name}" over ${target.protocol} — OLX endpoints must use https`);
    }
    const isRead = spec.method === 'GET';

    if (opts.rateLimit ?? !isRead) await this.o.limiter.acquire();

    const headers: Record<string, string> = { accept: 'application/json, text/plain, */*' };
    const session = await this.o.session.getSession();
    if (session.userAgent) headers['user-agent'] = session.userAgent;
    if (isWithinDomain(target.hostname, this.domain) || spec.sendSessionToForeignHost === true) {
      Object.assign(headers, session.headers, this.o.extraHeaders?.(session));
      const cookie = cookieHeaderFor(session, url);
      if (cookie) headers.cookie = cookie;
    }
    Object.assign(headers, opts.headers);

    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
    } else if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary itself
    }

    const maxAttempts = isRead ? 1 + (opts.retries ?? this.o.maxReadRetries ?? 2) : 1;
    const baseDelay = this.o.retryBaseMs ?? 1_000;
    const maxDelay = this.o.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    const timeoutMs = opts.timeoutMs ?? this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (let attempt = 1; ; attempt++) {
      if (attempt === 1 && opts.beforeSend) await opts.beforeSend();
      const started = Date.now();
      let res: Response;
      try {
        res = await this.transport(url, {
          method: spec.method,
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        this.record({ name, method: spec.method, url, attempt, started, error: (err as Error).message });
        if (attempt < maxAttempts) {
          await this.sleep(Math.min(baseDelay * 2 ** (attempt - 1), maxDelay));
          continue;
        }
        if (!isRead) {
          throw new UncertainWriteError(
            name,
            `Network error or timeout during OLX "${name}" — the request may have been processed`,
            { cause: err },
          );
        }
        throw new OlxSdkError(`Network error calling OLX "${name}"`, { cause: err });
      }

      this.record({ name, method: spec.method, url, attempt, started, status: res.status });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        let where = 'another page';
        // A write answered by a bare 3xx (no Location) can't be called "not processed".
        let looksLikeLogin = isRead && !location;
        if (location) {
          try {
            const loc = new URL(location, url);
            where = loc.origin + loc.pathname;
            looksLikeLogin = LOGIN_PATH.test(loc.pathname);
          } catch {
            /* keep generic */
          }
        }
        if (!isRead && !looksLikeLogin) {
          // Post/redirect/get: a successful write often answers 303 → the new resource.
          // We can't tell success from failure here, so it must not be treated as "not created".
          throw new UncertainWriteError(
            name,
            `OLX answered "${name}" with HTTP ${res.status} → ${where}; the write may have succeeded`,
            { status: res.status },
          );
        }
        this.o.session.invalidate?.();
        throw new AuthError(
          `OLX redirected "${name}" (HTTP ${res.status}) to ${where}. The session has probably expired; ` +
            'run `npm run login` again. If this endpoint legitimately redirects, update its path to the final URL.',
          res.status,
        );
      }

      if (res.ok) {
        const type = res.headers.get('content-type') ?? '';
        let payload: unknown;
        try {
          payload = await readBody(res);
        } catch (err) {
          // Headers said success but the body was cut off (reset, timeout mid-body).
          this.record({ name, method: spec.method, url, attempt, started, status: res.status, error: (err as Error).message });
          if (!isRead) {
            throw new UncertainWriteError(
              name,
              `OLX accepted "${name}" (HTTP ${res.status}) but the response body could not be read`,
              { cause: err, status: res.status },
            );
          }
          if (attempt < maxAttempts) {
            await this.sleep(Math.min(baseDelay * 2 ** (attempt - 1), maxDelay));
            continue;
          }
          throw new OlxSdkError(`Could not read the OLX response for "${name}"`, { cause: err });
        }
        if (type.includes('text/html')) {
          // An HTML page from an API endpoint is usually a login or challenge page.
          const message = `OLX answered "${name}" with an HTML page instead of data (login or bot-protection page?)`;
          if (!isRead) throw new UncertainWriteError(name, message, { status: res.status });
          throw new OlxSdkError(message);
        }
        return payload as T;
      }

      const payload = await readBody(res).catch(() => undefined);
      if (res.status === 401 || res.status === 403) {
        this.o.session.invalidate?.();
        throw new AuthError(
          `OLX rejected the request to "${name}" with HTTP ${res.status}. The session has probably ` +
            'expired (run `npm run login` again), or bot protection is challenging this client.',
          res.status,
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wanted = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** (attempt - 1);
        const delay = Math.min(wanted, maxDelay);
        this.logger.warn('Retrying OLX read', { endpoint: name, status: res.status, delay });
        await this.sleep(delay);
        continue;
      }
      if (!isRead && res.status >= 500) {
        throw new UncertainWriteError(name, `OLX returned HTTP ${res.status} for "${name}" — outcome unknown`, {
          status: res.status,
          body: payload,
        });
      }
      throw new OlxHttpError(name, res.status, payload);
    }
  }

  /**
   * PUTs a file to a one-time signed upload URL (e.g. S3). The session is never attached,
   * redirects are not followed, and only URLs accepted by `isAllowedUrl` are contacted.
   * The URL's query (the signature) is kept out of logs and errors.
   */
  async putToSignedUrl(
    rawUrl: string,
    data: Uint8Array,
    contentType: string,
    isAllowedUrl: (url: URL) => boolean,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new OlxSdkError('OLX returned an invalid upload URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new OlxSdkError('OLX returned an upload URL that is not plain https; refusing to upload');
    }
    if (!isAllowedUrl(url)) {
      throw new OlxSdkError(`OLX returned an upload URL on an unexpected host or path (${url.hostname}); refusing to upload`);
    }
    const name = 'signedUpload';
    const started = Date.now();
    let res: Response;
    try {
      res = await this.transport(url.toString(), {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: data as BodyInit,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      this.record({ name, method: 'PUT', url: url.toString(), attempt: 1, started, error: (err as Error).name });
      throw new UncertainWriteError(name, 'Network error or timeout while uploading a photo', { cause: err });
    }
    this.record({ name, method: 'PUT', url: url.toString(), attempt: 1, started, status: res.status });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return;
    if (res.status >= 500) {
      throw new UncertainWriteError(name, `Photo upload returned HTTP ${res.status}`, { status: res.status });
    }
    // Includes 403 for an expired signature: the photo was not stored.
    throw new OlxHttpError(name, res.status, undefined);
  }

  private record(r: {
    name: string;
    method: string;
    url: string;
    attempt: number;
    started: number;
    status?: number;
    error?: string;
  }): void {
    const u = new URL(r.url);
    const entry: RequestLogEntry = {
      ts: new Date(r.started).toISOString(),
      endpoint: r.name,
      method: r.method,
      url: u.origin + u.pathname, // query strings can carry identifiers; keep them out of the log
      attempt: r.attempt,
      durationMs: Date.now() - r.started,
      status: r.status,
      error: r.error,
    };
    // Logging must never change the outcome of a call (e.g. turn a successful create into a failure).
    try {
      this.o.requestLog?.write(entry);
    } catch (err) {
      this.logger.warn('Could not write request log', { error: (err as Error).message });
    }
    this.logger.debug('OLX request', { ...entry });
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
