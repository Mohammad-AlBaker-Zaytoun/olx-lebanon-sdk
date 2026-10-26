import { readFileSync } from 'node:fs';
import { validate } from '@readme/openapi-parser';
import { describe, expect, it, vi } from 'vitest';
import {
  ImageUploadError,
  MappingError,
  OlxHttpError,
  ReconcileRequiredError,
  UncertainWriteError,
  toErrorInfo,
} from '../src/errors.js';
import { buildServer } from '../src/server/app.js';
import { openApiDocument } from '../src/server/openapi.js';
import { JobQueue } from '../src/server/queue.js';
import { MemorySyncStore } from '../src/sync/SyncStore.js';

const KEY = 'k'.repeat(32);
const auth = { 'x-api-key': KEY };

function server(handler: ConstructorParameters<typeof JobQueue>[0] = async () => ({ action: 'created' })) {
  const queue = new JobQueue(handler);
  const store = new MemorySyncStore();
  const app = buildServer({
    apiKey: KEY,
    queue,
    store,
    resolve: { link: vi.fn(), forget: vi.fn(async () => true) },
    status: async () => ({ ok: true }),
  });
  return { app, queue, store };
}

const listing = { title: 'Dell', description: 'Laptop', price: 899, categoryId: '175', locationId: 47 };

describe('REST /v1: one error shape', () => {
  it('every error is { error: { code, message, requestId } }, with the id in X-Request-Id', async () => {
    const { app } = server();
    const res = await app.inject({ method: 'GET', url: '/v1/status' });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error).toMatchObject({ code: 'unauthorized', message: expect.any(String) });
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it("echoes a caller's safe request id, and replaces an unsafe one", async () => {
    const { app } = server();
    const ok = await app.inject({ method: 'GET', url: '/v1/health', headers: { 'x-request-id': 'store-42.a' } });
    expect(ok.headers['x-request-id']).toBe('store-42.a');
    const bad = await app.inject({ method: 'GET', url: '/v1/health', headers: { 'x-request-id': 'a b<script>' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown routes and old unversioned paths are not_found (after auth)', async () => {
    const { app } = server();
    expect((await app.inject({ method: 'GET', url: '/v1/nope' })).statusCode).toBe(401);
    const old = await app.inject({ method: 'GET', url: '/listings', headers: auth });
    expect(old.statusCode).toBe(404);
    expect(old.json()).toMatchObject({ error: { code: 'not_found', message: expect.stringContaining('/v1') } });
  });

  it('validation errors list their issues with a path', async () => {
    const { app } = server();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/products/P1/listing',
      headers: auth,
      payload: { ...listing, locationId: 'beirut' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'invalid_listing', details: { issues: [expect.objectContaining({ path: 'locationId' })] } },
    });
  });

  it('bad JSON is bad_request; an oversized body is payload_too_large', async () => {
    const { app } = server();
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/products/P1/listing',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'bad_request' } });
    const big = await app.inject({
      method: 'PUT',
      url: '/v1/products/P1/listing',
      headers: auth,
      payload: { ...listing, description: 'x'.repeat(1_100_000) },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('accepts OLX ids in the listing body', async () => {
    const { app } = server();
    const res = await app.inject({ method: 'PUT', url: '/v1/products/P1/listing', headers: auth, payload: listing });
    expect(res.statusCode).toBe(202);
  });

  it('a failed job reports a stable error code and details', async () => {
    const { app, queue } = server(async () => {
      throw new OlxHttpError('createAd', 422, {
        message: 'Please select a more specific location.',
        errors: { location_id: ['Please select a more specific location.'] },
      });
    });
    const put = await app.inject({ method: 'PUT', url: '/v1/products/P1/listing', headers: auth, payload: listing });
    await queue.idle();
    const job = await app.inject({ method: 'GET', url: `/v1/jobs/${put.json<{ jobId: string }>().jobId}`, headers: auth });
    expect(job.json()).toMatchObject({
      status: 'failed',
      error: {
        code: 'olx_rejected',
        status: 422,
        details: { olxErrors: { location_id: ['Please select a more specific location.'] } },
      },
    });
  });
});

describe('toErrorInfo', () => {
  it('maps each SDK error to its code and useful details', () => {
    expect(toErrorInfo(new MappingError('bad', ['Title is empty']))).toEqual({
      code: 'invalid_listing',
      message: 'bad',
      details: { issues: ['Title is empty'] },
    });
    expect(toErrorInfo(new UncertainWriteError('createAd', 'timeout', { status: 502 }))).toMatchObject({
      code: 'outcome_unknown',
      status: 502,
    });
    expect(toErrorInfo(new ImageUploadError('no'))).toMatchObject({ code: 'image_upload_failed' });
    expect(toErrorInfo(new ReconcileRequiredError('P', 'ad_gone'))).toMatchObject({
      code: 'reconcile_required',
      details: { reason: 'ad_gone' },
    });
    expect(toErrorInfo(new Error('boom'))).toEqual({ code: 'internal_error', message: 'boom' });
  });

  it('every SDK error code is listed in the OpenAPI ErrorCode enum', () => {
    const enumCodes = openApiDocument.components.schemas.ErrorCode.enum as readonly string[];
    for (const e of [
      new MappingError('x'),
      new OlxHttpError('x', 400, {}),
      new UncertainWriteError('x', 'x'),
      new ImageUploadError('x'),
      new ReconcileRequiredError('p', 'ad_gone'),
    ]) {
      expect(enumCodes).toContain(e.code);
    }
  });
});

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await validate(structuredClone(openApiDocument) as never);
    expect(result.valid, JSON.stringify('errors' in result ? result.errors : [], null, 2)).toBe(true);
  });

  it('is served at /v1/openapi.json without a key', async () => {
    const { app } = server();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: '3.1.0', info: { version: openApiDocument.info.version } });
  });

  it('documents exactly the routes the service has', async () => {
    const { app } = server();
    for (const [path, item] of Object.entries(openApiDocument.paths)) {
      for (const method of Object.keys(item).filter((k) => ['get', 'put', 'post', 'delete'].includes(k))) {
        const url = path.replace('{productId}', 'P1').replace('{jobId}', 'missing');
        const res = await app.inject({
          method: method.toUpperCase() as 'GET',
          url,
          headers: auth,
          payload: method === 'get' || method === 'delete' ? undefined : {},
        });
        const body = res.json<{ error?: { message?: string } }>();
        // A missing route answers "No route …"; real routes answer anything else.
        expect(body.error?.message ?? '', `${method.toUpperCase()} ${path}`).not.toMatch(/^No route/);
      }
    }
  });

  it('every route the service has is documented', async () => {
    const { app } = server();
    await app.ready();
    // printRoutes draws a tree: "├── /v1/products/:productId/listing (GET, PUT)" then "│   └── /resolve (POST)".
    const stack: string[] = [];
    const actual = new Set<string>();
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const m = /^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?/.exec(line);
      if (!m) continue;
      const depth = m[1]!.length / 4;
      stack.length = depth;
      stack[depth] = m[2]!;
      const path = stack.join('').replace(/:(\w+)/g, '{$1}');
      for (const method of (m[3] ?? '').split(', ').filter((x) => x && x !== 'HEAD')) actual.add(`${method} ${path}`);
    }
    const documented = new Set(
      Object.entries(openApiDocument.paths).flatMap(([path, item]) =>
        Object.keys(item)
          .filter((k) => ['get', 'put', 'post', 'delete', 'patch'].includes(k))
          .map((k) => `${k.toUpperCase()} ${path}`),
      ),
    );
    expect([...actual].sort()).toEqual([...documented].sort());
  });

  it('the shipped openapi.json is up to date (run `npm run openapi`)', () => {
    expect(JSON.parse(readFileSync('openapi.json', 'utf8'))).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
  });
});

