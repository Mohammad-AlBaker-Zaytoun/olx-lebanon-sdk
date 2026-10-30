/**
 * OLX Connect's logic, independent of the real browser so it can be tested with a fake `chrome`.
 *
 * One request at a time: an allowed website opens a port and asks for a token; the extension
 * shows its own confirmation naming the website; after "Allow" it uses a valid OLX sign-in that
 * already exists, or opens OLX in a pop-up and waits for the person to sign in by hand; then it
 * answers that port only, and keeps nothing.
 */
import {
  OLX_CONNECT_PORT,
  clampTimeout,
  isDecisionMessage,
  isPingMessage,
  isRequestMessage,
  type OlxTokenResult,
  type PingReply,
  type ResultMessage,
} from '../../src/connect/protocol.js';
import { inspectAccessToken, isFreshJwt } from '../../src/session/token.js';
import type { ChromeApi, CookieChangeInfo, MessageSender, Port } from './chrome.js';

export const OLX_URL = 'https://www.olx.com.lb/';
/** OLX's own link for "open the sign-in dialog". */
export const OLX_SIGN_IN_URL = 'https://www.olx.com.lb/?login=true';

export interface ConnectServiceDeps {
  chrome: ChromeApi;
  /** Exact origins allowed to ask (e.g. https://www.example.com), set at build time. */
  allowedOrigins: readonly string[];
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  randomId?: () => string;
  /** Wait after a cookie change before reading, so OLX can set the whole cookie set. Default 400 ms. */
  settleMs?: number;
}

interface Active {
  id: string;
  port: Port;
  origin: string;
  nonce: string;
  stage: 'confirm' | 'signin' | 'done';
  confirmWindowId?: number;
  popupWindowId?: number;
  /** Windows closed by the extension itself (not a "cancel" by the person). */
  closing: Set<number>;
  timeout: unknown;
  settle?: unknown;
}

const isOlxDomain = (domain: string) => {
  const d = domain.toLowerCase().replace(/^\./, '');
  return d === 'olx.com.lb' || d.endsWith('.olx.com.lb');
};

