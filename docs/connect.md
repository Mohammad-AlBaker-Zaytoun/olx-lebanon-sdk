# Connect an OLX account from your website

Your app needs an OLX access token. `npx olx-lb login` and `npx olx-lb token` get one on a computer with Node.js. This guide is for when someone without that setup should be able to connect or renew the account from your website's admin:

- [Check a token before saving it](#check-a-token-before-saving-it): `inspectAccessToken` and `account.profile()`.
- [Let the client renew the token](#let-the-client-renew-the-token): the refresh token, `onSessionRefreshed`, a token read from your database.
- [Sign in with OLX: the OLX Connect extension](#sign-in-with-olx-the-olx-connect-extension): a button in your admin, a pop-up, a token.
- [Pairing: `olx-lb connect`](#pairing-olx-lb-connect): for browsers the extension doesn't cover.
- [What we know about OLX sign-in](#what-we-know-about-olx-sign-in).

In every case a person signs in by hand, completing any code or CAPTCHA themselves. Nothing here stores a password or signs in automatically.

## Check a token before saving it

```ts
import { createOlxClient, inspectAccessToken } from 'olx-lebanon-sdk';

const info = inspectAccessToken(pasted);
// { wellFormed: true, expiresAt: Date, issuedAt: Date, subject: 'a1b2…', name: 'Zaytoun Store' }
if (!info.wellFormed) throw new Error('That is not an OLX token');

// Proves OLX accepts it: the cheapest call there is.
const account = await createOlxClient({ accessToken: pasted }).account.profile();
```

`inspectAccessToken` reads the token without any network call and never throws: a malformed token gives `wellFormed: false` and `null` fields. `subject` is the account's public id (OLX's `externalID`, the same as `account.profile().externalId`), and `name` is the first and last name the token carries.

It proves nothing about whether OLX still accepts the token. `client.account.profile()` does: a token OLX rejects makes it throw an `OlxSdkError` with code `auth_failed`. Compare `account.externalId` with the account you had before: ads belong to the account that posted them.

## Let the client renew the token

An OLX sign-in comes with two tokens: the **access token** (valid about a year), which every call sends, and a **refresh token**, which the OLX website trades for a new access token. Give the client both and it renews the access token itself:

```ts
const olx = createOlxClient({
  accessToken: saved.accessToken,
  refreshToken: saved.refreshToken,
  onSessionRefreshed: async ({ accessToken, refreshToken, expiresAt }) => {
    await db.saveOlxTokens({ accessToken, refreshToken, expiresAt }); // save both
  },
});
```

- The client renews when the access token expires **within 30 days**, and after OLX rejects it (HTTP 401), at most once per call. A request rejected with 401 is sent again once with the new token: OLX did not process it, so this can't post anything twice.
- **One renewal at a time** per client: calls made meanwhile wait for it and use the new token.
- **Save both tokens** in `onSessionRefreshed`. OLX may answer with a new refresh token, and then the old one should be treated as used up. `onSessionRefreshed` is awaited; if it throws, the client keeps the new tokens and calls it again on the next request.
- A renewal that fails while the current token still works is not an error: calls carry on with the current token, `refresh.onFailed` is called, and the client tries again an hour later. Once the token has expired or OLX rejects it, a failed renewal is `auth_failed`: a person must sign in again.
- `client.session.refresh()` renews now (for a scheduled job, say) and returns the new pair.

Options, under `refresh`:

| Option | Default | |
| --- | --- | --- |
| `beforeExpiryDays` | `30` | Renew when the access token expires within this many days. |
| `afterDays` | off | Also renew once the access token is this many days old, e.g. `7`. See below. |
| `onFailed` | — | `(error: OlxSdkError) => void`, called when a renewal fails. |
| `authUrl` | `OLX_LB_AUTH_URL` | OLX's sign-in service. |

`refresh: false` turns renewal off. `refreshOlxTokens(refreshToken)` is the renewal on its own, for your own code.

How long OLX keeps a refresh token valid is not published. The OLX website only renews after a 401, and its sign-in cookies last at most 30 days. If renewing a nearly expired token turns out to fail because the refresh token was too old, set `afterDays: 7` so the refresh token is used every week.

### A token saved in your database

`accessToken` (and `refreshToken`) can be functions. The client calls them before each request, so a long-lived client picks up a token saved from your admin without being rebuilt:

```ts
const olx = createOlxClient({
  accessToken: async () => (await getOlxConnection()).accessToken, // cache inside: called on every request
  refreshToken: async () => (await getOlxConnection()).refreshToken,
  onSessionRefreshed: (tokens) => saveOlxConnection(tokens),
});
```

After a renewal the client keeps the new token until your function returns something else (normally the pair you just saved).

### Where the refresh token comes from

- **OLX Connect** returns it with the access token (`refreshToken`).
- **`olx-lb connect`** sends it to your website with the access token.
- **`npx olx-lb token --json`** prints `{ accessToken, refreshToken, expiresAt }` from the session `olx-lb login` saved.
- A session saved by `olx-lb login` carries it as a cookie, so the CLI and the REST service renew their own session (and save it back to `session.json`).

## Sign in with OLX: the OLX Connect extension

Your admin page can't read OLX's sign-in: the token lives in an olx.com.lb cookie that browsers keep away from other sites, and OLX offers no "Sign in with OLX". **OLX Connect** is a small Chrome and Edge extension that can read that cookie and hands it to your site, and only your site, when the person allows it.

1. The admin clicks **Sign in with OLX** on your site.
2. The extension checks that the asking site is one it was built for. Any other site gets nothing.
3. It shows its own window: "www.example.com is asking for your OLX access token. Allow?" The page can't click or skip it.
4. It opens OLX in a pop-up, on its sign-in dialog. The person signs in, completing any code or CAPTCHA themselves. If OLX is already signed in on that browser, it uses that sign-in instead (sign out on olx.com.lb first to use another account).
5. As soon as OLX sets a valid sign-in, it closes the pop-up and answers your page with the tokens.
6. Your page sends the token to your server, which checks and saves it.

### On your admin page

```ts
'use client';
import { isOlxConnectAvailable, requestOlxToken } from 'olx-lebanon-sdk/connect';

async function signInWithOlx() {
  const result = await requestOlxToken(); // from a click handler
  if (!result.ok) return showMessage(MESSAGES[result.reason]);
  // { token, refreshToken, expiresAt, account: { id, name } }
  await fetch('/api/admin/olx-connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await adminIdToken()}` },
    body: JSON.stringify({ token: result.token, refreshToken: result.refreshToken }),
  });
}

