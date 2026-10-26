# REST service

For store backends that aren't written in JavaScript (PHP, Python, .NET, Java, Go…), the SDK runs as a small HTTP service next to your store. Your backend sends it products; it queues them, posts them at a human pace, and tells you the outcome.

- [Run it](#run-it)
- [How a sync works](#how-a-sync-works)
- [Endpoints](#endpoints)
- [Listing body](#listing-body)
- [Jobs](#jobs)
- [Errors](#errors)
- [Parked products](#parked-products)
- [Ad lifecycle](#ad-lifecycle)
- [Webhooks](#webhooks)
- [OpenAPI and generated clients](#openapi-and-generated-clients)
- [Running it as a service](#running-it-as-a-service)
- [Security](#security)

Ready-made clients: [PHP](../examples/rest/client.php), [Python](../examples/rest/client.py), [cURL](../examples/rest/curl.sh). They are run against the service in the SDK's test suite.

## Run it

In an empty folder (or your project):

```bash
npm install olx-lebanon-sdk
npm install -D playwright && npx playwright install chromium

npx olx-lb init      # .env with a random SERVER_API_KEY, config/catalog.json, .gitignore entries
npx olx-lb login     # sign in once, by hand
npx olx-lb check     # read-only: session, account, your newest ads
npx olx-lb serve     # http://127.0.0.1:8787
```

Your backend needs the same `SERVER_API_KEY` value, sent as the `X-Api-Key` header. Keep it in your backend's own configuration (for example `OLX_SDK_API_KEY`).

## How a sync works

```
your backend                       REST service                         OLX
     │  PUT /v1/products/SKU-1/listing  │                                 │
     │ ───────────────────────────────▶ │  validate, queue                │
     │  202 { jobId, status: queued }   │                                 │
     │ ◀─────────────────────────────── │                                 │
     │                                  │  wait for a pacing slot         │
     │                                  │  upload photos, create or edit  │
     │                                  │ ──────────────────────────────▶ │
     │                                  │ ◀────────────────────────────── │
     │  GET /v1/jobs/{jobId}  (or a webhook)                              │
     │ ───────────────────────────────▶ │                                 │
     │  { status: succeeded, result: { action, record: { adId, … } } }    │
     │ ◀─────────────────────────────── │                                 │
```

- `PUT` answers in milliseconds. The ad is posted later, in order, at about one write a minute.
- The service remembers which ad belongs to which product, so your backend only ever sends product ids. Sending the same product again edits its ad, and does nothing at all if the content is unchanged.
- To learn the outcome, poll `GET /v1/jobs/{jobId}` or receive a [webhook](#webhooks). Save `result.record.adId` next to your product if you want to link to the ad.

## Endpoints

All paths are under `/v1`. Every route except `/v1/health` and `/v1/openapi.json` needs the `X-Api-Key` header.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Liveness: `{ "ok": true }` |
| `GET` | `/v1/openapi.json` | The OpenAPI 3.1 document |
| `GET` | `/v1/status` | Session state, queue, writes in the last hour, products needing attention |
| `PUT` | `/v1/products/{productId}/listing` | Create or update the product's ad → `202 { jobId, status }`. `?force=true` pushes unchanged content too |
| `DELETE` | `/v1/products/{productId}/listing` | Remove the product's ad → `202 { jobId, status }` |
| `GET` | `/v1/products/{productId}/listing` | The stored link: ad id, status, sync state |
| `POST` | `/v1/products/{productId}/listing/deactivate` | Take the ad offline without deleting it → `202 { jobId }`. The next `PUT` republishes it |
| `POST` | `/v1/products/{productId}/listing/activate` | Put a `limited` ad live with a free slot → `202 { jobId }`; the job result has `result`: `activated`, `needs_package` or `not_limited` |
| `POST` | `/v1/products/{productId}/listing/sold` | Mark the ad as sold, body `{ "soldOn": "olx" }` or `{ "soldOn": "elsewhere" }` → `202 { jobId }` |
| `GET` | `/v1/products/{productId}/listing/metrics` | Views and leads for the product's ad |
| `POST` | `/v1/products/{productId}/listing/resolve` | Resolve a [parked product](#parked-products) |
| `POST` | `/v1/listings/refresh` | Re-read every linked ad's status from OLX (expired, live after review…) → `202 { jobId }` |
| `GET` | `/v1/listings` | All stored links |
| `GET` | `/v1/jobs/{jobId}` | A job and its outcome |

**Product ids** are yours: letters, digits and `. _ : -`, up to 128 characters. URL-encode them.

**`GET /v1/status`** looks like:

```json
{
  "session": { "loggedIn": true, "savedAt": "2026-10-26T08:12:44.000Z", "cookieCount": 0, "capturedHeaders": ["authorization"] },
  "endpoints": { "createAd": true, "…": true },
  "missingEndpoints": [],
  "queue": { "queued": 0, "running": false, "tracked": 12 },
  "writesLastHour": 3,
  "needsAttention": [{ "productId": "SKU-9", "syncState": "needs_reconcile", "lastError": "…" }]
}
```

Check `session.loggedIn` and `needsAttention` from your monitoring.

## Listing body

```json
{
  "title": "Dell Latitude 5440",
  "description": "16 GB RAM, 512 GB SSD, 1 year warranty",
  "price": 899,
  "currency": "USD",
  "categoryId": "175",
  "locationId": "47",
  "attributes": { "make": "3", "type": "1", "new_used": "1" },
  "images": [{ "url": "https://shop.example.com/images/dell-5440.jpg" }]
}
```

| Field | |
| --- | --- |
| `title`, `description` | Required. Up to 70 and 4,096 characters (checked when the job runs: a longer one fails as `invalid_listing`). |
| `price` | A number, or a decimal string such as `"899.00"` (as SQL decimals often arrive). |
| `currency` | `USD` (default) or `LBP`. |
| `categoryId` or `categoryKey` | OLX's category id, or a key from `config/catalog.json`. Exactly one. |
| `locationId` or `locationKey` | An OLX **area** id, or a key from the catalog file. Leave both out to use `listingDefaults` from the catalog file ([store-wide defaults](concepts.md#store-wide-defaults)). |
| `attributes` | The category's fields with OLX's values (or your names, with a `categoryKey`). An empty array `[]` (PHP's `json_encode([])`) counts as none. At most 100. |
| `images` | Up to 20 `{ "url": "https://…" }`. URL-only over REST. |

Ids may be strings or numbers. To keep the queue small in memory, a request is refused at once (400) with a title over 1,000 characters, a description over 20,000, or an attribute value over 1,000; OLX's own limits are checked when the job runs. Find them with `npx olx-lb catalog …` ([how](getting-started.md#3-find-the-ids-for-your-ad)).

## Jobs

```json
{
  "id": "6f0c…",
  "type": "upsert",
  "productId": "SKU-1042",
  "status": "succeeded",
  "createdAt": "…", "startedAt": "…", "finishedAt": "…",
  "result": {
    "action": "created",
    "record": { "productId": "SKU-1042", "adId": "117146151", "status": "active", "contentHash": "…", "createdAt": "…", "lastSyncedAt": "…" },
    "ad": { "id": "117146151", "status": "active" }
  }
}
```

| `status` | |
| --- | --- |
| `queued`, `running` | Not finished. Poll again in a few seconds. |
| `succeeded` | Upsert: `result.action` is `created`, `updated`, `republished` (an inactive or expired ad brought back) or `unchanged`. Remove: `deleted` / `not_found`. Deactivate and sold: `result.record`. Activate: `result.result` and `result.record`. Refresh: `result.updated`, `result.missing`, `result.checked`. |
| `failed` | `error` has a stable `code`; see [Errors](errors.md#codes). |
| `cancelled` | The service stopped before the job ran. Send the request again. |

- Jobs run **one at a time**. A new request for a product that is still waiting replaces the waiting job, so a burst of edits becomes one.
- At most 2,000 products can wait. Beyond that, `PUT` and `DELETE` answer `429 queue_full` with `Retry-After`.
- Finished jobs are kept in memory (the latest 500) and lost on restart. The product links are not: they are in the store.
- Raw OLX responses never leave the service.

## Errors

Every error has one shape. `code` is stable; branch on it, not on the message.

```json
{ "error": { "code": "invalid_listing", "message": "The listing body is invalid", "details": { "issues": [{ "path": "locationId", "message": "must be a numeric OLX id" }] }, "requestId": "3f1c…" } }
```

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing or wrong `X-Api-Key` |
| `invalid_product_id`, `invalid_listing`, `invalid_resolution` | 400 | Fix the request; `details.issues` says what |
| `bad_request` | 400, or another 4xx (e.g. 415 for a wrong `Content-Type`) | The request couldn't be read; the message says why |
| `not_found` | 404 | No such link, job or route (old unversioned paths too). Without a valid key, unknown routes answer 401 |
| `link_conflict`, `healthy_link` | 409 | A resolve would orphan or share an ad; `details.adId` |
| `payload_too_large` | 413 | Body over 1 MB |
| `queue_full` | 429 | Too many products waiting; retry after `Retry-After` |
| `shutting_down` | 503 | Stopping; retry after it restarts (`Retry-After`) |
| `internal_error` | 500 | Unexpected; the error is in the service log with the request id |

A failed **job** reports the same shape in `job.error`, with the SDK's codes (`olx_rejected`, `auth_failed`, `outcome_unknown`…). The full list, with what to do for each, is in [Errors](errors.md).

**Request ids.** Each response carries `X-Request-Id`. Send your own (letters, digits, `. _ : -`, up to 64 characters) and it is echoed back, and included when the service logs an internal error, so both sides' logs line up.

## Parked products

When the service can't know whether OLX created an ad (a timeout, a 5xx, an unreadable answer), it **parks** the product instead of posting it again; see [Concepts](concepts.md#duplicate-protection-and-parked-products). Parked products appear in `/v1/status` under `needsAttention`, and their jobs fail with `reconcile_required` until you resolve them. Check My ads on olx.com.lb, then:

```http
POST /v1/products/SKU-1042/listing/resolve
Content-Type: application/json
X-Api-Key: …

{ "action": "link", "adId": "117146151" }
```

| Body | When |
| --- | --- |
| `{ "action": "link", "adId": "…" }` | The ad exists: manage it from now on. Also adopts an ad you posted by hand. |
| `{ "action": "forget" }` | No ad exists: the next sync creates one. |

Both refuse with `409` when they would leave an ad orphaned or shared: `link_conflict` (the product has a healthy link to another ad, or the ad belongs to another product) and `healthy_link` (forgetting a healthy link would leave its ad live and unmanaged). Add `"replace": true` or `"force": true` only if that is what you want. To take an ad down, use `DELETE`.

## Ad lifecycle

The usual flow for a shop:

| When | Call |
| --- | --- |
| A product is added or changes | `PUT /v1/products/{id}/listing` |
| It's out of stock, coming back | `POST …/deactivate`. A later `PUT` brings the same ad back |
| It's gone for good | `DELETE /v1/products/{id}/listing` |
| It sold | `POST …/sold` with `{ "soldOn": "olx" }` or `"elsewhere"`. To sell it again, `POST …/resolve { "action": "forget" }`, then `PUT` posts a new ad |
| Once a day, say | `POST /v1/listings/refresh`, so expired ads are noticed and come back with the next `PUT` |

Deactivate, activate and sold are queued and paced like any write. Their jobs fail with the same [codes](errors.md#codes); for example, sold on a product that has no ad gives `sdk_error`, and a `PUT` on a sold ad gives `reconcile_required` with `details.reason: "ad_sold"`. See [Concepts: ad lifecycle](concepts.md#ad-lifecycle).

## Webhooks

Set `WEBHOOK_URL` and `WEBHOOK_SECRET` (16+ characters, different from `SERVER_API_KEY`) and every finished job, including cancelled ones, is POSTed there as JSON, without raw OLX data.

Each request is signed:

- `X-Olx-Sdk-Timestamp`: unix seconds
- `X-Olx-Sdk-Signature`: `sha256=` + hex HMAC-SHA256 of `"{timestamp}.{raw body}"` with the secret

Verify the signature over the **raw** body bytes, compare in constant time, reject timestamps older than five minutes, and refuse to verify with an empty secret. Ready-made verifiers: [PHP](../examples/rest/webhook.php), [Python](../examples/rest/webhook.py). In Node.js:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, rawBody: string, ts: string, sig: string): boolean {
  if (secret.length < 16 || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex'));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

Delivery is best-effort: one attempt, a 10-second timeout, redirects refused, plain http only to localhost. Treat webhooks as a fast path and polling (or `GET /v1/listings`) as the source of truth.

## OpenAPI and generated clients

The full contract is [`openapi.json`](../openapi.json) (OpenAPI 3.1). It ships in the package (`olx-lebanon-sdk/openapi.json`) and the service serves it at `GET /v1/openapi.json`. Generate a typed client instead of writing one (openapi-generator needs Java):

```bash
npx @openapitools/openapi-generator-cli generate -i http://127.0.0.1:8787/v1/openapi.json -g php -o olx-client     # or python, csharp, java, go…
```

Postman and Insomnia import it directly.

## Running it as a service

The service reads `.env` from its **working directory**, so always start it from the folder that holds `.env`.

- **Linux (systemd):** `WorkingDirectory=/srv/olx-sdk`, `ExecStart=/usr/bin/npx olx-lb serve`, `Restart=on-failure`.
- **Windows:** Task Scheduler ("Start in" = the folder, trigger at startup, "Run whether user is logged on or not"), or NSSM with the folder as the startup directory.
- **pm2:** `pm2 start "npx olx-lb serve" --name olx-sdk --cwd /srv/olx-sdk`.
- **From code,** with your own store: [`startServer()`](node.md#running-the-rest-service-from-your-code).

On stop (Ctrl+C, SIGTERM, a service stop), the running job finishes, waiting jobs are cancelled (and sent to the webhook), and new requests get `503 shutting_down`. Run **one instance** per OLX account: two instances would each pace themselves and could both create the same new product.

## Security

- The service binds to `127.0.0.1` by default. Keep it on the same machine or private network as your backend; to expose it, put it behind a reverse proxy with TLS and keep the API key.
- The API key check runs in constant time. Internal error details are never returned; they go to the service log.
- Photo URLs must be https and resolve to public addresses, so a caller can't point the service at your internal network. Redirects are re-checked on every hop, and downloads stop at 10 MB. If your photos are on a LAN host or plain http, list it in `OLX_IMAGE_HOSTS`; listed hosts are trusted as-is. On a server with internal services, setting `OLX_IMAGE_HOSTS` to your image host is the safest choice.
- See also [Security notes](../README.md#security) for the session files and captures.
