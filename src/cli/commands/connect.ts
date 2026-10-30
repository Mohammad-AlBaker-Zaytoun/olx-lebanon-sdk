import { loadConfig } from '../../config.js';
import { olxLebanonBearer } from '../../listings/olxLebanon.js';
import { DEFAULT_CAPTURED_HEADERS, SessionManager } from '../../session/SessionManager.js';
import { MemorySessionStore, refreshTokenOf, type SessionData } from '../../session/storage.js';
import { inspectAccessToken } from '../../session/token.js';
import type { Command } from '../index.js';
import { CliError, UsageError, parseFlags, type CliContext } from '../util.js';

/** Where the website receives a paired sign-in. */
export const PAIR_PATH = '/api/admin/olx-connection/pair';

export interface PairPayload {
  code: string;
  token: string;
  refreshToken: string | null;
}

/** The site's answer, as the contract defines it. */
export type PairAnswer = { ok: true; account?: { name?: string } } | { ok: false; reason: string };

/** Checks the site address and returns the pairing URL. https only (http for localhost). */
export function pairUrl(site: string): URL {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new UsageError(`Not a website address: ${site} (give it like https://www.example.com)`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new UsageError('The website address must start with https:// (the sign-in is sent there)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UsageError('Give the website address only, without a query, #fragment or user name');
  }
  return new URL(url.origin + url.pathname.replace(/\/+$/, '') + PAIR_PATH);
}

/** Checks the pairing code shown by the website's admin page. */
export function pairingCode(raw: unknown): string {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!code) throw new UsageError('--code is required: the pairing code shown in your website’s admin');
  if (!/^[A-Za-z0-9-]{4,64}$/.test(code)) throw new UsageError('That pairing code has characters a code never has');
  return code;
}

const REASONS: Record<string, string> = {
  code_invalid:
    'The website did not accept the code: it is wrong or was already used. Get a new code in the admin and try again.',
  code_expired: 'The code has expired (codes last 10 minutes). Get a new code in the admin and try again.',
  token_rejected: 'The website could not use this OLX sign-in (OLX refused it). Run the command again and sign in once more.',
};

/** Sends the sign-in to the website and returns its answer. The token is never followed through a redirect. */
export async function sendToSite(
  url: URL,
  payload: PairPayload,
  doFetch: (url: string, init: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
): Promise<PairAnswer> {
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CliError(`Could not reach ${url.origin}: ${(err as Error).message}. Check the address and your connection.`);
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    const to = res.headers.get('location');
    throw new CliError(
      `${url.origin} answered with a redirect${to ? ` to ${to}` : ''}; nothing was sent there. ` +
        'Use the website’s exact address (for example with or without www.).',
    );
  }
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (body && body.ok === true) {
    const account = typeof body.account === 'object' && body.account ? (body.account as { name?: unknown }) : undefined;
    return { ok: true, account: { name: typeof account?.name === 'string' ? account.name : undefined } };
  }
  if (body && body.ok === false && typeof body.reason === 'string') return { ok: false, reason: body.reason };
  throw new CliError(
    `${url.origin} answered HTTP ${res.status} without a pairing answer. Is this the right website, ` +
      `and is its admin set up for OLX pairing (${PAIR_PATH})?`,
  );
}

/** Opens the OLX sign-in window (Playwright) and returns the session, keeping it in memory only. */
async function signInInMemory(ctx: CliContext): Promise<SessionData> {
  const config = loadConfig();
  const session = new SessionManager({
    baseUrl: config.baseUrl,
    store: new MemorySessionStore(),
    captureHeaders: [...DEFAULT_CAPTURED_HEADERS, ...config.captureHeaders],
    extraHosts: config.extraHosts,
  });
  ctx.out(`Opening ${config.baseUrl} in a browser window.`);
  ctx.out('Sign in to the OLX account there. Complete any code or CAPTCHA by hand.');
  return session.loginInteractive(async () => {
    await ctx.ask('\nPress Enter here once you can see you are signed in… ');
  });
}

export interface ConnectDeps {
  signIn: (ctx: CliContext) => Promise<SessionData>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export function createConnectCommand(deps: ConnectDeps): Command {
  return {
    summary: 'Sign in to OLX and send the sign-in straight to your website (pairing code)',
    usage: `Usage: olx-lb connect <website> --code <pairing code> [--yes]

Connects your website to an OLX account without copying any token by hand:
  1. In your website's admin, ask for an OLX pairing code (it lasts 10 minutes).
  2. Run: olx-lb connect https://www.example.com --code AB12CD34
  3. Sign in to OLX in the browser window that opens (complete any code or CAPTCHA by hand),
     then press Enter in the terminal.
The sign-in is sent to <website>${PAIR_PATH} and the website's answer is printed.
Nothing is saved on this computer and the token is never shown.

Options:
  --code <code>  the pairing code from your website's admin (required)
  --yes          don't ask for confirmation

Needs Playwright: npm install playwright && npx playwright install chromium`,

    async run(args, ctx) {
      const { flags, positionals } = parseFlags(args, { code: 'string', yes: 'boolean' });
      if (positionals.length !== 1)
        throw new UsageError('Give the website address, e.g. olx-lb connect https://www.example.com --code AB12CD34');
      const url = pairUrl(positionals[0]!);
      const code = pairingCode(flags.code);

      if (!flags.yes) {
        ctx.out(`This signs you in to OLX and sends that sign-in to ${url.origin}.`);
        ctx.out(`It can then manage that OLX account. Only continue if ${url.host}'s admin gave you this code.`);
        const answer = (await ctx.ask('Continue? [y/N] ')).trim();
        if (!/^y(es)?$/i.test(answer)) return 1;
      }

      const session = await deps.signIn(ctx);
      const token = olxLebanonBearer(session);
      if (!token)
        throw new CliError(
          'No OLX sign-in was found in the browser window. Run the command again, and press Enter only once you are signed in.',
        );
      const info = inspectAccessToken(token);
      if (info.expiresAt && info.expiresAt.getTime() <= Date.now()) {
        throw new CliError('The OLX sign-in has already expired. Run the command again and sign in once more.');
      }

      ctx.out(`\nSending the sign-in to ${url.origin}…`);
      const answer = await sendToSite(url, { code, token, refreshToken: refreshTokenOf(session) ?? null }, deps.fetch);
      if (answer.ok) {
        const name = answer.account?.name;
        ctx.out(`Connected${name ? ` the OLX account "${name}"` : ''} to ${url.host}.`);
        if (info.expiresAt) ctx.out(`The sign-in is valid until ${info.expiresAt.toISOString().slice(0, 10)}.`);
        return;
      }
      throw new CliError(REASONS[answer.reason] ?? `${url.host} refused the sign-in (${answer.reason}).`);
    },
  };
}

export const connect: Command = createConnectCommand({ signIn: signInInMemory });
