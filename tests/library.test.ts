import { describe, expect, it, vi } from 'vitest';
import * as sdk from '../src/index.js';
import { createOlxClient, OlxCatalog, type CreateOlxClientOptions } from '../src/index.js';
import { CatalogMapper, parseCatalog } from '../src/mapping/CatalogMapper.js';
import { RestListingSchema } from '../src/listings/types.js';
import { jsonResponse } from './helpers.js';

const USER = '8d3f5a6e-1b2c-4d5e-9f00-112233445566';
const AD = '117000001';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + 'a'.repeat(40) + '.sig';

/** A PNG header with the given size. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function mockOlx() {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push({
      method: init.method ?? 'GET',
      url: u.toString(),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    if (u.pathname === '/api/v1/user')
      return jsonResponse({ data: { externalID: USER, name: { en: 'Shop' }, phoneNumber: '+96170000000' } });
    if (u.pathname === '/api/images/get-signed-url/') {
      return jsonResponse({
        data: {
          url: `https://olx-lb-prod.s3.eu-central-1.amazonaws.com/temp/${u.searchParams.get('imageName')}.jpg?X-Amz-Signature=s`,
        },
      });
    }
    if (u.hostname.endsWith('amazonaws.com')) return new Response(null, { status: 200 });
    if (u.pathname === '/api/v1/post-ad') return jsonResponse({ data: { ad: { externalID: AD, id: 1 } } });
    if (u.pathname === `/api/v1/edit-ad/${AD}`)
      return jsonResponse({ data: { state: 'pending', ad: { externalID: AD, state: 'pending' } } });
    if (u.pathname === `/api/v1/ads/${AD}/delete`) return new Response(null, { status: 204 });
    if (u.pathname === '/api/v1/user/my-ads') {
      return jsonResponse({
        next: null,
        results: [{ id: 1, externalID: AD, state: 'active', photos: [{ id: 18000001 }, { id: 18000002 }] }],
      });
    }
    return new Response('nope', { status: 404 });
  });
  const imageFetch = vi.fn(async () => new Response(png(800, 600) as BodyInit, { headers: { 'content-type': 'image/png' } }));
  return {
    calls,
    fetch: fetch as unknown as typeof globalThis.fetch,
    imageFetch: imageFetch as unknown as typeof globalThis.fetch,
  };
}

const ad = {
  title: 'Dell Latitude 5440',
  description: '16 GB RAM, 512 GB SSD',
  price: 899,
  categoryId: '175',
  locationId: 47,
  attributes: { make: '3', type: '1', new_used: '1' },
  images: [{ url: 'https://shop.example/dell.png' }],
};

function client(extra: Partial<CreateOlxClientOptions> = {}) {
  const m = mockOlx();
  const olx = createOlxClient({
    accessToken: TOKEN,
    fetch: m.fetch,
    imageFetch: m.imageFetch,
    allowedImageHosts: ['shop.example'],
    writeLimits: { minIntervalMs: 0, jitterMs: 0 },
    ...extra,
  });
  return { olx, ...m };
}

describe('createOlxClient', () => {
  it('needs nothing but a token: built-in endpoints, no files', () => {
    const { olx } = client();
    expect(olx.missingEndpoints()).toEqual([]);
  });

  it('rejects ambiguous or malformed credentials', () => {
    expect(() => createOlxClient({ accessToken: TOKEN, session: { cookies: [], headers: {}, savedAt: '' } })).toThrow(/only one/);
    expect(() => createOlxClient({ accessToken: '  ' })).toThrow(/malformed/);
  });

  it('without a session, explains how to get a token', async () => {
    const olx = createOlxClient({ fetch: mockOlx().fetch });
    await expect(olx.ads.list()).rejects.toThrow(/accessToken/);
  });

  it('the main entry exposes the library, not the server or capture tools', () => {
    expect(typeof sdk.createOlxClient).toBe('function');
    expect('buildServer' in sdk).toBe(false);
    expect('summarizeHar' in sdk).toBe(false);
  });
});

describe('client.ads (OLX ids, no catalog)', () => {
  it('creates an ad with the token, raw ids and attributes, then reads its state', async () => {
    const { olx, calls } = client();
    const created = await olx.ads.create(ad);
    expect(created).toMatchObject({ id: AD, status: 'active' });

    const post = calls.find((c) => c.url.endsWith('/post-ad'))!;
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(post.body))).toMatchObject({
      category_id: '175',
      location_id: '47',
      user_external_id: USER,
      extra_fields: { make: '3', type: '1', new_used: '1', price: 899, price_type: 'price' },
      contact_person: { name: 'Shop', mobile_phone_number: '+96170000000' },
    });
  });

  it('update without images keeps the photos; with images replaces them', async () => {
    const { olx, calls } = client();
    const { images: _drop, ...noImages } = ad;
    await olx.ads.update(AD, { ...noImages, price: 849 });
    const keep = JSON.parse(String(calls.filter((c) => c.method === 'PATCH').at(-1)!.body)) as Record<string, unknown>;
    expect(keep).toMatchObject({ images: [], order_photos: [], extra_fields: { price: 849 } });
    expect(keep).not.toHaveProperty('deleted_photos');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await olx.ads.update(AD, { ...ad, price: 829 });
    const replace = JSON.parse(String(calls.filter((c) => c.method === 'PATCH').at(-1)!.body)) as Record<string, unknown>;
    expect(replace.deleted_photos).toEqual([18000001, 18000002]);
    expect(replace.order_photos).toEqual([expect.stringMatching(/^tmp_/)]);
  });

  it('deletes and lists', async () => {
    const { olx, calls } = client();
    await olx.ads.delete(AD);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `https://api-prod.olx-dubizzle.com/api/v1/ads/${AD}/delete` });
    const page = await olx.ads.list({ perPage: 10 });
    expect(page.ads.map((a) => a.id)).toEqual([AD]);
    expect(new URL(calls.at(-1)!.url).searchParams.get('per_page')).toBe('10');
  });

  it('validates before sending anything', async () => {
    const { olx, calls } = client();
    await expect(olx.ads.create({ ...ad, categoryId: 'laptops' })).rejects.toThrow(/not a numeric OLX category id/);
    await expect(olx.ads.create({ ...ad, locationId: undefined })).rejects.toThrow(/Give the location/);
    expect(calls).toEqual([]);
  });
});

describe('client.sync with OLX ids', () => {
  it('keeps one ad per product without a catalog file', async () => {
    const { olx } = client();
    const first = await olx.sync.upsert('SKU-1', ad);
    expect(first).toMatchObject({ action: 'created', record: { adId: AD } });
    expect((await olx.sync.upsert('SKU-1', ad)).action).toBe('unchanged');
    expect((await olx.sync.upsert('SKU-1', { ...ad, price: 850 })).action).toBe('updated');
  });
});

describe('ids or catalog keys', () => {
  const mapper = new CatalogMapper(
    parseCatalog({
      categories: { laptops: { olxCategoryId: '175', attributeMap: { brand: 'make' }, valueMap: { brand: { Dell: '3' } } } },
      locations: { hamra: { olxLocationId: '47' } },
    }),
  );
  const base = { title: 't', description: 'd', price: 10 };

  it('raw ids pass attributes through as OLX names', () => {
    expect(mapper.resolve({ ...base, categoryId: 175, locationId: '47', attributes: { make: '3' } })).toMatchObject({
      categoryId: '175',
      locationId: '47',
      attributes: { make: '3' },
    });
  });

  it('keys use the catalog; ids and keys can be mixed per field', () => {
    expect(mapper.resolve({ ...base, categoryKey: 'laptops', locationId: 47, attributes: { brand: 'dell' } })).toMatchObject({
      categoryId: '175',
      locationId: '47',
      attributes: { make: '3' },
    });
  });

  it('refuses both or neither', () => {
    expect(() => mapper.resolve({ ...base, categoryId: 175, categoryKey: 'laptops', locationId: 47 })).toThrow(/not both/);
    expect(() => mapper.resolve({ ...base, locationId: 47 })).toThrow(/Give the category/);
  });

  it('the REST schema accepts either form and numbers as ids', () => {
    const rest = { ...base, images: [] };
    expect(RestListingSchema.parse({ ...rest, categoryId: 175, locationId: '47' })).toMatchObject({
      categoryId: '175',
      locationId: '47',
    });
    expect(RestListingSchema.safeParse({ ...rest, categoryKey: 'x', locationKey: 'y' }).success).toBe(true);
    expect(RestListingSchema.safeParse({ ...rest, categoryKey: 'x', categoryId: 1, locationKey: 'y' }).success).toBe(false);
    expect(RestListingSchema.safeParse({ ...rest, locationKey: 'y' }).success).toBe(false);
    expect(RestListingSchema.safeParse({ ...rest, categoryId: 'abc', locationId: 1 }).success).toBe(false);
  });
});

describe('client.catalog', () => {
  const tree = [
    {
      id: 4,
      name: 'Electronics & Home Appliances',
      externalID: '20',
      level: 0,
      children: [{ id: 43, name: 'Laptops, Tablets, Computers', externalID: '175', level: 1, children: [] }],
    },
  ];
  const fields = {
    '175': {
      flatFields: [
        { attribute: 'price', name: 'Price', valueType: 'float', isMandatory: false, roles: [], minValue: 5, maxValue: 50000 },
        {
          attribute: 'make',
          name: 'Brand',
          valueType: 'enum',
          isMandatory: true,
          roles: [],
          choices: [{ value: '3', label: 'Dell' }],
        },
        { attribute: 'hot', name: 'Hot', valueType: 'enum', isMandatory: false, roles: ['exclude_from_post_an_ad'] },
      ],
    },
  };
  const fetch = vi.fn(async (url: string | URL | Request) =>
    String(url).includes('/categoryFields') ? jsonResponse(fields) : jsonResponse(tree),
  ) as unknown as typeof globalThis.fetch;

  it('finds postable categories and caches the tree', async () => {
    const catalog = new OlxCatalog({ fetch });
    expect((await catalog.findCategories('laptop')).map((c) => [c.id, c.path.join(' > ')])).toEqual([
      ['175', 'Electronics & Home Appliances > Laptops, Tablets, Computers'],
    ]);
    expect(await catalog.findCategories('electronics')).toEqual([]); // not a leaf
    await catalog.categories();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => !String(u).includes('Fields'))).toHaveLength(
      1,
    );
  });

  it("describes a category's fields, without the hidden ones", async () => {
    const f = await new OlxCatalog({ fetch }).fields(175);
    expect(f.map((x) => x.attribute)).toEqual(['price', 'make']);
    expect(f[1]).toMatchObject({ required: true, choices: [{ value: '3', label: 'Dell' }], filledFromPrice: false });
    expect(f[0]).toMatchObject({ min: 5, max: 50000, filledFromPrice: true });
  });

  it('looks up areas offline, ignoring case and accents; districts are not postable', () => {
    const catalog = new OlxCatalog();
    expect(catalog.locations('HAMRA').map((l) => l.id)).toContain('47');
    expect(catalog.location(47)).toMatchObject({ name: 'Hamra', path: ['Beirut', 'Hamra'], postable: true, level: 2 });
    expect(catalog.location(2)).toMatchObject({ name: 'Beirut', postable: false });
    expect(catalog.locations('beirut').every((l) => l.postable)).toBe(true);
    expect(catalog.locations().length).toBeGreaterThan(600);
  });
});

describe('OLX_ACCESS_TOKEN for the CLI and the REST service', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXZhbHVl';

  it('is used instead of the session file', async () => {
    const config = sdk.loadConfig({ OLX_ACCESS_TOKEN: token, OLX_SESSION_FILE: '/nonexistent/session.json' });
    const client = sdk.OlxClient.fromConfig(config, { requestLog: new sdk.MemoryRequestLog() });
    const status = await client.session.status();
    expect(status).toMatchObject({ loggedIn: true, savedAt: 'access-token', capturedHeaders: ['authorization'] });
  });

  it('accepts a "Bearer " prefix and rejects an empty or malformed value as invalid configuration', () => {
    expect(sdk.loadConfig({ OLX_ACCESS_TOKEN: `Bearer ${token}` }).accessToken).toBe(`Bearer ${token}`);
    expect(sdk.sessionFromAccessToken(`Bearer ${token}`).headers.authorization).toBe(`Bearer ${token}`);
    expect(() => sdk.loadConfig({ OLX_ACCESS_TOKEN: 'short' })).toThrow(/OLX_ACCESS_TOKEN looks empty or malformed/);
    expect(() => sdk.loadConfig({ OLX_ACCESS_TOKEN: 'a b c d e f g h i j k l m n' })).toThrow(/OLX_ACCESS_TOKEN/);
  });

  it('without it, the session file is used as before', async () => {
    const client = sdk.OlxClient.fromConfig(sdk.loadConfig({ OLX_SESSION_FILE: '/nonexistent/session.json' }), {
      requestLog: new sdk.MemoryRequestLog(),
    });
    expect((await client.session.status()).loggedIn).toBe(false);
  });
});

describe('package entry points', () => {
  it('resolve for import and for require() (Node 22.12+ loads ESM through require)', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { exports: Record<string, unknown> };
    for (const [entry, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue;
      expect(target, entry).toMatchObject({ types: expect.any(String), import: expect.any(String), default: expect.any(String) });
    }
  });
});

describe('checks before anything is sent', () => {
  const olx = createOlxClient({
    accessToken: 'x'.repeat(40),
    fetch: vi.fn(async () => jsonResponse({})) as unknown as typeof fetch,
  });
  const ad = { title: 'Laptop', description: 'New', price: 899, categoryId: '175', locationId: '47' };

  it("applies OLX's title, description and photo limits without a catalog", async () => {
    await expect(olx.ads.create({ ...ad, title: 'x'.repeat(71) })).rejects.toMatchObject({
      code: 'invalid_listing',
      issues: [expect.stringMatching(/OLX allows 70/)],
    });
    await expect(
      olx.ads.create({ ...ad, images: Array.from({ length: 21 }, (_, i) => ({ url: `https://a.example/${i}.jpg` })) }),
    ).rejects.toMatchObject({ code: 'invalid_listing' });
  });

  it('a missing photo file is image_upload_failed, naming the file', async () => {
    const { ImageUploader, placeholderAdapter } = sdk;
    const up = new ImageUploader({ http: {} as never, adapter: placeholderAdapter });
    await expect(up.upload({ path: '/nonexistent/photo.jpg' })).rejects.toMatchObject({
      code: 'image_upload_failed',
      message: expect.stringMatching(/photo\.jpg.*file not found/),
    });
  });
});

describe('configuration with malformed URLs', () => {
  it('reports them as invalid configuration instead of crashing', () => {
    expect(() => sdk.loadConfig({ WEBHOOK_URL: 'not a url', WEBHOOK_SECRET: 's'.repeat(20) })).toThrow(
      /Invalid configuration[\s\S]*WEBHOOK_URL/,
    );
    expect(() => sdk.loadConfig({ OLX_BASE_URL: '::::' })).toThrow(/Invalid configuration[\s\S]*OLX_BASE_URL/);
  });
});

describe('loadEnvFile', () => {
  it("reads a .env file with Node's parser, and real environment variables win", async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'olx-env-')), '.env');
    writeFileSync(file, 'SERVER_PORT=9000\nOLX_CONTACT_NAME="My Shop # 1"\nEMPTY=\nLOG_LEVEL=debug\n');
    const env: NodeJS.ProcessEnv = { LOG_LEVEL: 'warn' };
    expect(sdk.loadEnvFile(file, env)).toBe(true);
    expect(env).toEqual({ SERVER_PORT: '9000', OLX_CONTACT_NAME: 'My Shop # 1', EMPTY: '', LOG_LEVEL: 'warn' });
    expect(sdk.loadEnvFile(join(file, '..', 'missing.env'), env)).toBe(false);
  });
});

describe('listingDefaults and the sync fingerprint', () => {
  it('a new footer or default location changes the fingerprint, so the next sync edits the ad', () => {
    const ad = { title: 'Laptop', description: 'New', price: 899, categoryId: '175' };
    const fp = (listingDefaults: Record<string, unknown>) =>
      sdk.hashListing(ad, new CatalogMapper(parseCatalog({ listingDefaults })).resolve(ad));
    const base = fp({ locationId: '99' });
    expect(fp({ locationId: '99' })).toBe(base);
    expect(fp({ locationId: '99', descriptionFooter: 'Delivery all over Lebanon' })).not.toBe(base);
    expect(fp({ locationId: '47' })).not.toBe(base);
  });
});
