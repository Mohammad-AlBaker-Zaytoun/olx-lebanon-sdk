import { existsSync, readFileSync } from 'node:fs';
import { OlxClient } from '../../client.js';
import { loadConfig } from '../../config.js';
import type { ListingInput } from '../../listings/types.js';
import { silentLogger } from '../../logger.js';
import type { Command } from '../index.js';
import { CliError, parseFlags, resolveFrom } from '../util.js';

export const check: Command = {
  summary: 'Check the setup against OLX without posting anything (session, account, your ads)',
  usage: `Usage: olx-lb check [--product <file.json>]

Read-only. Confirms the saved session works, shows the account the ads will be posted
from, and lists your newest ads. With --product, also checks that a product maps to a
valid category, location and fields (the same JSON your app would send).`,

  async run(args, ctx) {
    const { flags } = parseFlags(args, { product: 'string' });
    const config = loadConfig();
    const client = OlxClient.fromConfig(
      { ...config, sessionFile: resolveFrom(ctx, config.sessionFile), catalogFile: resolveFrom(ctx, config.catalogFile) },
      { logger: silentLogger },
    );
    let problems = 0;
    const line = (ok: boolean, label: string, detail: string) => {
      if (!ok) problems++;
      ctx.out(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(10)} ${detail}`);
    };

    const session = await client.session.status();
    line(session.loggedIn, 'session', session.loggedIn ? `saved ${session.savedAt}` : 'none: run `olx-lb login`');
    const missing = client.missingEndpoints();
    line(missing.length === 0, 'endpoints', missing.length ? `missing ${missing.join(', ')}` : 'all set');

    if (flags.product) {
      const file = resolveFrom(ctx, String(flags.product));
      if (!existsSync(file)) throw new CliError(`Product file not found: ${file}`);
      try {
        const m = client.mapper.resolve(JSON.parse(readFileSync(file, 'utf8')) as ListingInput);
        const loc = client.catalog.location(m.locationId);
        line(true, 'product', `category ${m.categoryId}, location ${m.locationId}${loc ? ` (${loc.path.join(' > ')})` : ''}`);
        if (loc && !loc.postable) line(false, 'location', `${loc.path.join(' > ')} is a district: OLX needs an area inside it`);
      } catch (err) {
        line(false, 'product', (err as Error).message);
      }
    }

    if (session.loggedIn) {
      try {
        const account = await client.listings.getAccount();
        line(true, 'account', `${account.name ?? '(no name)'}, phone ${account.phone ? 'set' : 'missing'}`);
        const contact = config.contact.name || account.name;
        if (contact && /^User [A-Za-z0-9]{4,}$/.test(contact)) {
          ctx.out("      tip: ads will show OLX's default name; set OLX_CONTACT_NAME to your business name");
        }
        const { ads } = await client.ads.list({ perPage: 20 });
        line(true, 'my ads', ads.length ? ads.map((a) => `${a.id} ${a.status}`).join(', ') : 'none');
      } catch (err) {
        line(false, 'account', (err as Error).message);
      }
    }
    ctx.out(problems ? `\n${problems} problem(s). Nothing was posted.` : '\nAll good. Nothing was posted.');
    return problems ? 1 : 0;
  },
};
