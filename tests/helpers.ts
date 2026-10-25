import type { RateLimiterClock } from '../src/http/rateLimiter.js';
import { parseCatalog } from '../src/mapping/CatalogMapper.js';
import type { SessionData } from '../src/session/storage.js';

/** Deterministic clock: sleeping just advances time. */
export function fakeClock(start = 1_700_000_000_000): RateLimiterClock & { t: number; sleeps: number[] } {
  const clock = {
    t: start,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0,
  };
  return clock;
}

export const session: SessionData = {
  cookies: [
    { name: 'sid', value: 'abc', domain: '.olx.com.lb', path: '/', expires: -1, secure: true },
    { name: 'other', value: 'x', domain: 'example.com', path: '/', expires: -1 },
  ],
  headers: { authorization: 'Bearer test-token' },
  userAgent: 'TestAgent/1.0',
  savedAt: '2026-10-26T00:00:00.000Z',
};

export const catalog = parseCatalog({
  limits: { titleMaxLength: 20, maxImages: 2 },
  categories: {
    phones: {
      olxCategoryId: 123,
      requiredAttributes: ['brand', 'condition'],
      attributeMap: { brand: 'make' },
      defaults: { condition: 'new' },
    },
  },
  locations: { beirut: { olxLocationId: 'loc-1' } },
});

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
