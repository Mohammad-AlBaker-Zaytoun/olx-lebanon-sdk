/**
 * The messages between a website and the OLX Connect browser extension (version 1).
 * Shared by `olx-lebanon-sdk/connect` and the extension; no Node.js or browser imports.
 */

/** The extension id of the official OLX Connect build (fixed by its signing key). */
export const OLX_CONNECT_EXTENSION_ID = 'jaflmnbipbkjchpepkbkgfjjhkjnlfda';

/** The name of the port a page opens with `chrome.runtime.connect`. */
export const OLX_CONNECT_PORT = 'olx-connect';

export const OLX_CONNECT_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const OLX_CONNECT_MIN_TIMEOUT_MS = 5_000;
export const OLX_CONNECT_MAX_TIMEOUT_MS = 15 * 60_000;

/** Why a request did not return a token. */
export type OlxConnectFailure = 'not_installed' | 'not_allowed' | 'cancelled' | 'timeout' | 'not_signed_in' | 'busy';

export const OLX_CONNECT_FAILURES: readonly OlxConnectFailure[] = [
  'not_installed',
  'not_allowed',
  'cancelled',
  'timeout',
  'not_signed_in',
  'busy',
];

/** The OLX account a token belongs to, read from the token itself. */
export interface OlxConnectAccount {
  /** OLX's public account id (`externalID`). */
  id: string;
  /** First and last name as the token carries them; often '' (use `account.profile()` for the name on ads). */
  name: string;
}

export interface OlxTokenSuccess {
  ok: true;
  /** The OLX access token. Send it to your server; never keep it in the browser. */
  token: string;
  /** The token that renews `token`, if OLX set one (see createOlxClient's `refreshToken`). */
  refreshToken: string | null;
  /** When `token` expires (ISO 8601), or null if unknown. */
  expiresAt: string | null;
  account: OlxConnectAccount | null;
}

export interface OlxTokenFailure {
  ok: false;
  reason: OlxConnectFailure;
}

export type OlxTokenResult = OlxTokenSuccess | OlxTokenFailure;

/** Page → extension, with `chrome.runtime.sendMessage`: is it installed and allowed here? */
export interface PingMessage {
  type: 'olx-connect/ping';
  v: 1;
}

export type PingReply = { ok: true; version: string } | { ok: false; reason: 'not_allowed' };

/** Page → extension, on the port: ask for a token. */
export interface RequestMessage {
  type: 'olx-connect/request';
  v: 1;
  /** Random, echoed in the result so the page matches it to its own request. */
  nonce: string;
  timeoutMs?: number;
}

/** Page → extension, on the port, every 20 s while waiting (keeps the extension awake). */
export interface KeepaliveMessage {
  type: 'olx-connect/keepalive';
  v: 1;
}

/** Extension → page, on the port. */
export type ResultMessage = { type: 'olx-connect/result'; v: 1; nonce: string } & OlxTokenResult;

/** Confirmation window → extension (inside the extension only). */
export interface DecisionMessage {
  type: 'olx-connect/decision';
  requestId: string;
  allow: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A valid nonce: 8 to 128 URL-safe characters. */
export const isNonce = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{8,128}$/.test(v);

export function isRequestMessage(v: unknown): v is RequestMessage {
  return (
    isObject(v) &&
    v.type === 'olx-connect/request' &&
    v.v === 1 &&
    isNonce(v.nonce) &&
    (v.timeoutMs === undefined || (typeof v.timeoutMs === 'number' && Number.isFinite(v.timeoutMs)))
  );
}

export function isPingMessage(v: unknown): v is PingMessage {
  return isObject(v) && v.type === 'olx-connect/ping' && v.v === 1;
}

export function isDecisionMessage(v: unknown): v is DecisionMessage {
  return isObject(v) && v.type === 'olx-connect/decision' && typeof v.requestId === 'string' && typeof v.allow === 'boolean';
}

/** Keeps a requested timeout within the allowed range. */
export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return OLX_CONNECT_DEFAULT_TIMEOUT_MS;
  return Math.min(OLX_CONNECT_MAX_TIMEOUT_MS, Math.max(OLX_CONNECT_MIN_TIMEOUT_MS, Math.round(ms)));
}

/**
 * Checks a result received on the port and returns it in its exact shape, or null if it is not
 * a well-formed result for `nonce`.
 */
export function readResult(v: unknown, nonce: string): OlxTokenResult | null {
  if (!isObject(v) || v.type !== 'olx-connect/result' || v.v !== 1 || v.nonce !== nonce) return null;
  if (v.ok === false) {
    const reason = OLX_CONNECT_FAILURES.includes(v.reason as OlxConnectFailure) ? (v.reason as OlxConnectFailure) : 'cancelled';
    return { ok: false, reason };
  }
  if (v.ok !== true || typeof v.token !== 'string' || !/^\S{20,}$/.test(v.token)) return null;
  const account =
    isObject(v.account) && typeof v.account.id === 'string' && typeof v.account.name === 'string'
      ? { id: v.account.id, name: v.account.name }
      : null;
  return {
    ok: true,
    token: v.token,
    refreshToken: typeof v.refreshToken === 'string' && v.refreshToken ? v.refreshToken : null,
    expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : null,
    account,
  };
}
