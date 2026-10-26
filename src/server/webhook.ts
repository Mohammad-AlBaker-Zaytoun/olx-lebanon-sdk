import { createHmac } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { Job } from './queue.js';

/** Removes untouched OLX responses (`raw`) from anything that leaves the process. */
export function stripRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRaw);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'raw')
        .map(([k, v]) => [k, stripRaw(v)]),
    );
  }
  return value;
}

/** Hex HMAC-SHA256 of `${timestamp}.${body}` — verify it on the receiving side. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export interface WebhookNotifier {
  send(job: Job): void;
  /** Waits for in-flight deliveries (used on shutdown). */
  flush(): Promise<void>;
}

/**
 * POSTs each finished job to WEBHOOK_URL, signed with WEBHOOK_SECRET.
 * Headers: `x-olx-sdk-timestamp` (unix seconds) and `x-olx-sdk-signature` (`sha256=<hex>`).
 * Redirects are refused, so the payload can't be bounced to another host.
 */
export function createWebhookNotifier(
  cfg: { url: string; secret: string },
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): WebhookNotifier {
  const inFlight = new Set<Promise<void>>();

  const deliver = async (job: Job): Promise<void> => {
    const body = JSON.stringify(stripRaw(job));
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-olx-sdk-timestamp': timestamp,
          'x-olx-sdk-signature': `sha256=${signWebhook(cfg.secret, timestamp, body)}`,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.warn('Webhook receiver returned an error', { jobId: job.id, status: res.status });
      await res.body?.cancel();
    } catch (err) {
      logger.warn('Webhook delivery failed', { jobId: job.id, error: (err as Error).message });
    }
  };

  return {
    send(job) {
      const p = deliver(job).finally(() => inFlight.delete(p));
      inFlight.add(p);
    },
    async flush() {
      await Promise.allSettled([...inFlight]);
    },
  };
}
