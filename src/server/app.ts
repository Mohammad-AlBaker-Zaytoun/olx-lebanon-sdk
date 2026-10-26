import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSafePathParam } from '../endpoints.js';
import { ForgetConflictError, LinkConflictError } from '../errors.js';
import { RestListingSchema } from '../listings/types.js';
import type { SyncRecord, SyncStore } from '../sync/SyncStore.js';
import { QueueFullError, QueueStoppedError, type JobQueue } from './queue.js';
import { stripRaw } from './webhook.js';

export interface ServerDeps {
  apiKey: string;
  queue: JobQueue;
  store: SyncStore;
  /** Manual resolution of parked products (see SyncService.link / forget). */
  resolve: {
    link(productId: string, adId: string, opts?: { replace?: boolean }): Promise<SyncRecord>;
    forget(productId: string, opts?: { force?: boolean }): Promise<boolean>;
  };
  status: () => Promise<Record<string, unknown>>;
}

const PRODUCT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const ResolveSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('link'),
    adId: z.string().trim().refine(isSafePathParam, 'adId may only contain letters, digits, "_", "-" and inner dots'),
    replace: z.boolean().optional(),
  }),
  z.object({ action: z.literal('forget'), force: z.boolean().optional() }),
]);

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Local REST API for your store backend. Writes are accepted immediately (202) and
 * executed by the queue; poll GET /jobs/:id or configure WEBHOOK_URL for the outcome.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/health') return;
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !safeEqual(key, deps.apiKey)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/status', async () => deps.status());

  app.get('/listings', async () => ({ listings: await deps.store.all() }));

  app.get<{ Params: { productId: string } }>('/products/:productId/listing', async (req, reply) => {
    const record = await deps.store.get(req.params.productId);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    return record;
  });

  app.put<{ Params: { productId: string }; Querystring: { force?: string } }>(
    '/products/:productId/listing',
    async (req, reply) => {
      const { productId } = req.params;
      if (!PRODUCT_ID.test(productId)) return reply.code(400).send({ error: 'invalid_product_id' });
      const parsed = RestListingSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_listing', issues: parsed.error.issues });
      }
      const force = req.query.force === 'true' || req.query.force === '1';
      const job = deps.queue.enqueue('upsert', productId, parsed.data, { force });
      return reply.code(202).send({ jobId: job.id, status: job.status });
    },
  );

  app.delete<{ Params: { productId: string } }>('/products/:productId/listing', async (req, reply) => {
    const { productId } = req.params;
    if (!PRODUCT_ID.test(productId)) return reply.code(400).send({ error: 'invalid_product_id' });
    const job = deps.queue.enqueue('remove', productId);
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  /**
   * Resolve a product parked as needs_reconcile / gone:
   *   { "action": "link", "adId": "…" }  — the ad exists on OLX; manage it from now on
   *   { "action": "forget" }             — no ad exists; the next sync creates one
   */
  app.post<{ Params: { productId: string } }>('/products/:productId/listing/resolve', async (req, reply) => {
    const { productId } = req.params;
    if (!PRODUCT_ID.test(productId)) return reply.code(400).send({ error: 'invalid_product_id' });
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_resolution', issues: parsed.error.issues });
    try {
      if (parsed.data.action === 'link') {
        return await deps.resolve.link(productId, parsed.data.adId, { replace: parsed.data.replace });
      }
      return { forgotten: await deps.resolve.forget(productId, { force: parsed.data.force }) };
    } catch (err) {
      if (err instanceof LinkConflictError) {
        return reply.code(409).send({
          error: 'link_conflict',
          adId: err.currentAdId,
          otherProductId: err.otherProductId,
          message: err.message,
        });
      }
      if (err instanceof ForgetConflictError) {
        return reply.code(409).send({ error: 'healthy_link', adId: err.currentAdId, message: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
    const job = deps.queue.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    // Raw OLX responses can carry tokens or personal data; they never leave the process.
    return stripRaw(job);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof QueueFullError) {
      void reply.code(429).header('retry-after', '60').send({ error: 'queue_full', message: err.message });
      return;
    }
    if (err instanceof QueueStoppedError) {
      void reply.code(503).header('retry-after', '30').send({ error: 'shutting_down', message: err.message });
      return;
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    // Client errors (bad JSON, body too large) are safe to explain; internal errors are not.
    void reply
      .code(status)
      .send(status === 500 ? { error: 'internal_error' } : { error: 'bad_request', message: err.message });
  });

  return app;
}
