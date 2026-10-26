/**
 * Find the ids for an ad, post it, change its price, then delete it.
 *
 *   OLX_ACCESS_TOKEN=… npx tsx examples/node/first-ad.ts photo.jpg
 *
 * This posts a real ad on your own account, then removes it. Writes are paced like a person
 * (at least a minute apart), so the whole run takes about two minutes.
 */
import { resolve } from 'node:path';
import { createOlxClient, toErrorInfo, type AdInput } from 'olx-lebanon-sdk';

const accessToken = process.env.OLX_ACCESS_TOKEN;
if (!accessToken) throw new Error('Set OLX_ACCESS_TOKEN first (`npx olx-lb login`, then `npx olx-lb token`)');

const photo = process.argv[2];
if (!photo) throw new Error('Give a photo: OLX needs at least one (npx tsx examples/node/first-ad.ts photo.jpg)');

const olx = createOlxClient({ accessToken });

// 1. Ids come from OLX's public catalog: no token needed for these calls.
const category = (await olx.catalog.findCategories('Laptops, Tablets'))[0];
const location = olx.catalog.locations('Hamra')[0];
if (!category || !location) throw new Error('Category or location not found');

// The category's form: which fields are required and what values they take.
const fields = await olx.catalog.fields(category.id);
for (const f of fields.filter((f) => f.required && !f.filledFromPrice)) {
  console.log(
    `${f.attribute} (${f.label}):`,
    f.choices
      .slice(0, 5)
      .map((c) => `${c.value}=${c.label}`)
      .join(', '),
  );
}

const ad: AdInput = {
  title: 'Test listing, please ignore',
  description: 'Posted by a script to try the SDK. It will be removed in a few minutes.',
  price: 100,
  categoryId: category.id, // "175"
  locationId: location.id, // "47", Beirut > Hamra
  attributes: { make: '3', type: '1', new_used: '1' }, // Dell, Laptop, New: values from `fields` above
  // A local file here; `{ url }` (public https) and `{ data, filename }` (bytes) work too.
  images: [{ path: resolve(photo) }],
};

try {
  // 2. Post it. `status` is active, pending_review, or limited (needs a paid OLX package).
  const created = await olx.ads.create(ad);
  console.log('Created', created.id, created.status, created.url ?? '');

  // 3. Edit it. Leaving `images` out keeps the photos that are already on the ad.
  const { images: _keepPhotos, ...withoutImages } = ad;
  const updated = await olx.ads.update(created.id, { ...withoutImages, price: 90 });
  console.log('Updated', updated.id, updated.status);

  // 4. Remove it.
  await olx.ads.delete(created.id);
  console.log('Deleted', created.id);
} catch (err) {
  // Every SDK error has a stable `code`; toErrorInfo adds the useful details (OLX's field errors…).
  console.error(toErrorInfo(err));
  process.exitCode = 1;
}
