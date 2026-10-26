/**
 * Step-by-step check against live OLX with ONE test product, using the same sync code as the
 * REST service. Run the steps in order and look at your "My ads" page in between:
 *
 *   npm run live-test -- check     read-only: session, account, endpoints, catalog mapping, My ads
 *   npm run live-test -- create    posts the test product (one real ad)
 *   npm run live-test -- edit      changes its price by +1 and re-syncs (edit in place)
 *   npm run live-test -- delete    removes the ad
 *
 * The product comes from captures/test-product.json (git-ignored; created on first run).
 * Links are kept in data/live-test-store.json, separate from the service's store.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { OlxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import type { ListingInput } from '../src/listings/types.js';

const PRODUCT_FILE = 'captures/test-product.json';
const PRODUCT_ID = 'TEST-1';

const template: ListingInput = {
  title: 'Test listing - please ignore',
  description: 'Test listing posted while setting up automatic listing. It will be removed shortly.',
  price: 100,
  currency: 'USD',
  categoryKey: 'computer-parts',
  locationKey: 'beirut',
  attributes: { type: 'Computer Accessories', condition: 'new' },
  images: [{ path: 'captures/test-photo.jpg' }],
};

if (!existsSync(PRODUCT_FILE)) {
  writeFileSync(PRODUCT_FILE, JSON.stringify(template, null, 2) + '\n');
  console.log(`Created ${PRODUCT_FILE}. Put a photo at captures/test-photo.jpg (or edit "images"), check the`);
  console.log('category, location and attributes, then run this again.');
  process.exit(0);
}

const product = JSON.parse(readFileSync(PRODUCT_FILE, 'utf8')) as ListingInput;
const config = loadConfig({ ...process.env, OLX_SYNC_STORE_FILE: 'data/live-test-store.json' });
const client = OlxClient.fromConfig(config, { logger: silentLogger });

/** The ad as "My ads" shows it: state and photo count. */
async function onOlx(adId: string): Promise<string> {
  const ad = await client.listings.findMine(adId);
  if (!ad) return 'not found in the newest pages of My ads';
  const raw = ad.raw as { photos?: unknown[]; price?: unknown };
  return `state ${ad.status}, ${raw.photos?.length ?? '?'} photo(s), price ${String(raw.price ?? '?')}`;
}

const step = process.argv[2];
try {
  if (step === 'check') {
    const session = await client.session.status();
    console.log(`session: ${session.loggedIn ? `saved ${session.savedAt}` : 'MISSING: run npm run login'}`);
    const missing = client.missingEndpoints();
    console.log(`endpoints: ${missing.length ? `MISSING ${missing.join(', ')}` : 'all mapped'}`);
    const mapped = client.mapper.resolve(product);
    console.log(`catalog: category ${mapped.categoryId}, location ${mapped.locationId}, fields ${JSON.stringify(mapped.attributes)}`);
    const account = await client.listings.getAccount();
    console.log(`account: ${account.name ?? '(no name)'}, phone ${account.phone ? 'set' : 'MISSING'}`);
    const mine = await client.listings.listMine({ page: 1, per_page: 20 });
    console.log(`My ads (first page): ${mine.length} ad(s) — ${mine.map((a) => `${a.id} ${a.status}`).join(', ') || 'none'}`);
    const record = await client.syncStore.get(PRODUCT_ID);
    console.log(`test product: ${record ? `linked to ad ${record.adId} (${record.status})` : 'not posted yet'}`);
    console.log('\nNothing was posted. Next: npm run live-test -- create');
  } else if (step === 'create') {
    const r = await client.sync.upsert(PRODUCT_ID, product);
    if (r.action === 'unchanged') {
      console.log(`Already posted as ad ${r.record.adId}; nothing sent.`);
    } else {
      console.log(`${r.action}: ad ${r.record.adId}, status ${r.record.status}`);
      console.log(`on OLX: ${await onOlx(r.record.adId)}`);
      console.log('\nCheck it on olx.com.lb under My ads. Next: npm run live-test -- edit');
    }
  } else if (step === 'edit') {
    const record = await client.syncStore.get(PRODUCT_ID);
    if (!record) throw new Error('Not posted yet: run `npm run live-test -- create` first');
    console.log(`before: ${await onOlx(record.adId)}`);
    const r = await client.sync.upsert(PRODUCT_ID, { ...product, price: product.price + 1 });
    console.log(`${r.action}: ad ${r.record.adId}, status ${r.record.status}`);
    console.log(`after:  ${await onOlx(r.record.adId)}`);
    console.log('\nSame photo count before and after = photos are replaced (good). More after = they pile up.');
    console.log('Next: npm run live-test -- delete');
  } else if (step === 'delete') {
    const r = await client.sync.remove(PRODUCT_ID);
    console.log(r.action === 'deleted' ? `deleted ad ${r.adId}${r.alreadyGone ? ' (it was already gone)' : ''}` : 'nothing to delete');
  } else {
    console.log('Usage: npm run live-test -- check | create | edit | delete');
    process.exitCode = 1;
  }
} catch (err) {
  const e = err as Error & { status?: number; body?: unknown };
  console.error(`\n${e.name}: ${e.message}`);
  if (e.status) console.error(`HTTP status: ${e.status}`);
  // OLX's error body says which field it rejected; it holds no secrets.
  if (e.body !== undefined) console.error(`OLX said: ${JSON.stringify(e.body).slice(0, 1500)}`);
  process.exitCode = 1;
}
