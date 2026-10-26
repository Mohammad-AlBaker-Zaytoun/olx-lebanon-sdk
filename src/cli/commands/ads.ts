import { OlxClient } from '../../client.js';
import { loadConfig } from '../../config.js';
import { silentLogger } from '../../logger.js';
import type { OlxAd } from '../../listings/types.js';
import type { Command } from '../index.js';
import { UsageError, parseFlags, resolveFrom, table } from '../util.js';

const ACTIONS = ['deactivate', 'activate', 'sold', 'delete', 'reason'] as const;

export const ads: Command = {
  summary: 'Your ads on OLX: status, views and leads; deactivate, activate, mark sold, delete',
  usage: `Usage:
  olx-lb ads [list] [--pages <n>] [--json]      your ads with status, expiry, views and leads
  olx-lb ads deactivate <adId>                  take an ad offline (not deleted)
  olx-lb ads activate <adId>                    put a "limited" ad live with a free slot, if one is left
  olx-lb ads sold <adId> --on olx|elsewhere     mark an ad as sold
  olx-lb ads delete <adId>                      delete an ad
  olx-lb ads reason <adId>                      why OLX's review refused an ad

Changes are paced like any write (a minute or more apart). They act on the ad only: if a
product of yours is synced to it, use your app (or the REST service) so the link follows.`,

  async run(args, ctx) {
    const { flags, positionals } = parseFlags(args, { json: 'boolean', pages: 'string', on: 'string' });
    const [what = 'list', adId] = positionals;
    const config = loadConfig();
    const client = OlxClient.fromConfig(
      { ...config, sessionFile: resolveFrom(ctx, config.sessionFile), catalogFile: resolveFrom(ctx, config.catalogFile) },
      { logger: silentLogger },
    );

    if (what === 'list') {
      const pages = Math.max(1, Math.min(50, Number(flags.pages ?? 1) || 1));
      const found: OlxAd[] = [];
      for (let page = 1; page <= pages; page++) {
        const { ads: batch, hasMore } = await client.ads.list({ page, perPage: 20 });
        found.push(...batch);
        if (!hasMore) break;
      }
      const metrics = found.length ? await client.ads.metrics(found.map((a) => a.id)) : {};
      if (flags.json) {
        ctx.out(
          JSON.stringify(
            found.map(({ raw: _raw, ...a }) => ({ ...a, metrics: metrics[a.id] ?? null, actions: client.ads.actions(a) })),
            null,
            2,
          ),
        );
        return;
      }
      if (!found.length) return void ctx.out('No ads on this account.');
      const rows = found.map((a) => {
        const m = metrics[a.id];
        const detail = a.promotion
          ? ` (${a.promotion.type}${a.promotion.pending ? ', pending' : ''})`
          : a.rejection
            ? ` (${a.rejection})`
            : '';
        return [
          a.id,
          `${a.status}${detail}`,
          a.expiresAt?.slice(0, 10) ?? '',
          m ? String(m.views) : '',
          m ? String(m.leads) : '',
          (a.title ?? '').slice(0, 40),
        ];
      });
      ctx.out(table([['id', 'status', 'expires', 'views', 'leads', 'title'], ...rows]).join('\n'));
      return;
    }

    if (!(ACTIONS as readonly string[]).includes(what)) throw new UsageError(`Unknown ads command "${what}"`);
    if (!adId || !/^\d{5,15}$/.test(adId)) throw new UsageError('Give the ad id (the digits in its OLX link)');

    switch (what as (typeof ACTIONS)[number]) {
      case 'deactivate':
        await client.ads.deactivate(adId);
        ctx.out(`deactivated ad ${adId}`);
        return;
      case 'activate': {
        const result = await client.ads.activate(adId);
        ctx.out(
          result === 'activated'
            ? `activated ad ${adId}`
            : result === 'needs_package'
              ? `ad ${adId} needs a package: the account has no free ad left in its category (buy one on OLX)`
              : `ad ${adId} isn't limited; nothing to do`,
        );
        return;
      }
      case 'sold': {
        if (flags.on !== 'olx' && flags.on !== 'elsewhere') throw new UsageError('Say where it sold: --on olx or --on elsewhere');
        await client.ads.markSold(adId, { soldOn: flags.on });
        ctx.out(`marked ad ${adId} as sold (${flags.on})`);
        return;
      }
      case 'delete':
        await client.ads.delete(adId);
        ctx.out(`deleted ad ${adId}`);
        return;
      case 'reason': {
        const reason = await client.ads.rejectionReason(adId);
        ctx.out(
          reason
            ? [reason.message, ...reason.rules.map((r) => `- ${r}`)].join('\n')
            : 'OLX has no rejection reason on file for this ad.',
        );
        return;
      }
    }
  },
};
