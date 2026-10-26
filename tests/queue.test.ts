import { describe, expect, it } from 'vitest';
import { JobQueue, type Job } from '../src/server/queue.js';

const listing = {
  title: 't',
  description: 'd',
  price: 1,
  categoryKey: 'c',
  locationKey: 'l',
};

describe('JobQueue', () => {
  it('runs jobs one at a time, in order', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const queue = new JobQueue(async (job) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(job.productId);
      active--;
      return job.productId;
    });
    queue.enqueue('upsert', 'A', listing);
    queue.enqueue('upsert', 'B', listing);
    queue.enqueue('remove', 'C');
    await queue.idle();
    expect(order).toEqual(['A', 'B', 'C']);
    expect(maxActive).toBe(1);
  });

  it('coalesces a waiting job for the same product into the newest request', async () => {
    const seen: Array<[string, number | undefined]> = [];
    const queue = new JobQueue(async (job, payload) => {
      seen.push([job.productId, payload?.price]);
    });
    queue.enqueue('upsert', 'A', listing); // starts running immediately
    const b1 = queue.enqueue('upsert', 'B', { ...listing, price: 10 });
    const b2 = queue.enqueue('upsert', 'B', { ...listing, price: 20 });
    expect(b2.id).toBe(b1.id);
    await queue.idle();
    expect(seen).toEqual([
      ['A', 1],
      ['B', 20],
    ]);
  });

  it('records failures and keeps going', async () => {
    const settled: Job[] = [];
    const queue = new JobQueue(
      async (job) => {
        if (job.productId === 'bad') throw new Error('boom');
        return 'ok';
      },
      { onSettled: (j) => settled.push(j) },
    );
    const bad = queue.enqueue('remove', 'bad');
    const good = queue.enqueue('remove', 'good');
    await queue.idle();
    expect(queue.get(bad.id)).toMatchObject({ status: 'failed', error: { code: 'internal_error', message: 'boom' } });
    expect(queue.get(good.id)).toMatchObject({ status: 'succeeded', result: 'ok' });
    expect(settled.map((j) => j.productId)).toEqual(['bad', 'good']);
  });

  it('caps finished-job history', async () => {
    const queue = new JobQueue(async () => undefined, { maxHistory: 2 });
    const first = queue.enqueue('remove', '1');
    queue.enqueue('remove', '2');
    queue.enqueue('remove', '3');
    await queue.idle();
    expect(queue.get(first.id)).toBeUndefined();
    expect(queue.stats().tracked).toBe(2);
  });
});
