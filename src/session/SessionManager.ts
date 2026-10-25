import { AuthError } from '../errors.js';
import { silentLogger, type Logger } from '../logger.js';
import type { SessionData, SessionStore } from './storage.js';

export interface SessionProvider {
  getSession(): Promise<SessionData>;
}

export interface SessionStatus {
  loggedIn: boolean;
  savedAt?: string;
  cookieCount: number;
  capturedHeaders: string[];
}

/** Headers worth replaying if the web app sends them on authenticated calls. Extend via options. */
export const DEFAULT_CAPTURED_HEADERS = ['authorization', 'x-access-token', 'x-auth-token', 'x-csrf-token'];

export interface SessionManagerOptions {
  baseUrl: string;
  store: SessionStore;
  logger?: Logger;
  captureHeaders?: string[];
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
  private readonly logger: Logger;

  constructor(private readonly opts: SessionManagerOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  async getSession(): Promise<SessionData> {
    if (!this.cached) this.cached = await this.opts.store.load();
    if (!this.cached) {
      throw new AuthError('No saved OLX session. Run `npm run login` and sign in to your OLX account.');
    }
    return this.cached;
  }

  async status(): Promise<SessionStatus> {
    const s = this.cached ?? (await this.opts.store.load());
    return {
      loggedIn: s !== null,
      savedAt: s?.savedAt,
      cookieCount: s?.cookies.length ?? 0,
      capturedHeaders: s ? Object.keys(s.headers) : [],
    };
  }

  async clear(): Promise<void> {
    this.cached = null;
    await this.opts.store.clear();
  }

  /**
   * Opens a visible Chromium window on OLX. You sign in yourself; when you're done,
   * `waitForUser` resolves (e.g. you press Enter in the terminal) and the session is saved.
   */
  async loginInteractive(waitForUser: () => Promise<void>): Promise<SessionData> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext({ locale: 'en-US' });
      const olxHost = new URL(this.opts.baseUrl).hostname.replace(/^www\./, '');
      const wanted = this.opts.captureHeaders ?? DEFAULT_CAPTURED_HEADERS;
      const captured: Record<string, string> = {};

      context.on('request', (req) => {
        let host: string;
        try {
          host = new URL(req.url()).hostname;
        } catch {
          return;
        }
        if (host !== olxHost && !host.endsWith('.' + olxHost)) return;
        const headers = req.headers();
        for (const name of wanted) {
          const value = headers[name];
          if (value) captured[name] = value;
        }
      });

      const page = await context.newPage();
      await page.goto(this.opts.baseUrl, { waitUntil: 'domcontentloaded' });
      await waitForUser();

      // Reload once so authenticated background calls fire and their headers get captured.
      await page.reload({ waitUntil: 'networkidle' }).catch(() => {});

      const state = await context.storageState();
      const userAgent = await page.evaluate(() => navigator.userAgent);
      const localStorage = Object.fromEntries(
        state.origins.map((o) => [o.origin, Object.fromEntries(o.localStorage.map((kv) => [kv.name, kv.value]))]),
      );

      const session: SessionData = {
        cookies: state.cookies,
        headers: captured,
        localStorage,
        userAgent,
        savedAt: new Date().toISOString(),
      };
      await this.opts.store.save(session);
      this.cached = session;
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
