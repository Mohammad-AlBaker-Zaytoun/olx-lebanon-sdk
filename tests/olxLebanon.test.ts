import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OlxClient } from '../src/client.js';
import { parseEndpoints } from '../src/endpoints.js';
import type { Transport } from '../src/http/HttpClient.js';
import { normalizeStatus } from '../src/listings/adapter.js';
import { imageSize } from '../src/listings/imageSize.js';
import { OLX_LB_IMAGE_BASE, olxLebanonAdapter, olxLebanonBearer } from '../src/listings/olxLebanon.js';
import { parseCatalog, type MappedListing } from '../src/mapping/CatalogMapper.js';
import { preferCapturedHeader } from '../src/session/SessionManager.js';
import { MemorySessionStore, type SessionData } from '../src/session/storage.js';
import { MemorySyncStore } from '../src/sync/SyncStore.js';
import { fakeClock, jsonResponse } from './helpers.js';

// ------------------------------------------------------------------ fixtures (invented values)
const USER = '8d3f5a6e-1b2c-4d5e-9f00-112233445566';
const AD = '117000001';

/** A valid PNG header: signature + IHDR with the given size. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

const listing: MappedListing = {
  categoryId: '219',
  locationId: '2',
  title: 'Budgie pair',
  description: 'Healthy and friendly',
  price: 111,
  currency: 'USD',
  attributes: { species: '2', age_group: '2' },
};

const ctx = {
  mode: 'create' as const,
  account: { externalId: USER, name: 'Store', phone: '+96170000000' },
  contact: { name: 'Store', phone: '+96170000000', method: 'phone_and_chat' },
};

const photo = { id: 'a-b', url: OLX_LB_IMAGE_BASE + 'a-b', width: 2000, height: 1333 };

// ------------------------------------------------------------------ adapter
describe('olxLebanonAdapter: request bodies', () => {
  it('builds the post-ad body exactly like the web app', () => {
    expect(olxLebanonAdapter.buildAdPayload(listing, [photo], ctx)).toEqual({
      extra_fields: { species: '2', age_group: '2', price: 111, price_type: 'price' },
      contact_person: { name: 'Store', mobile_phone_number: '+96170000000', contact_method: 'phone_and_chat' },
      area: 0,
      user_external_id: USER,
      state: 'pending',
      source: 'nova',
      category_id: '219',
      images: [
        { id: null, external_id: 'a-b', image_name: 'a-b', order_index: 0, is_main: true, url: OLX_LB_IMAGE_BASE + 'a-b', width: 2000, height: 1333 },
      ],
      description: 'Healthy and friendly',
      videos: [],
      title: 'Budgie pair',
      location_id: '2',
    });
  });

  it('puts a Lebanese-pound price in secondary_price and keeps an explicit price_type', () => {
    const body = olxLebanonAdapter.buildAdPayload(
      { ...listing, currency: 'LBP', price: 9_000_000, attributes: { price_type: 'arranged', price: 5 } },
      [],
      ctx,
    ) as { extra_fields: Record<string, unknown> };
    expect(body.extra_fields).toEqual({ price_type: 'arranged', secondary_price: 9_000_000 });
  });

  it('builds the edit-ad body (no account id, state or source)', () => {
    const body = olxLebanonAdapter.buildAdPayload(listing, [photo], { ...ctx, mode: 'update', account: undefined });
    expect(body).toMatchObject({ order_photos: [], images: [expect.objectContaining({ image_name: 'a-b' })], category_id: '219' });
    expect(body).not.toHaveProperty('user_external_id');
    expect(body).not.toHaveProperty('state');
  });

  it('refuses to create without the account id', () => {
    expect(() => olxLebanonAdapter.buildAdPayload(listing, [], { ...ctx, account: undefined })).toThrow(/account id is unknown/);
  });
});

describe('olxLebanonAdapter: responses', () => {
  it('reads the 9-digit externalID from post-ad, not the internal id', () => {
    const ad = olxLebanonAdapter.parseAd({ status: 'OK', data: { ad: { externalID: AD, id: 5_000_001, categoryID: 25 } } });
    expect(ad).toMatchObject({ id: AD, status: 'unknown' });
  });

  it('reads the state from edit-ad', () => {
    const ad = olxLebanonAdapter.parseAd({ data: { state: 'limited', ad: { id: 5_000_001, externalID: AD, state: 'limited', title: 'x' } } });
    expect(ad).toMatchObject({ id: AD, status: 'limited', title: 'x' });
  });

  it('reads my-ads results', () => {
    const ads = olxLebanonAdapter.parseAdList({
      count: 2,
      results: [
        { id: 1, externalID: AD, state: 'active', title: 'a' },
        { id: 2, externalID: '117000002', state: 'limited', virtualState: 'limited' },
      ],
    });
    expect(ads.map((a) => [a.id, a.status])).toEqual([
      [AD, 'active'],
      ['117000002', 'limited'],
    ]);
  });

  it('reads the account, whatever shape the name has', () => {
    const parse = olxLebanonAdapter.parseAccount!;
    expect(parse({ data: { externalID: USER, name: 'Store', phoneNumber: '+9613' } })).toEqual({ externalId: USER, name: 'Store', phone: '+9613' });
    expect(parse({ data: { externalID: USER, name: { en: 'Store EN' }, first_name: null } }).name).toBe('Store EN');
    expect(parse({ data: { externalID: USER, name: { ar: 'متجر', en: 'Store EN' }, first_name: 'Mo', last_name: 'Z' } }).name).toBe('Store EN');
    expect(parse({ data: { externalID: USER, name: {}, first_name: 'Mo', last_name: 'Z' } }).name).toBe('Mo Z');
    expect(() => parse({ data: {} })).toThrow(/externalID/);
  });

  it('maps OLX states', () => {
    expect(normalizeStatus('limited')).toBe('limited');
    expect(normalizeStatus('pending')).toBe('pending_review');
    expect(normalizeStatus('active')).toBe('active');
  });
});

describe('olxLebanonAdapter: photo uploads', () => {
  const flow = olxLebanonAdapter.signedUpload!;

  it('names photos "<account id>-<uuid>", like the web app', () => {
    const name = flow.newImageName({ externalId: USER });
    expect(name.startsWith(USER + '-')).toBe(true);
    expect(name.slice(USER.length + 1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(flow.newImageName({ externalId: USER })).not.toBe(name);
    expect(flow.signQuery('n')).toEqual({ imageName: 'n' });
  });

  it('uses the stored file name from the upload URL (OLX adds .jpg)', () => {
    const info = { width: 1, height: 1, contentType: 'image/png' };
    const s3 = 'https://olx-lb-prod.s3.eu-central-1.amazonaws.com/temp/';
    expect(flow.toUploadedImage('n-1', { ...info, uploadUrl: `${s3}n-1.jpg?X-Amz-Signature=x` }).url).toBe(OLX_LB_IMAGE_BASE + 'n-1.jpg');
    expect(flow.toUploadedImage('n-1', { ...info, uploadUrl: `${s3}n-1.webp` }).url).toBe(OLX_LB_IMAGE_BASE + 'n-1.webp');
    // Anything unexpected in the URL falls back to the captured format.
    expect(flow.toUploadedImage('n-1', { ...info, uploadUrl: `${s3}other.jpg` }).url).toBe(OLX_LB_IMAGE_BASE + 'n-1.jpg');
  });

  it('only uploads to S3', () => {
    for (const ok of ['olx-lb-prod.s3.eu-central-1.amazonaws.com', 's3.eu-central-1.amazonaws.com', 'b.s3-eu-west-1.amazonaws.com']) {
      expect(flow.isAllowedUploadHost(ok)).toBe(true);
    }
    for (const bad of ['evil.com', 's3.amazonaws.com.evil.com', 'amazonaws.com', 'olx-lb-prod.s3.eu-central-1.amazonaws.co']) {
      expect(flow.isAllowedUploadHost(bad)).toBe(false);
    }
  });
});

describe('session token', () => {
  const base: SessionData = { cookies: [], headers: {}, savedAt: '' };
  const cookie = (value: string, domain = '.olx.com.lb') => ({ name: 'accessToken', value, domain, path: '/', expires: -1 });

  it('uses a captured Bearer header first', () => {
    expect(olxLebanonBearer({ ...base, headers: { authorization: 'Bearer abc' }, cookies: [cookie('zzz')] })).toBe('abc');
  });

  it('falls back to the accessToken cookie when the header is another scheme', () => {
    const token = jwt({ exp: 2_000_000_000 });
    expect(olxLebanonBearer({ ...base, headers: { authorization: 'Basic c2VhcmNo' }, cookies: [cookie(token)] }, 1_800_000_000)).toBe(token);
  });

  it('ignores an expired cookie and cookies of other sites', () => {
    expect(olxLebanonBearer({ ...base, cookies: [cookie(jwt({ exp: 100 }))] }, 200)).toBeUndefined();
    expect(olxLebanonBearer({ ...base, cookies: [cookie('x', '.evil.com')] })).toBeUndefined();
  });

  it('at login, never replaces a Bearer token with another scheme', () => {
    expect(preferCapturedHeader('authorization', 'Bearer a', 'Basic b')).toBe('Bearer a');
    expect(preferCapturedHeader('authorization', 'Basic b', 'Bearer a')).toBe('Bearer a');
    expect(preferCapturedHeader('authorization', undefined, 'Basic b')).toBe('Basic b');
    expect(preferCapturedHeader('x-csrf-token', 'a', 'b')).toBe('b');
  });
});

describe('imageSize', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    expect(imageSize(png(2000, 1333))).toEqual({ width: 2000, height: 1333, type: 'image/png' });
    expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]))).toEqual({ width: 320, height: 240, type: 'image/gif' });
    // SOI, an APP0 segment, then SOF0 with height 600 / width 800.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600, type: 'image/jpeg' });
    const webp = new Uint8Array(30);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24); // 800 x 600, stored minus one
    expect(imageSize(webp)).toEqual({ width: 800, height: 600, type: 'image/webp' });
  });

  it('returns undefined for anything else', () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageSize(new TextEncoder().encode('<html>'))).toBeUndefined();
  });
});

describe('catalog valueMap', () => {
  it('translates store values to OLX choice values, then renames the key', async () => {
    const { CatalogMapper } = await import('../src/mapping/CatalogMapper.js');
    const mapper = new CatalogMapper(
      parseCatalog({
        categories: { phones: { olxCategoryId: '9', attributeMap: { condition: 'new_used' }, valueMap: { condition: { new: '1', used: '2' } } } },
        locations: { beirut: { olxLocationId: '2' } },
      }),
    );
    const base = { title: 't', description: 'd', price: 1, categoryKey: 'phones', locationKey: 'beirut' };
    expect(mapper.resolve({ ...base, attributes: { condition: 'used', color: 'red' } }).attributes).toEqual({ new_used: '2', color: 'red' });
    expect(mapper.resolve({ ...base, attributes: { condition: 'refurbished' } }).attributes).toEqual({ new_used: 'refurbished' });
  });
});

// ------------------------------------------------------------------ end to end
describe('OLX Lebanon end to end (mocked OLX, shipped endpoints file)', () => {
  const endpoints = parseEndpoints(JSON.parse(readFileSync('config/endpoints.example.json', 'utf8')));
  const catalog = parseCatalog({
    categories: { birds: { olxCategoryId: '219', defaults: { species: '2' } } },
    locations: { beirut: { olxLocationId: '2' } },
  });
  const token = jwt({ exp: 4_000_000_000, aud: 'prod-api' });
  const session: SessionData = {
    cookies: [
      { name: 'accessToken', value: token, domain: '.olx.com.lb', path: '/', expires: -1, secure: true },
      { name: '_ga', value: 'GA1', domain: '.olx.com.lb', path: '/', expires: -1 },
    ],
    headers: { authorization: 'Basic c2VhcmNoLWtleQ==' }, // the search cluster's key, captured by mistake
    savedAt: '2026-10-26T00:00:00.000Z',
  };
  const product = {
    title: 'Budgie pair',
    description: 'Healthy and friendly',
    price: 111,
    categoryKey: 'birds',
    locationKey: 'beirut',
    images: [{ url: 'https://cdn.zaytoon.test/budgie.png' }],
  };

  function setup(opts: { uploadUrl?: string; state?: string; imageBytes?: Uint8Array } = {}) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const transport = vi.fn<Transport>(async (url, init) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: String(init.method), headers, body: init.body });
      const u = new URL(url);
      if (u.pathname === '/api/v1/user') {
        return jsonResponse({ status: 'OK', data: { externalID: USER, name: { ar: 'متجر زيتون', en: 'Zaytoon Store' }, phoneNumber: '+96170000000' } });
      }
      if (u.pathname === '/api/images/get-signed-url/') {
        const name = u.searchParams.get('imageName')!;
        return jsonResponse({ status: 'OK', data: { url: opts.uploadUrl ?? `https://olx-lb-prod.s3.eu-central-1.amazonaws.com/temp/${name}.jpg?X-Amz-Signature=s3cr3t`, fields: { Host: ['x'] } } });
      }
      if (u.hostname.endsWith('amazonaws.com')) return new Response(null, { status: 200 });
      if (u.pathname === '/api/v1/post-ad') {
        return jsonResponse({ status: 'OK', data: { ad: { externalID: AD, id: 5_000_001, categoryID: 25 }, next_page: { post: true } } });
      }
      if (u.pathname === '/api/v1/user/my-ads') {
        return jsonResponse({ count: 1, next: null, results: [{ id: 5_000_001, externalID: AD, state: opts.state ?? 'limited', title: 'Budgie pair' }] });
      }
      if (u.pathname === `/api/v1/edit-ad/${AD}`) {
        return jsonResponse({ status: 'OK', data: { state: 'active', ad: { externalID: AD, state: 'active' } } });
      }
      if (u.pathname === `/api/v1/ads/${AD}/delete`) return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    });
    const imageFetch = vi.fn(async () => new Response((opts.imageBytes ?? png(2000, 1333)) as BodyInit, { headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch;
    const client = new OlxClient({
      baseUrl: 'https://www.olx.com.lb',
      endpoints,
      catalog,
      sessionStore: new MemorySessionStore(session),
      syncStore: new MemorySyncStore(),
      writeLimits: { minIntervalMs: 0, jitterMs: 0, maxPerHour: 100 },
      clock: fakeClock(),
      transport,
      imageFetch,
      allowedImageHosts: ['zaytoon.test'],
    });
    return { client, calls };
  }

  it('creates the ad: account, signed URL, S3 upload, post-ad, then reads the state', async () => {
    const { client, calls } = setup();
    expect(client.missingEndpoints()).toEqual([]);

    const result = await client.sync.upsert('P-1', product);
    expect(result.action).toBe('created');
    expect(result.record).toMatchObject({ adId: AD, status: 'limited' });

    expect(calls.map((c) => `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}`)).toEqual([
      'GET api-prod.olx-dubizzle.com/api/v1/user',
      'GET www.olx.com.lb/api/images/get-signed-url/',
      `PUT olx-lb-prod.s3.eu-central-1.amazonaws.com/temp/${new URL(calls[1]!.url).searchParams.get('imageName')}.jpg`,
      'POST api-prod.olx-dubizzle.com/api/v1/post-ad',
      'GET api-prod.olx-dubizzle.com/api/v1/user/my-ads',
    ]);
    const [user, sign, put, post] = calls;

    // The user's token, from the accessToken cookie (the captured Basic key is not used).
    for (const c of [user!, sign!, post!]) expect(c.headers.authorization).toBe(`Bearer ${token}`);
    expect(user!.headers['accept-language']).toBe('en');
    // OLX cookies go to olx.com.lb only, never to the Dubizzle API or S3.
    expect(sign!.headers.cookie).toContain('accessToken=');
    expect(user!.headers.cookie).toBeUndefined();
    expect(post!.headers.cookie).toBeUndefined();
    // Nothing of the session goes to S3.
    expect(put!.headers).toEqual({ 'content-type': 'image/png' });
    expect(put!.body).toEqual(png(2000, 1333));

    const name = new URL(sign!.url).searchParams.get('imageName')!;
    expect(name).toMatch(new RegExp(`^${USER}-[0-9a-f-]{36}$`));
    expect(JSON.parse(String(post!.body))).toEqual({
      extra_fields: { species: '2', price: 111, price_type: 'price' },
      contact_person: { name: 'Zaytoon Store', mobile_phone_number: '+96170000000', contact_method: 'allow_chat_communication' },
      area: 0,
      user_external_id: USER,
      state: 'pending',
      source: 'nova',
      category_id: '219',
      images: [{ id: null, external_id: name, image_name: name, order_index: 0, is_main: true, url: `${OLX_LB_IMAGE_BASE}${name}.jpg`, width: 2000, height: 1333 }],
      description: 'Healthy and friendly',
      videos: [],
      title: 'Budgie pair',
      location_id: '2',
    });
  });

  it('edits in place with PATCH edit-ad/{externalID}, then deletes', async () => {
    const { client, calls } = setup();
    await client.sync.upsert('P-1', product);
    const updated = await client.sync.upsert('P-1', { ...product, price: 99 });
    expect(updated).toMatchObject({ action: 'updated', record: { adId: AD, status: 'active' } });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`https://api-prod.olx-dubizzle.com/api/v1/edit-ad/${AD}`);
    expect(JSON.parse(String(patch.body))).toMatchObject({ extra_fields: { price: 99 }, order_photos: [] });

    await client.sync.remove('P-1');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `https://api-prod.olx-dubizzle.com/api/v1/ads/${AD}/delete` });
    expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/v1/user'))).toHaveLength(1); // account read once
  });

  it('refuses an upload URL outside S3: nothing uploaded, no ad sent, product not parked', async () => {
    const { client, calls } = setup({ uploadUrl: 'https://evil.example/steal?x=1' });
    await expect(client.sync.upsert('P-1', product)).rejects.toThrow(/unexpected host/);
    expect(calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/post-ad'))).toBe(false);
    expect((await client.syncStore.get('P-1'))?.syncState).toBeUndefined();
  });

  it('fails before uploading anything when the product photo is not an image', async () => {
    // The store returns HTML labelled as a PNG.
    const { client, calls } = setup({ imageBytes: new TextEncoder().encode('<html>') });
    await expect(client.sync.upsert('P-1', product)).rejects.toThrow(/not a readable JPEG, PNG, WebP or GIF/);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/user']);
  });
});
