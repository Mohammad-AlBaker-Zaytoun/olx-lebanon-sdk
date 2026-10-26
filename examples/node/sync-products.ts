/**
 * Keep one OLX ad per product: the first run posts, later runs edit only what changed.
 *
 *   OLX_ACCESS_TOKEN=… npx tsx examples/node/sync-products.ts
 *
 * Run it on a schedule (cron, Task Scheduler) or after your stock changes. Links between products
 * and ads are kept in data/olx-links.json here; use a database store in a real app
 * (see ../stores/sql-store.ts).
 */
import { JsonFileSyncStore, OlxSdkError, createLogger, createOlxClient, toErrorInfo, type AdInput } from 'olx-lebanon-sdk';

/** Your store's product, however it looks. */
interface Product {
  sku: string;
  name: string;
  summary: string;
  priceUsd: number;
  inStock: boolean;
  photoUrls: string[];
}

/** Turns your product into an ad. Ids from `npx olx-lb catalog …`. */
function toAd(p: Product): AdInput {
  return {
    title: p.name.slice(0, 70),
    description: p.summary,
    price: p.priceUsd,
    categoryId: '175',
    locationId: '47',
    attributes: { make: '3', type: '1', new_used: '1' },
    images: p.photoUrls.slice(0, 20).map((url) => ({ url })),
  };
}

async function loadProducts(): Promise<Product[]> {
  // Replace with a query to your database or shop API.
  return [
    {
      sku: 'SKU-1042',
      name: 'Dell Latitude 5440',
      summary: '16 GB RAM, 512 GB SSD, 1 year warranty.',
      priceUsd: 899,
      inStock: true,
      photoUrls: ['https://shop.example.com/images/dell-5440.jpg'],
    },
  ];
}

const accessToken = process.env.OLX_ACCESS_TOKEN;
if (!accessToken) throw new Error('Set OLX_ACCESS_TOKEN first');

const olx = createOlxClient({
  accessToken,
  store: new JsonFileSyncStore('data/olx-links.json'),
  logger: createLogger('info'),
});

for (const product of await loadProducts()) {
  try {
    if (!product.inStock) {
      const removed = await olx.sync.remove(product.sku);
      if (removed.action === 'deleted') console.log(product.sku, 'removed from OLX');
      continue;
    }
    const result = await olx.sync.upsert(product.sku, toAd(product));
    console.log(product.sku, result.action, result.record.adId, result.record.status);
  } catch (err) {
    if (!(err instanceof OlxSdkError)) throw err;
    switch (err.code) {
      case 'auth_failed':
        // Every other product would fail the same way: stop and renew the token.
        console.error('OLX rejected the token. Run `npx olx-lb login`, then update OLX_ACCESS_TOKEN.');
        throw err;
      case 'reconcile_required':
        // Parked: an earlier create may have posted, or the ad was removed on OLX.
        // Check My ads, then olx.sync.link(sku, adId) or olx.sync.forget(sku).
        console.warn(product.sku, 'needs a decision:', err.message);
        break;
      default:
        // invalid_listing, olx_rejected (details.olxErrors names the field), outcome_unknown…
        console.warn(product.sku, 'not synced:', toErrorInfo(err));
    }
  }
}
