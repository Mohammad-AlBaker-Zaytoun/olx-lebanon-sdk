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

Requirements: Node.js 20 or newer.

```bash
npm install
npx playwright install chromium        # browser used for login and capture

cp .env.example .env                   # then set SERVER_API_KEY
cp config/endpoints.example.json config/endpoints.json
cp config/catalog.example.json  config/catalog.json

npm run login                          # sign in to your OLX account
npm run capture                        # record one manual ad post → captures/
# …fill endpoints.json / catalog.json from the capture…

npm run build && npm start             # REST service on 127.0.0.1:8787
```

Generate an API key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## REST API

Every route except `/health` requires the `X-Api-Key` header. The service binds to `127.0.0.1` by default, so keep it on the same machine or private network as your store.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check (no key needed) |
| `GET` | `/status` | Session state, mapped endpoints, queue, writes in the last hour |
| `PUT` | `/products/:productId/listing` | Create or update the ad for a product → `202 { jobId }` |
| `DELETE` | `/products/:productId/listing` | Remove the product's ad → `202 { jobId }` |
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

`categoryKey` and `locationKey` are **your** names from `config/catalog.json`, which maps them to OLX's IDs, required attributes and field names. Over REST, images are URL-only, and you can restrict them to your own hosts with `OLX_IMAGE_HOSTS`. If `WEBHOOK_URL` is set, every finished job is also POSTed there.

### Calling it from PHP

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

```ts
import 'dotenv/config';
import { OlxClient, loadConfig } from 'olx-lebanon-sdk';

const client = OlxClient.fromConfig(loadConfig(), {
  // adapter: myOlxAdapter,      // your real wire format
  // syncStore: mySqlServerStore // keep product ↔ ad links in your own DB
});

const result = await client.sync.upsert('P-100', {
  title: 'Router AX3000',
  description: 'Wi-Fi 6 router',
  price: 89,
  categoryKey: 'networking',
  locationKey: 'beirut',
  images: [{ path: './images/router.jpg' }],
});
console.log(result.action); // "created" | "updated" | "unchanged"
```

Lower-level access goes through `client.listings.create / update / delete / get / listMine`.

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
| `OLX_IMAGE_HOSTS` | *(any)* | Comma-separated allowlist for image URLs |
| `SERVER_API_KEY` | — | Required for the REST service (16+ chars) |

## Security notes

- `.olx-session/` and `captures/` hold credentials that give **full access to your OLX account**. Both are git-ignored. Never commit or share them.
- The request log (`logs/requests.jsonl`) records method, path, status and timing only. It contains no bodies, cookies, tokens or query strings.
- The REST service uses a constant-time API key check and accepts only URL images, so a caller can't make it read local files.

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
