# Node.js guide

Scripts, cron jobs, workers and Express/Fastify/Nest servers. If you use Next.js, read the [Next.js guide](nextjs.md) instead; everything here still applies underneath.

- [A sync script](#a-sync-script)
- [Running it on a schedule](#running-it-on-a-schedule)
- [Inside a web server](#inside-a-web-server)
- [A worker that syncs on change](#a-worker-that-syncs-on-change)
- [Logging](#logging)
- [Running the REST service from your code](#running-the-rest-service-from-your-code)
- [CommonJS projects](#commonjs-projects)

## A sync script

The simplest production setup is a script that runs every so often, reads your products, and calls `sync.upsert` for each. Unchanged products cost nothing (no call to OLX), so running it often is fine.

```ts
import { JsonFileSyncStore, OlxSdkError, createLogger, createOlxClient, toErrorInfo } from 'olx-lebanon-sdk';

const olx = createOlxClient({
  accessToken: process.env.OLX_ACCESS_TOKEN,
  store: new JsonFileSyncStore('data/olx-links.json'),
  logger: createLogger('info'),
});

for (const product of await loadProducts()) {
  try {
    if (!product.inStock) {
      await olx.sync.remove(product.sku);
      continue;
    }
    const { action, record } = await olx.sync.upsert(product.sku, toAd(product));
    console.log(product.sku, action, record.adId, record.status);
  } catch (err) {
    if (!(err instanceof OlxSdkError)) throw err;
    if (err.code === 'auth_failed') process.exit(1);        // every product would fail: renew the token
    console.warn(product.sku, 'not synced:', toErrorInfo(err)); // fix this product, carry on with the rest
  }
}
```

The full script, with the product mapping and the parked-product case, is [`examples/node/sync-products.ts`](../examples/node/sync-products.ts).

Choose the store by where the script runs:

- **One machine, one script:** `JsonFileSyncStore` is enough. Back the file up with your other data; losing it means the SDK no longer knows which ad belongs to which product.
- **Anything shared or important:** a database, with [`SqlSyncStore`](../examples/stores/sql-store.ts) or your own four-method store.

## Running it on a schedule

Writes are paced at about one a minute, so a run with many changes takes a while. Make sure two runs never overlap, or both may try to create the same new product:

- **cron (Linux, macOS):** `*/30 * * * * cd /srv/shop && flock -n /tmp/olx-sync.lock node sync.js >> logs/olx-sync.log 2>&1`
- **Windows Task Scheduler:** set "Start in" to the project folder, and under Settings choose "Do not start a new instance" if the task is already running.
- **A process manager or container:** run the script in a loop with a sleep between runs, as one replica.

## Inside a web server

Create one client when the server starts and reuse it. A short route can sync one product:

```ts
import express from 'express';
import { createOlxClient, toErrorInfo } from 'olx-lebanon-sdk';

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN, store: myDbStore });
const app = express();

app.post('/admin/products/:id/olx', requireStaff, async (req, res) => {
  try {
    const product = await getProduct(req.params.id);
    const { action, record } = await olx.sync.upsert(product.id, toAdInput(product));
    res.json({ action, adId: record.adId, status: record.status });
  } catch (err) {
    res.status(502).json({ error: toErrorInfo(err) });
  }
});
```

A write can wait more than a minute for its pacing slot, so for anything beyond a single product, hand the work to a background job and answer the request at once.

## A worker that syncs on change

If your shop emits events (product saved, stock changed), a single worker can listen and sync:

```ts
const pending = new Set<string>();
let running = false;

export function productChanged(id: string) {
  pending.add(id); // a burst of changes to one product becomes one edit
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.size) {
      const [id] = pending;
      pending.delete(id!);
      const product = await getProduct(id!);
      await olx.sync.upsert(id!, toAdInput(product)).catch((err) => log.warn('OLX sync failed', { id, error: toErrorInfo(err) }));
    }
  } finally {
    running = false;
  }
}
```

This is the same idea as the REST service's queue: one writer, newest content wins. If you'd rather not write it, run the [REST service](rest-api.md) and send it `PUT` requests.

## Logging

By default the SDK is silent. Pass a logger with `debug`, `info`, `warn` and `error` methods, each taking `(message, meta?)`:

```ts
import { createLogger } from 'olx-lebanon-sdk';
createOlxClient({ accessToken, logger: createLogger('info') }); // JSON lines on stderr

// or your own (pino, winston…):
createOlxClient({ accessToken, logger: { debug: (m, x) => log.debug(x, m), info: (m, x) => log.info(x, m), warn: (m, x) => log.warn(x, m), error: (m, x) => log.error(x, m) } });
```

The SDK never logs tokens, cookies, request bodies or query strings. Failures include OLX's validation messages, so you can see what to fix. For an audit trail of calls to OLX (method, path, status, timing), pass `requestLog: new FileRequestLog('logs/requests.jsonl')`.

## Running the REST service from your code

The REST service is also a library export. Start it with your own client, for example to keep links in your database instead of a JSON file:

```ts
import pg from 'pg';
import { createOlxClient } from 'olx-lebanon-sdk';
import { startServer } from 'olx-lebanon-sdk/server';
import { SqlSyncStore } from './sql-store.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN, store: new SqlSyncStore(pool) });

const server = await startServer({ client }); // port, API key and webhook from the environment
// …later: await server.stop()
```

Full file: [`examples/node/rest-service.ts`](../examples/node/rest-service.ts). Settings: [Configuration](configuration.md#environment-variables).

## CommonJS projects

The package is ESM only.

- **Node 22.12 and later** can `require('olx-lebanon-sdk')` directly.
- **Node 20 (and 22 before 22.12):** use `const { createOlxClient } = await import('olx-lebanon-sdk')` inside an async function, or switch the project to ESM (`"type": "module"`).
- **TypeScript** with `"module": "CommonJS"`: set `"module": "NodeNext"` (or `"Node16"`) and `"moduleResolution"` to match, so the dynamic import is kept as written.
