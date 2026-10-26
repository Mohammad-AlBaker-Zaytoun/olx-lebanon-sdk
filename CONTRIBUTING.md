# Contributing

Thanks for helping. Bug reports, fixes, docs and examples are all welcome. Please read [Responsible use](README.md#responsible-use) first: changes that help automate other people's accounts, post in bulk, or get around OLX's protections won't be accepted.

- [Reporting a bug](#reporting-a-bug)
- [Setting up](#setting-up)
- [Making a change](#making-a-change)
- [Tests](#tests)
- [When OLX changes its website](#when-olx-changes-its-website)
- [Project layout](#project-layout)
- [Releasing (maintainers)](#releasing-maintainers)

## Reporting a bug

Open an issue with the bug template. The most useful details are the SDK version (`npx olx-lb --version`), your Node.js version, how you use it (library, CLI, REST service), and the error's `code`, `message` and `details`.

**Never post** your access token, `.env`, anything from `.olx-session/`, or `.har` files from `captures/`: they give full access to your OLX account. The `.summary.txt` and `.shapes.txt` files from `olx-lb capture` are masked for sharing, but read them before you attach them.

Security problems go through a private report instead; see [SECURITY.md](SECURITY.md).

## Setting up

Node.js 20.19 or newer.

```bash
git clone <your fork>
cd olx-lebanon-sdk
npm install
npm run check        # typecheck, lint, format check and tests: what CI runs
```

If `npm install` leaves out dev dependencies, `NODE_ENV=production` is set in your shell; clear it for the install.

Useful scripts:

| Script | |
| --- | --- |
| `npm run typecheck` | The SDK, the tests and the examples |
| `npm run lint` / `npm run format` | ESLint / Prettier (`format:check` to only check) |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run build` | `dist/` |
| `npm run olx -- <command>` | The CLI from source, e.g. `npm run olx -- catalog locations hamra` |
| `npm run openapi` | Regenerates `openapi.json` after changing the REST API |
| `npm run update-locations` | Refreshes `src/data/locations.ts` from OLX (needs a capture) |

## Making a change

1. For anything bigger than a small fix, open an issue first, so we can agree on the approach.
2. Branch from `main`. Keep each pull request to one change.
3. Add or update tests. A bug fix starts with a test that fails without it.
4. Update the docs in `docs/` and the examples when behaviour or the API changes, and add a line to `CHANGELOG.md` under the next version.
5. Run `npm run check`.

Guidelines:

- **Public API.** Everything exported from `src/index.ts`, `src/server/exports.ts`, the error codes, the REST API under `/v1` and the CLI commands are public. Changing them needs a changelog entry, and breaking them needs a good reason.
- **Error codes are stable.** Add new codes rather than changing the meaning of existing ones, and list new ones in `OlxErrorCode`, the OpenAPI `ErrorCode` enum and `docs/errors.md`.
- **Writes are never retried,** and nothing may weaken duplicate protection or pacing defaults.
- **No secrets in logs.** Tokens, cookies, request bodies and query strings never go to logs, errors or the request log.
- **The main entry point loads only `zod`.** Keep Fastify, Playwright and the tools behind their own entry points.
- **Plain language** in messages and docs: say what happened and what to do.

## Tests

- Tests never call the live OLX website. Mock `fetch` (see `tests/helpers.ts`).
- Fixtures use neutral data: `example-store.test` hosts, made-up names, `+96170000000`-style numbers. Never real accounts, tokens or captures.
- The REST examples in `examples/rest/` run against a local service in `tests/examples-rest.test.ts` when PHP, Python and bash are installed; they are skipped otherwise.
- `tests/docs-links.test.ts` checks every relative link and anchor in the docs.

To check a change against the real OLX website, use your **own** account and `npx olx-lb test-post create|edit|delete`, which posts and removes one test ad. Don't post real listings while testing.

## When OLX changes its website

OLX has no public API, so a change on their side can break posting. [docs/ENDPOINT-CAPTURE.md](docs/ENDPOINT-CAPTURE.md) explains how to record the website with `olx-lb capture` and see what changed. In a pull request, include the relevant masked `.shapes.txt` excerpt, never the `.har` file.

## Project layout

```
src/
  index.ts            the library's public exports
  createClient.ts     createOlxClient()
  client.ts           OlxClient: wires everything together
  listings/           AdsApi, ListingsApi, photos, the OLX Lebanon wire format
  sync/               SyncService (one ad per product) and stores
  catalog/            OlxCatalog: categories, fields, locations
  mapping/            CatalogMapper: your names to OLX ids, validation
  http/               HTTP client, pacing
  session/            sessions, sign-in with Playwright
  server/             the REST service (olx-lebanon-sdk/server)
  cli/                olx-lb
  tools/              capture and HAR tools (olx-lebanon-sdk/tools)
  data/locations.ts   the shipped location snapshot
docs/                 user documentation
examples/             type-checked examples
tests/                Vitest
```

## Releasing (maintainers)

1. Update `version` in `package.json` and the heading in `CHANGELOG.md`.
2. `npm run check && npm run build && npm pack --dry-run`, and look at the file list.
3. Commit, then tag: `git tag v0.3.0 && git push origin v0.3.0`.
4. The release workflow checks that the tag matches `package.json`, runs every check, and publishes to npm with provenance. It needs npm trusted publishing set up for this repository (or an `NPM_TOKEN` secret).
5. Create the GitHub release from the tag, with the changelog section as notes.
