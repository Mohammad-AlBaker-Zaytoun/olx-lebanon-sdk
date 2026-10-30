import { AuthError, OlxSdkError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { loadPlaywright } from './playwright.js';
import type { OlxTokens } from './refresh.js';
import { accessTokenOf, refreshTokenOf, withTokens, type SessionData, type SessionStore, type StoredCookie } from './storage.js';
import { inspectAccessToken } from './token.js';

export interface SessionProvider {
  getSession(): Promise<SessionData>;
  /** Called when OLX rejects the session, so the next call re-reads it from the store. */
  invalidate?(): void;
  /**
   * Called once when OLX rejects `rejected` with HTTP 401. Returns a renewed session to retry the
   * request with, or null when the session can't be renewed.
   */
  renewAfterRejection?(rejected: SessionData): Promise<SessionData | null>;
}

/** The new token pair after a renewal, as given to `onSessionRefreshed`. */
export interface RefreshedSession extends OlxTokens {
  /** When the new access token expires, or null if it can't be read. */
  expiresAt: Date | null;
}

/** How a client renews its access token with the refresh token. */
export interface SessionRefreshOptions {
  /** Exchanges a refresh token for a new pair (`refreshOlxTokens` for OLX Lebanon). */
  refresher: (refreshToken: string) => Promise<OlxTokens>;
  /** Renew when the access token expires within this many days. Default 30. */
  beforeExpiryDays?: number;
  /**
   * Also renew once the access token is this many days old (its `iat`). Off by default. Set it
   * (e.g. 7) to use the refresh token regularly, in case OLX expires unused refresh tokens.
   */
  afterDays?: number;
  /** Called after each renewal with the new pair: save it. Awaited; retried on the next request if it throws. */
  onRefreshed?: (session: RefreshedSession) => void | Promise<void>;
  /** Called when a renewal fails. While the current token still works, requests carry on with it. */
  onFailed?: (error: OlxSdkError) => void;
  /** Wait this long before trying again after a failed early renewal. Default 1 hour. */
  retryAfterMs?: number;
  now?: () => number;
}

export interface SessionStatus {
  loggedIn: boolean;
  savedAt?: string;
  cookieCount: number;
  capturedHeaders: string[];
}

interface BrowserStorageState {
  cookies: StoredCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/**
 * Keeps only cookies and localStorage for the given domains (and subdomains). Signing in with
 * Google/Facebook puts their session cookies in the same browser context; those must never
 * end up in session.json.
 */
export function scopeStorageState(
  state: BrowserStorageState,
  domains: string[],
): { cookies: StoredCookie[]; localStorage: Record<string, Record<string, string>> } {
  const inScope = (host: string) => {
    const h = host.toLowerCase().replace(/^\./, '');
    return domains.some((d) => h === d || h.endsWith('.' + d));
  };
  return {
    cookies: state.cookies.filter((c) => inScope(c.domain)),
    localStorage: Object.fromEntries(
      state.origins
        .filter((o) => {
          try {
            return inScope(new URL(o.origin).hostname);
          } catch {
            return false;
          }
        })
        .map((o) => [o.origin, Object.fromEntries(o.localStorage.map((kv) => [kv.name, kv.value]))]),
    ),
  };
}

/**
 * Decides which value to keep when a header is seen more than once during login. A user's
 * `Bearer` token is never replaced by another scheme: third-party services the page calls
 * (a search cluster, say) can send their own fixed `Basic` key under the same name.
 */
export function preferCapturedHeader(name: string, current: string | undefined, next: string): string {
  if (name === 'authorization' && current && /^bearer\s/i.test(current) && !/^bearer\s/i.test(next)) return current;
  return next;
}

/** Headers worth replaying if the web app sends them on authenticated calls. Extend via options. */
export const DEFAULT_CAPTURED_HEADERS = ['authorization', 'x-access-token', 'x-auth-token', 'x-csrf-token'];

export interface SessionManagerOptions {
  baseUrl: string;
  store: SessionStore;
  logger?: Logger;
  /** Header names to capture; defaults to DEFAULT_CAPTURED_HEADERS. */
  captureHeaders?: string[];
  /** Non-OLX hosts the web app sends authenticated calls to (e.g. an image or API host). */
  extraHosts?: string[];
  /** Renew the access token with the session's refresh token. Off when not given. */
  refresh?: SessionRefreshOptions;
}

const DAY_MS = 86_400_000;

/**
 * Owns the logged-in OLX session.
 *
 * Login is always done by you, in a real (headed) browser window: OTPs, CAPTCHAs and
 * phone verification are completed by hand and are never automated or bypassed.
 * The SDK then reuses the saved cookies/headers for plain HTTP calls.
 */
export class SessionManager implements SessionProvider {
  private cached: SessionData | null = null;
  private cachedVersion: string | undefined;
  private readonly logger: Logger;
  /** The renewal in progress; there is never more than one per client. */
  private renewing: Promise<SessionData> | null = null;
  /** A renewal whose `onRefreshed` failed: offered again on the next request. */
  private unsaved: RefreshedSession | null = null;
  /** After an early renewal fails, no new early attempt for the same refresh token until then. */
  private quietUntil = new Map<string, number>();

  constructor(private readonly opts: SessionManagerOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  async getSession(): Promise<SessionData> {
    let s = await this.current();
    if (!s) {
      throw new AuthError(
        'No OLX session. Pass `accessToken` to createOlxClient (get one with `npx olx-lb login`), or run `olx-lb login`.',
      );
    }
    if (this.unsaved) await this.notifyRefreshed(this.unsaved);
    const refresh = this.opts.refresh;
    if (refresh && this.dueForRenewal(s, refresh)) {
      const token = refreshTokenOf(s)!;
      const stillValid = !this.isExpired(s);
      try {
        s = await this.renew(s);
      } catch (err) {
        // An early renewal that fails is not fatal while the current token still works.
        if (!stillValid) throw err;
        this.quietUntil.set(token, this.now() + (refresh.retryAfterMs ?? 3_600_000));
        this.logger.warn('Could not renew the OLX session early; using the current token', {
          error: (err as Error).message,
        });
      }
    }
    return s;
  }

  /**
   * Renews the access token now with the session's refresh token, saves the new pair to the
   * session store and calls `onSessionRefreshed`. Throws `AuthError` if OLX refuses it.
   */
  async refresh(): Promise<RefreshedSession> {
    const s = await this.current();
    if (!s) throw new AuthError('No OLX session to renew; sign in first.');
    const renewed = await this.renew(s);
    return this.describe(renewed);
  }

  async renewAfterRejection(rejected: SessionData): Promise<SessionData | null> {
    if (!this.opts.refresh) return null;
    const current = (await this.current()) ?? rejected;
    // Someone else renewed (or replaced) the session meanwhile: retry with that one.
    if (accessTokenOf(current) !== accessTokenOf(rejected)) return current;
    if (!refreshTokenOf(current)) return null;
    try {
      return await this.renew(current);
    } catch (err) {
      this.logger.warn('Could not renew the OLX session after OLX rejected it', { error: (err as Error).message });
      return null;
    }
  }

  private now(): number {
    return this.opts.refresh?.now?.() ?? Date.now();
  }

  private isExpired(s: SessionData): boolean {
    const exp = inspectAccessToken(accessTokenOf(s) ?? '').expiresAt;
    return exp !== null && exp.getTime() <= this.now();
  }

  private dueForRenewal(s: SessionData, refresh: SessionRefreshOptions): boolean {
    const token = refreshTokenOf(s);
    if (!token) return false;
    if ((this.quietUntil.get(token) ?? 0) > this.now()) return false;
    const info = inspectAccessToken(accessTokenOf(s) ?? '');
    const now = this.now();
    if (info.expiresAt && info.expiresAt.getTime() - now <= (refresh.beforeExpiryDays ?? 30) * DAY_MS) return true;
    if (refresh.afterDays !== undefined && info.issuedAt && now - info.issuedAt.getTime() >= refresh.afterDays * DAY_MS) {
      return true;
    }
    return false;
  }

  private describe(s: SessionData): RefreshedSession {
    const accessToken = accessTokenOf(s) ?? '';
    return {
      accessToken,
      refreshToken: refreshTokenOf(s) ?? '',
      expiresAt: inspectAccessToken(accessToken).expiresAt,
    };
  }

  /** One renewal at a time: concurrent callers share the one in flight. */
  private renew(s: SessionData): Promise<SessionData> {
    this.renewing ??= this.doRenew(s).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async doRenew(s: SessionData): Promise<SessionData> {
    const refresh = this.opts.refresh;
    const token = refreshTokenOf(s);
    if (!refresh || !token) throw new AuthError('This OLX session has no refresh token; sign in again.');
    let tokens: OlxTokens;
    try {
      tokens = await refresh.refresher(token);
    } catch (err) {
      const e = err instanceof OlxSdkError ? err : new OlxSdkError('Could not renew the OLX session', { cause: err });
      try {
        refresh.onFailed?.(e);
      } catch {
        /* a callback must not change the outcome */
      }
      throw e;
    }
    const renewed = withTokens(s, tokens, this.now());
    await this.opts.store.save(renewed);
    this.cached = renewed;
    this.cachedVersion = await this.opts.store.version?.();
    this.quietUntil.delete(token);
    this.logger.info('OLX session renewed', { expiresAt: inspectAccessToken(tokens.accessToken).expiresAt?.toISOString() });
    await this.notifyRefreshed(this.describe(renewed));
    return renewed;
  }

  private async notifyRefreshed(session: RefreshedSession): Promise<void> {
    const onRefreshed = this.opts.refresh?.onRefreshed;
    if (!onRefreshed) return;
    try {
      await onRefreshed(session);
      const latest = this.cached ? accessTokenOf(this.cached) : undefined;
      if (this.unsaved === session || latest === session.accessToken) this.unsaved = null;
    } catch (err) {
      // Keep the new pair and offer it again: losing it could mean signing in again.
      this.unsaved = session;
      this.logger.error('onSessionRefreshed failed; it will be called again on the next request', {
        error: (err as Error).message,
      });
    }
  }

  invalidate(): void {
    this.cached = null;
    this.cachedVersion = undefined;
  }

  /** Returns the cached session, reloading it if the store reports a change. */
  private async current(): Promise<SessionData | null> {
    const store = this.opts.store;
    if (store.version) {
      const v = await store.version();
      if (this.cached && v !== this.cachedVersion) {
        this.logger.info('Session store changed; reloading');
        this.cached = null;
      }
      if (!this.cached) {
        this.cached = await store.load();
        this.cachedVersion = v;
      }
    } else if (!this.cached) {
      this.cached = await store.load();
    }
    return this.cached;
  }

  async status(): Promise<SessionStatus> {
    const s = await this.current();
    return {
      loggedIn: s !== null,
      savedAt: s?.savedAt,
      cookieCount: s?.cookies.length ?? 0,
      capturedHeaders: s ? Object.keys(s.headers) : [],
    };
  }

  async clear(): Promise<void> {
    this.invalidate();
    await this.opts.store.clear();
  }

  /**
   * Opens a visible Chromium window on OLX. You sign in yourself; when you're done,
   * `waitForUser` resolves (e.g. you press Enter in the terminal) and the session is saved.
   */
  async loginInteractive(waitForUser: () => Promise<void>): Promise<SessionData> {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext({ locale: 'en-US' });
      const domains = [new URL(this.opts.baseUrl).hostname.toLowerCase().replace(/^www\./, ''), ...(this.opts.extraHosts ?? [])];
      const wanted = (this.opts.captureHeaders ?? DEFAULT_CAPTURED_HEADERS).map((h) => h.toLowerCase());
      const captured: Record<string, string> = {};

      context.on('request', (req) => {
        let host: string;
        try {
          host = new URL(req.url()).hostname.toLowerCase();
        } catch {
          return;
        }
        if (!domains.some((d) => host === d || host.endsWith('.' + d))) return;
        const headers = req.headers();
        for (const name of wanted) {
          const value = headers[name];
          if (value) captured[name] = preferCapturedHeader(name, captured[name], value);
        }
      });

      const page = await context.newPage();
      await page.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded' });
      await waitForUser();

      // Reload once so authenticated background calls fire and their headers get captured.
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {});

      const state = await context.storageState();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const { cookies, localStorage } = scopeStorageState(state, domains);

      const session: SessionData = {
        cookies,
        headers: captured,
        localStorage,
        userAgent,
        savedAt: new Date().toISOString(),
      };
      await this.opts.store.save(session);
      this.cached = session;
      this.cachedVersion = await this.opts.store.version?.();
      this.logger.info('OLX session saved', {
        cookies: session.cookies.length,
        capturedHeaders: Object.keys(captured),
      });
      return session;
    } finally {
      await browser.close();
    }
  }
}
