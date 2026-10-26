/**
 * 0.4 features against a mocked OLX: deactivate / activate / mark sold / republish, rejection
 * reasons, metrics, account, orders, catalog extras, sync integration, and the state mapping.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MemorySyncStore,
  OlxCatalog,
  OlxClient,
  adActions,
  createOlxClient,
  loadConfig,
  olxLebanonState,
  type SyncRecord,
} from '../src/index.js';
import { jsonResponse } from './helpers.js';

const USER = '8d3f5a6e-1b2c-4d5e-9f00-112233445566';
const AD = '117000001';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + 'a'.repeat(40) + '.sig';

type Call = { method: string; url: URL; body?: unknown };

/** A mocked OLX: `myAds` is what "My ads" returns; `answers` overrides routes by "METHOD /path". */
function mockOlx(opts: { myAds?: Array<Record<string, unknown>>; answers?: Record<string, () => Response> } = {}) {
  const calls: Call[] = [];
  const myAds = opts.myAds ?? [{ externalID: AD, virtualState: 'active', photos: [{ id: 18000001 }] }];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const key = `${method} ${url.pathname.replace('/api/v1', '')}`;
    const custom = opts.answers?.[key];
    if (custom) return custom();
    if (key === 'GET /user')
      return jsonResponse({ data: { externalID: USER, name: { en: 'Shop' }, phoneNumber: '+96170000000' } });
    if (key === 'GET /user/my-ads') return jsonResponse({ next: null, results: myAds });
    if (key === `POST /ads/${AD}/deactivate`) return new Response(null, { status: 200 });
    if (key === `POST /ads/${AD}/mark-as-sold`) return new Response(null, { status: 200 });
    if (key === `POST /ads/${AD}/activate`)
      return jsonResponse({ status: 'OK', data: { message_code: 'ad_activated' }, messageCode: 'ad_activated' });
    if (key === `PATCH /republish-ad/${AD}`)
      return jsonResponse({ data: { state: 'moderation_pending', ad: { externalID: AD } } });
    if (key === `PATCH /edit-ad/${AD}`) return jsonResponse({ data: { state: 'pending', ad: { externalID: AD } } });
    if (key === '/post-ad' || key === 'POST /post-ad') return jsonResponse({ data: { ad: { externalID: AD } } });
    if (key === `POST /ads/${AD}/delete`) return new Response(null, { status: 204 });
    if (key === `GET /ads/${AD}/rejection-reason`)
      return jsonResponse({
        status: 'OK',
        data: {
          longMessage: 'Photos must show the item',
          longMessage_l1: 'يجب أن تظهر الصور المنتج',
          rules: ['No stock photos'],
        },
        messageCode: 'rejection_reason',
      });
    if (key === 'GET /user/ads-analytics') {
      const ids = url.searchParams.getAll('ads_ids[]');
      return jsonResponse({
        status: 'OK',
        data: Object.fromEntries(
          ids.map((id) => [
            id,
            {
              searchCount: 40,
              viewCount: 12,
              phoneViewCount: 3,
              chatLeadsCount: 2,
              whatsAppLeadsCount: 1,
              smsLeadsCount: 0,
              applyLeadCount: 0,
              favoriteCount: 5,
            },
          ]),
        ),
      });
    }
    if (key === 'GET /user/wallet')
      return jsonResponse({
        status: 'OK',
        data: { balance: 12.5, firstAmountToExpire: { remainingValue: 10, expiresAt: '2026-12-01T00:00:00Z' } },
      });
    if (key === 'GET /package-offers/posting/limit/9')
      return jsonResponse({
        status: 'OK',
        data: [
          {
            title: 'Post more ads',
            packageType: 'limit_featured',
            offers: [
              {
                items: [
                  {
                    packageOfferExternalId: '58710',
                    price: 52,
                    discountPrice: 0,
                    benefits: ['1 extra ad'],
                    productPackage: { name: 'Featured', productItems: [{ type: 'ad_limit_bump' }, { type: 'featured_ad' }] },
                  },
                ],
              },
            ],
          },
        ],
      });
    if (key === 'GET /selling-orders')
      return jsonResponse({ status: 'OK', data: [{ externalID: AD, title: 'Laptop', deliveryOffersCount: 2 }] });
    if (key === `GET /selling-orders/${AD}`)
      return jsonResponse({ status: 'OK', data: [{ externalID: 'ORD-1', status: 'new' }] });
    if (key === 'POST /delivery-orders/ORD-1/update-status/accept') return new Response(null, { status: 200 });
    if (key === 'GET /exchange-rate') return jsonResponse({ status: 'OK', data: { base: 'USD', rates: { LBP: 89500 } } });
    if (key === 'GET /delivery-config')
      return jsonResponse({ maxPrice: 3000, maxWeight: 40, maxTimeToShipInDays: 3, minTimeToShipInDays: 2 });
    return new Response('nope', { status: 404 });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

function client(o: Parameters<typeof mockOlx>[0] = {}, store = new MemorySyncStore()) {
  const m = mockOlx(o);
  const olx = createOlxClient({ accessToken: TOKEN, fetch: m.fetch, store, writeLimits: { minIntervalMs: 0, jitterMs: 0 } });
  return { olx, store, ...m };
}

const listing = { title: 'Dell Latitude 5440', description: '16 GB RAM', price: 899, categoryId: '175', locationId: '47' };

describe('OLX Lebanon states', () => {
  it.each([
    ['active', { status: 'active' }],
    ['featured', { status: 'active', promotion: { type: 'featured', pending: false } }],
    ['elite_pending', { status: 'active', promotion: { type: 'elite', pending: true } }],
    ['disabled', { status: 'inactive' }],
    ['sold', { status: 'sold' }],
    ['expired', { status: 'expired' }],
    ['limited', { status: 'limited' }],
    ['moderation_pending', { status: 'pending_review' }],
    ['moderation_soft_reject', { status: 'rejected', rejection: 'soft' }],
    ['moderation_critical_reject', { status: 'rejected', rejection: 'hard' }],
  ])('%s', (state, expected) => {
    expect(olxLebanonState(state)).toEqual(expected);
  });

  it('My ads exposes state, promotion and expiry', async () => {
    const { olx } = client({ myAds: [{ externalID: AD, virtualState: 'featured', expiresAt: 1798761600 }] });
    expect(await olx.ads.find(AD)).toMatchObject({
      status: 'active',
      state: 'featured',
      promotion: { type: 'featured', pending: false },
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('adActions follows the website: what each status allows', () => {
    expect(adActions({ status: 'active' })).toEqual(['edit', 'deactivate', 'mark_sold', 'delete']);
    expect(adActions({ status: 'inactive' })).toEqual(['republish', 'delete']);
    expect(adActions({ status: 'expired' })).toContain('republish');
    expect(adActions({ status: 'limited' })[0]).toBe('activate');
    expect(adActions({ status: 'sold' })).toEqual(['delete']);
    expect(adActions({ status: 'rejected', rejection: 'soft' })).toEqual(['edit', 'rejection_reason', 'delete']);
    expect(adActions({ status: 'rejected', rejection: 'hard' })).toEqual(['rejection_reason', 'delete']);
  });
});

describe('olx.ads actions', () => {
  it('deactivate, activate and markSold send what the website sends', async () => {
    const { olx, calls } = client();
    await olx.ads.deactivate(AD);
    expect(await olx.ads.activate(AD)).toBe('activated');
    await olx.ads.markSold(AD, { soldOn: 'olx' });
    await olx.ads.markSold(AD, { soldOn: 'elsewhere' });
    const writes = calls.filter((c) => c.method === 'POST').map((c) => [c.url.pathname.replace('/api/v1', ''), c.body]);
    expect(writes).toEqual([
      [`/ads/${AD}/deactivate`, undefined],
      [`/ads/${AD}/activate`, undefined],
      [`/ads/${AD}/mark-as-sold`, { reason: 'sold', soldType: 'inside' }],
      [`/ads/${AD}/mark-as-sold`, { reason: 'sold', soldType: 'outside' }],
    ]);
  });

  it('every new write is paced like the others', async () => {
    const m = mockOlx();
    const olx = createOlxClient({
      accessToken: TOKEN,
      fetch: m.fetch,
      writeLimits: { minIntervalMs: 0, jitterMs: 0, maxPerHour: 1000 },
    });
    await olx.ads.deactivate(AD);
    await olx.ads.markSold(AD, { soldOn: 'olx' });
    expect(olx.limiter.recentCount).toBe(2);
  });

  it('markSold insists on soldOn', async () => {
    const { olx, calls } = client();
    await expect(olx.ads.markSold(AD, {} as never)).rejects.toThrow(/soldOn/);
    expect(calls).toHaveLength(0);
  });

  it('activate reports needs_package and not_limited, and falls back to the ad state', async () => {
    const needs = client({
      answers: {
        [`POST /ads/${AD}/activate`]: () =>
          jsonResponse({ status: 'OK', data: { message_code: 'ad_not_eligible_for_free_quota' } }),
      },
    });
    expect(await needs.olx.ads.activate(AD)).toBe('needs_package');
    const notLimited = client({
      answers: { [`POST /ads/${AD}/activate`]: () => jsonResponse({ messageCode: 'ad_not_limited' }) },
    });
    expect(await notLimited.olx.ads.activate(AD)).toBe('not_limited');
    const unreadable = client({ answers: { [`POST /ads/${AD}/activate`]: () => jsonResponse({}) } });
    expect(await unreadable.olx.ads.activate(AD)).toBe('activated'); // My ads says active
  });

  it('republish sends the edit body to republish-ad, keeping photos without images', async () => {
    const { olx, calls } = client({ myAds: [{ externalID: AD, virtualState: 'disabled', photos: [{ id: 1 }] }] });
    const ad = await olx.ads.republish(AD, listing);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url.pathname).toBe(`/api/v1/republish-ad/${AD}`);
    expect(patch.body).toMatchObject({ category_id: '175', location_id: '47', images: [], order_photos: [] });
    expect(ad.status).toBe('pending_review');
  });

  it('rejectionReason reads the message, and is undefined when OLX has none', async () => {
    const { olx } = client();
    expect(await olx.ads.rejectionReason(AD)).toEqual({
      message: 'Photos must show the item',
      messageAr: 'يجب أن تظهر الصور المنتج',
      rules: ['No stock photos'],
    });
    const none = client({
      answers: {
        [`GET /ads/${AD}/rejection-reason`]: () =>
          jsonResponse({ status: 'OK', data: { longMessage: 'x', rules: [] }, messageCode: 'rejection_reason_not_found' }),
      },
    });
    expect(await none.olx.ads.rejectionReason(AD)).toBeUndefined();
  });

  it('metrics: one call per 50 ids with repeated ads_ids[], leads summed', async () => {
    const { olx, calls } = client();
    const ids = Array.from({ length: 51 }, (_, i) => String(117000000 + i));
    const metrics = await olx.ads.metrics([...ids, ids[0]!]);
    expect(Object.keys(metrics)).toHaveLength(51);
    expect(metrics[ids[0]!]).toEqual({
      searchViews: 40,
      views: 12,
      storyViews: 0,
      reelViews: 0,
      phoneViews: 3,
      chatLeads: 2,
      whatsAppLeads: 1,
      smsLeads: 0,
      applyLeads: 0,
      favorites: 5,
      leads: 6,
    });
    const reads = calls.filter((c) => c.url.pathname.endsWith('/ads-analytics'));
    expect(reads.map((c) => c.url.searchParams.getAll('ads_ids[]').length)).toEqual([50, 1]);
    expect(olx.limiter.recentCount).toBe(0); // reads aren't paced
  });
});

describe('olx.account, olx.orders, catalog extras', () => {
  it('wallet and posting-limit offers', async () => {
    const { olx } = client();
    expect(await olx.account.wallet()).toEqual({ balance: 12.5, nextExpiry: { amount: 10, expiresAt: '2026-12-01T00:00:00Z' } });
    expect(await olx.account.postingLimitOffers(9)).toEqual([
      {
        id: '58710',
        type: 'limit_featured',
        title: 'Post more ads',
        name: 'Featured',
        price: 52,
        items: ['ad_limit_bump', 'featured_ad'],
        benefits: ['1 extra ad'],
      },
    ]);
    expect((await olx.account.profile()).externalId).toBe(USER);
  });

  it('delivery orders: listings, orders per ad, and status changes', async () => {
    const { olx, calls } = client();
    expect(await olx.orders.listings()).toEqual([expect.objectContaining({ id: AD, title: 'Laptop', offers: 2 })]);
    expect(calls.at(-1)!.url.searchParams.get('status')).toBe('active');
    expect(await olx.orders.forAd(AD, 'archived')).toEqual([expect.objectContaining({ id: 'ORD-1', status: 'new' })]);
    await olx.orders.update('ORD-1', 'accept');
    expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    expect(calls.at(-1)!.url.pathname).toBe('/api/v1/delivery-orders/ORD-1/update-status/accept');
    await expect(olx.orders.update('ORD-1', 'ship' as never)).rejects.toThrow(/Unknown delivery order action/);
    await expect(olx.orders.update('../x', 'accept')).rejects.toThrow(/Unsafe/);
  });

  it('exchange rate and delivery limits are public', async () => {
    const m = mockOlx();
    const catalog = new OlxCatalog({ fetch: m.fetch });
    expect(await catalog.exchangeRate()).toEqual({ base: 'USD', lbp: 89500 });
    expect(await catalog.deliveryConfig()).toEqual({ maxPrice: 3000, maxWeightKg: 40, minDaysToShip: 2, maxDaysToShip: 3 });
    expect(m.calls.every((c) => !('authorization' in ((c as unknown as { headers?: object }).headers ?? {})))).toBe(true);
  });
});

describe('sync with the ad lifecycle', () => {
  async function linked(status: SyncRecord['status'] = 'active') {
    const c = client();
    const { record } = await c.olx.sync.upsert('SKU-1', listing);
    await c.store.set({ ...record, status });
    return c;
  }

  it('deactivate keeps the link; the next upsert republishes even with unchanged content', async () => {
    const { olx, store, calls } = await linked();
    expect((await olx.sync.deactivate('SKU-1')).status).toBe('inactive');
    expect((await store.get('SKU-1'))?.adId).toBe(AD);
    const result = await olx.sync.upsert('SKU-1', listing);
    expect(result.action).toBe('republished');
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.url.pathname)).toEqual([`/api/v1/republish-ad/${AD}`]);
    expect(result.record.status).not.toBe('inactive');
  });

  it('an expired ad is republished too', async () => {
    const { olx } = await linked('expired');
    expect((await olx.sync.upsert('SKU-1', { ...listing, price: 850 })).action).toBe('republished');
  });

  it('a sold ad is not edited: upsert says so, forget is allowed, and the next upsert posts anew', async () => {
    const { olx, calls } = await linked();
    expect((await olx.sync.markSold('SKU-1', 'elsewhere')).status).toBe('sold');
    await expect(olx.sync.upsert('SKU-1', listing)).rejects.toMatchObject({ code: 'reconcile_required', reason: 'ad_sold' });
    expect(await olx.sync.forget('SKU-1')).toBe(true); // no force needed: the ad isn't live
    expect((await olx.sync.upsert('SKU-1', listing)).action).toBe('created');
    expect(calls.filter((c) => c.url.pathname.endsWith('/post-ad'))).toHaveLength(2);
  });

  it('a healthy active link still needs force to forget', async () => {
    const { olx } = await linked();
    await expect(olx.sync.forget('SKU-1')).rejects.toMatchObject({ code: 'healthy_link' });
  });

  it('activate stores the new status', async () => {
    const { olx } = await linked('limited');
    const { result, record } = await olx.sync.activate('SKU-1');
    expect(result).toBe('activated');
    expect(record.status).toBe('active');
  });

  it('a 404 from deactivate marks the link gone', async () => {
    const c = client({ answers: { [`POST /ads/${AD}/deactivate`]: () => jsonResponse({ message: 'not found' }, 404) } });
    await c.olx.sync.upsert('SKU-1', listing);
    await expect(c.olx.sync.deactivate('SKU-1')).rejects.toMatchObject({ code: 'reconcile_required', reason: 'ad_gone' });
    expect((await c.store.get('SKU-1'))?.syncState).toBe('gone');
  });

  it('state changes need a linked, healthy product', async () => {
    const { olx } = client();
    await expect(olx.sync.deactivate('NOPE')).rejects.toThrow(/no OLX ad linked/);
  });

  it('refresh stores changed statuses and lists products whose ad is missing', async () => {
    const store = new MemorySyncStore();
    const base = { contentHash: 'h', createdAt: '2026-01-01T00:00:00Z', lastSyncedAt: '2026-01-01T00:00:00Z' };
    await store.set({ productId: 'A', adId: AD, status: 'active', ...base });
    await store.set({ productId: 'B', adId: '117000002', status: 'pending_review', ...base });
    await store.set({ productId: 'C', adId: '117000003', status: 'active', ...base });
    const { olx } = client(
      {
        myAds: [
          { externalID: AD, virtualState: 'expired' },
          { externalID: '117000002', virtualState: 'active' },
        ],
      },
      store,
    );
    const r = await olx.sync.refresh();
    expect(r.updated.map((u) => [u.productId, u.status])).toEqual([
      ['A', 'expired'],
      ['B', 'active'],
    ]);
    expect(r.missing).toEqual(['C']);
    expect((await store.get('A'))?.status).toBe('expired');
    expect(olx.limiter.recentCount).toBe(0);
  });
});

describe('an endpoints file only overrides what it lists', () => {
  it('new built-in endpoints stay available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olx-ep-'));
    const file = join(dir, 'endpoints.json');
    writeFileSync(file, JSON.stringify({ deleteAd: { method: 'POST', path: '/custom/{id}/remove' }, adMetrics: null }));
    const client = OlxClient.fromConfig(loadConfig({ OLX_ENDPOINTS_FILE: file, OLX_SESSION_FILE: join(dir, 's.json') }));
    const status = client.endpointStatus();
    expect(status.deactivateAd).toBe(true);
    expect(status.deleteAd).toBe(true);
    expect(status.adMetrics).toBe(false);
  });
});
