# olx-lebanon-sdk

An **unofficial** TypeScript SDK and local REST service for posting and managing **your own** listings on [OLX Lebanon](https://www.olx.com.lb).

OLX Group publishes partner APIs for some countries, but OLX Lebanon runs on Dubizzle Group's platform and has no public API or SDK. This project fills that gap for one use case: a seller automating **their own account**. It lets a store backend create, edit and remove its products' ads the same way it pushes to any other sales channel.

> [!WARNING]
> **Unofficial — use at your own risk.** This project is not affiliated with, endorsed by, or supported by OLX, Dubizzle Group, or any of their affiliates. Automating an account may conflict with OLX's Terms of Use, and OLX can change its website at any time and break this tool. You alone are responsible for how you use it. See [Responsible use](#responsible-use).

---

## How it works

```
 Your store backend (PHP, etc.)
            │  HTTP + X-Api-Key
            ▼
 ┌──────────────────────────────────────────┐
 │ REST service (Fastify, localhost only)   │
 │   PUT/DELETE /products/:id/listing       │
 │            │                             │
 │            ▼                             │
 │ Job queue  — one job at a time,          │
 │              bursts per product coalesced│
 │            │                             │
 │            ▼                             │
 │ SyncService — product ↔ ad link,         │
 │              create once / edit / skip   │
 │            │                             │
 │            ▼                             │
 │ CatalogMapper — your categories &        │
 │                 locations → OLX ids      │
 │            │                             │
 │            ▼                             │
 │ HTTP client — saved session, write       │
 │               throttling, request log    │
 └────────────┼─────────────────────────────┘
              ▼
          OLX Lebanon
```

- **Session.** You log in yourself in a real browser window (`npm run login`), and complete any OTP or CAPTCHA by hand. The SDK saves the cookies and auth headers, then reuses them for plain HTTP calls.
- **Endpoints are configuration, not code.** OLX's internal endpoints aren't documented. The ones the web app uses were recorded from a real session and ship in `config/endpoints.example.json`. The ad API lives on Dubizzle Group's backend (`api-prod.olx-dubizzle.com`), and photos go to S3 through a signed URL. If OLX changes them, recapture with `npm run capture` ([docs/ENDPOINT-CAPTURE.md](docs/ENDPOINT-CAPTURE.md)).
- **Adapter.** OLX's exact request and response formats live in one swappable object (`OlxAdapter`). The built-in `olxLebanonAdapter` (the default) matches the captured format. If OLX changes it, pass your own adapter instead of editing SDK code.
- **Sync, don't spam.** Each store product maps to exactly one ad. Changed products are edited in place, never reposted. Content that hasn't changed is never sent. Writes are spaced out with jitter and capped per hour, and they are never retried automatically, because a retry could create a duplicate ad.

## Status

The endpoints and wire format are mapped from a capture of the OLX Lebanon web app (October 2026) and covered by tests against that format. Not yet verified against live OLX with a test product. Before you post, fill in **your** categories and location in `config/catalog.json` (see [Catalog](#catalog)).

### Free-ad limits

OLX Lebanon gives each account a limited number of free ads per category. An ad posted past that limit is created but stays hidden in the `limited` state until you buy a package on OLX. The SDK never buys packages for you.

OLX's post-ad answer has no state, so right after a create (or an edit without one), and only after the link is saved, the SDK checks the newest pages of "My ads" once. If it finds the ad there, `status` in the sync record, `/jobs` and the webhook becomes `limited`, `pending_review` or `active`. If the check fails, `status` stays `unknown` and the create still counts as done. The status isn't refreshed later, for example after you buy a package: the next edit of that product reads it again.

## Quick start

Requirements: Node.js 20 or newer. Run every command **from the project folder**: `.env` and the `config/`, `data/` and `logs/` paths are resolved from the current working directory.

**Windows (PowerShell):**

```powershell
npm install                                    # also builds dist/
npx playwright install chromium                # browser used for login and capture

Copy-Item .env.example .env                    # then set SERVER_API_KEY
Copy-Item config\endpoints.example.json config\endpoints.json
Copy-Item config\catalog.example.json config\catalog.json

npm run login                                  # sign in to your OLX account
npm run catalog -- categories laptop           # find OLX category ids
npm run catalog -- fields 175                  # their posting fields -> catalog.json

npm run build
npm start                                      # REST service on 127.0.0.1:8787
```

**macOS / Linux / Git Bash:**

```bash
npm install
npx playwright install chromium
cp .env.example .env
cp config/endpoints.example.json config/endpoints.json
cp config/catalog.example.json config/catalog.json
npm run login
npm run catalog -- categories laptop
npm run catalog -- fields 175
npm run build && npm start
```

Generate an API key (and a separate webhook secret, if you use webhooks) with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If you run the service from Task Scheduler, NSSM or a Windows service, set its working directory ("Start in") to the project folder.

## REST API

Every route except `/health` requires the `X-Api-Key` header. The service binds to `127.0.0.1` by default, so keep it on the same machine or private network as your store.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check (no key needed) |
| `GET` | `/status` | Session state, mapped endpoints, queue, writes in the last hour, products needing attention |
| `PUT` | `/products/:productId/listing` | Create or update the ad for a product → `202 { jobId }`. Add `?force=true` to push unchanged content. |
| `DELETE` | `/products/:productId/listing` | Remove the product's ad → `202 { jobId }` |
| `POST` | `/products/:productId/listing/resolve` | Resolve a parked product (see below) |
| `GET` | `/products/:productId/listing` | The stored product ↔ ad link |
| `GET` | `/listings` | All stored links |
| `GET` | `/jobs/:jobId` | Job outcome (`queued`, `running`, `succeeded`, `failed`, `cancelled`), without raw OLX data |

Listing body:

```json
{
  "title": "iPhone 15 128GB",
  "description": "Sealed box, 1 year warranty",
  "price": 799,
  "currency": "USD",
  "categoryKey": "mobile-phones",
  "locationKey": "beirut",
  "attributes": { "brand": "Apple", "condition": "new" },
  "images": [{ "url": "https://your-store.example/images/iphone15.jpg" }]
}
```

`categoryKey` and `locationKey` are **your** names from `config/catalog.json`, which maps them to OLX's IDs, required attributes and field names.

Over REST, images are URL-only. By default an image URL must be https and must resolve to a public address. If you set `OLX_IMAGE_HOSTS`, images may only come from those hosts, and those hosts are trusted as-is (http and LAN addresses allowed). Redirects are re-checked on every hop, and downloads are capped at 10 MB.

### Parked products (duplicate protection)

Sometimes OLX may or may not have created an ad: a timeout, a 5xx, a redirect that isn't to a login page, or a response the adapter couldn't read. A failed *image* upload doesn't count, because no ad request has been sent at that point, so it simply fails and can be retried. In that case the product is **parked** with `syncState: "needs_reconcile"` instead of being posted again. If OLX says a linked ad no longer exists, the link is marked `"gone"`. Parked products show up under `needsAttention` in `/status`, and further syncs for them fail with `ReconcileRequiredError` until you resolve them:

```http
POST /products/P-100/listing/resolve
{ "action": "link", "adId": "123456789" }   # the ad exists on OLX: manage it from now on
{ "action": "forget" }                      # no ad exists: the next sync creates one
```

`link` also lets you adopt an ad you posted by hand. Both actions guard against orphaned or shared ads, answering `409` unless you opt in:

- `link` refuses (`link_conflict`) to replace a healthy link to a *different* ad, or to take an ad that another product is already linked to. Add `"replace": true` to do it anyway.
- `forget` refuses (`healthy_link`) on a product with a healthy link, because the ad would stay live but unmanaged and the next sync would post a second one. To take an ad down, use `DELETE`. Add `"force": true` only if you really mean to stop managing it.

A product whose create is running right now is not listed under `needsAttention`. A resolve sent during a create waits for that create to finish and is then checked against its result.

### Queue behaviour

- Jobs run one at a time.
- A new request for a product that is already waiting replaces the waiting job.
- At most 2,000 products can wait at once. Beyond that, `PUT`/`DELETE` answer `429 queue_full` with `Retry-After`.
- On shutdown (Ctrl+C or a service stop), the running job is allowed to finish. Waiting jobs are marked `cancelled` and reported to the webhook, so resend them after a restart. Requests that arrive during shutdown get `503 shutting_down`.

### Webhooks

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

### Calling it from PHP

`OLX_SDK_API_KEY` in your store's environment must hold the same value as `SERVER_API_KEY` in this project's `.env`.

- **Product ids** may contain letters, digits and `. _ : -`, up to 128 characters.
- **`price`** may be a number or a decimal string (`"799.00"`, which is how SQL Server decimals often arrive).
- **`attributes`** may be an empty PHP array: `json_encode([])` produces `[]`, which is accepted as "no attributes".

```php
function olxSyncProduct(string $productId, array $listing): array
{
    $ch = curl_init('http://127.0.0.1:8787/products/' . rawurlencode($productId) . '/listing');
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

    if ($status !== 202) {
        throw new RuntimeException("OLX sync rejected ($status): $body");
    }
    return json_decode($body, true); // ['jobId' => ..., 'status' => ...]
}
```

## Using the SDK directly

The package is **ESM-only**. Use `import`, not `require()`, from a project with `"type": "module"` in its `package.json` (or from `.mjs` files). That also makes the top-level `await` below work.

From another Node project, install it from a local clone or the git URL. The `prepare` script builds `dist/` on install:

```bash
npm install ../olx-lebanon-sdk
# or: npm install git+https://github.com/Mohammad-AlBaker-Zaytoun/olx-lebanon-sdk.git
```

```ts
import 'dotenv/config';
import { OlxClient, loadConfig } from 'olx-lebanon-sdk';

const client = OlxClient.fromConfig(loadConfig(), {
  // adapter: myOlxAdapter,      // only if OLX changes its format
  // syncStore: mySqlServerStore // keep product ↔ ad links in your own DB
});

const result = await client.sync.upsert('P-100', {
  title: 'Lenovo ThinkPad T14',
  description: '16GB RAM, 512GB SSD, 1 year warranty',
  price: 899,
  categoryKey: 'laptops', // a key from config/catalog.json
  locationKey: 'beirut',
  images: [{ path: './images/t14.jpg' }],
});
console.log(result.action); // "created" | "updated" | "unchanged"
```

`client.sync` also has `remove`, `link` and `forget`. Calls for the same product are serialised. Lower-level access goes through `client.listings.create / update / delete / get / listMine`.

`fromConfig` logs to stderr at `LOG_LEVEL`. Pass `logger: silentLogger` to mute it, or your own `Logger`. Timeouts and limits can be tuned with `http: { timeoutMs, maxReadRetries }` and `images: { maxBytes, timeoutMs, totalTimeoutMs, maxRedirects }`.

Use **one process per sync store**. Two processes sharing `data/sync-store.json` would overwrite each other's records. To use the SDK alongside the REST service, call the service, or give each process its own store.

### Extension points

| Interface | Default | Replace it to… |
| --- | --- | --- |
| `OlxAdapter` | `olxLebanonAdapter` | follow a change in OLX's request and response JSON |
| `SyncStore` | `JsonFileSyncStore` | store product ↔ ad links in SQL Server, MySQL, etc. |
| `SessionStore` | `FileSessionStore` | keep the session in a secrets manager |
| `Logger` / `RequestLog` | JSON lines | plug in pino, winston, your log stack |
| `ListingsPort` | `ListingsApi` | wrap or replace the OLX calls. `create` **must** await `hooks.beforeSend()` right before sending the ad, or crash-time duplicate protection is lost (a warning is logged if it isn't called) |

## Catalog

`config/catalog.json` maps **your** category and location keys to OLX's ids and fields. The OLX data you need is public, and `npm run catalog` reads it for you (no login, nothing posted):

```bash
npm run catalog -- categories phone      # category ids by name; use one WITHOUT subcategories
npm run catalog -- fields 9 175          # the posting form's fields, their choices, and a starting entry
```

For each category:

- `olxCategoryId`: the category id (OLX's `externalID`).
- `requiredAttributes`: the fields the form requires, in your store's names. Price and price type are filled from the product's `price` and `currency`.
- `attributeMap`: renames your attribute names to OLX's, e.g. `{ "condition": "new_used" }`.
- `valueMap`: translates your values to OLX's choice values, e.g. `{ "condition": { "new": "1", "used": "2" } }`. Matching ignores case and surrounding spaces. Unlisted values are sent as they are. `npm run catalog -- fields` prints a `valueMap` with every choice, keyed by OLX's labels.
- `defaults`: values used when a product doesn't give one.
- `priceLimits`: the category's USD price range from the posting form (`{ "min": 10, "max": 10000 }`). A product outside it fails before anything is sent.

Locations use OLX's numeric location `id`. Every category accepts a district (level 1), for example Beirut `2`, Metn `21`, Baabda `8`, Keserouan `18`, Tripoli `3`, Saida `5`, Zahle `4`, Jbeil `16`. The full list is in `config/catalog.example.json`.

Changing `OLX_CONTACT_*` doesn't change existing ads by itself, because contact details aren't part of a product's fingerprint. Sync with `?force=true` to push them to ads that are already up.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Notes |
| --- | --- | --- |
| `OLX_MIN_WRITE_INTERVAL_MS` | `60000` | Minimum gap between writes |
| `OLX_WRITE_JITTER_MS` | `15000` | Random extra delay added to each gap |
| `OLX_MAX_WRITES_PER_HOUR` | `20` | Rolling hourly cap |
| `OLX_IMAGE_HOSTS` | *(any public https host)* | Comma-separated hosts images may come from; listed hosts are trusted |
| `OLX_EXTRA_HOSTS` | — | Non-OLX hosts the web app talks to; recorded by `capture`, watched by `login`. Set to `olx-dubizzle.com,olx-lb-prod.s3.eu-central-1.amazonaws.com` (as in `.env.example`) |
| `OLX_ADAPTER` | `olx-lebanon` | `placeholder` only when you pass a custom adapter in code |
| `OLX_CONTACT_NAME` / `OLX_CONTACT_PHONE` | *(your OLX profile)* | Contact shown on your ads |
| `OLX_CONTACT_METHOD` | `allow_chat_communication` | OLX's contact option for your ads |
| `OLX_CAPTURE_HEADERS` | — | Extra auth header names to save at login (defaults: `authorization`, `x-access-token`, `x-auth-token`, `x-csrf-token`) |
| `SERVER_API_KEY` | — | Required for the REST service (16+ chars) |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | — | Optional signed job notifications; the secret is required with the URL |

## Security notes

- `.olx-session/` and `captures/` hold credentials that give **full access to your OLX account**. Both are git-ignored. On Linux and macOS they are written owner-only (`0600`/`0700`). On Windows, file modes have no effect and the files inherit the folder's permissions, so keep the project in your own user folder, not a shared one. Never commit or share them. The `.summary.txt` next to a capture only lists methods, paths and status codes. Ids, tokens, emails and phone-like path segments are replaced with `{id}`. Still, skim it before sharing.
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
npm run typecheck
npm test
npm run build
```

## License

[MIT](LICENSE). The license covers this code only, and grants no rights to OLX's services, trademarks or content.
