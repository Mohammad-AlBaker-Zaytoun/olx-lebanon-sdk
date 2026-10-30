/**
 * olx-lebanon-sdk/connect: "Sign in with OLX" for your website's admin pages, through the
 * OLX Connect browser extension. Browser only, no Node.js imports.
 *
 * ```ts
 * import { requestOlxToken } from 'olx-lebanon-sdk/connect';
 *
 * const result = await requestOlxToken();
 * if (result.ok) await fetch('/api/admin/olx-connection', { method: 'POST', body: JSON.stringify({ token: result.token }) });
 * else showMessage(result.reason); // 'not_installed', 'cancelled', 'timeout', ...
 * ```
 *
 * The extension only answers the websites it was built for, asks the person before handing
 * over the token, and opens OLX in a pop-up for them to sign in by hand.
 */
import {
  OLX_CONNECT_EXTENSION_ID,
  OLX_CONNECT_PORT,
  clampTimeout,
  readResult,
  type KeepaliveMessage,
  type OlxTokenResult,
  type PingMessage,
  type PingReply,
  type RequestMessage,
} from './protocol.js';

export {
  OLX_CONNECT_EXTENSION_ID,
  type OlxConnectAccount,
  type OlxConnectFailure,
  type OlxTokenFailure,
  type OlxTokenResult,
  type OlxTokenSuccess,
} from './protocol.js';
export { inspectAccessToken, type AccessTokenInfo } from '../session/token.js';

/** The part of Chrome's `chrome.runtime` a web page gets when an extension lists its site. */
interface PagePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}
interface PageRuntime {
  sendMessage(extensionId: string, message: unknown, callback: (response: unknown) => void): void;
  connect(extensionId: string, info: { name: string }): PagePort;
  lastError?: { message?: string };
}

export interface OlxConnectOptions {
  /** The extension to talk to; defaults to the official OLX Connect build. */
  extensionId?: string;
}

const KEEPALIVE_MS = 20_000;
/** How long the page waits past the extension's own timeout before giving up itself. */
const GRACE_MS = 10_000;

function pageRuntime(): PageRuntime | undefined {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<PageRuntime> } }).chrome?.runtime;
  return typeof runtime?.sendMessage === 'function' && typeof runtime.connect === 'function'
    ? (runtime as PageRuntime)
    : undefined;
}

function ping(runtime: PageRuntime, id: string, timeoutMs: number): Promise<PingReply | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const done = (reply: PingReply | null) => {
      clearTimeout(timer);
      resolve(reply);
    };
    try {
      const message: PingMessage = { type: 'olx-connect/ping', v: 1 };
      runtime.sendMessage(id, message, (response) => {
        // Reading lastError marks it handled (no "Unchecked runtime.lastError" warning).
        if (runtime.lastError) return done(null);
        const r = response as Partial<{ ok: boolean; version: unknown; reason: unknown }> | undefined;
        if (r?.ok === true && typeof r.version === 'string') return done({ ok: true, version: r.version });
        if (r?.ok === false && r.reason === 'not_allowed') return done({ ok: false, reason: 'not_allowed' });
        done(null);
      });
    } catch {
      done(null); // e.g. a malformed extension id
    }
  });
}

/**
 * Whether the OLX Connect extension is installed and answers this website. Never throws;
 * safe to call during server rendering (it reports `installed: false` there).
 */
export async function isOlxConnectAvailable(
  options: OlxConnectOptions & { timeoutMs?: number } = {},
): Promise<{ installed: boolean; version?: string }> {
  const runtime = pageRuntime();
  if (!runtime) return { installed: false };
  const reply = await ping(runtime, options.extensionId ?? OLX_CONNECT_EXTENSION_ID, options.timeoutMs ?? 2_000);
  return reply?.ok ? { installed: true, version: reply.version } : { installed: false };
}

function nonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Asks the OLX Connect extension for an OLX access token. The extension shows its own
 * confirmation naming your site, then opens OLX in a pop-up where the person signs in (or
 * uses the account already signed in there).
 *
 * Resolves, never rejects: `{ ok: true, token, refreshToken, expiresAt, account }`, or
 * `{ ok: false, reason }` with reason `not_installed`, `not_allowed`, `cancelled`, `timeout`,
 * `not_signed_in` or `busy`. Call it from a click handler.
 */
export async function requestOlxToken(
  options: OlxConnectOptions & {
    /** How long the person has to sign in. Default 5 minutes (5 s to 15 min). */
    timeoutMs?: number;
    /** Cancels the request (the extension closes its windows). */
    signal?: AbortSignal;
  } = {},
): Promise<OlxTokenResult> {
  const runtime = pageRuntime();
  if (!runtime) return { ok: false, reason: 'not_installed' };
  const id = options.extensionId ?? OLX_CONNECT_EXTENSION_ID;
  const reply = await ping(runtime, id, 2_000);
  if (!reply) return { ok: false, reason: 'not_installed' };
  if (!reply.ok) return { ok: false, reason: 'not_allowed' };
  if (options.signal?.aborted) return { ok: false, reason: 'cancelled' };

  const timeoutMs = clampTimeout(options.timeoutMs);
  const requestNonce = nonce();
  let port: PagePort;
  try {
    port = runtime.connect(id, { name: OLX_CONNECT_PORT });
  } catch {
    return { ok: false, reason: 'not_installed' };
  }

  return new Promise<OlxTokenResult>((resolve) => {
    let settled = false;
    const finish = (result: OlxTokenResult) => {
      if (settled) return;
      settled = true;
      clearInterval(keepalive);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, reason: 'cancelled' });

    port.onMessage.addListener((message) => {
      const result = readResult(message, requestNonce);
      if (result) finish(result);
    });
    // The extension closed the connection without answering (it was reloaded, for example).
    port.onDisconnect.addListener(() => {
      void runtime.lastError;
      finish({ ok: false, reason: 'cancelled' });
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const keepalive = setInterval(() => {
      try {
        port.postMessage({ type: 'olx-connect/keepalive', v: 1 } satisfies KeepaliveMessage);
      } catch {
        finish({ ok: false, reason: 'cancelled' });
      }
    }, KEEPALIVE_MS);
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs + GRACE_MS);

    try {
      port.postMessage({ type: 'olx-connect/request', v: 1, nonce: requestNonce, timeoutMs } satisfies RequestMessage);
    } catch {
      finish({ ok: false, reason: 'not_installed' });
    }
  });
}
