/**
 * Reading OLX access tokens without the network. No Node.js imports: this file is also used by
 * the browser entry point (`olx-lebanon-sdk/connect`) and the OLX Connect extension.
 */

/** What can be read from an OLX access token without calling OLX. */
export interface AccessTokenInfo {
  /** Passes the same check `createOlxClient({ accessToken })` makes (non-empty, no spaces). */
  wellFormed: boolean;
  /** When the token stops working (the JWT's `exp`), or null if it can't be read. */
  expiresAt: Date | null;
  /** When OLX issued it (the JWT's `iat`), or null. */
  issuedAt: Date | null;
  /** The account's public id (the JWT's `sub`, OLX's `externalID`), or null. */
  subject: string | null;
  /** The account's first and last name as the token carries them, or null. */
  name: string | null;
}

/** Removes surrounding spaces and a leading "Bearer ". */
export function normalizeAccessToken(token: string): string {
  return token.trim().replace(/^bearer\s+/i, '');
}

/** The check `sessionFromAccessToken` makes: at least 20 characters, no whitespace. */
export function isWellFormedAccessToken(token: string): boolean {
  return /^\S{20,}$/.test(normalizeAccessToken(token));
}

/** Decodes the JSON payload of a JWT, or returns null if it isn't one. Never throws. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = normalizeAccessToken(token).split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const seconds = (v: unknown): Date | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null);
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/**
 * Reads an OLX access token's expiry, issue date and account, without any network call.
 * Never throws: a malformed token gives `wellFormed: false` and `null` fields.
 *
 * This proves nothing about whether OLX still accepts the token. To check that, call
 * `client.account.profile()`: it is the cheapest call, and a rejected token makes it throw an
 * `OlxSdkError` with code `auth_failed`.
 *
 * ```ts
 * const { wellFormed, expiresAt, subject } = inspectAccessToken(pasted);
 * ```
 */
export function inspectAccessToken(token: string): AccessTokenInfo {
  if (typeof token !== 'string') {
    return { wellFormed: false, expiresAt: null, issuedAt: null, subject: null, name: null };
  }
  const claims = decodeJwtPayload(token);
  const name = claims ? [text(claims.first_name), text(claims.last_name)].filter(Boolean).join(' ') : '';
  return {
    wellFormed: isWellFormedAccessToken(token),
    expiresAt: seconds(claims?.exp),
    issuedAt: seconds(claims?.iat),
    subject: text(claims?.sub),
    name: name || null,
  };
}

/** True when `token` is a JWT whose `exp` is later than `now` (plus `marginMs`). */
export function isFreshJwt(token: string, now = Date.now(), marginMs = 0): boolean {
  const { wellFormed, expiresAt } = inspectAccessToken(token);
  return wellFormed && expiresAt !== null && expiresAt.getTime() > now + marginMs;
}
