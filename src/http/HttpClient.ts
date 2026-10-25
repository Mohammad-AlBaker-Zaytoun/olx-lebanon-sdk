import { buildUrl, requireEndpoint, type EndpointMap, type EndpointName } from '../endpoints.js';
import { AuthError, OlxHttpError, OlxSdkError } from '../errors.js';
import { silentLogger, type Logger, type RequestLog } from '../logger.js';
import type { SessionProvider } from '../session/SessionManager.js';
import { cookieHeaderFor } from '../session/storage.js';
import type { WriteRateLimiter } from './rateLimiter.js';

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Defaults to true for non-GET calls. Image uploads opt out (they are part of one ad write). */
  rateLimit?: boolean;
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
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Replays OLX web-app calls with your saved session. Writes are never auto-retried:
 * a timed-out "create ad" may still have succeeded, and retrying would duplicate it.
 */
export class OlxHttpClient {
  private readonly logger: Logger;
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: HttpClientOptions) {
    this.logger = o.logger ?? silentLogger;
    this.transport = o.transport ?? ((url, init) => fetch(url, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T = unknown>(name: EndpointName, opts: CallOptions = {}): Promise<T> {
    const spec = requireEndpoint(this.o.endpoints, name);
    const url = buildUrl(this.o.baseUrl, spec, opts.params, opts.query);
    const isRead = spec.method === 'GET';

    if (opts.rateLimit ?? !isRead) await this.o.limiter.acquire();

    const session = await this.o.session.getSession();
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      ...session.headers,
      ...opts.headers,
    };
    if (session.userAgent) headers['user-agent'] = session.userAgent;
    const cookie = cookieHeaderFor(session, url);
    if (cookie) headers.cookie = cookie;

    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['content-type'] = 'application/json';
    } else if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary itself
    }

    const maxAttempts = isRead ? 1 + (this.o.maxReadRetries ?? 2) : 1;
    const baseDelay = this.o.retryBaseMs ?? 1_000;

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await this.transport(url, { method: spec.method, headers, body });
      } catch (err) {
        this.record(name, spec.method, url, attempt, started, undefined, (err as Error).message);
        if (attempt < maxAttempts) {
          await this.sleep(baseDelay * 2 ** (attempt - 1));
          continue;
        }
        throw new OlxSdkError(`Network error calling OLX "${name}"`, { cause: err });
      }

      this.record(name, spec.method, url, attempt, started, res.status);
      if (res.ok) return (await readBody(res)) as T;

      const payload = await readBody(res).catch(() => undefined);
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(
          `OLX rejected the request to "${name}" with HTTP ${res.status}. The session has probably ` +
            'expired (run `npm run login` again), or bot protection is challenging this client.',
          res.status,
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** (attempt - 1);
        this.logger.warn('Retrying OLX read', { endpoint: name, status: res.status, delay });
        await this.sleep(delay);
        continue;
      }
      throw new OlxHttpError(name, res.status, payload);
    }
  }

  private record(
    endpoint: string,
    method: string,
    url: string,
    attempt: number,
    started: number,
    status?: number,
    error?: string,
  ): void {
    const u = new URL(url);
    const entry = {
      ts: new Date(started).toISOString(),
      endpoint,
      method,
      url: u.origin + u.pathname, // query strings can carry identifiers; keep them out of the log
      attempt,
      durationMs: Date.now() - started,
      status,
      error,
    };
    this.o.requestLog?.write(entry);
    this.logger.debug('OLX request', entry);
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