describe('internal errors', () => {
  it('are logged with the request id, and the caller only sees internal_error', async () => {
    const error = vi.fn();
    const app = buildServer({
      apiKey: KEY,
      queue: new JobQueue(async () => ({})),
      store: new MemorySyncStore(),
      resolve: { link: vi.fn(), forget: vi.fn() },
      status: async () => {
        throw new Error('database is down');
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: { ...auth, 'x-request-id': 'req-7' } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'internal_error', message: 'Internal error', requestId: 'req-7' } });
    expect(res.body).not.toContain('database is down');
    expect(error).toHaveBeenCalledWith(
      'Request failed',
      expect.objectContaining({ requestId: 'req-7', error: 'database is down' }),
    );
  });
});

describe('malformed listing bodies', () => {
  const bad: unknown[] = [
    { ...listing, images: [{ url: 'not a url' }] },
    { ...listing, images: [{ url: 'ftp://files.example/a.jpg' }] },
    { ...listing, images: [{ url: 'https://user:pass@cdn.example/a.jpg' }] },
    { ...listing, images: [{ path: '/etc/passwd' }] },
    { ...listing, images: Array.from({ length: 21 }, () => ({ url: 'https://cdn.example/a.jpg' })) },
    { ...listing, images: 'https://cdn.example/a.jpg' },
    { ...listing, price: 'free' },
    { ...listing, price: -1 },
    { ...listing, attributes: [1, 2] },
    { ...listing, attributes: { make: { nested: true } } },
    { ...listing, categoryId: '175', categoryKey: 'laptops' },
    { ...listing, locationId: 0 },
    { ...listing, title: '   ' },
    { ...listing, description: 'x'.repeat(20_001) },
    { ...listing, title: 'x'.repeat(1_001) },
    { ...listing, attributes: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`a${i}`, '1'])) },
    [],
    'text',
    null,
    42,
  ];

  it.each(bad.map((b) => [JSON.stringify(b).slice(0, 60), b]))('%s → 400 invalid_listing, never 500', async (_label, body) => {
    const { app } = server();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/products/P1/listing',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: expect.stringMatching(/^(invalid_listing|bad_request)$/) } });
  });
});
