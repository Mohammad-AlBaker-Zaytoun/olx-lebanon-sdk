/**
 * The few Chrome extension APIs OLX Connect uses, typed by hand (no @types/chrome dependency).
 * Shapes follow developer.chrome.com/docs/extensions/reference (Manifest V3, Chrome 116+).
 */

export interface MessageSender {
  /** The extension that sent the message (set for messages from the extension's own pages). */
  id?: string;
  /** The page URL (extension pages and web pages). */
  url?: string;
  /** The page's origin, for web pages (Chrome 80+). */
  origin?: string;
}

export interface Port {
  name: string;
  sender?: MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown, port: Port) => void): void };
  onDisconnect: { addListener(cb: (port: Port) => void): void };
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface CookieChangeInfo {
  removed: boolean;
  cookie: Cookie;
  cause: string;
}

export interface Window {
  id?: number;
}

export interface ChromeApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    onMessage: {
      addListener(cb: (message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | void): void;
    };
    onMessageExternal: {
      addListener(cb: (message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | void): void;
    };
    onConnectExternal: { addListener(cb: (port: Port) => void): void };
  };
  cookies: {
    get(details: { url: string; name: string }): Promise<Cookie | null>;
    onChanged: { addListener(cb: (info: CookieChangeInfo) => void): void };
  };
  windows: {
    create(data: {
      url: string;
      type: 'popup' | 'normal';
      width?: number;
      height?: number;
      focused?: boolean;
    }): Promise<Window | undefined>;
    remove(windowId: number): Promise<void>;
    onRemoved: { addListener(cb: (windowId: number) => void): void };
  };
}
