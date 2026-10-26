# Examples

Every TypeScript example here is type-checked against the SDK on each change (`npm run typecheck`). The PHP, Python and shell clients are run against a local service in the test suite. Copy what you need into your app and replace `olx-lebanon-sdk` imports as they are; the relative imports between example files become your own paths (for example `@/lib/olx`).

| File | What it shows |
| --- | --- |
| [`node/first-ad.ts`](node/first-ad.ts) | Look up ids, post an ad, edit it, delete it |
| [`node/sync-products.ts`](node/sync-products.ts) | One ad per product from a script or cron job, with error handling by code |
| [`node/rest-service.ts`](node/rest-service.ts) | Run the REST service from code, with links in PostgreSQL |
| [`stores/sql-store.ts`](stores/sql-store.ts) | A `SyncStore` on a SQL table (PostgreSQL; notes for MySQL and SQL Server) |
| [`nextjs/lib/olx.ts`](nextjs/lib/olx.ts) | One client per process in a Next.js app |
| [`nextjs/lib/products.ts`](nextjs/lib/products.ts) | Turning your product into an ad |
| [`nextjs/lib/auth.ts`](nextjs/lib/auth.ts) | Keeping OLX routes staff-only |
| [`nextjs/app/api/products/[id]/olx/route.ts`](nextjs/app/api/products/%5Bid%5D/olx/route.ts) | Route handler: publish and remove, errors as HTTP statuses |
| [`nextjs/app/products/actions.ts`](nextjs/app/products/actions.ts) | Server action for a "Publish on OLX" button |
| [`nextjs/app/api/olx/locations/route.ts`](nextjs/app/api/olx/locations/route.ts) | A location search for your admin UI (no token, no network) |
| [`rest/curl.sh`](rest/curl.sh) | The REST service from the command line |
| [`rest/client.php`](rest/client.php) | PHP client (PHP 8.1+, curl extension) |
| [`rest/client.py`](rest/client.py) | Python client (3.8+, standard library only) |
| [`rest/webhook.php`](rest/webhook.php), [`rest/webhook.py`](rest/webhook.py) | Verifying signed job notifications |

The ids used throughout (`175` laptops, `47` Beirut > Hamra, `make: '3'` Dell) are real OLX Lebanon ids. Find your own with `npx olx-lb catalog …` or `olx.catalog` ([guide](../docs/getting-started.md#3-find-the-ids-for-your-ad)).
