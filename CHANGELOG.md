# Changelog

## 0.3.0 — 2026-10-26

A library you install in a Node.js or Next.js app and call directly.

### Added

- `createOlxClient(options)`: configure everything in code (`accessToken`, `store`, `catalog`, `contact`, `writeLimits`…), with no files or environment variables. OLX Lebanon's endpoints are built in.
- `client.ads`: `create`, `update`, `delete`, `list`, `find`, `status` by OLX id. On `update`, leaving `images` out keeps the ad's photos, and passing `images` replaces them.
- `client.catalog`: `findCategories`, `fields`, `locations`, `location`. Categories and fields are read live from OLX's public API and cached for an hour. Locations ship with the SDK (662 entries, including Arabic names).
- Ads and products can use OLX ids directly (`categoryId`, `locationId`, OLX attribute names); the catalog file is optional. Keys and ids can be mixed, and the REST body accepts both.
- The `olx-lb` CLI ships in the package: `init`, `login`, `token`, `check`, `catalog`, `test-post`, `serve`, `capture`. It replaces the repo-only `npm run` scripts, which remain as aliases.
- `startServer()` in `olx-lebanon-sdk/server`.
- Verified in a Next.js 15 (webpack) and 16 (Turbopack) app with no configuration.

### Changed (breaking)

- Entry points: the main import is the library only (it loads `zod` and nothing else). The REST service moved to `olx-lebanon-sdk/server` (`buildServer`, `startServer`, `JobQueue`, webhooks), and the capture tools to `olx-lebanon-sdk/tools`.
- `playwright` is now an optional peer dependency, needed only for `olx-lb login` and `olx-lb capture`.
- `ListingInput.categoryKey` and `locationKey` are optional; give either the key or the OLX id.
- `config/endpoints.json` is optional: without it, the built-in endpoints are used.


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
