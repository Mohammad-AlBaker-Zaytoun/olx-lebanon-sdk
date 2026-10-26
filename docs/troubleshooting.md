# Troubleshooting

Start with `npx olx-lb check`: it is read-only and shows whether the session works, which account ads go to, and your newest ads. With `--product product.json`, it also shows how a product maps, without posting it.

- [Setup](#setup)
- [Posting](#posting)
- [Next.js and serverless](#nextjs-and-serverless)
- [REST service](#rest-service)
- [Asking for help](#asking-for-help)

## Setup

**`Cannot find package 'playwright'` or a browser error on `olx-lb login`**
Sign-in needs Playwright and its browser: `npm install -D playwright && npx playwright install chromium`. Only the sign-in step needs it; your app doesn't.

**`ERR_REQUIRE_ESM`, `require() of ES Module`, or `ERR_PACKAGE_PATH_NOT_EXPORTED`**
The package is ESM. Use `import`, or see [CommonJS projects](node.md#commonjs-projects).

**`npm install` skipped dev dependencies (`tsc` or `vitest` not found)**
`NODE_ENV=production` is set in your shell, so npm leaves out dev dependencies. Clear it for the install: `NODE_ENV= npm install` (Windows cmd: `set NODE_ENV=&& npm install`).

**`createOlxClient: accessToken looks empty or malformed`, or `auth_failed` "No OLX session" on the first call**
The token variable is empty or cut short (the first message), or not set at all in this environment (the second). Print `Boolean(process.env.OLX_ACCESS_TOKEN)` where the client is created: in Next.js, `.env.local` is read at startup, so restart `next dev` after changing it, and set the variable in your host's settings for deployments.

**`Invalid configuration: …`**
The CLI or REST service found a bad value in `.env`; the message names the variable. `SERVER_API_KEY` and `WEBHOOK_SECRET` need 16 or more characters and must differ.

## Posting

**`auth_failed`**
OLX refused the token: it expired (about a year), you changed your password or signed out everywhere, or OLX flagged the session. Run `npx olx-lb login` again, then `npx olx-lb token`, and update `OLX_ACCESS_TOKEN`.

**`invalid_listing`**
Nothing was sent; `issues` lists what to fix, for example "Title is 83 characters; OLX allows 70", "locationId 2 is the district "Beirut"; OLX needs an area in it", or "Category "laptops" requires: brand".

**`olx_rejected` with `location_id`: "Please select a more specific location."**
The location is a district (Beirut), not an area (Beirut > Hamra). Pick one from `npx olx-lb catalog locations <text>`; only areas are listed.

**`olx_rejected` naming an attribute**
A field is missing or has a value OLX doesn't know. `npx olx-lb catalog fields <categoryId>` lists the fields and their values; send the value (`"3"`), not the label (`"Dell"`), unless your catalog maps labels to values.

**The ad was created but buyers can't see it (`limited`)**
The account has used its free ads in that category. The ad goes live after you buy a package on OLX; then `olx.ads.status(adId)` shows `active`. The SDK never buys packages.

**`pending_review` after every edit**
That's OLX's normal review of edited ads, the same as edits made by hand. It clears by itself.

**A write takes a minute or more**
That's the pacing: at least 60 seconds between writes, plus a random delay, and at most 20 an hour. It's per client, so make sure you create one client and reuse it. See [Concepts: pacing](concepts.md#pacing).

**`outcome_unknown`**
OLX may or may not have created the ad. Don't resend it. With `sync`, the product is now parked: check My ads, then `sync.link(productId, adId)` or `sync.forget(productId)`. See [parked products](concepts.md#duplicate-protection-and-parked-products).

**`reconcile_required` on every sync of one product**
It is parked, or its ad was removed on OLX. Resolve it as above; the error message says which.

**`image_upload_failed`**
The message names the photo and the reason. Common ones: a local file that doesn't exist, the URL is plain http or on a private network (allow the host with `allowedImageHosts` / `OLX_IMAGE_HOSTS`), the file is over 10 MB, the server answered with an error page instead of an image, or a redirect went to a host that isn't allowed.

**The photos didn't change after an update**
With `ads.update`, pass `images` to replace them; leaving it out keeps the current photos. With `sync`, photos are re-uploaded only when the list of sources changes, so a new picture at the same URL isn't noticed. Change the URL (for example `photo.jpg?v=2`), or call `upsert` with `{ force: true }`.

**`Ad … was not found in "My ads", so its current photos are unknown; the edit was not sent`**
An edit with new photos first reads the ad's current photos from My ads. The ad was removed on OLX, or is older than the pages searched. Check it on OLX; if it's gone, `sync.remove` (or `sync.forget`) the product and sync it again.

**Posting worked before and now fails for every product**
OLX may have changed its website. Update the SDK first. If the latest version still fails, see [When OLX changes its website](concepts.md#when-olx-changes-its-website).

## Next.js and serverless

**`Module not found: Can't resolve 'fs'` / `'dns'`, or "The edge runtime does not support Node.js modules"**
The SDK was imported in a client component, middleware, or an Edge route. Use it in route handlers, server actions and server components, with `export const runtime = 'nodejs'`, and add `import 'server-only'` to the file that creates the client.

**The same product was posted twice**
Either the store is in memory (each serverless invocation starts empty), or two processes synced the same new product at once. Use a [database store](concepts.md#the-store) and a [single writer](concepts.md#one-writer-per-product).

**The function times out**
A write waits for its pacing slot and the photo uploads. Raise `maxDuration`, and move bulk syncing to a background job or the [REST service](rest-api.md). See [Running on Vercel](nextjs.md#running-on-vercel-and-other-serverless-hosts).

## REST service

**`SERVER_API_KEY is not set`**
Run `npx olx-lb init`, or add a random value of 16+ characters to `.env`. Your backend sends the same value as `X-Api-Key`.

**The service doesn't see my `.env`**
It reads `.env` from the folder it is started in. Set the working directory ("Start in" in Task Scheduler, `WorkingDirectory` in systemd), or pass `--env-file <path>`.

**`401 unauthorized`**
The `X-Api-Key` header is missing or differs from `SERVER_API_KEY`. Under IIS or Apache, PHP's `getenv()` often can't see system environment variables; read the key from your app's config instead.

**`404 not_found` on a path that used to work**
Since 0.3.0 every path is under `/v1`.

**Jobs stay `queued` for a long time**
Jobs run one at a time, about one write a minute. `GET /v1/status` shows the queue length and the writes in the last hour.

**`EADDRINUSE`**
Another program uses the port, often an earlier copy of the service. Stop it, or set `SERVER_PORT`.

**Webhook signatures never match**
Verify the raw request body, not JSON you decoded and encoded again, and make sure your receiver's secret equals `WEBHOOK_SECRET` exactly (no quotes or trailing spaces). See [Webhooks](rest-api.md#webhooks).

## Asking for help

Open an issue with the SDK version (`npx olx-lb --version`), your Node.js version, the error's `code` and `message`, and `details` if any. Leave out your token, `.env`, `.olx-session/` and `.har` files: they give access to your OLX account. The `.summary.txt` and `.shapes.txt` files from `olx-lb capture` are masked for sharing, but skim them first.
