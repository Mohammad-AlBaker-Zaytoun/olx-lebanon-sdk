# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. You'll get an answer within a week, and a fix or a plan within 30 days for confirmed issues. Credit is given in the release notes unless you'd rather not.

Include what you found, how to reproduce it, and what an attacker could do with it. Don't include real tokens or session files; a made-up value shows the problem just as well.

## Supported versions

Security fixes go into the latest release. Before 1.0, that is the latest minor version.

## In scope

- Leaking the access token, session cookies or other secrets: to logs, errors, the request log, webhooks, REST responses, or hosts other than OLX.
- The REST service: authentication bypass, reading local files, reaching internal networks through photo URLs (SSRF), crashing it with a request.
- Photo downloads: getting around the https, public-address or host checks, or the size and redirect limits.
- Anything that makes the SDK post an ad twice or post to the wrong account.
- Webhook signing that can be forged or replayed.

Known and documented: the photo download checks the address and then resolves DNS again to download, so a hostile DNS server could rebind between the two. On a server with internal services, set `OLX_IMAGE_HOSTS`.

## Out of scope

- OLX's own website and services: report those to OLX.
- Problems that need someone to already have your token, `.env`, `.olx-session/` or `.har` files. Those files are full access to your account by design; keep them private.
- Using the SDK against OLX's terms. See [Responsible use](README.md#responsible-use).

## Your own setup

- Keep the access token in a server-side secret, never in browser code or in git.
- Run the REST service on `127.0.0.1` or a private network, with a long random `SERVER_API_KEY`.
- Use a `WEBHOOK_SECRET` that differs from the API key, and verify signatures on the raw body.
- If a token may have leaked, change your OLX password (which signs out old sessions), then run `npx olx-lb login` again.
