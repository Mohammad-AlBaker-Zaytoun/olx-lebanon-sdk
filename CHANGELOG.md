# Changelog

## 0.4.0 — 2026-10-26

The rest of a seller's ad lifecycle, insights, and OLX delivery orders.

### Verified live (26 Oct 2026)

- Deactivate: the backend `state` turns `inactive` at once, while the website may show `limited`. Deactivating again answers `ad_already_inactive`, which the SDK treats as done.
- Republish of a deactivated ad brings it back and renews its expiry (to `limited` on an account with no free slot left).
- Activate: `needs_package` for a limited ad with no free slot left, and `not_limited` for a deactivated one, which comes back with republish instead.
- Mark as sold: `state` turns `sold` at once; the website's state follows within about 20 seconds.
- Metrics, wallet, exchange rate and posting-limit offers read correctly. A new ad without a photo is refused by OLX, which is now checked before sending.

### Added

- `olx.ads`: `deactivate`, `activate` (a `limited` ad with a free slot: `activated`, `needs_package` or `not_limited`), `markSold({ soldOn: 'olx' | 'elsewhere' })`, `republish` (an inactive or expired ad), `rejectionReason`, `metrics` (views and leads per ad), and `actions(ad)` / `adActions()`: what the website offers for an ad in its status.
- `OlxAd` has `state` (OLX's own state), `promotion` (`featured` / `elite`, and whether it's pending), `rejection` (`soft` / `hard`) and `expiresAt`.
- `olx.sync`: `deactivate`, `activate`, `markSold`, and `refresh()`, which re-reads every linked ad's status from My ads in one pass. `upsert` on an inactive or expired ad republishes it (`action: 'republished'`).
- `olx.account`: `profile`, `wallet`, `postingLimitOffers(categoryId)` (read only; the SDK never buys).
- `olx.orders` (experimental): OLX delivery listings, the orders on an ad, and `update(orderId, 'accept' | 'reject' | 'cancel' | 'out_for_delivery' | 'delivered')`.
- `olx.catalog`: `exchangeRate()` (USD → LBP) and `deliveryConfig()`, both public.
- REST: `POST …/listing/deactivate`, `…/activate`, `…/sold`, `GET …/listing/metrics`, `POST /v1/listings/refresh`; job types `deactivate`, `activate`, `mark_sold`, `refresh`.
- A new ad needs at least one photo, as OLX requires ("The images field is required"). It's checked before sending; a catalog's `limits.minImages: 0` turns the check off.

### Changed (breaking)

- `AdStatus` has two new values: `inactive` (deactivated) and `sold`. Generic status names like `deactivated` or `disabled` now read as `inactive`, where they read as `deleted` before.
- OLX's states are read as OLX defines them: `featured` and `elite` are `active` with a `promotion`, and a soft rejection is `rejected` with `rejection: 'soft'`. The backend `state` decides `inactive` and `sold`, since OLX's display state lags behind and can show a deactivated ad as `limited`.
- A sold product can't be edited: `upsert` fails with `reconcile_required` (`reason: 'ad_sold'`). `forget` it to post a new ad; `forget` no longer needs `force` for a sold or deleted ad.
- An endpoints file (`OLX_ENDPOINTS_FILE`) now overrides only the entries it lists, so endpoints added in new versions keep working without editing it.

## 0.3.0 — 2026-10-26

A library you install in a Node.js or Next.js app and call directly.

### Verified live (26 Oct 2026)

- Laptops (USD): create with a photo, edit keeping photos, edit replacing photos, delete, using an access token only.
- Mobile phones (LBP): create with a photo and no location, so the store-wide default (Beirut > Downtown) and the description footer applied; OLX stored 9,000,000 LL, the brand, the area and the footer. Edited in place (photos kept), then deleted.

### Added

