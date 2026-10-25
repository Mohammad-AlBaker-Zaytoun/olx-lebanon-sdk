import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { RestListingSchema } from '../listings/types.js';
import type { SyncStore } from '../sync/SyncStore.js';
import type { JobQueue } from './queue.js';

export interface ServerDeps {
  apiKey: string;
  queue: JobQueue;
  store: SyncStore;
  status: () => Promise<Record<string, unknown>>;
}

const PRODUCT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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
    if (req.url.split('?')[0] === '/health') return;
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

  app.put<{ Params: { productId: string } }>('/products/:productId/listing', async (req, reply) => {
    const { productId } = req.params;
    if (!PRODUCT_ID.test(productId)) return reply.code(400).send({ error: 'invalid_product_id' });
    const parsed = RestListingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_listing', issues: parsed.error.issues });
    }
    const job = deps.queue.enqueue('upsert', productId, parsed.data);
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  app.delete<{ Params: { productId: string } }>('/products/:productId/listing', async (req, reply) => {
    const { productId } = req.params;
    if (!PRODUCT_ID.test(productId)) return reply.code(400).send({ error: 'invalid_product_id' });
    const job = deps.queue.enqueue('remove', productId);
    return reply.code(202).send({ jobId: job.id, status: job.status });
  });

  app.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
    const job = deps.queue.get(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return job;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    void reply.code(status).send({ error: status === 500 ? 'internal_error' : 'bad_request', message: err.message });
  });

  return app;
}
