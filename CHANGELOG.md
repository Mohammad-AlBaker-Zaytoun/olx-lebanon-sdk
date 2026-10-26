# Changelog

## 0.2.0 — 2026-10-26

Real OLX Lebanon wire format, mapped from a capture of the web app.

### Changed (breaking)

- **The default adapter is now `olxLebanonAdapter`** (it was `placeholderAdapter`). It needs the `createAd`, `updateAd`, `deleteAd`, `listMyAds`, `currentUser` and `signImageUpload` endpoints, which ship in `config/endpoints.example.json`. Without them, creates and edits fail before anything is sent. To keep the old behaviour, pass `adapter: placeholderAdapter`, or set `OLX_ADAPTER=placeholder`.
- `OlxAdapter.buildAdPayload(listing, imageIds, ctx)` takes a third argument. `imageIds` is still `string[]`. The full photo details (url, width, height) are in `ctx.images`.
- `ImageUploader.uploadAll` returns `UploadedImage[]` (`{ id, url?, width?, height?, contentType? }`) instead of `string[]`.
- New ad status `limited` (the ad exists but needs a paid package to be visible).

### Added

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
