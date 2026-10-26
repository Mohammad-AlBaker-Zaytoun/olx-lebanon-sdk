import { describe, expect, it } from 'vitest';
import { normalizeStatus, placeholderAdapter } from '../src/listings/adapter.js';
import { cookieHeaderFor } from '../src/session/storage.js';
import { formatHostActivity, isSensitiveSegment, summarizeHar, tallyHosts } from '../src/tools/har.js';
import { session } from './helpers.js';

describe('placeholderAdapter', () => {
  it('unwraps common envelopes and normalises status', () => {
    const ad = placeholderAdapter.parseAd({ data: { id: 991, state: 'PENDING_MODERATION', url: 'https://x/991' } });
    expect(ad).toMatchObject({ id: '991', status: 'pending_review', url: 'https://x/991' });
  });

  it('parses lists and image uploads', () => {
    expect(placeholderAdapter.parseAdList({ results: [{ id: 'a' }, { id: 'b' }] }).map((a) => a.id)).toEqual(['a', 'b']);
    expect(placeholderAdapter.parseImageUpload({ image_id: 'img-1' })).toBe('img-1');
  });

  it('fails loudly when it cannot find an id', () => {
    expect(() => placeholderAdapter.parseAd({ ok: true })).toThrow(/ad id/);
  });

  it.each([
    ['active', 'active'],
    ['LIVE', 'active'],
    ['deactivated', 'deleted'],
    ['rejected_by_moderator', 'rejected'],
    ['expired', 'expired'],
    ['weird', 'unknown'],
  ])('normalizeStatus(%s) = %s', (input, expected) => {
    expect(normalizeStatus(input)).toBe(expected);
  });
});

describe('cookieHeaderFor', () => {
  it('only sends matching, unexpired, secure-appropriate cookies', () => {
    expect(cookieHeaderFor(session, 'https://api.olx.com.lb/x')).toBe('sid=abc');
    expect(cookieHeaderFor(session, 'http://www.olx.com.lb/x')).toBe(''); // secure cookie over http
    const expired = { ...session, cookies: [{ ...session.cookies[0]!, expires: 10 }] };
    expect(cookieHeaderFor(expired, 'https://www.olx.com.lb/')).toBe('');
  });
});

describe('summarizeHar', () => {
  it('keeps API calls, collapses ids, drops static assets and puts writes first', () => {
    const calls = summarizeHar(
      {
        log: {
          entries: [
            { request: { method: 'GET', url: 'https://www.olx.com.lb/app.js' }, response: { status: 200 } },
            {
              request: { method: 'GET', url: 'https://www.olx.com.lb/api/ads/123456' },
              response: { status: 200, content: { mimeType: 'application/json' } },
            },
            {
              request: { method: 'GET', url: 'https://www.olx.com.lb/api/ads/987654' },
              response: { status: 200, content: { mimeType: 'application/json' } },
            },
            {
              request: {
                method: 'POST',
                url: 'https://www.olx.com.lb/api/ads',
                postData: { mimeType: 'application/json' },
              },
              response: { status: 201 },
            },
            { request: { method: 'POST', url: 'https://tracker.example/collect' }, response: { status: 204 } },
          ],
        },
      },
      (host) => host.endsWith('olx.com.lb'),
    );
    expect(calls.map((c) => `${c.method} ${c.pattern} x${c.count}`)).toEqual([
      'POST https://www.olx.com.lb/api/ads x1',
      'GET https://www.olx.com.lb/api/ads/{id} x2',
    ]);
  });
});

describe('HAR summary: ids with file extensions', () => {
  it('collapses ids that carry an extension, like Next.js data routes', () => {
    for (const seg of ['117145974.json', '117145974.html', 'aZ9kQ2mN8pL4xR7tV1.json']) expect(isSensitiveSegment(seg)).toBe(true);
    for (const seg of ['post.json', 'myAds.json', 'listing.json', 'success.json']) expect(isSensitiveSegment(seg)).toBe(false);
    const [call] = summarizeHar({
      log: {
        entries: [
          {
            request: { method: 'GET', url: 'https://www.olx.com.lb/_next/data/abc/en/edit/117145974.json' },
            response: { status: 200, content: { mimeType: 'application/json' } },
          },
        ],
      },
    });
    expect(call!.pattern).toBe('https://www.olx.com.lb/_next/data/abc/en/edit/{id}');
  });
});

describe('tallyHosts', () => {
  const recorded = (h: string) => h === 'olx.com.lb' || h.endsWith('.olx.com.lb');

  it('lists only unrecorded hosts, hostnames and method counts, writes first', () => {
    const hosts = tallyHosts(
      [
        { method: 'GET', url: 'https://www.olx.com.lb/api/x' },
        { method: 'GET', url: 'https://cdn.example/a.js?token=secret' },
        { method: 'GET', url: 'https://cdn.example/b.js' },
        { method: 'OPTIONS', url: 'https://api.example/ads' },
        { method: 'POST', url: 'https://api.example/ads' },
        { method: 'PUT', url: 'https://storage.example/upload/abc?sig=secret' },
        { method: 'GET', url: 'data:image/png;base64,AAAA' },
        { method: 'GET', url: 'not a url' },
      ],
      recorded,
    );
    expect(hosts).toEqual([
      { host: 'api.example', methods: { OPTIONS: 1, POST: 1 } },
      { host: 'storage.example', methods: { PUT: 1 } },
      { host: 'cdn.example', methods: { GET: 2 } },
    ]);
    const text = formatHostActivity(hosts);
    expect(text).not.toMatch(/secret|upload|ads|\.js/);
    expect(text).toContain('POST x1');
  });

  it('says so when nothing else was contacted', () => {
    expect(formatHostActivity(tallyHosts([{ method: 'GET', url: 'https://www.olx.com.lb/' }], recorded))).toBe(
      'No other hosts were contacted.',
    );
  });
});
