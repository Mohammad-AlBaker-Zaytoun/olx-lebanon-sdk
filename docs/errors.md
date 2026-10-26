# Errors

Errors from OLX calls, validation, photos and sync are `OlxSdkError`s with a stable `code`. (Programming mistakes, such as invalid options to `createOlxClient`, throw a `TypeError`, and errors from your own store pass through unchanged.) The same codes appear in REST job results and webhooks. Codes are part of the public API: they don't change in minor versions, while messages may be reworded at any time. Branch on `err.code`.

- [Handling errors](#handling-errors)
- [Codes](#codes)
- [REST-only codes](#rest-only-codes)
- [OLX's own validation messages](#olxs-own-validation-messages)

## Handling errors

```ts
import { OlxSdkError, toErrorInfo } from 'olx-lebanon-sdk';

try {
  await olx.sync.upsert(product.id, toAdInput(product));
} catch (err) {
  if (!(err instanceof OlxSdkError)) throw err; // a bug in your code, a database error…

  switch (err.code) {
    case 'invalid_listing':
    case 'olx_rejected':
      // The product needs fixing. Show the details to whoever edits products.
      return markProductInvalid(product.id, toErrorInfo(err).details);
    case 'auth_failed':
      // Every write will fail until someone signs in again: alert, and stop the batch.
      throw err;
    case 'reconcile_required':
      // Parked: someone must check My ads, then sync.link() or sync.forget().
      return flagForReview(product.id, err.message);
    default:
      // outcome_unknown, image_upload_failed…: log it, try again on the next run.
      log.warn('OLX sync failed', toErrorInfo(err));
  }
}
```

`toErrorInfo(err)` turns any error into a plain object, safe to log or return from an API:

```ts
{ code: 'olx_rejected', message: 'OLX returned HTTP 422 for "createAd"', status: 422,
  details: { olxMessage: 'Please select a more specific location.', olxErrors: { location_id: ['Please select a more specific location.'] } } }
```

Anything that isn't an SDK error becomes `{ code: 'internal_error', message }`. `toErrorInfo` never includes tokens, cookies or raw responses; `details.olxMessage` and `olxErrors` are OLX's validation messages only.

`instanceof` with the subclasses works too, and gives typed access to their fields (`OlxHttpError.status` and `.body`, `MappingError.issues`, `ReconcileRequiredError.reason`…).

## Codes

| `code` | Class | What happened | Safe to retry? | What to do |
| --- | --- | --- | --- | --- |
| `invalid_listing` | `MappingError` | The input failed validation before anything was sent. `details.issues` lists each problem ("Title is 83 characters; OLX allows 70"). | After fixing | Fix the product. |
| `olx_rejected` | `OlxHttpError` | OLX refused the request. `status` is OLX's HTTP status; `details.olxErrors` names the fields (see [below](#olxs-own-validation-messages)). Also a photo upload that OLX's storage refused (endpoint `signedUpload`). | After fixing | Fix the product. A 404 on edit means the ad is gone (`sync` marks the link `gone`). |
| `auth_failed` | `AuthError` | No session, or OLX rejected the token (401/403). | No | `npx olx-lb login`, then update `OLX_ACCESS_TOKEN`. |
| `outcome_unknown` | `UncertainWriteError` | A write was sent, but its answer was lost (timeout, 5xx, an answer that couldn't be read). The ad **may exist**. | **No** | Don't resend blindly. Check My ads. `sync` parks the product for you. |
| `image_upload_failed` | `ImageUploadError` | A photo couldn't be used: the file or download failed, it isn't a JPEG/PNG/WebP/GIF, it is over 10 MB, its URL isn't allowed, or the upload to OLX was cut off. The message says which photo. Nothing was posted. | Yes | Fix the photo if the message says so; otherwise retry. |
| `reconcile_required` | `ReconcileRequiredError` | `sync`: the product is parked (`details.reason: 'uncertain_create'`) or its ad was removed on OLX (`'ad_gone'`). | After resolving | `sync.link(productId, adId)` if the ad exists, `sync.forget(productId)` if not. |
| `link_conflict` | `LinkConflictError` | `sync.link` would replace a healthy link to another ad, or take an ad another product uses (`details.adId`, `details.otherProductId`). | — | Pass `{ replace: true }` if you mean it. |
| `healthy_link` | `ForgetConflictError` | `sync.forget` on a healthy link: the ad would stay live but unmanaged (`details.adId`). | — | Use `sync.remove` to take the ad down, or `{ force: true }`. |
| `endpoint_not_configured` | `EndpointNotConfiguredError` | A custom adapter needs an endpoint you didn't configure. | — | Only with custom `endpoints` / `adapter`. |
| `sdk_error` | `OlxSdkError` | Anything else the SDK refused, such as an invalid ad id or a failed catalog lookup. | Depends | Read the message. |

Two more codes are not SDK errors: `internal_error` (anything unexpected, such as a database error in your store; `toErrorInfo` gives it this code, and the REST service logs the message) and `cancelled` (a REST job dropped because the service stopped before it ran; send it again).

### Why writes are never retried automatically

Some reads (pages of My ads, the account details) are retried on network errors, 429 and 5xx; quick lookups and the catalog fail at once, and you can simply call again. Writes are never retried: if a create times out, OLX may have posted it, and a retry would post it twice. That is what `outcome_unknown` and parking are for.

## REST-only codes

The REST service adds codes for problems with the HTTP request itself; see [REST service: errors](rest-api.md#errors): `unauthorized`, `invalid_product_id`, `invalid_resolution`, `bad_request`, `not_found`, `payload_too_large`, `queue_full`, `shutting_down`.

## OLX's own validation messages

When OLX refuses an ad, its answer names the field. Common ones:

| `olxErrors` field | Typical message | Fix |
| --- | --- | --- |
| `location_id` | "Please select a more specific location." | You sent a district (Beirut). Send an area (Beirut > Hamra): `catalog.locations()` returns only areas. The SDK catches districts it knows as `invalid_listing` before sending. |
| `category_id` | — | Use a category without subcategories: `catalog.findCategories()` returns only those. |
| an attribute (`make`, `new_used`…) | required / invalid choice | Check `catalog.fields(categoryId)`: send a `value` from `choices`, not the label. |
| `price` | outside the allowed range | Each category has limits; `catalog.fields()` shows `min` / `max` on `price`. |
| `title`, `description` | too long | The SDK checks OLX's limits (70 and 4,096 characters) before sending. |

OLX's wording can change; the field names are the reliable part.
