import { AuthError, OlxSdkError } from '../errors.js';
import { isWellFormedAccessToken } from './token.js';

/**
 * OLX Lebanon's sign-in service. The website renews a session there by POSTing its refresh
 * token to `/auth/refresh` (captured from the web app, October 2026).
 */
export const OLX_LB_AUTH_URL = 'https://auth-bridge-prod.olx-dubizzle.com';

/** A pair of tokens: the bearer token for API calls and the token that renews it. */
export interface OlxTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshOlxTokensOptions {
  /** Defaults to OLX_LB_AUTH_URL. */
  authUrl?: string;
  /** Replaces fetch (tests, proxies). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Exchanges a refresh token for a new access token, the way the OLX website does.
 *
 * OLX may answer with a new refresh token (then the old one should be considered used up) or
 * without one (then the old one stays valid); either way the returned pair is the one to keep.
 *
 * Throws an `AuthError` (code `auth_failed`) when OLX refuses the refresh token: a person must
 * then sign in again. Network errors and OLX server errors throw a plain `OlxSdkError`.
 */
export async function refreshOlxTokens(refreshToken: string, options: RefreshOlxTokensOptions = {}): Promise<OlxTokens> {
  const token = typeof refreshToken === 'string' ? refreshToken.trim() : '';
  if (!token) throw new AuthError('No OLX refresh token to renew the session with; sign in again.');
  const base = (options.authUrl ?? OLX_LB_AUTH_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/auth/refresh`);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new OlxSdkError('The OLX sign-in service must be called over https');
  }
  const doFetch = options.fetch ?? ((u: string, init: RequestInit) => fetch(u, init));
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new OlxSdkError('Network error while renewing the OLX session', { cause: err });
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status >= 500) throw new OlxSdkError(`OLX's sign-in service returned HTTP ${res.status} while renewing the session`);
  if (!res.ok) {
    throw new AuthError(`OLX refused to renew the session (HTTP ${res.status}); sign in again.`, res.status);
  }
  // The web app reads `data.token` (or `token` at the top level) and an optional new refresh token.
  const data = rec(rec(body).data ?? body);
  const accessToken = typeof data.token === 'string' ? data.token : '';
  if (!isWellFormedAccessToken(accessToken)) {
    throw new AuthError('OLX answered the session renewal without an access token; sign in again.', res.status);
  }
  const next = typeof data.refreshToken === 'string' && data.refreshToken.trim() ? data.refreshToken.trim() : token;
  return { accessToken, refreshToken: next };
}
