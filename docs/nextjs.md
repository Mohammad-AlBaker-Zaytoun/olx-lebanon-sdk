# Next.js guide

Use the SDK inside your Next.js app (App Router) to publish products to OLX from your own admin pages or API. Tested with Next.js 15 (webpack) and 16 (Turbopack), with no extra configuration.

The complete files are in [`examples/nextjs`](../examples/nextjs). This page walks through them.

- [Set up](#set-up)
- [One client for the app](#one-client-for-the-app)
- [Turn a product into an ad](#turn-a-product-into-an-ad)
- [A route handler](#a-route-handler)
- [A server action](#a-server-action)
- [Lookups for your admin UI](#lookups-for-your-admin-ui)
- [Running on Vercel and other serverless hosts](#running-on-vercel-and-other-serverless-hosts)
- [Rules of thumb](#rules-of-thumb)

## Set up

```bash
npm install olx-lebanon-sdk server-only
npm install -D playwright && npx playwright install chromium   # only for the one-time sign-in
npx olx-lb login
npx olx-lb token
```

`.env.local`:

```bash
OLX_ACCESS_TOKEN=eyJhbGciOi…           # from `npx olx-lb token`; server-only, never NEXT_PUBLIC_
OLX_CONTACT_NAME=Your Store            # optional: the name buyers see (defaults to your OLX profile)
DATABASE_URL=postgres://…              # where product ↔ ad links are kept
ADMIN_API_KEY=…                        # if you use the example's simple route protection
```

Create the links table from the comment at the top of [`sql-store.ts`](../examples/stores/sql-store.ts), or use your ORM (see [Using Prisma or Drizzle](#using-prisma-or-drizzle)).

## One client for the app

Create the client once and import it wherever you need it. One client means one write pace and one place to configure.

```ts
// lib/olx.ts
import 'server-only';
import pg from 'pg';
import { createOlxClient, type OlxClient } from 'olx-lebanon-sdk';
import { SqlSyncStore } from './sql-store';

// Keep one client per process, also across hot reloads in `next dev`.
const globalForOlx = globalThis as unknown as { olx?: OlxClient; olxPool?: pg.Pool };
const pool = (globalForOlx.olxPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL }));

export const olx = (globalForOlx.olx ??= createOlxClient({
  accessToken: process.env.OLX_ACCESS_TOKEN,
  store: new SqlSyncStore(pool),
  contact: { name: process.env.OLX_CONTACT_NAME },
}));
```

`import 'server-only'` makes the build fail if a client component ever imports this file, so the token can't end up in browser code.

### Using Prisma or Drizzle

The store is four methods, so any database layer works. With Prisma and a model like

```prisma
model OlxLink {
  productId String   @id
  adId      String
  record    Json
  updatedAt DateTime @updatedAt
}
```

the store is:

```ts
import type { Prisma } from '@prisma/client';
import type { SyncRecord, SyncStore } from 'olx-lebanon-sdk';
import { prisma } from './prisma';

export const prismaSyncStore: SyncStore = {
  get: async (productId) => (await prisma.olxLink.findUnique({ where: { productId } }))?.record as unknown as SyncRecord | undefined,
  set: async (record) => {
    const data = { adId: record.adId, record: record as unknown as Prisma.InputJsonValue };
    await prisma.olxLink.upsert({ where: { productId: record.productId }, create: { productId: record.productId, ...data }, update: data });
  },
  delete: async (productId) => {
    await prisma.olxLink.deleteMany({ where: { productId } });
  },
  all: async () => (await prisma.olxLink.findMany()).map((r) => r.record as unknown as SyncRecord),
};
```

## Turn a product into an ad

Keep the mapping from your product to OLX's fields in one function. The ids come from `npx olx-lb catalog …` ([how](getting-started.md#3-find-the-ids-for-your-ad)).

```ts
// lib/products.ts (excerpt)
const MAKE = { Dell: '3', HP: '4', Lenovo: '6' } as const;   // `npx olx-lb catalog fields 175`
const CONDITION = { new: '1', used: '2' } as const;

export function toAdInput(p: Product): AdInput {
  return {
    title: p.name.slice(0, 70),          // OLX's limit
    description: p.description,
    price: p.price,                      // USD
    categoryId: '175',
    locationId: '47',
    attributes: { make: MAKE[p.brand], type: '1', new_used: CONDITION[p.condition] },
    images: p.imageUrls.map((url) => ({ url })),
  };
}
```

If many product types map to many categories, a [catalog](concepts.md#your-own-names-the-catalog) keeps the codes out of your code.

## A route handler

```ts
// app/api/products/[id]/olx/route.ts
import { OlxSdkError, toErrorInfo, type OlxErrorCode } from 'olx-lebanon-sdk';
import { isAdmin } from '@/lib/auth';
import { olx } from '@/lib/olx';
import { getProduct, toAdInput } from '@/lib/products';

export const runtime = 'nodejs';   // not 'edge'
export const maxDuration = 300;    // a write waits for its pacing slot and the photo uploads

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  if (!isAdmin(req)) return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  const { id } = await params;
  const product = await getProduct(id);
  if (!product) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  try {
    const result = await olx.sync.upsert(product.id, toAdInput(product));
    return Response.json({ action: result.action, adId: result.record.adId, status: result.record.status });
  } catch (err) {
    return errorResponse(err);
  }
}
```

`DELETE` and `errorResponse`, which turns the SDK's [error codes](errors.md) into HTTP statuses, are in the [full file](../examples/nextjs/app/api/products/%5Bid%5D/olx/route.ts).

**Protect these routes.** Anyone who can call them can post to your OLX account. The example checks a bearer key ([`lib/auth.ts`](../examples/nextjs/lib/auth.ts)); if your app has sign-in, check the user's role instead.

## A server action

For a "Publish on OLX" button in your admin pages:

```ts
// app/products/actions.ts
'use server';

import { toErrorInfo } from 'olx-lebanon-sdk';
import { olx } from '@/lib/olx';
import { getProduct, toAdInput } from '@/lib/products';

export async function publishToOlx(productId: string) {
  // Server actions are public endpoints: check that the user is staff here.
  const product = await getProduct(productId);
  if (!product) return { ok: false, code: 'not_found', message: 'No such product' } as const;
  try {
    const { record } = await olx.sync.upsert(product.id, toAdInput(product));
    return { ok: true, adId: record.adId, status: record.status } as const;
  } catch (err) {
    const { code, message } = toErrorInfo(err);
    return { ok: false, code, message } as const;
  }
}
```

Return plain objects from actions: an `Error` thrown from a server action loses its `code` on the way to the browser.

## Lookups for your admin UI

Locations ship with the SDK, so a search for a location picker costs nothing:

```ts
// app/api/olx/locations/route.ts
import { OlxCatalog } from 'olx-lebanon-sdk';

export const runtime = 'nodejs';
const catalog = new OlxCatalog();

export function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return Response.json([]);
  return Response.json(catalog.locations(q).slice(0, 20).map((l) => ({ id: l.id, label: l.path.join(' › '), labelAr: l.nameAr })));
}
```

`catalog.findCategories(text)` and `catalog.fields(id)` work the same way (they call OLX's public catalog and cache for an hour), so your form can offer exactly the choices OLX accepts.

## Running on Vercel and other serverless hosts

Serverless functions are short-lived, run many copies at once, and keep nothing in memory between requests. Three consequences:

1. **Use a database store.** The default memory store forgets every link when the function ends, so the next sync would post the product again.
2. **Pacing is per instance.** One instance waits a minute between its writes; two instances don't wait for each other. Publishing one product from a button is fine. For many products, don't loop over them in a request.
3. **Writes take time.** A create waits for its pacing slot, downloads and uploads the photos, then reads the status back. Allow a long `maxDuration`, and expect a minute or more when writes follow each other.

For bulk or scheduled syncing, move the writes out of request handlers:

- **A background job** (Vercel Cron, Inngest, Trigger.dev, a queue worker) that syncs changed products one by one. Give it a concurrency of 1, so there is a [single writer](concepts.md#one-writer-per-product).
- **The REST service** on a small always-on server. Your Next.js app calls `PUT /v1/products/:id/listing`, which answers at once with a job id, and the service works through the queue at a human pace. See [REST service](rest-api.md).

## Rules of thumb

- Server only: route handlers, server actions, server components, `runtime = 'nodejs'`.
- One client per process, reused.
- The token in a server-side environment variable or a server-only database document, never `NEXT_PUBLIC_…`. To connect or renew it from your admin pages, see [Connect an OLX account from your website](connect.md).
- A database store in production.
- One writer per product, and bulk work in the background.
- Branch on `err.code`, and show `toErrorInfo(err).details` to whoever fixes the product. See [Errors](errors.md).
