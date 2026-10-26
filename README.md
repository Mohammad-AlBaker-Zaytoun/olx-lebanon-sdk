# olx-lebanon-sdk

Post, edit and delete **your own** ads on [OLX Lebanon](https://www.olx.com.lb) from Node.js and Next.js. A typed client, product sync with duplicate protection, catalog lookups, a CLI, and an optional REST service for PHP, Python, .NET and other backends.

OLX Lebanon runs on Dubizzle Group's platform and has no public API. This SDK does what the OLX website does when you post by hand, using your own signed-in account, so a store or app can list its products automatically.

> [!WARNING]
> **Unofficial — use at your own risk.** This project is not affiliated with, endorsed by, or supported by OLX, Dubizzle Group, or any of their affiliates. Automating an account may conflict with OLX's Terms of Use, and OLX can change its website at any time and break this tool. You alone are responsible for how you use it. See [Responsible use](#responsible-use).

```ts
import { createOlxClient } from 'olx-lebanon-sdk';

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN });

const ad = await olx.ads.create({
  title: 'Dell Latitude 5440',
  description: '16 GB RAM, 512 GB SSD, 1 year warranty',
  price: 899,                                          // USD
  categoryId: '175',                                   // Laptops, Tablets, Computers
  locationId: '47',                                    // Beirut > Hamra
  attributes: { make: '3', type: '1', new_used: '1' }, // Dell, Laptop, New
  images: [{ url: 'https://shop.example.com/dell-5440.jpg' }],
});
console.log(ad.id, ad.status); // "117146151" "active"
```

**[Documentation](docs/README.md)** · [Getting started](docs/getting-started.md) · [Next.js](docs/nextjs.md) · [Node.js](docs/node.md) · [REST service](docs/rest-api.md) · [API reference](docs/api-reference.md) · [Examples](examples)

## Features

- **Typed client.** Create, edit, delete and list your ads, with TypeScript types and editor docs for everything.
- **Product sync.** `sync.upsert(productId, ad)` keeps one ad per product: it posts once, edits in place, and skips unchanged products. Links live in your own database through a four-method store.
- **No duplicate ads.** Writes are never retried. When OLX's answer is lost, the product is parked for you to check instead of being posted again.
- **Human pace.** At least a minute between writes and at most 20 an hour by default, so the account behaves like a person.
- **Catalog lookups.** Categories, each category's fields and choices, and all 662 locations (with Arabic names, offline), to find ids or build your own forms.
- **Photos.** From URLs, local files or bytes. Re-uploaded only when they change, and downloaded with SSRF protection.
- **Stable error codes.** `invalid_listing`, `olx_rejected` (with OLX's field errors), `auth_failed`, `outcome_unknown`… The same codes in the library, the REST API and webhooks.
- **REST service and CLI.** `npx olx-lb serve` for any language, with an OpenAPI 3.1 contract, a job queue and signed webhooks. `npx olx-lb` also signs you in, looks up ids, and test-posts.

## Install

```bash
npm install olx-lebanon-sdk
```

Node.js 20 or newer, ESM, server-side only. In Next.js, use it in route handlers, server actions and server components with the Node.js runtime, not the Edge runtime.

## Sign in once

You sign in **by hand**, once, in a real browser window. Complete any code or CAPTCHA yourself; the SDK never automates those. Sign-in needs Playwright as a dev tool; your app doesn't.

```bash
npm install -D playwright && npx playwright install chromium
npx olx-lb login     # a browser opens: sign in to OLX, then press Enter in the terminal
npx olx-lb token     # prints the access token for OLX_ACCESS_TOKEN
```

The token lasts about a year. Treat it like your password: never commit it or send it to a browser. [More](docs/getting-started.md#2-sign-in-once-and-get-your-access-token)

## One ad per product

```ts
import { createOlxClient } from 'olx-lebanon-sdk';

const olx = createOlxClient({ accessToken: process.env.OLX_ACCESS_TOKEN, store: myDatabaseStore });

const { action, record } = await olx.sync.upsert('SKU-1042', adInput); // 'created' | 'updated' | 'unchanged'
await olx.sync.remove('SKU-1042');                                      // out of stock: the ad is deleted
```

The store is `get`, `set`, `delete` and `all` on your database; see the [SQL example](examples/stores/sql-store.ts) or [Prisma](docs/nextjs.md#using-prisma-or-drizzle). How sync, parking and pacing work: [Concepts](docs/concepts.md).

## Find ids

OLX's catalog is public, so no token is needed:

```bash
npx olx-lb catalog categories laptop    # 175  Electronics & Home Appliances > Laptops, Tablets, Computers
npx olx-lb catalog fields 175           # the form's fields and their values: make "3" = Dell…
npx olx-lb catalog locations hamra      # 47   Beirut > Hamra (ads need an area, not a district)
```

The same from code: `olx.catalog.findCategories('laptop')`, `olx.catalog.fields('175')`, `olx.catalog.locations('hamra')`.

## CLI

| Command | What it does |
| --- | --- |
| `olx-lb init` | Sets up a folder for the CLI and REST service: `.env` with a new API key, a catalog file, `.gitignore` entries |
| `olx-lb login` | Opens a browser to sign in by hand, then saves the session to `.olx-session/` |
| `olx-lb token` | Prints the access token for your app's environment variables |
| `olx-lb check [--product file.json]` | Read-only check of the session, the account, your newest ads, and how a product maps |
| `olx-lb catalog categories\|fields\|locations` | Category ids, a category's fields and choices, area ids. `--json` for scripts |
| `olx-lb test-post create\|edit\|delete` | Walks one test ad through posting, editing and deleting |
| `olx-lb serve` | Runs the REST service |
| `olx-lb capture [shapes]` | For maintainers: records the OLX website to follow a change ([guide](docs/ENDPOINT-CAPTURE.md)) |

`--help` on any command for details. Exit codes: `0` ok, `1` failed, `2` wrong usage.

## REST service for other languages

```bash
npx olx-lb init && npx olx-lb login && npx olx-lb serve    # http://127.0.0.1:8787
```

```bash
curl -X PUT http://127.0.0.1:8787/v1/products/SKU-1042/listing \
  -H "X-Api-Key: $OLX_SDK_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Dell Latitude 5440","description":"16 GB RAM","price":899,"categoryId":"175","locationId":"47","attributes":{"make":"3","type":"1","new_used":"1"}}'
# 202 {"jobId":"6f0c…","status":"queued"}
```

Your backend sends products; the service queues them, posts at a human pace, and reports each outcome by job status or signed webhook. Ready-made clients for [PHP](examples/rest/client.php) and [Python](examples/rest/client.py), and an [OpenAPI 3.1 document](openapi.json) for generating others. [REST guide](docs/rest-api.md)

## Status

Verified against live OLX Lebanon on 26 October 2026: creating an ad with a photo, editing it with the same photos (nothing re-uploaded) and with new ones (old ones removed), and deleting it.

- An edited ad goes back into OLX's review (`pending_review`) for a while, as edits made by hand do.
- Each account gets a limited number of free ads per category. Beyond that, an ad is created but hidden (`limited`) until you buy a package on OLX. The SDK never buys anything.
- OLX can change its website at any time. Validation errors carry OLX's own field messages, unknown answers to writes are never guessed at, and [a capture guide](docs/ENDPOINT-CAPTURE.md) shows what changed.

## Security

- Your **access token**, `.olx-session/` and the `.har` files in `captures/` give **full access to your OLX account**. They are git-ignored, and written owner-only on Linux and macOS. On Windows, keep the project in your own user folder. Never commit or share them.
- The files made *from* a capture (`.summary.txt`, `.shapes.txt`, `.public/`) mask ids, names, phone numbers, emails, free text and tokens so they can be shared, but skim them first.
- The session's cookies and auth header go only to the OLX domain and its subdomains, over https (an endpoint on another host gets them only if you set `sendSessionToForeignHost` for it). Redirects from OLX are never followed. Photos are uploaded only to OLX's own storage folder, and the session never goes with a download or upload.
- `session.json` keeps only OLX's cookies and storage. If you sign in with Google or Facebook, those sites' cookies are not saved.
- Locations ship with the SDK. Only the maintainer script `npm run update-locations` contacts OLX's location search, with the website's own read-only key from a capture, which is never printed or saved.
- Photo downloads refuse plain http and private or internal addresses unless you allow a host. Redirects are re-checked on every hop, and downloads stop at 10 MB. (Known limit: the address check and the download resolve DNS separately. On a server with internal services, allow only your image host.)
- The request log records method, path, status and timing only. Logs never contain tokens, cookies, request bodies or query strings; a failed job's log line includes OLX's validation message, which is what you need to fix the product.
- The REST service binds to `127.0.0.1`, checks its API key in constant time, accepts only URL photos, and never returns raw OLX responses or internal error details.

Found a security problem? Please report it privately to the maintainer rather than in a public issue.

## Responsible use

This tool exists so that a seller can manage **their own** listings without retyping them. Please keep it that way:

- Use it only with an account you own, for items you are actually selling.
- Keep posting human-paced. Don't lower the pacing defaults to post in bulk.
- Don't post duplicate or misleading ads. The sync layer is designed to edit, not repost.
- Never try to bypass CAPTCHAs, phone verification or other protections. Complete them yourself.
- Don't use it to scrape or redistribute other users' listings or personal data.
- If OLX offers an official API or partner feed for Lebanon, prefer that.

## Development

```bash
npm install
npm run typecheck    # the SDK and the examples
npm test
npm run build
npm run olx -- help  # the CLI from source
```

[CHANGELOG.md](CHANGELOG.md) lists what changed in each version. `npm run update-locations` refreshes the shipped locations, and `npm run openapi` regenerates `openapi.json` (maintainers).

## License

[MIT](LICENSE). The license covers this code only, and grants no rights to OLX's services, trademarks or content.
