# Getting started

From nothing to your first ad in about fifteen minutes. You need Node.js 20 or newer and an OLX Lebanon account that is yours.

1. [Install](#1-install)
2. [Sign in once and get your access token](#2-sign-in-once-and-get-your-access-token)
3. [Find the ids for your ad](#3-find-the-ids-for-your-ad)
4. [Post, edit and delete an ad](#4-post-edit-and-delete-an-ad)
5. [Keep one ad per product](#5-keep-one-ad-per-product)
6. [Next steps](#next-steps)

## 1. Install

```bash
npm install olx-lebanon-sdk
```

The package is ESM: use `import`. It runs on the server only (Node.js, not browsers or the Edge runtime), because it holds your access token and uses Node's crypto, DNS and file APIs.

## 2. Sign in once and get your access token

The SDK acts as your signed-in account. You sign in **by hand**, once, in a real browser window that the CLI opens. That step needs Playwright, as a dev tool only:

```bash
npm install -D playwright
npx playwright install chromium

npx olx-lb login     # a browser opens: sign in to OLX, then press Enter in the terminal
npx olx-lb token     # prints your access token
```

Complete any code, CAPTCHA or phone check yourself in that window. The SDK never automates them.

Put the token in your app's secrets, for example `.env.local`:

```bash
OLX_ACCESS_TOKEN=eyJhbGciOi…
```

- The token lasts about a year. When it expires, or after you change your OLX password, run `npx olx-lb login` again and update the variable.
- Treat it like your password: it gives full access to your OLX account. Never commit it, log it, or send it to a browser.
- `olx-lb login` also saves the session in `.olx-session/`, which is git-ignored. Don't share that folder either.

Check that it works, without posting anything:

```bash
npx olx-lb check     # session, the account ads will be posted from, your newest ads
```

## 3. Find the ids for your ad

An ad needs a **category id**, a **location id**, and the category's **fields** (brand, condition…) with OLX's own values. All of it is public, so these lookups need no token.

From the terminal:

```bash
npx olx-lb catalog categories laptop       # 175  Electronics & Home Appliances > Laptops, Tablets, Computers
npx olx-lb catalog fields 175              # make [enum] "Brand": "3" = Dell, "4" = HP… ; new_used: "1" = New…
npx olx-lb catalog locations hamra         # 47   Beirut > Hamra
```

Or from code, for example to fill dropdowns in your admin pages:

```ts
import { OlxCatalog } from 'olx-lebanon-sdk';

const catalog = new OlxCatalog();
await catalog.findCategories('laptop');  // [{ id: '175', name: 'Laptops, Tablets, Computers', path: [...], isLeaf: true }]
await catalog.fields('175');             // [{ attribute: 'make', label: 'Brand', required: true, choices: [{ value: '3', label: 'Dell' }, …] }, …]
catalog.locations('hamra');              // [{ id: '47', name: 'Hamra', path: ['Beirut', 'Hamra'], postable: true, … }]
```

Two rules OLX enforces:

- **Categories:** only a category without subcategories can hold ads. `findCategories` returns only those unless you pass `{ leavesOnly: false }`.
- **Locations:** an ad needs an **area** (Beirut > Hamra), not a district (Beirut). `locations()` returns only areas unless you pass `{ includeDistricts: true }`. The 662 locations ship with the SDK, with Arabic names, so `locations()` makes no network call.

## 4. Post, edit and delete an ad

```ts
import { createOlxClient } from 'olx-lebanon-sdk';

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN });

const ad = await olx.ads.create({
  title: 'Dell Latitude 5440',
  description: '16 GB RAM, 512 GB SSD, 1 year warranty',
  price: 899, // USD by default; pass currency: 'LBP' for Lebanese pounds
  categoryId: '175',
  locationId: '47',
  attributes: { make: '3', type: '1', new_used: '1' }, // Dell, Laptop, New
  images: [{ url: 'https://shop.example.com/images/dell-5440.jpg' }],
});
console.log(ad.id, ad.status); // "117146151" "active"

await olx.ads.update(ad.id, { ...sameFieldsAsAbove, price: 849 }); // the whole ad, not only the change
await olx.ads.delete(ad.id);
```

Things to know before you go further:

- **Writes are paced like a person:** at least a minute between writes, plus a random extra delay, and at most 20 an hour. The second call above waits about a minute. This is deliberate; see [Concepts: pacing](concepts.md#pacing).
- **An update sends the whole ad.** OLX's edit form needs every field. Leave `images` out to keep the ad's current photos, or pass `images` to replace them.
- **`status`** tells you what buyers see: `active`, `pending_review` (after an edit, for a while), or `limited` (the account has used its free ads in that category; see [Concepts: ad status](concepts.md#ad-status)).

A complete runnable version is in [`examples/node/first-ad.ts`](../examples/node/first-ad.ts). To try posting without writing code, `npx olx-lb test-post create`, then `edit`, then `delete`, walks one test ad through the same steps.

## 5. Keep one ad per product

If you sell from a shop or a database, you rarely want to track ad ids yourself. `olx.sync` does it: the first call for a product posts its ad, later calls edit that same ad, and only when something changed.

```ts
const result = await olx.sync.upsert('SKU-1042', adInput); // action: 'created' | 'updated' | 'unchanged'
await olx.sync.remove('SKU-1042');                          // out of stock: the ad is deleted
```

The links between your products and their ads need to be stored somewhere that survives restarts, usually your own database. That is a four-method interface; see [Concepts: product sync](concepts.md#product-sync) and the [SQL store example](../examples/stores/sql-store.ts).

## Next steps

- Building with Next.js: [Next.js guide](nextjs.md)
- A script, worker or Express app: [Node.js guide](node.md)
- Your backend is PHP, Python, .NET…: [REST service](rest-api.md)
- How sync, pacing, photos and statuses work: [Concepts](concepts.md)
- Something failed: [Errors](errors.md) and [Troubleshooting](troubleshooting.md)