// Show the button only where it can work:
const { installed, version } = await isOlxConnectAvailable();
```

`olx-lebanon-sdk/connect` is browser-only (no Node.js imports) and never throws. `requestOlxToken` resolves `{ ok: true, token, refreshToken, expiresAt, account }` or `{ ok: false, reason }`:

| `reason` | |
| --- | --- |
| `not_installed` | The extension isn't installed in this browser, or isn't built for this site. Chrome doesn't let a site tell these apart. |
| `not_allowed` | The extension answered but refuses this site. |
| `cancelled` | The person declined, or closed the confirmation or the OLX pop-up (or `signal` was aborted). |
| `timeout` | No sign-in within `timeoutMs` (default 5 minutes; 5 s to 15 min). |
| `not_signed_in` | The pop-up was closed while OLX held only an expired or unreadable sign-in. |
| `busy` | Another request is already open in this browser. |

Options: `timeoutMs`, `signal` (an `AbortSignal`), and `extensionId` for your own build. The token is a full-access secret: send it to your server at once, never keep it in the browser, and check it there (`inspectAccessToken`, then `account.profile()`). `account` is read from the token itself; trust what `profile()` returns.

### Installing it

The official build answers `https://www.zaytounsolutions.com` and `https://zaytounsolutions.com`. Its extension id is **`jaflmnbipbkjchpepkbkgfjjhkjnlfda`** (`OLX_CONNECT_EXTENSION_ID`), and stays the same in every version.

```bash
npm run build:extension   # in a clone of this repository
```

Then in Chrome or Edge: open `chrome://extensions` (or `edge://extensions`), turn on Developer mode, click **Load unpacked**, and pick `extension/dist`. Details, other sites and the Chrome Web Store: [extension/README.md](../extension/README.md).

### Building it for your own site

