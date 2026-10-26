import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Command } from '../index.js';
import { parseFlags, resolveFrom, type CliContext } from '../util.js';

const ENV_TEMPLATE = (apiKey: string, contactName: string) => `# olx-lebanon-sdk settings. Keep this file private and out of git.

# Who buyers contact on your ads. Empty: taken from your OLX profile.
OLX_CONTACT_NAME=${contactName}
OLX_CONTACT_PHONE=
# allow_chat_communication (the website's default)
OLX_CONTACT_METHOD=

# Where the saved login is kept (written by \`olx-lb login\`). Treat it as a password.
OLX_SESSION_FILE=.olx-session/session.json
# Or, on a server without a browser: the token from \`olx-lb token\`, used instead of the file.
# OLX_ACCESS_TOKEN=

# Optional: your own names for categories and locations (see \`olx-lb catalog\`).
OLX_CATALOG_FILE=config/catalog.json

# Product <-> ad links, kept by the sync service.
OLX_SYNC_STORE_FILE=data/sync-store.json
OLX_REQUEST_LOG_FILE=logs/requests.jsonl

# Write pacing: keep it human-paced.
OLX_MIN_WRITE_INTERVAL_MS=60000
OLX_WRITE_JITTER_MS=15000
OLX_MAX_WRITES_PER_HOUR=20

# Optional: only download product photos from these hosts (comma-separated).
OLX_IMAGE_HOSTS=

# Hosts the OLX website talks to (used by \`olx-lb login\` and \`olx-lb capture\`).
OLX_EXTRA_HOSTS=olx-dubizzle.com,olx-lb-prod.s3.eu-central-1.amazonaws.com

# REST service (\`olx-lb serve\`), for store backends in any language.
SERVER_HOST=127.0.0.1
SERVER_PORT=8787
SERVER_API_KEY=${apiKey}

# Optional: signed notification of every finished job (WEBHOOK_SECRET must differ from SERVER_API_KEY).
WEBHOOK_URL=
WEBHOOK_SECRET=

LOG_LEVEL=info
`;

const CATALOG_TEMPLATE = {
  _comment:
    'Optional. Your own names for OLX categories and locations, used as categoryKey / locationKey. Find ids with `olx-lb catalog categories <text>`, fields with `olx-lb catalog fields <id>`, areas with `olx-lb catalog locations <text>`. Ads can also use OLX ids directly (categoryId / locationId) without this file.',
  limits: { titleMaxLength: 70, descriptionMaxLength: 4096, maxImages: 20 },
  categories: {},
  locations: {},
};

// Anchored to the project root, so an app's own src/data/ or logs/ folders aren't hidden.
const IGNORE = ['.env', '/.olx-session/', '/captures/', '/data/', '/logs/'];

function write(ctx: CliContext, path: string, content: string, force: boolean, mode?: number): 'created' | 'kept' | 'replaced' {
  const abs = resolveFrom(ctx, path);
  const existed = existsSync(abs);
  if (existed && !force) return 'kept';
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, mode ? { mode } : undefined);
  return existed ? 'replaced' : 'created';
}

export const init: Command = {
  summary: 'Set up this folder: settings (.env), an optional catalog file, and .gitignore entries',
  usage: `Usage: olx-lb init [--yes] [--force] [--contact-name <name>]

Creates, in the current folder:
  .env                 settings, with a new random SERVER_API_KEY
  config/catalog.json  optional names for categories and locations
  .gitignore           adds .env, /.olx-session/, /captures/, /data/, /logs/

Existing files are kept unless you pass --force.

Options:
  --yes                 don't ask questions; use defaults
  --force               replace existing .env and catalog file
  --contact-name <name> the name buyers see on your ads (default: your OLX profile name)`,

  async run(args, ctx) {
    const { flags } = parseFlags(args, { yes: 'boolean', force: 'boolean', 'contact-name': 'string' });
    const force = flags.force === true;
    let contactName = typeof flags['contact-name'] === 'string' ? flags['contact-name'] : '';
    if (!flags.yes && !contactName && !(existsSync(resolveFrom(ctx, '.env')) && !force)) {
      contactName = (await ctx.ask('Name buyers see on your ads (Enter: use your OLX profile name): ')).trim();
    }
    if (/[\r\n]/.test(contactName)) contactName = contactName.replace(/[\r\n]+/g, ' ');

    const results: Array<[string, string]> = [];
    results.push(['.env', write(ctx, '.env', ENV_TEMPLATE(randomBytes(32).toString('hex'), contactName), force, 0o600)]);
    results.push([
      'config/catalog.json',
      write(ctx, 'config/catalog.json', JSON.stringify(CATALOG_TEMPLATE, null, 2) + '\n', force),
    ]);

    const gi = resolveFrom(ctx, '.gitignore');
    const current = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const variants = (l: string) => [l, l.replace(/\/$/, ''), l.replace(/^\//, ''), l.replace(/^\/|\/$/g, '')];
    const missing = IGNORE.filter((l) => !variants(l).some((v) => have.has(v)));
    if (missing.length) {
      const sep = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(gi, `${current}${sep}${current ? '\n' : ''}# olx-lebanon-sdk (secrets and local state)\n${missing.join('\n')}\n`);
      results.push(['.gitignore', current ? `added ${missing.join(' ')}` : 'created']);
    } else {
      results.push(['.gitignore', 'kept (already ignores the secret files)']);
    }

    for (const [file, what] of results) ctx.out(`  ${what.padEnd(9)} ${relative(ctx.cwd, resolveFrom(ctx, file)) || file}`);
    if (results.some(([, w]) => w === 'kept') && !force) ctx.out('\nExisting files were kept. Use --force to replace them.');
    ctx.out(`
Next:
  1. olx-lb login                      sign in to your OLX account (opens a browser)
  2. olx-lb check                      confirm the session and account
  3. olx-lb catalog categories laptop  find category ids (and \`fields <id>\`, \`locations <text>\`)

In a Node.js or Next.js app, use the token from \`olx-lb token\` with createOlxClient().
For other languages, run the REST service: olx-lb serve`);
  },
};
