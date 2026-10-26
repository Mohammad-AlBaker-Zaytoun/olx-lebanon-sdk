# API reference

Everything below is exported from `olx-lebanon-sdk` unless marked otherwise. All types are included; your editor shows the same descriptions on hover.

- [`createOlxClient(options)`](#createolxclientoptions)
- [`olx.ads`](#olxads)
- [`olx.sync`](#olxsync)
- [`olx.catalog` / `OlxCatalog`](#olxcatalog--olxcatalog)
- [`olx.account`](#olxaccount)
- [`olx.orders`](#olxorders)
- [Types](#types)
- [Stores](#stores)
- [Errors](#errors)
- [Logging](#logging)
- [`olx-lebanon-sdk/server`](#olx-lebanon-sdkserver)
- [`olx-lebanon-sdk/tools`](#olx-lebanon-sdktools)
- [Stability](#stability)

## `createOlxClient(options)`

```ts
function createOlxClient(options?: CreateOlxClientOptions): OlxClient;
```

Creates a client. Throws `TypeError` when more than one of `accessToken`, `session` and `sessionStore` is given, or when the token is clearly malformed. Options are listed in [Configuration](configuration.md#in-code-createolxclient-options).

Create one client per process and reuse it: it holds the write pace, the account cache and the catalog cache.

The client:

| Member | |
| --- | --- |
| `ads` | [`AdsApi`](#olxads): your ads by OLX id |
| `sync` | [`SyncService`](#olxsync): one ad per product |
| `catalog` | [`OlxCatalog`](#olxcatalog--olxcatalog): categories, fields, locations |
| `account` | [`AccountApi`](#olxaccount): profile, wallet, package offers (read only) |
| `orders` | [`OrdersApi`](#olxorders): OLX delivery orders (experimental) |
| `syncStore` | The `SyncStore` passed as `store` |
| `session` | `SessionManager`: `status()` → `{ loggedIn, savedAt?, cookieCount, capturedHeaders }`, `clear()` |
| `limiter` | `WriteRateLimiter`: `recentCount` (writes in the last hour) |
| `listings`, `http`, `mapper`, `adapter` | Lower layers, for advanced use and tests |

## `olx.ads`

Your ads by their OLX id. Nothing is stored on your side.

| Method | Returns | |
| --- | --- | --- |
| `create(ad: AdInput)` | `Promise<OlxAd>` | Posts a new ad. Its `status` is read from My ads right after. |
| `update(adId, ad: AdInput)` | `Promise<OlxAd>` | Replaces the ad's content (the whole ad). Without `images`, the ad keeps its photos; with `images`, they replace the old ones. |
| `delete(adId)` | `Promise<void>` | Removes the ad. |
| `list({ page?, perPage? })` | `Promise<{ ads: OlxAd[]; hasMore: boolean }>` | One page of My ads, newest first. `perPage` 1–50, default 20. |
| `find(adId, { maxPages? })` | `Promise<OlxAd \| undefined>` | Looks for one of your ads in My ads (up to 50 pages by default). |
| `status(adId, { maxPages? })` | `Promise<AdStatus \| undefined>` | Reads an ad's current status from My ads (up to 50 pages by default); `undefined` if it isn't there. |
| `deactivate(adId)` | `Promise<void>` | Takes the ad offline without deleting it (status `inactive`). |
| `republish(adId, ad: AdInput)` | `Promise<OlxAd>` | Brings back an `inactive` or `expired` ad with this content (the whole ad, as for `update`; without `images` the photos stay). |
| `markSold(adId, { soldOn })` | `Promise<void>` | Marks the ad as sold, `soldOn: 'olx'` or `'elsewhere'`. After that it can only be deleted. |
| `activate(adId)` | `Promise<ActivateResult>` | Puts a `limited` ad live with a free slot: `'activated'`, `'needs_package'` or `'not_limited'`. |
| `rejectionReason(adId)` | `Promise<RejectionReason \| undefined>` | Why OLX's review refused the ad: `{ message, messageAr?, rules }`, or `undefined` if there is none on file. |
| `metrics(adIds)` | `Promise<Record<string, AdMetrics>>` | Views and leads per ad id; ads OLX has no numbers for yet are left out. |
| `actions(ad)` | `AdAction[]` | What can be done with an ad in its status (also exported as `adActions`). See [Ad status](concepts.md#ad-status). |

`create`, `update`, `delete`, `deactivate`, `republish`, `markSold` and `activate` are writes: [paced](concepts.md#pacing) and never retried. The others are reads.

## `olx.sync`

One ad per product of yours. See [Concepts: product sync](concepts.md#product-sync).

| Method | Returns | |
| --- | --- | --- |
| `upsert(productId, input: ListingInput, { force? })` | `Promise<UpsertResult>` | Creates the product's ad, edits it, or does nothing if unchanged. `force: true` pushes unchanged content. |
| `remove(productId)` | `Promise<RemoveResult>` | Deletes the ad and the link. |
| `link(productId, adId, { replace? })` | `Promise<SyncRecord>` | Resolves a parked product whose ad exists, or adopts an ad posted another way. The next `upsert` pushes the current content to it. |
| `forget(productId, { force? })` | `Promise<boolean>` | Drops the link; the next `upsert` creates a new ad. Resolves `true` if there was a link. |
| `deactivate(productId)` | `Promise<SyncRecord>` | Takes the product's ad offline; the next `upsert` republishes it. |
| `activate(productId)` | `Promise<{ result: ActivateResult; record: SyncRecord }>` | Activates the product's `limited` ad. |
| `markSold(productId, soldOn)` | `Promise<SyncRecord>` | Marks the product's ad as sold. `upsert` then fails with `reason: 'ad_sold'` until you `forget` the link. |
| `refresh({ maxPages? })` | `Promise<RefreshResult>` | Re-reads every linked ad's status from My ads and stores the changes: `{ updated, missing, checked }`. Reads only. |
| `isBusy(productId)` | `boolean` | Whether a create for the product is running in this process. |

`upsert` on an `inactive` or `expired` ad republishes it (`action: 'republished'`), even when the content is unchanged. On a `sold` ad it throws `reconcile_required`. See [Ad lifecycle](concepts.md#ad-lifecycle).

```ts
type UpsertResult =
  | { action: 'created' | 'updated' | 'republished'; record: SyncRecord; ad: OlxAd }
  | { action: 'unchanged'; record: SyncRecord };

type RemoveResult = { action: 'deleted'; adId: string; alreadyGone?: boolean } | { action: 'not_found' };
```

Calls for the same product are serialized within the process. Product ids are your own strings (the REST service limits them to letters, digits and `. _ : -`).

## `olx.catalog` / `OlxCatalog`

OLX's public catalog. No token needed: `new OlxCatalog()` works on its own.

| Member | Returns | |
| --- | --- | --- |
| `categories()` | `Promise<Category[]>` | The category tree. Cached for an hour. |
| `findCategories(text?, { leavesOnly? })` | `Promise<Category[]>` | Categories whose name contains the text (accents and case ignored). Only categories that can hold ads, unless `leavesOnly: false`. |
| `category(id)` | `Promise<Category \| undefined>` | One category. |
| `fields(categoryId)` | `Promise<CategoryField[]>` | The posting form's fields for a category. Cached for an hour. |
| `locations(text?, { includeDistricts? })` | `Location[]` | Locations whose path or Arabic name matches. Areas only, unless `includeDistricts: true`. No network. |
| `location(id)` | `Location \| undefined` | One location. |
| `locationsTakenAt` | `string` | Date of the shipped location snapshot. |
| `exchangeRate()` | `Promise<{ base: 'USD'; lbp: number }>` | OLX's current USD → LBP rate. |
| `deliveryConfig()` | `Promise<DeliveryConfig>` | OLX delivery's limits: `maxPrice` (USD), `maxWeightKg`, `minDaysToShip`, `maxDaysToShip`. |

`new OlxCatalog({ fetch?, apiBase?, timeoutMs? })`.

## `olx.account`

Your account, read only: the SDK never buys or spends.

| Method | Returns | |
| --- | --- | --- |
| `profile()` | `Promise<AccountInfo>` | `{ externalId, name?, phone? }` of the signed-in account. |
| `wallet()` | `Promise<Wallet>` | `{ balance, nextExpiry? }`: prepaid credit in USD, and the amount that expires first. |
| `postingLimitOffers(categoryId)` | `Promise<PackageOffer[]>` | What OLX charges to post past the free limit in a category: `{ id, type, title?, name?, price, discountPrice?, items, benefits }`, prices in USD. |

## `olx.orders`

OLX delivery orders on your listings: buyers order through OLX, and you accept and ship. **Experimental:** mapped from the OLX website's code and not yet checked against real orders; fields beyond `id` and `status` are in `raw`.

| Method | Returns | |
| --- | --- | --- |
| `listings(status?)` | `Promise<SellingListing[]>` | Your listings with delivery orders, `'active'` (default) or `'archived'`: `{ id, title?, offers?, raw }`. |
| `forAd(adId, status?)` | `Promise<DeliveryOrder[]>` | The orders on one ad: `{ id, status?, raw }`. |
| `update(orderId, action)` | `Promise<void>` | `'accept'`, `'reject'`, `'cancel'`, `'out_for_delivery'` or `'delivered'`. A paced write. |

## Types

### `ListingInput` (alias `AdInput`)

| Field | Type | |
| --- | --- | --- |
| `title` | `string` | Required, up to 70 characters (OLX's limit, checked before sending). |
| `description` | `string` | Required, up to 4,096 characters. |
| `price` | `number` | In `currency`. |
| `currency` | `'USD' \| 'LBP'` | Default `USD`. |
| `categoryId` / `categoryKey` | `string \| number` / `string` | OLX's id, or a key from your catalog. Exactly one. |
| `locationId` / `locationKey` | `string \| number` / `string` | An area id, or a key from your catalog. One of them, or neither to use the catalog's `listingDefaults`. |
| `attributes` | `Record<string, string \| number \| boolean>` | The category's fields: OLX's names and values with `categoryId`, your names with `categoryKey`. |
| `images` | `ImageSource[]` | Up to 20. |

```ts
type ImageSource =
  | { url: string }
  | { path: string }
  | { data: Uint8Array; filename: string; contentType?: string };
```

### `OlxAd`

```ts
interface OlxAd {
  id: string;
  status: AdStatus;
  url?: string;
  title?: string;
  state?: string;          // OLX's own state, e.g. 'featured', 'moderation_soft_reject', 'disabled'
  promotion?: { type: 'featured' | 'elite'; pending: boolean };
  rejection?: 'soft' | 'hard';
  expiresAt?: string;      // ISO 8601
  raw: unknown; // OLX's own answer; may hold personal data, don't pass it to clients
}

type AdStatus =
  | 'active' | 'pending_review' | 'limited' | 'rejected' | 'expired'
  | 'inactive' | 'sold' | 'deleted' | 'unknown';

type AdAction = 'edit' | 'deactivate' | 'activate' | 'mark_sold' | 'republish' | 'delete' | 'rejection_reason';

interface AdMetrics {
  searchViews: number; views: number; storyViews: number; reelViews: number;
  phoneViews: number; chatLeads: number; whatsAppLeads: number; smsLeads: number; applyLeads: number;
  favorites: number;
  leads: number;           // phoneViews + chatLeads + whatsAppLeads + smsLeads + applyLeads
}
```

### `SyncRecord`

```ts
interface SyncRecord {
  productId: string;
  adId: string;            // empty while parked
  adUrl?: string;
  status: AdStatus;
  syncState?: 'creating' | 'needs_reconcile' | 'gone'; // absent: healthy
  contentHash: string;     // fingerprint of the content last sent
  imagesHash?: string;     // fingerprint of the photo list last sent
  createdAt: string;       // ISO 8601
  lastSyncedAt: string;
  lastError?: string;
}
```

Store records whole and return them unchanged; later versions may add fields.

### Catalog types

```ts
interface Category { id: string; name: string; path: string[]; isLeaf: boolean; children: Category[] }

interface CategoryField {
  attribute: string;               // the key in `attributes`
  label: string;
  type: 'enum' | 'float' | 'integer' | 'string' | 'boolean' | (string & {});
  required: boolean;
  choices: { value: string; label: string }[]; // send `value`
  min?: number; max?: number; minLength?: number; maxLength?: number;
  filledFromPrice: boolean;        // price fields, filled from `price` and `currency`
}

interface Location { id: string; name: string; nameAr?: string; level: number; path: string[]; postable: boolean }
```

## Stores

```ts
interface SyncStore {
  get(productId: string): Promise<SyncRecord | undefined>;
  set(record: SyncRecord): Promise<void>;
  delete(productId: string): Promise<void>;
  all(): Promise<SyncRecord[]>;
}
```

| Class | |
| --- | --- |
| `MemorySyncStore` | In memory. The default; for tests and trials. |
| `JsonFileSyncStore(path)` | A JSON file, written atomically. One process per file. |

A database example: [`examples/stores/sql-store.ts`](../examples/stores/sql-store.ts).

Sessions use the same pattern: `SessionStore` (`load`, `save`, `clear`), with `MemorySessionStore`, `FileSessionStore(path)`, and `sessionFromAccessToken(token)` to build a session from a token.

## Errors

`OlxSdkError` and its subclasses, each with a stable `code`; see [Errors](errors.md).

| Export | |
| --- | --- |
| `OlxSdkError` | Base class. `code: OlxErrorCode`. |
| `MappingError` | `invalid_listing`. `issues: string[]`. |
| `AuthError` | `auth_failed`. `status?`. |
| `OlxHttpError` | `olx_rejected`. `endpoint`, `status`, `body`. |
| `UncertainWriteError` | `outcome_unknown`. `endpoint`, `status?`. |
| `ImageUploadError` | `image_upload_failed`. |
| `ReconcileRequiredError` | `reconcile_required`. `productId`, `reason: 'uncertain_create' \| 'ad_gone'`. |
| `LinkConflictError` | `link_conflict`. `productId`, `currentAdId`, `otherProductId?`. |
| `ForgetConflictError` | `healthy_link`. `productId`, `currentAdId`. |
| `EndpointNotConfiguredError` | `endpoint_not_configured`. `endpoint`. |
| `toErrorInfo(err)` | `{ code, message, status?, details? }` for any thrown value. |
| `type OlxErrorCode`, `type ErrorInfo` | |

## Logging

| Export | |
| --- | --- |
| `type Logger` | `{ debug, info, warn, error }`, each `(message: string, meta?: Record<string, unknown>) => void`. |
| `createLogger(level?, sink?)` | JSON lines to stderr, or to `sink(line)`. |
| `silentLogger` | The default. |
| `FileRequestLog(path)`, `MemoryRequestLog` | `requestLog` implementations. |

## `olx-lebanon-sdk/server`

The REST service, for running it from your own code. It needs `fastify`, which is installed with the SDK, and is not loaded unless you import this entry point.

| Export | |
| --- | --- |
| `startServer({ client?, config?, logger?, handleSignals? })` | Starts the service and resolves `{ url, stop() }` once it listens. Settings come from `loadConfig()` (environment variables) unless `config` is given; pass `client` to use your own store. Stops cleanly on SIGINT/SIGTERM unless `handleSignals: false`. |
| `buildServer(deps)` | The Fastify app without listening, for embedding or tests. |
| `openApiDocument` | The OpenAPI 3.1 document (also `olx-lebanon-sdk/openapi.json`). |
| `JobQueue`, `QueueFullError`, `QueueStoppedError` | The one-at-a-time job queue. |
| `signWebhook(secret, timestamp, body)` | The webhook signature, for tests of your receiver. |
| `API_PREFIX` | `'/v1'`. |

Also from the main entry: `loadConfig(env?)` reads the [environment variables](configuration.md#environment-variables), and `OlxClient.fromConfig(config)` builds a client from them.

## `olx-lebanon-sdk/tools`

Maintainer tools for following OLX website changes: HAR summaries, body shapes, the catalog field reader. See [ENDPOINT-CAPTURE.md](ENDPOINT-CAPTURE.md). Not needed to use the SDK.

## Stability

The SDK follows [semantic versioning](https://semver.org) from 1.0. Before 1.0, minor versions may change the API, and the [changelog](../CHANGELOG.md) lists every change.

- **Stable:** `createOlxClient`, `ads`, `sync`, `catalog`, the types above, `SyncStore`, error classes and codes, `toErrorInfo`, the REST API under `/v1`, the CLI commands and their exit codes.
- **Advanced, may change in minor versions:** `listings`, `http`, `mapper`, `adapter`, `endpoints`, `OlxClient`'s constructor, and the `tools` entry point.
- **Not covered:** OLX itself. When OLX changes its website, a release follows the change, possibly with a new minor version.
