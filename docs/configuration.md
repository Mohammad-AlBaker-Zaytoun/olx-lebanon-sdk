# Configuration

- [In code: `createOlxClient` options](#in-code-createolxclient-options)
- [Environment variables](#environment-variables) (CLI and REST service)
- [The catalog file](#the-catalog-file)
- [Files the SDK writes](#files-the-sdk-writes)

## In code: `createOlxClient` options

A library client is configured entirely in code. It reads no files and no environment variables by itself.

```ts
createOlxClient({
  accessToken: process.env.OLX_ACCESS_TOKEN,
  store: mySyncStore,
  contact: { name: 'Your Store' },
  logger: createLogger('info'),
});
```

| Option | Default | |
| --- | --- | --- |
| `accessToken` | — | From `olx-lb token`. Give this, `session` or `sessionStore`: exactly one. |
| `session` | — | A saved session object, as `olx-lb login` writes it. |
| `sessionStore` | — | Your own `{ load, save, clear }` store for the session. |
| `store` | `MemorySyncStore` | Where `sync` keeps product ↔ ad links. Use a database in production ([concepts](concepts.md#the-store)). |
| `catalog` | none | Your own names for categories and locations ([concepts](concepts.md#your-own-names-the-catalog)). An object or parsed JSON. |
| `contact` | your OLX profile | `{ name, phone, method }` shown to buyers. Empty fields come from your profile. `method` defaults to `allow_chat_communication`. |
| `writeLimits` | `{ minIntervalMs: 60000, jitterMs: 15000, maxPerHour: 20 }` | Write pacing ([concepts](concepts.md#pacing)). Partial values are merged with the defaults. |
| `allowedImageHosts` | any public https host | Only download photos from these hosts (and their subdomains). Listed hosts are trusted as-is: http and private addresses are allowed for them. |
| `logger` | silent | `{ debug, info, warn, error }`, each `(message, meta?)`. `createLogger(level)` writes JSON lines to stderr. |
| `requestLog` | none | Records each call to OLX (method, path, status, timing; never bodies or tokens). `FileRequestLog(path)` or `MemoryRequestLog`. |
| `fetch` | global `fetch` | Used for calls to OLX. For tests and proxies. |
| `imageFetch` | global `fetch` | Used to download product photos. |
| `http` | `{ timeoutMs: 30000, maxReadRetries: 2 }` | Timeouts and read retries for calls to OLX (`retryBaseMs`, `maxRetryDelayMs` too). Writes are never retried. |
| `images` | 10 MB and 20 s per photo, 2 min per ad, 3 redirects | Photo download limits: `maxBytes`, `timeoutMs`, `totalTimeoutMs`, `maxRedirects`. |
| `endpoints`, `adapter`, `baseUrl` | built in | Only for following an OLX change before a release ([capture guide](ENDPOINT-CAPTURE.md)). |

## Environment variables

The CLI (`olx-lb`) and the REST service read settings from the environment, and from a `.env` file in the folder they run in. `npx olx-lb init` writes a commented `.env` with a random `SERVER_API_KEY`. Empty values (`FOO=`) count as unset. An invalid value stops the program with a message naming the variable.

### Account

| Variable | Default | |
| --- | --- | --- |
| `OLX_SESSION_FILE` | `.olx-session/session.json` | Written by `olx-lb login`. A secret. |
| `OLX_ACCESS_TOKEN` | — | Use this token instead of the session file, for example on a server where you can't open a browser. Get it with `olx-lb token`. |
| `OLX_CONTACT_NAME`, `OLX_CONTACT_PHONE`, `OLX_CONTACT_METHOD` | your profile, your profile, `allow_chat_communication` | Contact shown on your ads. Existing ads pick it up on their next edit (or `?force=true`). |

### Listings

| Variable | Default | |
| --- | --- | --- |
| `OLX_CATALOG_FILE` | `config/catalog.json` | Optional: your own category and location names. |
| `OLX_SYNC_STORE_FILE` | `data/sync-store.json` | The REST service's product ↔ ad links. Back it up. |
| `OLX_IMAGE_HOSTS` | any public https host | Comma-separated hosts photos may come from (and are trusted). |
| `OLX_MIN_WRITE_INTERVAL_MS`, `OLX_WRITE_JITTER_MS`, `OLX_MAX_WRITES_PER_HOUR` | `60000`, `15000`, `20` | Write pacing. |

### REST service

| Variable | Default | |
| --- | --- | --- |
| `SERVER_API_KEY` | — | Required, 16+ characters. Callers send it as `X-Api-Key`. |
| `SERVER_HOST` | `127.0.0.1` | Interface to listen on. Keep it local or private. |
| `SERVER_PORT` | `8787` | |
| `WEBHOOK_URL` | — | Optional: where finished jobs are POSTed. https, or http to localhost. |
| `WEBHOOK_SECRET` | — | Required with `WEBHOOK_URL`, 16+ characters, different from `SERVER_API_KEY`. |

### Diagnostics and maintenance

| Variable | Default | |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `OLX_REQUEST_LOG_FILE` | `logs/requests.jsonl` | Method, path, status and timing of each call to OLX. |
| `OLX_EXTRA_HOSTS` | set by `init` | Hosts the OLX website uses, recorded by `login` and `capture`. |
| `OLX_CAPTURE_HEADERS` | — | Extra request headers to keep at login. |
| `OLX_ENDPOINTS_FILE` | `config/endpoints.json` | Optional. If the file exists, it **replaces** the built-in endpoint map, so it must list every endpoint (start from `config/endpoints.example.json`). In code, the `endpoints` option is merged instead. |
| `OLX_ADAPTER` | `olx-lebanon` | `placeholder` only for building a custom adapter. |
| `OLX_BASE_URL` | `https://www.olx.com.lb` | https only (http for localhost, for testing). |

To use a settings file other than `.env`, pass `--env-file <path>` to any `olx-lb` command.

## The catalog file

`config/catalog.json` holds the same structure as the `catalog` option:

```json
{
  "categories": {
    "laptops": {
      "label": "Laptops, Tablets, Computers",
      "olxCategoryId": "175",
      "requiredAttributes": ["brand", "type", "condition"],
      "attributeMap": { "brand": "make", "condition": "new_used" },
      "valueMap": { "brand": { "Dell": "3", "HP": "4" }, "type": { "Laptop": "1" }, "condition": { "new": "1", "used": "2" } },
      "defaults": { "condition": "new" },
      "priceLimits": { "min": 5, "max": 50000 }
    }
  },
  "locations": {
    "shop": { "olxLocationId": "47" }
  }
}
```

`npx olx-lb catalog fields 175` prints an entry like this for any category, with every choice filled in. `olx-lb check --product product.json` shows how a product maps, without posting it.

## Files the SDK writes

| Path | Written by | Contains | Share? |
| --- | --- | --- | --- |
| `.env` | `olx-lb init` | Settings and secrets | **Never** |
| `.olx-session/` | `olx-lb login` | Your session: full access to your account | **Never** |
| `captures/*.har` | `olx-lb capture` | Recorded website traffic, including your password if you typed it | **Never** |
| `captures/*.summary.txt`, `*.shapes.txt`, `.public/` | `olx-lb capture` | Masked summaries made for sharing | After a look |
| `data/sync-store.json` | REST service, `JsonFileSyncStore` | Product ↔ ad links | Back up |
| `data/test-post-store.json` | `olx-lb test-post` | The test ad's link | — |
| `logs/requests.jsonl` | CLI, REST service | Calls to OLX, without bodies or tokens | Yes |

`olx-lb init` adds the private ones to `.gitignore`. On Linux and macOS, secret files are written owner-only. On Windows, keep the project in your own user folder.
