/**
 * OLX Connect's service worker. The allowed origins are written in at build time
 * (scripts/build-extension.ts); everything else is in core.ts.
 */
import type { ChromeApi } from './chrome.js';
import { createConnectService } from './core.js';

declare const chrome: ChromeApi;
declare const __OLX_CONNECT_ALLOWED_ORIGINS__: string[];

const service = createConnectService({ chrome, allowedOrigins: __OLX_CONNECT_ALLOWED_ORIGINS__ });

// Listeners are registered at the top level, as Manifest V3 requires.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  service.onMessageExternal(message, sender, sendResponse);
});
chrome.runtime.onConnectExternal.addListener((port) => service.onConnectExternal(port));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  service.onMessage(message, sender, sendResponse);
});
chrome.cookies.onChanged.addListener((info) => service.onCookieChanged(info));
chrome.windows.onRemoved.addListener((windowId) => service.onWindowRemoved(windowId));
