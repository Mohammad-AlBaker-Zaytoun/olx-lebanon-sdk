import { describe, expect, it } from 'vitest';
import { WriteRateLimiter } from '../src/http/rateLimiter.js';
import { fakeClock } from './helpers.js';

describe('WriteRateLimiter', () => {
  it('lets the first write through immediately', async () => {
    const clock = fakeClock();
    const limiter = new WriteRateLimiter({ minIntervalMs: 1000, jitterMs: 0, maxPerHour: 10 }, clock);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([]);
  });

  it('spaces consecutive writes by the minimum interval', async () => {
    const clock = fakeClock();
    const limiter = new WriteRateLimiter({ minIntervalMs: 1000, jitterMs: 0, maxPerHour: 10 }, clock);
    const start = clock.t;
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(clock.t - start).toBe(2000);
  });

  it('adds jitter to the gap', async () => {
    const clock = { ...fakeClock(), random: () => 0.5 };
    const c = fakeClock();
    const limiter = new WriteRateLimiter(
      { minIntervalMs: 1000, jitterMs: 400, maxPerHour: 10 },
      { now: c.now, sleep: c.sleep, random: clock.random },
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(c.sleeps).toEqual([1200]);
  });

  it('enforces the hourly cap', async () => {
    const clock = fakeClock();
    const limiter = new WriteRateLimiter({ minIntervalMs: 0, jitterMs: 0, maxPerHour: 2 }, clock);
    const start = clock.t;
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.recentCount).toBe(2);
    await limiter.acquire(); // must wait for the first write to age out
    expect(clock.t - start).toBe(60 * 60 * 1000);
  });
});
