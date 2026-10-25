# Mapping OLX's endpoints from your own session

OLX Lebanon has no public API, so the SDK copies what the OLX website already does when **you** post an ad. This guide records that once and turns it into configuration.

Do this with **your own account**, and post **one real ad** you actually want listed, or delete it at the end.

## 1. Record a manual post

```bash
npm run capture
```

A Chromium window opens on OLX. In it:

1. Log in.
2. Post an ad by hand, with at least one photo, a category that has required fields (a phone, say), and a location.
3. Optional but very useful: edit that ad (change the price), then delete it.
4. Go back to the terminal and press Enter.

You get two files:

- `captures/olx-flow-<timestamp>.har`: the full recording, which you can open in Chrome DevTools → Network → Import HAR.
- `captures/olx-flow-<timestamp>.summary.txt`: the API-looking calls, with writes listed first and IDs collapsed to `{id}`.

> [!CAUTION]
> The HAR contains your password, cookies and tokens. `captures/` is git-ignored. Never commit it, upload it or paste it into an issue.

## 2. Identify each operation

In the summary, or in the DevTools Network tab with the HAR loaded, find:

| SDK endpoint | What to look for |
| --- | --- |
| `uploadImage` | A `POST` with a `multipart/form-data` body, fired as you add a photo. Note the **field name** of the file part. |
| `createAd` | The `POST` sent when you click "Post now". Its body carries your title, price and category. |
| `updateAd` | The `PUT`/`PATCH`/`POST` sent when you save an edit. The URL usually contains the ad id. |
| `deleteAd` | The call sent when you remove the ad. |
| `getAd` | A `GET` that returns a single ad's JSON, often on the "My ads" page or the ad page. |
| `listMyAds` | A `GET` that returns your list of ads ("My ads"). |

Category trees, attribute definitions and location lookups usually show up as `GET`s while you fill in the form. Those are where the IDs for step 4 come from.

## 3. Fill in `config/endpoints.json`

```json
{
  "uploadImage": { "method": "POST", "path": "https://<image-host>/<captured-path>" },
  "createAd":    { "method": "POST", "path": "/<captured-path>" },
  "updateAd":    { "method": "PUT",  "path": "/<captured-path>/{id}" },
  "deleteAd":    { "method": "DELETE", "path": "/<captured-path>/{id}" },
  "getAd":       { "method": "GET",  "path": "/<captured-path>/{id}" },
  "listMyAds":   { "method": "GET",  "path": "/<captured-path>" }
}
```

- `path` is relative to `OLX_BASE_URL`, or an absolute URL if the call goes to another host.
- `{id}` is replaced with the OLX ad id.
- Leave anything you didn't see as `null`. `GET /status` on the service shows what's mapped.

## 4. Fill in `config/catalog.json`

For each kind of product you sell, add a category entry:

- `olxCategoryId`: the category id from the `createAd` body.
- `requiredAttributes`: the fields the OLX form wouldn't let you skip, using your store's names.
- `attributeMap`: renames your names to OLX's field names (for example `"brand": "make"`).
- `defaults`: values to use when a product doesn't specify one.

Add your locations with their `olxLocationId` too. Also check `limits` (maximum title length, description length and image count) against what the form actually enforces. The example values are guesses.

## 5. Match the wire format: a custom adapter

Compare the captured `createAd` body with what `placeholderAdapter.buildAdPayload` produces. They will differ. Write your own adapter and pass it to the client:

```ts
import { OlxClient, loadConfig, placeholderAdapter, type OlxAdapter } from 'olx-lebanon-sdk';

const olxAdapter: OlxAdapter = {
  ...placeholderAdapter,
  imageFieldName: '<field name from the upload request>',
  buildAdPayload(listing, imageIds) {
    return {
      // shape this exactly like the captured createAd body
    };
  },
  parseAd(raw) {
    // read the real id / status / url fields from the captured response
    return placeholderAdapter.parseAd(raw);
  },
};

const client = OlxClient.fromConfig(loadConfig(), { adapter: olxAdapter });
```

Tip: put a trimmed, anonymised copy of the real request and response in a unit test, so you'll notice when OLX changes the format.

## 6. Check the auth mechanism

Open `.olx-session/session.json` (never share it) after `npm run login`:

- If `headers.authorization` (or similar) is present, the SDK replays it automatically.
- If the token lives only in `localStorage` (also saved there), add a header in your adapter flow. Alternatively, extend `captureHeaders` in `SessionManager` with the header name the web app actually sends.
- Some calls need a CSRF token from a cookie or a page. If writes return 403 while reads work, that's the usual cause.

## 7. Dry run

1. `npm run build && npm start`
2. `GET /status`: confirm `loggedIn: true` and the endpoints you mapped show as configured.
3. `PUT /products/TEST-1/listing` with one real product, then poll `GET /jobs/:id`.
4. Check the ad on OLX, then `DELETE /products/TEST-1/listing`.

## When it breaks

OLX will change things. Typical symptoms:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `AuthError` (401/403) on every call | Session expired | `npm run login` |
| `AuthError` only on writes | CSRF or new header | Recapture, then compare headers |
| `OlxHttpError` 400/422 on create | New required field or renamed attribute | Recapture, then update `catalog.json` or the adapter |
| 404 on a mapped endpoint | Path changed | Recapture, then update `endpoints.json` |

`logs/requests.jsonl` shows the status and timing of every call, which is usually enough to see which step changed.