- Store-wide `listingDefaults` in the catalog: a default location for listings that don't give one, and a `descriptionFooter` added to every description ("Delivery all over Lebanon"). Both count in the sync fingerprint; over REST, the location may now be left out.
- `createOlxClient(options)`: configure everything in code (`accessToken`, `store`, `catalog`, `contact`, `writeLimits`…), with no files or environment variables. OLX Lebanon's endpoints are built in.
- `client.ads`: `create`, `update`, `delete`, `list`, `find`, `status` by OLX id. On `update`, leaving `images` out keeps the ad's photos, and passing `images` replaces them.
- `client.catalog`: `findCategories`, `fields`, `locations`, `location`. Categories and fields are read live from OLX's public API and cached for an hour. Locations ship with the SDK (662 entries, including Arabic names).
- Ads and products can use OLX ids directly (`categoryId`, `locationId`, OLX attribute names); the catalog file is optional. Keys and ids can be mixed, and the REST body accepts both.
- The `olx-lb` CLI ships in the package: `init`, `login`, `token`, `check`, `catalog`, `test-post`, `serve`, `capture`. It replaces the repo-only `npm run` scripts, which remain as aliases.
- `startServer()` in `olx-lebanon-sdk/server`.
- Stable error codes: every `OlxSdkError` has a `code` (`invalid_listing`, `auth_failed`, `olx_rejected`, `outcome_unknown`, `image_upload_failed`, `reconcile_required`, `link_conflict`, `healthy_link`). `toErrorInfo(err)` turns any error into `{ code, message, status?, details? }`. OLX's own field errors are in `details.olxErrors`.
- REST: an OpenAPI 3.1 document (`openapi.json`, served at `GET /v1/openapi.json`), validated and checked against the routes in tests. `X-Request-Id` on every response, echoing a safe one from the caller.
- Verified in a Next.js 15 (webpack) and 16 (Turbopack) app with no configuration.
- Documentation in `docs/`: getting started, Next.js and Node.js guides, concepts, REST service, API reference, configuration, errors and troubleshooting. Relative links and anchors are checked in tests.
- `examples/`: Node.js scripts, Next.js route handlers and server actions, a SQL `SyncStore`, and PHP, Python and cURL clients for the REST service. The TypeScript examples are type-checked with the SDK, and the PHP, Python and shell clients run against a local service in tests.
- `OLX_ACCESS_TOKEN` for the CLI and the REST service: used instead of the session file, for servers where you can't open a browser. `sessionFromAccessToken(token)` builds a session from a token.
- OLX's title, description and photo limits (70, 4,096, 20) are checked before sending even without a catalog; a catalog's `limits` still overrides them. Over REST, at most 20 photos (was 30).
- `sync.upsert(…, { force: true })` re-sends the photos too, so a new picture behind an unchanged URL reaches OLX.
- `ads.status(adId)` searches My ads like `ads.find` (up to 50 pages), instead of only the newest 60 ads.
- The REST service logs unexpected errors (`internal_error`) with the request id; before, they weren't recorded.
- `RunningServer` is exported from `olx-lebanon-sdk/server`.
- `require('olx-lebanon-sdk')` works on Node.js 22.12 and later (the entry points now have a `default` condition).
- A location that is a whole district or the country is refused before sending (`invalid_listing`, with areas to choose from), instead of OLX's 422 "Please select a more specific location".

### Project

- Ready for npm: public package metadata, a tag-triggered release workflow with npm provenance, and source maps with inlined sources.
- ESLint and Prettier, enforced in CI with a production dependency audit; tests on Node.js 20, 22 and 24, on Linux and Windows.
- `CONTRIBUTING.md`, `SECURITY.md` (private vulnerability reports), `CODE_OF_CONDUCT.md`, issue and pull request templates, Dependabot.

### Security

- An edit or delete marks an ad as gone only when that request itself answers 404/410. Before, a 404 from another call in the same operation (the account, a photo upload) marked a live ad as gone, inviting a duplicate.
- `sync.link(…, { replace: true })` waits for a sync of the product that currently holds the ad, so the ad can't end up linked to two products.
- `olx-lb init --force` makes an existing `.env` owner-only, as a new one is.
- REST: listing bodies are capped (title 1,000 and description 20,000 characters, 100 attributes), so a queue full of large bodies can't exhaust memory.
- The published types no longer reference `playwright`, so apps without it type-check with `skipLibCheck: false`. `loadPlaywright` is no longer exported.
- zod 4 (fixes GHSA-mrhx-c7xc-m3w5 in zod 3). Validation messages for wrong types now read like "Invalid input: expected number, received string"; error codes and issue paths are unchanged.
- REST photo URLs must be http(s); a malformed URL is a 400 `invalid_listing` instead of an internal error.

