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
- **Endpoints are configuration, not code.** OLX's internal endpoints aren't documented, so you record them from your own browser (`npm run capture`) and put them in `config/endpoints.json`. Until an endpoint is mapped, calls to it fail with a clear `EndpointNotConfiguredError`.
- **Adapter.** OLX's exact request and response formats live in one swappable object (`OlxAdapter`). The bundled `placeholderAdapter` is a best guess, and you replace it once you've seen real traffic.
- **Sync, don't spam.** Each store product maps to exactly one ad. Changed products are edited in place, never reposted. Content that hasn't changed is never sent. Writes are spaced out with jitter and capped per hour, and they are never retried automatically, because a retry could create a duplicate ad.

## Status

`v0.1` is the full skeleton, with tests for every layer except the live OLX calls themselves. Before it can post real ads, it needs:

1. Endpoints captured and filled in: `config/endpoints.json`
2. The real payload format: a custom `OlxAdapter` (or edits to `placeholderAdapter`)
3. Real category, attribute and location IDs: `config/catalog.json`

[docs/ENDPOINT-CAPTURE.md](docs/ENDPOINT-CAPTURE.md) walks through all three.

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
npm run capture                                # record one manual ad post -> captures\
# ...fill endpoints.json / catalog.json from the capture...

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
npm run capture
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
| `GET` | `/jobs/:jobId` | Job outcome (`queued`, `running`, `succeeded`, `failed`) |

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

Sometimes OLX may or may not have created an ad: a timeout, a 5xx, or a response the adapter couldn't read. In that case the product is **parked** with `syncState: "needs_reconcile"` instead of being posted again. If OLX says a linked ad no longer exists, the link is marked `"gone"`. Parked products show up under `needsAttention` in `/status`, and further syncs for them fail with `ReconcileRequiredError` until you resolve them:

```http
POST /products/P-100/listing/resolve
{ "action": "link", "adId": "123456789" }   # the ad exists on OLX: manage it from now on
{ "action": "forget" }                      # no ad exists: the next sync creates one
```

### Webhooks

If `WEBHOOK_URL` is set, every finished job is POSTed there, minus raw OLX responses. Each request is signed with `WEBHOOK_SECRET`, which must differ from `SERVER_API_KEY`. The headers are `X-Olx-Sdk-Timestamp` (unix seconds) and `X-Olx-Sdk-Signature: sha256=<hex HMAC of "timestamp.body">`. Redirects are refused, and plain http is only allowed for localhost. Verifying in PHP:

```php
$body = file_get_contents('php://input');
$ts   = $_SERVER['HTTP_X_OLX_SDK_TIMESTAMP'] ?? '';
$sig  = $_SERVER['HTTP_X_OLX_SDK_SIGNATURE'] ?? '';
$ok   = abs(time() - (int) $ts) < 300
     && hash_equals('sha256=' . hash_hmac('sha256', "$ts.$body", getenv('OLX_WEBHOOK_SECRET')), $sig);
if (!$ok) { http_response_code(401); exit; }
$job = json_decode($body, true);
```

### Calling it from PHP

`OLX_SDK_API_KEY` in your store's environment must hold the same value as `SERVER_API_KEY` in this project's `.env`.

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

From another Node project, install it from a local clone or the git URL. The `prepare` script builds `dist/` on install:

```bash
npm install ../olx-lebanon-sdk
# or: npm install git+https://github.com/Mohammad-AlBaker-Zaytoun/olx-lebanon-sdk.git
```

```ts
import 'dotenv/config';
import { OlxClient, loadConfig } from 'olx-lebanon-sdk';

const client = OlxClient.fromConfig(loadConfig(), {
  // adapter: myOlxAdapter,      // your real wire format
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

Use **one process per sync store**. Two processes sharing `data/sync-store.json` would overwrite each other's records. To use the SDK alongside the REST service, call the service, or give each process its own store.

### Extension points

| Interface | Default | Replace it to… |
| --- | --- | --- |
| `OlxAdapter` | `placeholderAdapter` | match OLX's real request and response JSON |
| `SyncStore` | `JsonFileSyncStore` | store product ↔ ad links in SQL Server, MySQL, etc. |
| `SessionStore` | `FileSessionStore` | keep the session in a secrets manager |
| `Logger` / `RequestLog` | JSON lines | plug in pino, winston, your log stack |

## Configuration

All settings are environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Notes |
| --- | --- | --- |
| `OLX_MIN_WRITE_INTERVAL_MS` | `60000` | Minimum gap between writes |
| `OLX_WRITE_JITTER_MS` | `15000` | Random extra delay added to each gap |
| `OLX_MAX_WRITES_PER_HOUR` | `20` | Rolling hourly cap |
| `OLX_IMAGE_HOSTS` | *(any public https host)* | Comma-separated hosts images may come from; listed hosts are trusted |
| `OLX_EXTRA_HOSTS` | — | Non-OLX hosts the web app talks to (e.g. an image CDN); recorded by `capture`, watched by `login` |
| `OLX_CAPTURE_HEADERS` | — | Extra auth header names to save at login (defaults: `authorization`, `x-access-token`, `x-auth-token`, `x-csrf-token`) |
| `SERVER_API_KEY` | — | Required for the REST service (16+ chars) |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | — | Optional signed job notifications; the secret is required with the URL |

## Security notes

- `.olx-session/` and `captures/` hold credentials that give **full access to your OLX account**. Both are git-ignored and written owner-only. Never commit or share them. The `.summary.txt` next to a capture holds no secrets.
- Your session's cookies and auth headers are only sent to the OLX domain and its subdomains. An endpoint on another host gets them only if you set `sendSessionToForeignHost` for it. Redirects from OLX are never followed. Only https endpoints are called.
- The request log (`logs/requests.jsonl`) records method, path, status and timing only. It contains no bodies, cookies, tokens or query strings, and neither do image error messages.
- The REST service uses a constant-time API key check, hides internal error details, and accepts only URL images, so a caller can't make it read local files. Image downloads block private and internal addresses unless you allowlist a host.

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
