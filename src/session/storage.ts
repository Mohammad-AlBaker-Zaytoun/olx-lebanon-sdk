import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
 * A session made from an access token alone (OLX accepts the bearer token without cookies).
 * Accepts the token with or without a leading "Bearer ".
 */
export function sessionFromAccessToken(accessToken: string): SessionData {
  const token = accessToken.trim().replace(/^bearer\s+/i, '');
  if (!/^\S{20,}$/.test(token)) throw new TypeError('The OLX access token looks empty or malformed');
  return { cookies: [], headers: { authorization: `Bearer ${token}` }, savedAt: 'access-token' };
}