```bash
npm run build:extension -- --origins https://admin.example.com --key my-extension.pub
```

Give exact origins (no wildcards; `http://localhost:<port>` is allowed for development). Use your own key, so your build has its own id, and pass that id to `requestOlxToken({ extensionId })`. [extension/README.md](../extension/README.md) shows how to make one.

### What the extension can and can't do

- Permissions: `cookies`, for `*.olx.com.lb` only. No content scripts, no access to other sites or to your tabs and history.
- It answers only the origins it was built with, checked on every request, and only the page that asked (matched by a random nonce).
- It asks before every hand-over, naming the site, in a window the site can't control.
- It never stores, logs or sends the token anywhere else, and never hands over an expired or unreadable token.
- It never types a password, solves a CAPTCHA or replays a sign-in.

### The messages, for other languages

A page opens a port with `chrome.runtime.connect(EXTENSION_ID, { name: 'olx-connect' })` and posts `{ type: 'olx-connect/request', v: 1, nonce, timeoutMs }`, then `{ type: 'olx-connect/keepalive', v: 1 }` every 20 seconds while it waits. The extension answers once on the same port: `{ type: 'olx-connect/result', v: 1, nonce, ok: true, token, refreshToken, expiresAt, account }` or `{ …, ok: false, reason }`. `chrome.runtime.sendMessage(EXTENSION_ID, { type: 'olx-connect/ping', v: 1 })` answers `{ ok: true, version }`. A port (rather than one message) keeps the extension awake while the person signs in.

## Pairing: `olx-lb connect`

For Firefox and Safari, or anyone without the extension: your admin shows a one-time code, and someone with Node.js runs

```bash
npx olx-lb connect https://www.example.com --code AB12CD34
```

It opens OLX in a browser window, as `olx-lb login` does. After the person signs in and presses Enter, it POSTs `{ code, token, refreshToken }` to `https://www.example.com/api/admin/olx-connection/pair` and prints the site's answer. Nothing is saved on that computer, and the token is never printed, so nobody copies a year-long secret through chat or email.

Your site's endpoint:

- Takes `{ code, token, refreshToken }` with no other credential: the code is the authority. Make codes random, single use, valid 10 minutes, rate limited, and compare them in constant time.
- Answers `{ ok: true, account: { name } }`, or `{ ok: false, reason }` with `code_invalid`, `code_expired` or `token_rejected`; `olx-lb connect` explains each one.
- The command sends only to https (http for localhost) and never follows a redirect, so the token can't be forwarded elsewhere.

## What we know about OLX sign-in

Checked against the OLX Lebanon website on 30 October 2026:

- The website keeps three cookies on `www.olx.com.lb`: `accessToken` (the token the API takes), `refreshToken` and `idToken`. All are `HttpOnly`, `Secure` and `SameSite=Lax`, so no page script can read them (this is why a bookmarklet can't work and the extension needs the `cookies` permission).
- The cookies expire at most 30 days after they are set, while the access token inside is valid for a year. OLX's API takes the token without any cookie, so it keeps working after the browser drops the cookie.
- The website renews with `POST https://auth-bridge-prod.olx-dubizzle.com/auth/refresh` and `{ refreshToken }`, and does so only after a 401.
- A renewal returns a new access token valid for a year from that moment **and a new refresh token**. The access token from before the renewal keeps working.
- Signing in again does not end earlier sign-ins: a token from an earlier sign-in kept working after a new one.
- olx.com.lb sends no `Cross-Origin-Opener-Policy` header.
- The access token is a JWT from `auth-bridge-service` with the account's id (`sub`), name and phone number. The name can be empty (it is for the store account we tested); `account.profile()` gives the name shown on ads.

Checked live with OLX Connect from `https://www.zaytounsolutions.com`: a sign-in by hand in the pop-up returned a token that `account.profile()` accepted, for the same account, and the pop-up closed by itself.

Not known yet: how long a refresh token stays valid, whether a refresh token still works after it has been used once (the SDK always keeps the newest), and whether OLX limits where a token is used from. The SDK is written to work either way.

---

Made with ❤️ by [Zaytoun Solutions](https://www.zaytounsolutions.com) · [www.zaytounsolutions.com](https://www.zaytounsolutions.com)
