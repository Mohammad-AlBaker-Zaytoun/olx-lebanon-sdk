/**
 * Opens a real browser on OLX Lebanon so you can sign in yourself (including any OTP or
 * CAPTCHA). When you press Enter here, the session is saved for the SDK to reuse.
 */
import 'dotenv/config';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { DEFAULT_CAPTURED_HEADERS, SessionManager } from '../src/session/SessionManager.js';
import { FileSessionStore } from '../src/session/storage.js';

const config = loadConfig();
const session = new SessionManager({
  baseUrl: config.baseUrl,
  store: new FileSessionStore(config.sessionFile),
  captureHeaders: [...DEFAULT_CAPTURED_HEADERS, ...config.captureHeaders],
  extraHosts: config.extraHosts,
});

console.log(`Opening ${config.baseUrl} in a browser window.`);
console.log('Log in to YOUR OLX account there. Complete any OTP / CAPTCHA by hand.');

const saved = await session.loginInteractive(async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('\nPress Enter here once you can see you are logged in… ');
  rl.close();
});

const headers = Object.keys(saved.headers);
console.log(`\nSession saved to ${config.sessionFile}`);
console.log(`  cookies: ${saved.cookies.length}`);
console.log(`  captured auth headers: ${headers.length > 0 ? headers.join(', ') : 'none (cookie-based session)'}`);
console.log('Keep this file private — it gives full access to your OLX account.');
