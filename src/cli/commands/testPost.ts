import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { OlxClient } from '../../client.js';
import { loadConfig } from '../../config.js';
import type { ListingInput } from '../../listings/types.js';
import { silentLogger } from '../../logger.js';
import type { Command } from '../index.js';
import { CliError, UsageError, parseFlags, resolveFrom } from '../util.js';

const PRODUCT_ID = 'OLX-LB-TEST-POST';

const TEMPLATE: ListingInput = {
  title: 'Test listing - please ignore',
  description: 'Test listing posted while setting up automatic listing. It will be removed shortly.',
  price: 100,
  currency: 'USD',
  categoryId: '174',
  locationId: '47',
  attributes: { type: '2', new_used: '1' },
  images: [{ path: 'test-photo.jpg' }],
};

export const testPost: Command = {
  summary: 'Post, edit and delete one test ad, step by step, to confirm everything works',
  usage: `Usage: olx-lb test-post <create|edit|delete> [--product <file.json>]

Uses the same sync code as your app. Run the steps in order and look at My ads on
olx.com.lb in between:
  create   posts the test product (one real ad)
  edit     raises its price by 1 and edits the ad in place
  delete   removes the ad

Options:
  --product <file>  the test product (default: olx-test-product.json; created on first run)

Its link is kept in data/test-post-store.json, apart from your app's store.`,

  async run(args, ctx) {
    const { flags, positionals } = parseFlags(args, { product: 'string' });
    const step = positionals[0];
    if (!step || !['create', 'edit', 'delete'].includes(step)) throw new UsageError('Say which step: create, edit or delete');
    const file = resolveFrom(ctx, String(flags.product ?? 'olx-test-product.json'));
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify(TEMPLATE, null, 2) + '\n');
      ctx.out(`Created ${file}.`);
      ctx.out('Put a photo next to it as test-photo.jpg (or edit "images"), check the category, location and');
      ctx.out('fields (`olx-lb catalog fields 174`, `olx-lb catalog locations <text>`), then run this again.');
      return 0;
    }
    const product = JSON.parse(readFileSync(file, 'utf8')) as ListingInput;
    // Photo paths are relative to the product file.
    const base = file.replace(/[\\/][^\\/]*$/, '');
    product.images = product.images?.map((img) => ('path' in img && !/^([a-z]:)?[\\/]/i.test(img.path) ? { path: `${base}/${img.path}` } : img));

    const config = loadConfig();
    const client = OlxClient.fromConfig(
      {
        ...config,
        sessionFile: resolveFrom(ctx, config.sessionFile),
        catalogFile: resolveFrom(ctx, config.catalogFile),
        syncStoreFile: resolveFrom(ctx, 'data/test-post-store.json'),
      },
      { logger: silentLogger },
    );
    const onOlx = async (adId: string) => {
      const ad = await client.ads.find(adId, { maxPages: 3 });
      if (!ad) return 'not in your newest ads';
      return `state ${ad.status}, ${(ad.raw as { photos?: unknown[] }).photos?.length ?? '?'} photo(s)`;
    };

    if (step === 'create') {
      const r = await client.sync.upsert(PRODUCT_ID, product);
      if (r.action === 'unchanged') return void ctx.out(`Already posted as ad ${r.record.adId}; nothing sent.`);
      ctx.out(`${r.action}: ad ${r.record.adId}, status ${r.record.status}`);
      ctx.out(`on OLX: ${await onOlx(r.record.adId)}`);
      ctx.out('\nCheck it on olx.com.lb under My ads. Next: olx-lb test-post edit');
    } else if (step === 'edit') {
      const record = await client.syncStore.get(PRODUCT_ID);
      if (!record) throw new CliError('Not posted yet: run `olx-lb test-post create` first');
      ctx.out(`before: ${await onOlx(record.adId)}`);
      const r = await client.sync.upsert(PRODUCT_ID, { ...product, price: product.price + 1 });
      ctx.out(`${r.action}: ad ${r.record.adId}, status ${r.record.status}`);
      ctx.out(`after:  ${await onOlx(r.record.adId)}`);
      ctx.out('\nThe photo count should stay the same. Next: olx-lb test-post delete');
    } else {
      const r = await client.sync.remove(PRODUCT_ID);
      ctx.out(r.action === 'deleted' ? `deleted ad ${r.adId}${r.alreadyGone ? ' (it was already gone)' : ''}` : 'nothing to delete');
    }
  },
};