### Changed (breaking)

- Node.js 20.12 or newer (was 20.0). `.env` files are read with Node's own parser, so `dotenv` is no longer a dependency; `loadEnvFile(path?)` is exported for your own scripts. Variables already set in the environment still win over the file.
- Entry points: the main import is the library only (it loads `zod` and nothing else). The REST service moved to `olx-lebanon-sdk/server` (`buildServer`, `startServer`, `JobQueue`, webhooks), and the capture tools to `olx-lebanon-sdk/tools`.
- `playwright` is now an optional peer dependency, needed only for `olx-lb login` and `olx-lb capture`.
- `ListingInput.categoryKey` and `locationKey` are optional; give either the key or the OLX id.
- `config/endpoints.json` is optional: without it, the built-in endpoints are used.
- Every photo problem (a missing file, a failed download, not an image, over 10 MB, a URL that isn't allowed) is now `ImageUploadError` (`image_upload_failed`), instead of a plain `OlxSdkError`.
- REST: the API moved under `/v1` (e.g. `PUT /v1/products/:id/listing`), and unversioned paths now answer `404 not_found`. Every error is `{ "error": { "code", "message", "details"?, "requestId" } }`, instead of `{ "error": "<code>", … }`. Failed jobs' `error` is `{ code, message, status?, details? }`, instead of `{ name, message }`.


## 0.2.0 — 2026-10-26

Real OLX Lebanon wire format, mapped from a capture of the web app.

### Changed (breaking)

- **The default adapter is now `olxLebanonAdapter`** (it was `placeholderAdapter`). It needs the `createAd`, `updateAd`, `deleteAd`, `listMyAds`, `currentUser` and `signImageUpload` endpoints, which ship in `config/endpoints.example.json`. Without them, creates and edits fail before anything is sent. To keep the old behaviour, pass `adapter: placeholderAdapter`, or set `OLX_ADAPTER=placeholder`.
- `OlxAdapter.buildAdPayload(listing, imageIds, ctx)` takes a third argument. `imageIds` is still `string[]`. The full photo details (url, width, height) are in `ctx.images`.
- `ImageUploader.uploadAll` returns `UploadedImage[]` (`{ id, url?, width?, height?, contentType? }`) instead of `string[]`.
- New ad status `limited` (the ad exists but needs a paid package to be visible).

### Verified live (26 Oct 2026)

Create, edit and delete of a test ad on OLX Lebanon, including photo upload, photos kept on an edit, and photos replaced on an edit.

### Fixed

- Edits no longer pile up photos. An edit whose photos are unchanged since the last sync uploads nothing, and OLX keeps the ad's photos. An edit with new photos removes the old ones with `deleted_photos`, using the ids read from My ads first. If the ad isn't found there, nothing is sent.
- Locations must be an area inside a district. OLX rejects a district alone with 422.

### Added

- `npm run catalog -- locations [text]`: area ids from the posting form's location search.
- `npm run live-test -- check | create | edit | delete`: a step-by-step check against live OLX with one test product.
- `npm run capture` starts signed in with the session saved by `npm run login`.
- Signed-URL photo uploads (`SignedUploadFlow`). Photos only go to OLX's own bucket and folder, and the session is never sent there.
- The account (`currentUser`) is read once per saved session. `OLX_CONTACT_NAME`, `OLX_CONTACT_PHONE` and `OLX_CONTACT_METHOD` override the contact on ads.
- A best-effort "My ads" status lookup after writes, done only after the result is saved.
- Catalog `valueMap` (case-insensitive) and `priceLimits`.
- `npm run catalog`: category ids and a category's posting fields, with a ready `valueMap`.
- `npm run capture:shapes`: a redacted request/response report from a capture.
- The capture summary lists other hosts the page contacted.
- `imageSize`: JPEG (with EXIF orientation), PNG, WebP and GIF dimensions.

## 0.1.0

First skeleton: session login and capture, HTTP client, sync service, REST service and job queue, with a placeholder wire format.
