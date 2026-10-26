# olx-lebanon-sdk

Post, edit and delete **your own** ads on [OLX Lebanon](https://www.olx.com.lb) from Node.js and Next.js: a typed client, product sync, catalog lookup, a CLI, and an optional REST service for other languages.

OLX Lebanon runs on Dubizzle Group's platform and has no public API. This SDK does what the OLX website does when you post by hand, using your own signed-in account, so a store or app can list its products automatically.

> [!WARNING]
> **Unofficial — use at your own risk.** This project is not affiliated with, endorsed by, or supported by OLX, Dubizzle Group, or any of their affiliates. Automating an account may conflict with OLX's Terms of Use, and OLX can change its website at any time and break this tool. You alone are responsible for how you use it. See [Responsible use](#responsible-use).

```ts
import { createOlxClient } from 'olx-lebanon-sdk';

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN });

const ad = await olx.ads.create({
  title: 'Dell Latitude 5440',
  description: '16 GB RAM, 512 GB SSD, 1 year warranty',
  price: 899,                                  // USD
  categoryId: '175',                           // Laptops, Tablets, Computers
  locationId: '47',                            // Beirut > Hamra
  attributes: { make: '3', type: '1', new_used: '1' }, // Dell, Laptop, New
  images: [{ url: 'https://shop.example.com/dell-5440.jpg' }],
});
console.log(ad.id, ad.status); // "117146151" "active"
```

## Contents

- [Install](#install)
- [Get an access token](#get-an-access-token)
- [Ads](#ads)
- [Product sync](#product-sync)
- [Catalog: categories, fields, locations](#catalog-categories-fields-locations)
- [Next.js](#nextjs)
- [CLI](#cli)
- [REST service (PHP, Python, .NET…)](#rest-service-php-python-net)
- [Configuration](#configuration)
- [Errors](#errors)
- [Status and limits](#status-and-limits)
- [Security notes](#security-notes)
- [Responsible use](#responsible-use)

## Install

```bash
npm install olx-lebanon-sdk
```

- **Runtime:** Node.js 20 or newer, ESM. Use `import`, not `require()`. On Node 22, `require()` of ESM also works.
- **Server-side only:** it uses Node APIs (crypto, DNS, file system) and your access token. In Next.js, use it in route handlers, server actions and server components, with the Node.js runtime and not the Edge runtime.
- **One-time sign-in:** this opens a browser and needs Playwright as a dev tool (`npm install -D playwright && npx playwright install chromium`). Your app itself never needs Playwright.

## Get an access token

You sign in once, by hand, in a real browser window. Complete any code or CAPTCHA yourself; the SDK never automates those. Then copy the token into your app's secrets:

```bash
npx olx-lb login     # opens a browser: sign in to OLX, then press Enter in the terminal
npx olx-lb token     # prints the access token
```

Store it as an environment variable, for example `OLX_ACCESS_TOKEN` in `.env.local` or your host's secret settings. The token lasts about a year. Treat it like a password: anyone who has it can manage your OLX account. Never commit it or send it to the browser. When it expires, or after you change your OLX password, run `olx-lb login` again.

## Ads

`olx.ads` works with ads by their OLX id. Nothing is stored on your side.

```ts
const ad = await olx.ads.create(input);       // → { id, status, title, raw }
await olx.ads.update(ad.id, { ...input, price: 849 });
await olx.ads.delete(ad.id);
const { ads, hasMore } = await olx.ads.list({ page: 1, perPage: 20 });
const found = await olx.ads.find('117146151');
```

| `AdInput` field | |
| --- | --- |
| `title`, `description` | Required. OLX's limits are 70 and 4,096 characters. |
| `price`, `currency` | `currency` is `USD` (default) or `LBP`. USD goes in OLX's price field, LBP in its "LL" field. |
| `categoryId` | OLX's category id. Only categories without subcategories (see [Catalog](#catalog-categories-fields-locations)). |
| `locationId` | An **area** id, e.g. Beirut > Hamra (`47`). A district on its own is rejected by OLX. |
| `attributes` | The category's fields as OLX names them, with OLX's choice values, e.g. `{ make: '3' }` for Dell. Required fields depend on the category. |
| `images` | `{ url }` (https, public), `{ path }` (a local file) or `{ data, filename }` (a `Uint8Array`/`Buffer`, e.g. an upload). JPEG, PNG, WebP or GIF, up to 10 MB each, max 20. |

- **Updates replace the whole ad.** OLX's edit needs every field, not only the changed ones.
- **Photos on update:** leave `images` out to keep the ad's current photos. Pass `images` to replace them, and the old ones are removed.
- **`status`** is `active`, `pending_review`, `limited`, `rejected`, `expired`, `deleted` or `unknown`. `limited` means the account has used its free ads in that category, so the ad stays hidden until you buy a package on OLX (see [Status and limits](#status-and-limits)).
- **Writes are paced** to look like a person: at least 60 s between writes, plus some random delay, and at most 20 per hour by default. They are never retried automatically, because a retry could post the same ad twice. Change the pace with `writeLimits`.

## Product sync

If your app has products, `olx.sync` keeps **one ad per product**. The first sync creates the ad. Later syncs edit the same ad, and only when something changed. Photos are re-uploaded only when they change.

```ts
const result = await olx.sync.upsert('SKU-1042', input); // → { action: 'created' | 'updated' | 'unchanged', record }
await olx.sync.remove('SKU-1042');                        // deletes the ad and the link
```

Each product's link to its ad (the ad id, a fingerprint of what was sent, the status) lives in a **store**. The default is memory, which is lost on restart and on every serverless invocation. For anything real, pass a store backed by your database. It is four methods:

```ts
import { createOlxClient, type SyncStore, type SyncRecord } from 'olx-lebanon-sdk';

const store: SyncStore = {
  get: async (productId) => (await db.olxLink.findUnique({ where: { productId } }))?.record as SyncRecord | undefined,
  set: async (record) => void (await db.olxLink.upsert({ where: { productId: record.productId }, create: { productId: record.productId, record }, update: { record } })),
  delete: async (productId) => void (await db.olxLink.deleteMany({ where: { productId } })),
  all: async () => (await db.olxLink.findMany()).map((r) => r.record as SyncRecord),
};

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN, store });
```

`JsonFileSyncStore` (a JSON file) is included for scripts and single-server setups.

**Duplicate protection.** Right before a create is sent, the product is marked `creating`. If OLX's answer is lost (a timeout, a server error, a crash), the product is **parked** as `needs_reconcile` instead of being posted again. Check My ads, then call `olx.sync.link(productId, adId)` if the ad exists, or `olx.sync.forget(productId)` if it doesn't. If an ad was removed on OLX, the link becomes `gone` and the next sync tells you so instead of failing silently.

## Catalog: categories, fields, locations

OLX's catalog is public, so no token is needed. Use it to find ids, or to build forms and dropdowns in your app:

```ts
await olx.catalog.findCategories('laptop'); // [{ id: '175', name, path: ['Electronics & Home Appliances', 'Laptops, Tablets, Computers'] }]
await olx.catalog.fields('175');            // [{ attribute: 'make', label: 'Brand', required: true, choices: [{ value: '3', label: 'Dell' }, …] }, …]
olx.catalog.locations('hamra');             // [{ id: '47', name: 'Hamra', path: ['Beirut', 'Hamra'], postable: true }, …]
```

Categories and fields come live from OLX and are cached for an hour. Locations ship with the SDK (662 entries, Arabic names included), so `locations()` needs no network. You can also use the catalog without a client: `new OlxCatalog()`.

**Your own names (optional).** If your products use your own words ("laptops", `brand: "Dell"`, `condition: "used"`), pass a catalog that translates them. Products then use `categoryKey` and `locationKey`:

```ts
const olx = createOlxClient({
  accessToken: process.env.OLX_ACCESS_TOKEN,
  catalog: {
    categories: {
      laptops: {
        olxCategoryId: '175',
        requiredAttributes: ['brand', 'type', 'condition'],
        attributeMap: { brand: 'make', condition: 'new_used' },
        valueMap: { brand: { Dell: '3', HP: '4', Lenovo: '6' }, type: { Laptop: '1' }, condition: { new: '1', used: '2' } },
        defaults: { condition: 'new' },
        priceLimits: { min: 5, max: 50000 },
      },
    },
    locations: { shop: { olxLocationId: '47' } },
  },
});

await olx.sync.upsert('SKU-1', { title, description, price, categoryKey: 'laptops', locationKey: 'shop', attributes: { brand: 'dell', type: 'Laptop' } });
```

`valueMap` matching ignores case. `requiredAttributes` and `priceLimits` are checked before anything is sent. `npx olx-lb catalog fields 175` prints a ready-made entry with every choice.

## Next.js

```ts
// app/api/products/[id]/olx/route.ts
import 'server-only';
import { createOlxClient } from 'olx-lebanon-sdk';

export const runtime = 'nodejs'; // not 'edge'

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN, store: myDbStore });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProduct(id);
  const result = await olx.sync.upsert(id, toAdInput(product));
  return Response.json({ action: result.action, adId: result.record.adId, status: result.record.status });
}
```

Tested with Next.js 15 (webpack) and 16 (Turbopack), with no extra configuration.

- **Keep it on the server.** Only use the SDK in route handlers, server actions and server components. `import 'server-only'` makes Next.js fail the build if a client component imports it.
- **Serverless hosts (Vercel and the like):**
  - Pass a database-backed `store`. Memory is lost on every invocation.
  - A create downloads and uploads its photos and waits for OLX, which takes a few seconds per ad. Raise the function's `maxDuration` if you post from a request.
  - The write pacing is per process. In one invocation, the second write waits about a minute. For bulk listing, run a background job or the [REST service](#rest-service-php-python-net) on a server.

## CLI

Installed with the package as `olx-lb`. Run it with `npx olx-lb <command>`, or install it globally.

| Command | What it does |
| --- | --- |
| `olx-lb init` | Sets up a folder for the CLI and REST service: `.env` with a new API key, an optional catalog file, and `.gitignore` entries |
| `olx-lb login` | Opens a browser to sign in by hand, then saves the session to `.olx-session/` |
| `olx-lb token` | Prints the access token for your app's environment variables |
| `olx-lb check [--product file.json]` | Read-only check of the session, account, your newest ads, and how a product maps |
| `olx-lb catalog categories [text]` | Category ids |
| `olx-lb catalog fields <id>…` | A category's fields and choices, with a ready catalog entry |
| `olx-lb catalog locations [text]` | Area ids |
| `olx-lb test-post create\|edit\|delete` | Posts, edits and deletes one test ad, step by step |
| `olx-lb serve` | Runs the REST service |
| `olx-lb capture [shapes]` | For maintainers: records the OLX website to map a format change ([guide](docs/ENDPOINT-CAPTURE.md)) |

Add `--json` to `catalog` for machine-readable output, and `--help` to any command for details. Exit codes: `0` ok, `1` failed, `2` wrong usage.

## REST service (PHP, Python, .NET…)

For store backends that aren't written in JavaScript, the SDK runs as a small local HTTP service. It queues jobs one at a time and paces writes, and the same duplicate protection applies.

```bash
npx olx-lb init      # .env with a random SERVER_API_KEY
npx olx-lb login
npx olx-lb serve     # http://127.0.0.1:8787
```

Run it from the folder that holds `.env`. Under Task Scheduler, NSSM or a Windows service, set the working directory ("Start in") to that folder. You can also start it from code with `startServer()` from `olx-lebanon-sdk/server`.

### Endpoints

The API is versioned under `/v1`. Every route except `/v1/health` and `/v1/openapi.json` requires the `X-Api-Key` header. The service binds to `127.0.0.1` by default, so keep it on the same machine or private network as your store.

**OpenAPI.** The full contract is in [`openapi.json`](openapi.json) (OpenAPI 3.1), which also ships in the package. The service serves it at `GET /v1/openapi.json`. Generate a typed client for your language with openapi-generator, NSwag, oapi-codegen or similar, or import it into Postman.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness check (no key needed) |
| `GET` | `/v1/openapi.json` | The OpenAPI document (no key needed) |
| `GET` | `/v1/status` | Session state, queue, writes in the last hour, products needing attention |
| `PUT` | `/v1/products/:productId/listing` | Create or update the ad for a product → `202 { jobId }`. Add `?force=true` to push unchanged content. |
| `DELETE` | `/v1/products/:productId/listing` | Remove the product's ad → `202 { jobId }` |
| `POST` | `/v1/products/:productId/listing/resolve` | Resolve a parked product (see below) |
| `GET` | `/v1/products/:productId/listing` | The stored product ↔ ad link |
| `GET` | `/v1/listings` | All stored links |
| `GET` | `/v1/jobs/:jobId` | Job outcome (`queued`, `running`, `succeeded`, `failed`, `cancelled`), without raw OLX data |

**Errors** always have one shape, and `code` is stable, so branch on it rather than on the message:

```json
{ "error": { "code": "invalid_listing", "message": "The listing body is invalid", "details": { "issues": [{ "path": "locationId", "message": "must be a numeric OLX id" }] }, "requestId": "3f1c…" } }
```

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or wrong `X-Api-Key` |
| `invalid_product_id`, `invalid_listing`, `invalid_resolution`, `bad_request` | 400 | Fix the request (`details.issues` says what) |
| `not_found` | 404 | No such link, job or route |
| `link_conflict`, `healthy_link` | 409 | A resolve would orphan or share an ad (`details.adId`) |
| `payload_too_large` | 413 | Body over 1 MB |
| `queue_full` | 429 | Too many products waiting; retry after `Retry-After` |
| `shutting_down` | 503 | The service is stopping; retry after it restarts |
| `internal_error` | 500 | Unexpected; details are in the service log |

A **failed job** reports the same shape in `job.error`, with the library's codes: `invalid_listing`, `olx_rejected` (`status` and OLX's own field errors in `details.olxErrors`, e.g. `{"location_id": ["Please select a more specific location."]}`), `auth_failed`, `outcome_unknown`, `image_upload_failed`, `reconcile_required`, or `cancelled`.

**Request ids.** Each response has an `X-Request-Id` header. Send your own (letters, digits, `. _ : -`, up to 64 characters) and it is echoed back, so logs on both sides line up.

Listing body:

```json
{
  "title": "iPhone 15 128GB",
  "description": "Sealed box, 1 year warranty",
  "price": 799,
  "currency": "USD",
  "categoryId": "9",
  "locationId": "47",
  "attributes": { "make": "2", "new_used": "1" },
  "images": [{ "url": "https://your-store.example/images/iphone15.jpg" }]
}
```

The body is the same `AdInput` as in the library: OLX ids (`categoryId`, `locationId`) and OLX field values, or your own names (`categoryKey`, `locationKey`) from `config/catalog.json`.

Over REST, images are URL-only. By default an image URL must be https and must resolve to a public address. If you set `OLX_IMAGE_HOSTS`, images may only come from those hosts, and those hosts are trusted as-is (http and LAN addresses allowed). Redirects are re-checked on every hop, and downloads are capped at 10 MB.

#### Parked products (duplicate protection)

Sometimes OLX may or may not have created an ad: a timeout, a 5xx, a redirect that isn't to a login page, or a response the adapter couldn't read. A failed *image* upload doesn't count, because no ad request has been sent at that point, so it simply fails and can be retried. In that case the product is **parked** with `syncState: "needs_reconcile"` instead of being posted again. If OLX says a linked ad no longer exists, the link is marked `"gone"`. Parked products show up under `needsAttention` in `/v1/status`, and further syncs for them fail with `ReconcileRequiredError` until you resolve them:

```http
POST /v1/products/P-100/listing/resolve
{ "action": "link", "adId": "123456789" }   # the ad exists on OLX: manage it from now on
{ "action": "forget" }                      # no ad exists: the next sync creates one
```

`link` also lets you adopt an ad you posted by hand. Both actions guard against orphaned or shared ads, answering `409` unless you opt in:

- `link` refuses (`link_conflict`) to replace a healthy link to a *different* ad, or to take an ad that another product is already linked to. Add `"replace": true` to do it anyway.
- `forget` refuses (`healthy_link`) on a product with a healthy link, because the ad would stay live but unmanaged and the next sync would post a second one. To take an ad down, use `DELETE`. Add `"force": true` only if you really mean to stop managing it.

A product whose create is running right now is not listed under `needsAttention`. A resolve sent during a create waits for that create to finish and is then checked against its result.

#### Queue behaviour

- Jobs run one at a time.
- A new request for a product that is already waiting replaces the waiting job.
- At most 2,000 products can wait at once. Beyond that, `PUT`/`DELETE` answer `429 queue_full` with `Retry-After`.
- On shutdown (Ctrl+C or a service stop), the running job is allowed to finish. Waiting jobs are marked `cancelled` and reported to the webhook, so resend them after a restart. Requests that arrive during shutdown get `503 shutting_down`.

#### Webhooks

If `WEBHOOK_URL` is set, every finished job is POSTed there, minus raw OLX responses. Each request is signed with `WEBHOOK_SECRET`, which must differ from `SERVER_API_KEY`. The headers are `X-Olx-Sdk-Timestamp` (unix seconds) and `X-Olx-Sdk-Signature: sha256=<hex HMAC of "timestamp.body">`. Redirects are refused, and plain http is only allowed for localhost. Verifying in PHP, where `OLX_WEBHOOK_SECRET` in your store's environment must hold the same value as `WEBHOOK_SECRET` here:

```php
$secret = getenv('OLX_WEBHOOK_SECRET');
if (!is_string($secret) || strlen($secret) < 16) {
    // Never verify with an empty/missing secret: hash_hmac would accept forged requests.
    http_response_code(500);
    exit('OLX_WEBHOOK_SECRET is not configured');
}
$body = file_get_contents('php://input');
$ts   = $_SERVER['HTTP_X_OLX_SDK_TIMESTAMP'] ?? '';
$sig  = $_SERVER['HTTP_X_OLX_SDK_SIGNATURE'] ?? '';
$ok   = ctype_digit($ts)
     && abs(time() - (int) $ts) < 300
     && hash_equals('sha256=' . hash_hmac('sha256', "$ts.$body", $secret), $sig);
if (!$ok) { http_response_code(401); exit; }
$job = json_decode($body, true);
```

Under IIS or Apache, `getenv()` often can't see system environment variables. Set the secret where PHP can read it, for example in your app's config file, and keep the empty-secret check.

#### Calling it from PHP

`OLX_SDK_API_KEY` in your store's environment must hold the same value as `SERVER_API_KEY` in this project's `.env`.

- **Product ids** may contain letters, digits and `. _ : -`, up to 128 characters.
- **`price`** may be a number or a decimal string (`"799.00"`, which is how SQL Server decimals often arrive).
- **`attributes`** may be an empty PHP array: `json_encode([])` produces `[]`, which is accepted as "no attributes".

```php
function olxSyncProduct(string $productId, array $listing): array
{
    $ch = curl_init('http://127.0.0.1:8787/v1/products/' . rawurlencode($productId) . '/listing');
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => 'PUT',
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'X-Api-Key: ' . getenv('OLX_SDK_API_KEY'),
        ],
        CURLOPT_POSTFIELDS     => json_encode($listing),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $data = json_decode($body, true);
    if ($status !== 202) {
        // e.g. invalid_listing (fix the product), queue_full (retry later), unauthorized (check the key)
        $code = $data['error']['code'] ?? 'unknown';
        throw new RuntimeException("OLX sync rejected ($status $code): " . ($data['error']['message'] ?? $body));
    }
    return $data; // ['jobId' => ..., 'status' => 'queued']
}
```

## Configuration

`createOlxClient()` takes everything as options:

| Option | Default | |
| --- | --- | --- |
| `accessToken` | — | From `olx-lb token`. Or pass `session` / `sessionStore` |
| `store` | memory | Where `sync` keeps product ↔ ad links ([Product sync](#product-sync)) |
| `catalog` | none | Your own names for categories and locations |
| `contact` | your OLX profile | `{ name, phone, method }` shown to buyers. `method` defaults to `allow_chat_communication` |
| `writeLimits` | 60 s, +15 s, 20/h | `{ minIntervalMs, jitterMs, maxPerHour }` |
| `allowedImageHosts` | any public https host | Only download photos from these hosts (and trust them) |
| `logger`, `requestLog` | silent | Plug in your logger (`debug`/`info`/`warn`/`error`) |
| `fetch`, `imageFetch` | global `fetch` | For tests and proxies |
| `endpoints`, `adapter` | built in | Only if OLX moves an endpoint or changes its format |

The CLI and the REST service read the same settings from environment variables, usually a `.env` file created by `olx-lb init`:

| Variable | Default | Notes |
| --- | --- | --- |
| `OLX_SESSION_FILE` | `.olx-session/session.json` | Written by `olx-lb login`; a secret |
| `OLX_CATALOG_FILE` | `config/catalog.json` | Optional |
| `OLX_SYNC_STORE_FILE` | `data/sync-store.json` | The REST service's product ↔ ad links |
| `OLX_CONTACT_NAME` / `_PHONE` / `_METHOD` | profile / profile / `allow_chat_communication` | Contact on your ads. Existing ads change on their next edit (or `?force=true`) |
| `OLX_MIN_WRITE_INTERVAL_MS` / `OLX_WRITE_JITTER_MS` / `OLX_MAX_WRITES_PER_HOUR` | `60000` / `15000` / `20` | Write pacing |
| `OLX_IMAGE_HOSTS` | any public https host | Comma-separated photo hosts |
| `OLX_EXTRA_HOSTS` | set by `init` | Hosts the website uses, for `login` and `capture` |
| `SERVER_HOST` / `SERVER_PORT` / `SERVER_API_KEY` | `127.0.0.1` / `8787` / — | REST service. The key is required (16+ characters) |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | — | Optional signed job notifications |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## Errors

Every error is an `OlxSdkError` with a stable `code`, the same codes the REST service reports. Branch on `err.code`, or use `instanceof` with the subclasses:

| `code` | Class | Meaning | What to do |
| --- | --- | --- | --- |
| `invalid_listing` | `MappingError` | The input is invalid (`issues` lists why). Nothing was sent | Fix the input |
| `auth_failed` | `AuthError` | No session, or OLX rejected the token (401/403) | `olx-lb login`, then update the token |
| `olx_rejected` | `OlxHttpError` | OLX refused the request (`status`, and `body` names the field). For example 422 "Please select a more specific location" | Fix the input |
| `outcome_unknown` | `UncertainWriteError` | Sent, but the outcome is unknown. The ad may exist | Don't resend blindly; check My ads (`sync` parks the product for you) |
| `image_upload_failed` | `ImageUploadError` | A photo failed before the ad was sent | Retry |
| `reconcile_required` | `ReconcileRequiredError` | `sync`: the product is parked or its ad is gone | `sync.link()` or `sync.forget()` |
| `link_conflict`, `healthy_link` | `LinkConflictError`, `ForgetConflictError` | `sync.link()` / `forget()` would orphan or share an ad | Pass `replace` / `force` if you mean it |

```ts
import { OlxSdkError, toErrorInfo } from 'olx-lebanon-sdk';

try {
  await olx.ads.create(input);
} catch (err) {
  if (err instanceof OlxSdkError && err.code === 'olx_rejected') console.warn(toErrorInfo(err).details?.olxErrors);
  else throw err;
}
```

`toErrorInfo(err)` turns any error into `{ code, message, status?, details? }`, ready to log or return from an API route.

## Status and limits

Verified against live OLX on 26 October 2026 with a test product:

- **Create:** the photo is uploaded and the ad goes live with its photo.
- **Edit with the same photos:** the price changes and nothing is re-uploaded.
- **Edit with new photos:** the old photos are removed.
- **Delete:** the ad is removed.

OLX puts an edited ad back into review (`pending_review`) for a while, as it does for edits made by hand.

- **Free-ad limits.** Each account gets a limited number of free ads per category. An ad posted beyond that is created but stays hidden (`limited`) until you buy a package on OLX. The status is read from My ads right after each write. It isn't refreshed later, for example after you buy a package; `olx.ads.status(id)` reads it again. The SDK never buys packages.
- **OLX can change its website at any time.** If posting starts failing with new validation errors, `olx-lb capture` and [the capture guide](docs/ENDPOINT-CAPTURE.md) show what changed. Until a release follows the change, `endpoints` and `adapter` let you patch around it.

## Security notes

- Your **access token**, `.olx-session/` and the `.har` files in `captures/` hold credentials that give **full access to your OLX account**. Both are git-ignored. On Linux and macOS they are written owner-only (`0600`/`0700`). On Windows, file modes have no effect and the files inherit the folder's permissions, so keep the project in your own user folder, not a shared one. Never commit or share them.
- The files made *from* a capture are meant to be shareable, but skim them first:
  - `.summary.txt`: methods, paths and status codes, with ids and tokens replaced by `{id}`.
  - `.shapes.txt`: bodies with names, phone numbers, emails, free text and tokens masked. The token appears only as its type, issuer and lifetime.
  - `.public/`: OLX's public category and location data.
- Photos are only uploaded to OLX's own bucket and folder (`olx-lb-prod.s3.eu-central-1.amazonaws.com/temp/`). An upload URL anywhere else is refused, and no session ever goes with an upload.
- Locations ship with the SDK. Only the maintainer script `npm run update-locations` contacts OLX's location search, using the website's own read-only key from a capture (or `OLX_SEARCH_AUTH`). The key is never printed or saved.
- `session.json` keeps only cookies and storage for OLX (and `OLX_EXTRA_HOSTS`). If you sign in with Google or Facebook, those sites' cookies are not saved.
- Your session's cookies and auth headers are only sent to the OLX domain and its subdomains. An endpoint on another host gets them only if you set `sendSessionToForeignHost` for it. Redirects from OLX are never followed. Only https endpoints are called.
- The request log (`logs/requests.jsonl`) records method, path, status and timing only. It contains no bodies, cookies, tokens or query strings, and neither do image error messages.
- The REST service uses a constant-time API key check, hides internal error details, and accepts only URL images, so a caller can't make it read local files. Image downloads block private and internal addresses unless you allowlist a host. Known limit: the address check and the download resolve DNS separately, so a hostile DNS server could still rebind between the two. On a server with internal services, set `OLX_IMAGE_HOSTS` to your store's image host.

## Responsible use

This tool exists so that a seller can manage **their own** listings without retyping them. Please keep it that way:

- Use it only with an account you own, for items you are actually selling.
- Keep posting volume human-paced. Don't lower the throttling defaults to post in bulk.
- Don't post duplicate or misleading ads. The sync layer is designed to edit, not repost.
- Never try to bypass CAPTCHAs, phone verification or other protections. Complete them yourself.
- Don't use it to scrape or redistribute other users' listings or personal data.
- If OLX offers an official API or partner feed for Lebanon, prefer that.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run olx -- help      # the CLI from source
```

[CHANGELOG.md](CHANGELOG.md) lists what changed in each version. `npm run update-locations` refreshes the shipped locations (maintainers).

## License

[MIT](LICENSE). The license covers this code only, and grants no rights to OLX's services, trademarks or content.