export function createConnectService(d: ConnectServiceDeps) {
  const { chrome } = d;
  const allowed = new Set(d.allowedOrigins);
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const randomId = d.randomId ?? (() => crypto.randomUUID());
  const settleMs = d.settleMs ?? 400;
  const version = chrome.runtime.getManifest().version;
  const confirmUrl = chrome.runtime.getURL('confirm.html');

  let active: Active | null = null;

  const isAllowed = (origin: string | undefined): origin is string => typeof origin === 'string' && allowed.has(origin);

  function post(port: Port, message: ResultMessage): void {
    try {
      port.postMessage(message);
    } catch {
      /* the page went away */
    }
  }

  function closeWindow(a: Active, windowId: number | undefined): void {
    if (windowId === undefined) return;
    a.closing.add(windowId);
    chrome.windows.remove(windowId).catch(() => {});
  }

  /** Ends the active request: closes its windows, answers its port (unless it is gone). */
  function finish(a: Active, result: OlxTokenResult | null): void {
    if (active !== a || a.stage === 'done') return;
    a.stage = 'done';
    active = null;
    clearTimer(a.timeout);
    if (a.settle !== undefined) clearTimer(a.settle);
    closeWindow(a, a.confirmWindowId);
    closeWindow(a, a.popupWindowId);
    if (result) {
      post(a.port, { type: 'olx-connect/result', v: 1, nonce: a.nonce, ...result });
      // The page disconnects once it has the answer; this is only a fallback.
      setTimer(() => {
        try {
          a.port.disconnect();
        } catch {
          /* already closed */
        }
      }, 1_000);
    }
  }

  async function readCookies(): Promise<{ access: string; refresh: string }> {
    const [access, refresh] = await Promise.all([
      chrome.cookies.get({ url: OLX_URL, name: 'accessToken' }).catch(() => null),
      chrome.cookies.get({ url: OLX_URL, name: 'refreshToken' }).catch(() => null),
    ]);
    return { access: access?.value ?? '', refresh: refresh?.value ?? '' };
  }

  function success(access: string, refresh: string): OlxTokenResult {
    const info = inspectAccessToken(access);
    return {
      ok: true,
      token: access,
      refreshToken: refresh || null,
      expiresAt: info.expiresAt?.toISOString() ?? null,
      account: info.subject ? { id: info.subject, name: info.name ?? '' } : null,
    };
  }

  /** Answers with the current sign-in if it is valid. Returns whether it did. */
  async function tryFinishWithCookies(a: Active): Promise<boolean> {
    const { access, refresh } = await readCookies();
    if (active !== a || a.stage !== 'signin') return false;
    // Only a readable token with at least a minute left: never a stale or empty value.
    if (!isFreshJwt(access, now(), 60_000)) return false;
    finish(a, success(access, refresh));
    return true;
  }

  async function startSignIn(a: Active): Promise<void> {
    a.stage = 'signin';
    closeWindow(a, a.confirmWindowId);
    a.confirmWindowId = undefined;
    if (await tryFinishWithCookies(a)) return;
    if (active !== a) return;
    try {
      const w = await chrome.windows.create({ url: OLX_SIGN_IN_URL, type: 'popup', width: 520, height: 780, focused: true });
      if (active !== a) {
        if (w?.id !== undefined) chrome.windows.remove(w.id).catch(() => {});
        return;
      }
      a.popupWindowId = w?.id;
    } catch {
      finish(a, { ok: false, reason: 'cancelled' });
    }
  }

  async function popupClosed(a: Active): Promise<void> {
    // The person may close the pop-up right after signing in: look one last time.
    if (await tryFinishWithCookies(a)) return;
    if (active !== a) return;
    const { access } = await readCookies();
    finish(a, { ok: false, reason: access ? 'not_signed_in' : 'cancelled' });
  }

  function onRequest(port: Port, message: unknown): void {
    if (!isRequestMessage(message)) return;
    const origin = port.sender?.origin;
    if (!isAllowed(origin)) {
      post(port, { type: 'olx-connect/result', v: 1, nonce: message.nonce, ok: false, reason: 'not_allowed' });
      port.disconnect();
      return;
    }
    if (active) {
      post(port, { type: 'olx-connect/result', v: 1, nonce: message.nonce, ok: false, reason: 'busy' });
      return;
    }
    const a: Active = {
      id: randomId(),
      port,
      origin,
      nonce: message.nonce,
      stage: 'confirm',
      closing: new Set(),
      timeout: undefined,
    };
    active = a;
    a.timeout = setTimer(() => finish(a, { ok: false, reason: 'timeout' }), clampTimeout(message.timeoutMs));
    const url = `${confirmUrl}#${new URLSearchParams({ id: a.id, origin })}`;
    chrome.windows
      .create({ url, type: 'popup', width: 460, height: 380, focused: true })
      .then((w) => {
        if (active !== a || a.stage !== 'confirm') {
          if (w?.id !== undefined) chrome.windows.remove(w.id).catch(() => {});
          return;
        }
        a.confirmWindowId = w?.id;
      })
      .catch(() => finish(a, { ok: false, reason: 'cancelled' }));
  }

  return {
    /** `chrome.runtime.onMessageExternal`: the page's "are you there?". */
    onMessageExternal(message: unknown, sender: MessageSender, sendResponse: (r: PingReply) => void): void {
      if (!isPingMessage(message)) return;
      sendResponse(isAllowed(sender.origin) ? { ok: true, version } : { ok: false, reason: 'not_allowed' });
    },

    /** `chrome.runtime.onConnectExternal`: a page opens a port to ask for a token. */
    onConnectExternal(port: Port): void {
      if (port.name !== OLX_CONNECT_PORT) {
        port.disconnect();
        return;
      }
      port.onMessage.addListener((message) => onRequest(port, message));
      port.onDisconnect.addListener(() => {
        // The page closed or navigated away: stop, quietly.
        if (active?.port === port) finish(active, null);
      });
    },

    /** `chrome.runtime.onMessage`: the confirmation window's answer. */
    onMessage(message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void): void {
      if (!isDecisionMessage(message)) return;
      // Only the extension's own confirmation page can decide, and only for the current request.
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(confirmUrl)) return;
      const a = active;
      if (!a || a.stage !== 'confirm' || message.requestId !== a.id) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({ ok: true });
      if (!message.allow) finish(a, { ok: false, reason: 'cancelled' });
      else void startSignIn(a);
    },

    /** `chrome.cookies.onChanged`: OLX set its sign-in cookies. */
    onCookieChanged(info: CookieChangeInfo): void {
      const a = active;
      if (!a || a.stage !== 'signin' || info.removed) return;
      if (!isOlxDomain(info.cookie.domain)) return;
      if (info.cookie.name !== 'accessToken' && info.cookie.name !== 'refreshToken') return;
      if (a.settle !== undefined) clearTimer(a.settle);
      a.settle = setTimer(() => {
        a.settle = undefined;
        void tryFinishWithCookies(a);
      }, settleMs);
    },

    /** `chrome.windows.onRemoved`: closing a window before the end means "cancel". */
    onWindowRemoved(windowId: number): void {
      const a = active;
      if (!a || a.closing.delete(windowId)) return;
      if (windowId === a.confirmWindowId && a.stage === 'confirm') finish(a, { ok: false, reason: 'cancelled' });
      else if (windowId === a.popupWindowId && a.stage === 'signin') void popupClosed(a);
    },

    /** For tests. */
    get activeRequest(): { id: string; origin: string; stage: string; confirmWindowId?: number; popupWindowId?: number } | null {
      return active
        ? {
            id: active.id,
            origin: active.origin,
            stage: active.stage,
            confirmWindowId: active.confirmWindowId,
            popupWindowId: active.popupWindowId,
          }
        : null;
    },
  };
}

export type ConnectService = ReturnType<typeof createConnectService>;
