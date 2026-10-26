# Concepts

How the SDK behaves, and why. Read this before you wire it into a production app.

- [Two ways to work: `ads` and `sync`](#two-ways-to-work-ads-and-sync)
- [Product sync](#product-sync)
- [Duplicate protection and parked products](#duplicate-protection-and-parked-products)
- [Pacing](#pacing)
- [Photos](#photos)
- [Ad status](#ad-status)
- [Categories, fields and locations](#categories-fields-and-locations)
- [Your own names: the catalog](#your-own-names-the-catalog)
- [Store-wide defaults](#store-wide-defaults)
- [Authentication](#authentication)
- [When OLX changes its website](#when-olx-changes-its-website)

## Two ways to work: `ads` and `sync`

| | `olx.ads` | `olx.sync` |
| --- | --- | --- |
| You identify an ad by | its OLX id | your own product id |
| Stores anything | no | a link per product, in a store you choose |
| Skips unchanged content | no | yes |
| Protects against posting twice | no | yes |
| Good for | one-off tools, admin screens, scripts that track ids themselves | shops, catalogs, anything with products |

Both send the same requests to OLX and share the same pacing. Mixing them is fine: `sync.link(productId, adId)` adopts an ad you created with `ads.create` or by hand.

## Product sync

`olx.sync.upsert(productId, input)`:

1. Validates the input and computes a **fingerprint** of the ad content (title, description, price, category, location, attributes, photo list).
2. Reads the product's link from the store.
   - No link: **creates** the ad and saves the link.
   - A link with the same fingerprint: returns `unchanged` without calling OLX. Pass `{ force: true }` to push anyway.
   - A link with a different fingerprint: **edits** the same ad and updates the link.
3. Returns `{ action, record }`. The record holds the ad id, its URL, its status and the fingerprints.

`olx.sync.remove(productId)` deletes the ad and the link, and returns `{ action: 'deleted', adId }`, or `{ action: 'not_found' }` when the product has no link. If the ad is already gone from OLX, it still removes the link and adds `alreadyGone: true`. A parked product (below) can't be removed until it is resolved, because its ad id isn't known.

### The store

Links live in a `SyncStore`, four async methods: `get`, `set`, `delete`, `all`. The SDK ships two:

- `MemorySyncStore`, the default: lost on restart and between serverless invocations. Fine for trying things out, never for production.
- `JsonFileSyncStore(path)`: a JSON file with atomic writes. Good for scripts and a single server process.

In an app, implement the interface on your database. The record is a plain JSON object, so one table with a JSON column is enough; see [`examples/stores/sql-store.ts`](../examples/stores/sql-store.ts). Store the record as given and return it unchanged: the SDK adds fields in new versions.

### One writer per product

`upsert` and `remove` for the same product are serialized **inside one process**. Two processes that sync the same new product at the same moment could both post it. Keep writes in one place:

- one worker, cron job, or REST service instance does the syncing, or
- your app serializes per product (a job queue keyed by product id, or a database lock).

The REST service already runs one job at a time, so it is a ready-made single writer.

## Duplicate protection and parked products

The costly failure for a seller is a **duplicate ad**: OLX may count it against free-ad limits or treat it as spam. So the SDK never retries a write, and `sync` refuses to guess when it can't know what happened.

Right before a create request leaves (after pacing and photo uploads), the product's link is saved with `syncState: 'creating'`. Then:

- **OLX answers with the new ad:** the link gets the ad id. Done.
- **OLX clearly refuses** (validation, auth, a 4xx): the marker is removed. Nothing was posted, so fixing the input and trying again is safe.
- **The answer is lost** (timeout, connection reset, a 5xx, an answer the SDK can't read): the call throws `outcome_unknown`, and the product is **parked** as `needs_reconcile`. The ad may or may not exist.
- **The process crashes mid-create:** the `creating` marker stays, which also counts as parked.

When an edit finds that the ad no longer exists on OLX (deleted by hand, expired), the link is marked `gone`. One exception: an edit with **new photos** first looks the ad up in My ads (to remove its old photos), and if it isn't there, the edit stops with an `sdk_error` before anything is sent, and the link is left as it is. Check the ad on OLX, then `remove` or `forget` the product.

A parked or gone product throws `reconcile_required` on every `upsert` until someone decides:

```ts
await olx.sync.link('SKU-1042', '117146151'); // the ad exists on OLX: manage it from now on
await olx.sync.forget('SKU-1042');            // no ad exists: the next upsert creates one
```

To find the ad, look in My ads on olx.com.lb, or use `olx.ads.list()` / `olx.ads.find(id)`. Both resolutions protect you from mistakes:

- `link` refuses (`link_conflict`) to replace a healthy link to a different ad, or to take an ad another product already uses. Pass `{ replace: true }` if you mean it.
- `forget` refuses (`healthy_link`) on a healthy link, because the ad would stay live but unmanaged and the next sync would post a second one. To take an ad down, use `remove`. Pass `{ force: true }` only to stop managing an ad on purpose.

To list parked products, filter your store: `(await store.all()).filter((r) => r.syncState)`. The REST service reports them in `GET /v1/status` under `needsAttention`.

## Pacing

Every write (create, edit, delete) waits for a slot:

- at least `minIntervalMs` (60 s) since the previous write,
- plus a random `jitterMs` (up to 15 s),
- and no more than `maxPerHour` (20) in any rolling hour.

Reads (status, My ads, the catalog) are not paced. The pace is per client, so create **one client per process** and reuse it. Several clients, or several serverless instances, each have their own pace.

These defaults keep the account's activity close to a person's. You can change them with `writeLimits`, but lowering them to post in bulk is exactly what gets accounts flagged, and it goes against [responsible use](../README.md#responsible-use).

In practice: a sync of 20 changed products takes about 25 minutes. Run it in the background (a worker, a cron job, the REST service), not inside a web request.

## Photos

`images` is a list of up to 20 sources (OLX's limit, checked before sending, like the 70-character title and 4,096-character description; a catalog's `limits` can change them):

| Source | Use for |
| --- | --- |
| `{ url: 'https://…' }` | Photos already on your site or CDN. Must be https and resolve to a public address, unless the host is in `allowedImageHosts`. |
| `{ path: './photo.jpg' }` | Local files (scripts, the CLI). |
| `{ data: bytes, filename: 'photo.jpg' }` | Uploads you hold in memory, for example from a form. |

JPEG, PNG, WebP and GIF, up to 10 MB each. The SDK downloads each photo and uploads it to OLX's own storage; your session never goes with a download or an upload.

- **`ads.update`:** leave `images` out to keep the ad's photos; pass `images` to replace them all (the old ones are removed from the ad).
- **`sync.upsert`:** photos are re-uploaded only when the photo list changed (same URLs in the same order means unchanged). When the picture changes but the URL doesn't, change the URL (for example `photo.jpg?v=2`) or call `upsert` with `{ force: true }`, which re-sends the photos too.
- **Over REST,** photos are URL-only, so a caller can't make the service read local files.

## Ad status

| `status` | Meaning |
| --- | --- |
| `active` | Live and visible to buyers. |
| `pending_review` | OLX is reviewing it. Normal for a while after every edit, as with edits made by hand. |
| `limited` | Created, but hidden: the account has used its free ads in that category. It goes live after you buy a package on OLX. The SDK never buys anything. |
| `rejected` | OLX's review refused it. |
| `expired`, `deleted` | No longer live. |
| `unknown` | The status could not be read. |

The status is read from My ads right after each write. It isn't refreshed later by itself; `olx.ads.status(adId)` reads it again, for example after you buy a package. It searches My ads (up to 50 pages of 20 by default) and returns `undefined` if the ad isn't there.

## Categories, fields and locations

- **Categories** come live from OLX and are cached for an hour. Only leaf categories hold ads.
- **Fields** (`catalog.fields(categoryId)`) are the posting form for a category: each has an `attribute` name, a `type`, whether it is `required`, and for choice fields the allowed `choices` (`value` is what you send, `label` is what people see). `price`, `price_type` and `secondary_price` are marked `filledFromPrice`: the SDK fills them from `price` and `currency`.
- **Locations** ship with the SDK (a snapshot, see `catalog.locationsTakenAt`), so lookups are instant and offline. An ad needs an area or sub-area (`postable: true`), never a district.

## Your own names: the catalog

With OLX ids, every product carries OLX's codes (`categoryId: '175'`, `make: '3'`). If you'd rather keep your own vocabulary, pass a **catalog** that translates it, and use `categoryKey` / `locationKey` instead of the ids:

```ts
const olx = createOlxClient({
  accessToken,
  catalog: {
    categories: {
      laptops: {
        olxCategoryId: '175',
        requiredAttributes: ['brand', 'type', 'condition'],
        attributeMap: { brand: 'make', condition: 'new_used' },  // your name → OLX's
        valueMap: { brand: { Dell: '3', HP: '4' }, type: { Laptop: '1' }, condition: { new: '1', used: '2' } },
        defaults: { condition: 'new' },
        priceLimits: { min: 5, max: 50000 },                    // USD, checked before sending
      },
    },
    locations: { shop: { olxLocationId: '47' } },
  },
});

await olx.sync.upsert('SKU-1', { title, description, price, categoryKey: 'laptops', locationKey: 'shop', attributes: { brand: 'dell', type: 'Laptop' } });
```

`valueMap` matching ignores case, and values that aren't in the map pass through as they are. `npx olx-lb catalog fields 175` prints a ready-made entry for a category with every choice filled in. The CLI and REST service read the same structure from `config/catalog.json`.

## Store-wide defaults

Most stores post everything from one place and add the same line to every ad. Put both in the catalog once, instead of in every product:

```ts
createOlxClient({
  accessToken,
  catalog: {
    listingDefaults: {
      locationId: '99', // Beirut > Downtown, for listings that don't give a location
      descriptionFooter: 'Delivery all over Lebanon',
    },
  },
});
```

- **`locationId` or `locationKey`** is used when a listing gives neither. A listing's own location always wins. Like any location, it must be an area, not a district.
- **`descriptionFooter`** is added to the end of every description, after a blank line, unless the description already ends with it. It counts toward the 4,096-character limit.
- Both are part of the [sync fingerprint](#product-sync): change the footer or the default location and the next `upsert` of each product edits its ad.

The CLI and REST service read the same `listingDefaults` from `config/catalog.json`, so a REST body can leave the location out.

## Authentication

The SDK sends your access token as OLX's website does. A token alone is enough; cookies aren't needed. You can pass:

- `accessToken`: the usual choice, from an environment variable.
- `session`: a full saved session object, as `olx-lb login` writes it.
- `sessionStore`: your own `{ load(), save(), clear() }`, for example backed by a secrets manager.

The SDK never signs in by itself, never stores passwords, and never solves CAPTCHAs or phone checks. When the token stops working, calls fail with `auth_failed`; sign in again with `npx olx-lb login`.

## When OLX changes its website

OLX has no public API, so the SDK follows what the website does, and OLX can change that at any time. The SDK is built to fail loudly rather than do something unexpected: an unknown answer to a write is `outcome_unknown` (and parks the product), and validation errors carry OLX's own field messages in `details.olxErrors`.

If posting starts failing after working before:

1. Update the SDK: a fix may already be released.
2. `npx olx-lb check` confirms whether the session and reads still work.
3. Maintainers: [`ENDPOINT-CAPTURE.md`](ENDPOINT-CAPTURE.md) shows how to record the website and see what changed. Until a release, the `endpoints` and `adapter` options let you patch around it.
