import { loadConfig } from '../../config.js';
import { olxLebanonBearer } from '../../listings/olxLebanon.js';
import { DEFAULT_CAPTURED_HEADERS, SessionManager } from '../../session/SessionManager.js';
import { FileSessionStore, refreshTokenOf } from '../../session/storage.js';
import { inspectAccessToken } from '../../session/token.js';
import type { Command } from '../index.js';
import { CliError, parseFlags, resolveFrom } from '../util.js';

export const login: Command = {
  summary: 'Sign in to your OLX account in a browser window and save the session',
  usage: `Usage: olx-lb login

Opens a browser on OLX Lebanon. Sign in yourself (complete any code or CAPTCHA by hand),
then press Enter in the terminal. The session is saved to OLX_SESSION_FILE
(default .olx-session/session.json). It gives full access to your account: keep it private.

Needs Playwright: npm install playwright && npx playwright install chromium`,

  async run(args, ctx) {
    parseFlags(args, {});
    const config = loadConfig();
    const file = resolveFrom(ctx, config.sessionFile);
    const session = new SessionManager({
      baseUrl: config.baseUrl,
      store: new FileSessionStore(file),
      captureHeaders: [...DEFAULT_CAPTURED_HEADERS, ...config.captureHeaders],
      extraHosts: config.extraHosts,
    });
    ctx.out(`Opening ${config.baseUrl} in a browser window.`);
    ctx.out('Sign in to YOUR OLX account there. Complete any code or CAPTCHA by hand.');
    const saved = await session.loginInteractive(async () => {
      await ctx.ask('\nPress Enter here once you can see you are signed in… ');
    });
    const token = olxLebanonBearer(saved);
    ctx.out(`\nSession saved to ${file}`);
    ctx.out(`  cookies: ${saved.cookies.length}`);
    ctx.out(
      `  access token: ${token ? 'found' : 'NOT found (run `olx-lb login` again, and press Enter only once you are signed in)'}`,
    );
    if (!token) throw new CliError('No access token was captured; the session may not be signed in.');
    if (config.accessToken) {
      ctx.err('\nNote: OLX_ACCESS_TOKEN is set, and it is used instead of this session. Update it with');
      ctx.err('`olx-lb token`, or remove it to use the saved session.');
    }
    ctx.out('\nKeep this file private: it gives full access to your OLX account.');
    ctx.out('For a Node.js or Next.js app: `olx-lb token` prints the token for an environment variable.');
  },
};

export const token: Command = {
  summary: 'Print the access token from the saved session (for OLX_ACCESS_TOKEN in your app)',
  usage: `Usage: olx-lb token [--json] [--yes]

Prints the bearer token saved by \`olx-lb login\`, so you can store it as a secret
environment variable (e.g. OLX_ACCESS_TOKEN) and pass it to createOlxClient({ accessToken }).
Anyone with this token can manage your OLX account: never commit it or put it in browser code.

Options:
  --json  print { accessToken, refreshToken, expiresAt } instead, for an app that renews
          the token itself (createOlxClient({ accessToken, refreshToken, onSessionRefreshed }))
  --yes   print without asking for confirmation`,

  async run(args, ctx) {
    const { flags } = parseFlags(args, { yes: 'boolean', json: 'boolean' });
    const config = loadConfig();
    const saved = await new FileSessionStore(resolveFrom(ctx, config.sessionFile)).load();
    if (!saved) throw new CliError('No saved session. Run `olx-lb login` first.');
    const value = olxLebanonBearer(saved);
    if (!value) throw new CliError('The saved session has no access token. Run `olx-lb login` again.');
    const expiresAt = inspectAccessToken(value).expiresAt;
    if (!flags.yes) {
      const what = flags.json ? 'secrets that give' : 'a secret that gives';
      const answer = (await ctx.ask(`This prints ${what} full access to your OLX account. Continue? [y/N] `)).trim();
      if (!/^y(es)?$/i.test(answer)) return 1;
    }
    if (flags.json) {
      const refreshToken = refreshTokenOf(saved) ?? null;
      ctx.out(JSON.stringify({ accessToken: value, refreshToken, expiresAt: expiresAt?.toISOString() ?? null }, null, 2));
      return;
    }
    ctx.out(value);
    if (expiresAt) ctx.err(`(expires ${expiresAt.toISOString().slice(0, 10)})`);
  },
};
