import { AuthError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import { loadPlaywright } from './playwright.js';
import type { SessionData, SessionStore, StoredCookie } from './storage.js';

export interface SessionProvider {
  getSession(): Promise<SessionData>;
  /** Called when OLX rejects the session, so the next call re-reads it from the store. */
  invalidate?(): void;
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
}

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

  constructor(private readonly opts: SessionManagerOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  async getSession(): Promise<SessionData> {
    const s = await this.current();
    if (!s) {
      throw new AuthError(
        'No OLX session. Pass `accessToken` to createOlxClient (get one with `npx olx-lb login`), or run `olx-lb login`.',
      );
    }
    return s;
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
