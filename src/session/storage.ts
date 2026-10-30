import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isWellFormedAccessToken, normalizeAccessToken } from './token.js';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface SessionData {
  cookies: StoredCookie[];
  /** Auth-like request headers seen while logged in (e.g. `authorization`). */
  headers: Record<string, string>;
  /** localStorage per origin, in case OLX keeps its token there. */
  localStorage?: Record<string, Record<string, string>>;
  userAgent?: string;
  /**
   * The token that renews the access token. Sessions saved by `olx-lb login` also carry it as
   * the `refreshToken` cookie; this field, when set, takes precedence.
   */
  refreshToken?: string;
  savedAt: string;
}

export interface SessionStore {
  load(): Promise<SessionData | null>;
  save(data: SessionData): Promise<void>;
  clear(): Promise<void>;
  /**
   * Optional cheap change marker (e.g. file mtime). When it changes, the SessionManager
   * reloads, so a re-login from another process is picked up without a restart.
   */
  version?(): Promise<string | undefined>;
}

/** Stores the session as JSON with owner-only permissions. The file is a secret: keep it out of git. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly file: string) {}

  async load(): Promise<SessionData | null> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as SessionData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(data: SessionData): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => {}); // no-op on Windows
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }

  async version(): Promise<string | undefined> {
    try {
      const s = await stat(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return undefined;
    }
  }
}

export class MemorySessionStore implements SessionStore {
  constructor(private data: SessionData | null = null) {}
  async load(): Promise<SessionData | null> {
    return this.data;
  }
  async save(data: SessionData): Promise<void> {
    this.data = data;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}

/** Builds the `Cookie` header a browser would send to `url`. */
export function cookieHeaderFor(session: SessionData, url: string, nowSec = Date.now() / 1000): string {
  const { hostname, pathname, protocol } = new URL(url);
  return session.cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./, '').toLowerCase();
      const domainOk = hostname === domain || hostname.endsWith('.' + domain);
      const pathOk = pathname.startsWith(c.path || '/');
      const alive = c.expires === -1 || c.expires > nowSec;
      const secureOk = !c.secure || protocol === 'https:';
      return domainOk && pathOk && alive && secureOk;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * A session made from an access token alone (OLX accepts the bearer token without cookies),
 * plus the refresh token if you have one. Accepts the token with or without a leading "Bearer ".
 */
export function sessionFromAccessToken(accessToken: string, refreshToken?: string): SessionData {
  if (typeof accessToken !== 'string' || !isWellFormedAccessToken(accessToken)) {
    throw new TypeError('The OLX access token looks empty or malformed');
  }
  const token = normalizeAccessToken(accessToken);
  const refresh = typeof refreshToken === 'string' && refreshToken.trim() ? refreshToken.trim() : undefined;
  return {
    cookies: [],
    headers: { authorization: `Bearer ${token}` },
    ...(refresh ? { refreshToken: refresh } : {}),
    savedAt: 'access-token',
  };
}

const isOlxCookie = (c: StoredCookie, name: string) =>
  c.name === name && /(^|\.)olx\.com\.lb$/i.test(c.domain.replace(/^\./, ''));

/** The session's bearer token: the `authorization` header, else the `accessToken` cookie. */
export function accessTokenOf(session: SessionData): string | undefined {
  const header = session.headers.authorization;
  if (header && /^bearer\s+\S/i.test(header)) return normalizeAccessToken(header);
  return session.cookies.find((c) => isOlxCookie(c, 'accessToken') && c.value)?.value;
}

/** The session's refresh token: the `refreshToken` field, else the `refreshToken` cookie. */
export function refreshTokenOf(session: SessionData): string | undefined {
  if (session.refreshToken?.trim()) return session.refreshToken.trim();
  return session.cookies.find((c) => isOlxCookie(c, 'refreshToken') && c.value)?.value || undefined;
}

/** A copy of `session` carrying a renewed token pair (header, cookies and `refreshToken`). */
export function withTokens(
  session: SessionData,
  tokens: { accessToken: string; refreshToken: string },
  now = Date.now(),
): SessionData {
  return {
    ...session,
    headers: { ...session.headers, authorization: `Bearer ${tokens.accessToken}` },
    cookies: session.cookies.map((c) =>
      isOlxCookie(c, 'accessToken')
        ? { ...c, value: tokens.accessToken }
        : isOlxCookie(c, 'refreshToken')
          ? { ...c, value: tokens.refreshToken }
          : c,
    ),
    refreshToken: tokens.refreshToken,
    savedAt: new Date(now).toISOString(),
  };
}

type MaybePromise<T> = T | Promise<T>;
const digest = (v: string) => createHash('sha256').update(v).digest('base64url');

/**
 * A session read from your own functions on every request, so a long-lived client picks up a
 * token saved elsewhere (a database, a secrets store) without being rebuilt. Keep the functions
 * cheap: cache inside them if they read a database.
 *
 * A token renewed by the client is kept in memory until your functions return something new
 * (normally the pair you saved in `onSessionRefreshed`).
 */
export class TokenSourceStore implements SessionStore {
  private last: { access: string; refresh?: string } | undefined;
  private renewed: { from: string; data: SessionData } | undefined;

  constructor(
    private readonly accessToken: () => MaybePromise<string>,
    private readonly refreshToken?: () => MaybePromise<string | null | undefined>,
  ) {}

  private async read(): Promise<{ access: string; refresh?: string }> {
    const access = await this.accessToken();
    const refresh = (await this.refreshToken?.()) ?? undefined;
    this.last = { access: typeof access === 'string' ? access : '', refresh: refresh || undefined };
    return this.last;
  }

  async version(): Promise<string> {
    const { access, refresh } = await this.read();
    if (this.renewed && this.renewed.from !== access) this.renewed = undefined;
    if (this.renewed) return 'renewed:' + digest(this.renewed.data.savedAt + (this.renewed.data.headers.authorization ?? ''));
    return digest(`${access}\n${refresh ?? ''}`);
  }

  async load(): Promise<SessionData | null> {
    const { access, refresh } = this.last ?? (await this.read());
    if (this.renewed && this.renewed.from === access) return this.renewed.data;
    if (!access.trim()) return null;
    try {
      return sessionFromAccessToken(access, refresh);
    } catch {
      throw new TypeError('The access token returned by your accessToken function looks empty or malformed');
    }
  }

  async save(data: SessionData): Promise<void> {
    this.renewed = { from: this.last?.access ?? '', data };
  }

  async clear(): Promise<void> {
    this.renewed = undefined;
  }
}
