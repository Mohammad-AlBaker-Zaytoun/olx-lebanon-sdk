# OLX Connect

A small Chrome and Edge extension (Manifest V3) that lets **your own website's admin** get an OLX Lebanon access token: the admin clicks **Sign in with OLX**, allows it in the extension's window, signs in to OLX in a pop-up, and your page receives the token. The page side is [`olx-lebanon-sdk/connect`](../docs/connect.md#sign-in-with-olx-the-olx-connect-extension).

Unofficial: not affiliated with OLX or Dubizzle Group.

## The official build

| | |
| --- | --- |
| Extension id | `jaflmnbipbkjchpepkbkgfjjhkjnlfda` (fixed by [`key.pub`](key.pub); the same in every version) |
| Websites it answers | [`allowed-origins.txt`](allowed-origins.txt): `https://www.zaytounsolutions.com`, `https://zaytounsolutions.com` |
| Permissions | `cookies`, with host access to `https://*.olx.com.lb/*` only |

## Install it (load unpacked)

```bash
git clone https://github.com/Mohammad-AlBaker-Zaytoun/olx-lebanon-sdk.git
cd olx-lebanon-sdk
npm install
npm run build:extension      # writes extension/dist and prints the extension id
```

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension/dist` folder.
4. Check that the id shown is `jaflmnbipbkjchpepkbkgfjjhkjnlfda`.

Keep the folder where it is: Chrome loads the extension from it. To update, pull, build again and click the reload icon on the extension's card.

## Build it for another website

```bash
npm run build:extension -- --origins https://admin.example.com,https://example.com
```

Origins come from `--origins`, else `OLX_CONNECT_ALLOWED_ORIGINS`, else `allowed-origins.txt`. Each must be an exact origin: https, no path, no wildcard (`http://localhost:<port>` is allowed for development). A build only answers the origins it was built with; adding a site needs a new build.

A build for another website should have **its own id**, so it never collides with the official one. Make a key once and keep the private half safe (it is what lets you keep the id, for example in the Chrome Web Store):

```bash
openssl genrsa -out olx-connect.pem 2048      # private: never commit it (*.pem is git-ignored)
openssl rsa -in olx-connect.pem -pubout -outform DER | openssl base64 -A > olx-connect.pub
npm run build:extension -- --origins https://admin.example.com --key olx-connect.pub
```

The build prints the id; pass it to `requestOlxToken({ extensionId })` and `isOlxConnectAvailable({ extensionId })`.

## Publish it in the Chrome Web Store (optional)

An unlisted item lets your team install it with one click. The store refuses a first upload that has a `key` field, so build without it:

```bash
npm run build:extension -- --store      # writes extension/dist-store
```

Zip the *contents* of `extension/dist-store`. To try to keep the same id in the store, put the private key in the zip's root as `key.pem` for the first upload, and check the item id in the dashboard before you publish. If the store gives a different id, use that one in your site (`extensionId`) and replace `key.pub` with the public key from the dashboard's **Package › View public key**, so unpacked builds match it.

## How it works

The code is in [`src/`](src): `core.ts` holds the logic (tested in [`tests/connect.test.ts`](../tests/connect.test.ts)), `background.ts` wires it to Chrome, and `confirm.html` / `confirm.ts` are the confirmation window. The built files are not minified, so you can read what you install.

1. A page on an allowed origin opens a port and sends a request with a random nonce. Any other origin is answered `not_allowed` and nothing else happens.
2. The extension opens its confirmation window, naming the origin. Declining or closing it answers `cancelled`.
3. After **Allow**, it uses a valid OLX sign-in already in the browser, or opens `https://www.olx.com.lb/?login=true` in a pop-up and waits for OLX to set its `accessToken` cookie.
4. It accepts only a readable token that is valid for at least another minute, closes the pop-up, and answers that port with the token, the refresh token, the expiry and the account read from the token.
5. One request at a time (`busy` otherwise); the request ends after its timeout (default 5 minutes). Nothing is stored or logged.

`npm run build && npm run test:extension` checks the whole flow in Playwright's Chromium, with OLX replaced by a stub.

---

Made with ❤️ by [Zaytoun Solutions](https://www.zaytounsolutions.com) · [www.zaytounsolutions.com](https://www.zaytounsolutions.com)
