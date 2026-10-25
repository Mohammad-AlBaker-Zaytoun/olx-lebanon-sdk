import { describe, expect, it } from 'vitest';
import { normalizeStatus, placeholderAdapter } from '../src/listings/adapter.js';
import { cookieHeaderFor } from '../src/session/storage.js';
import { summarizeHar } from '../src/tools/har.js';
import { session } from './helpers.js';

describe('placeholderAdapter', () => {
  it('unwraps common envelopes and normalises status', () => {
    const ad = placeholderAdapter.parseAd({ data: { id: 991, state: 'PENDING_MODERATION', url: 'https://x/991' } });
    expect(ad).toMatchObject({ id: '991', status: 'pending_review', url: 'https://x/991' });
  });

  it('parses lists and image uploads', () => {
    expect(placeholderAdapter.parseAdList({ results: [{ id: 'a' }, { id: 'b' }] }).map((a) => a.id)).toEqual([
      'a',
      'b',
    ]);
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
