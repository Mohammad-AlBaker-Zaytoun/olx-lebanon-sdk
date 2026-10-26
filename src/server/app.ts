import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isSafePathParam } from '../endpoints.js';
import { ForgetConflictError, LinkConflictError, toErrorInfo } from '../errors.js';
import { RestListingSchema } from '../listings/types.js';
import type { SyncRecord, SyncStore } from '../sync/SyncStore.js';
import type { Logger } from '../logger.js';
import { openApiDocument } from './openapi.js';
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
  /** Unexpected errors (500 internal_error) are logged here, with the request id. */
  logger?: Logger;
}

/**
 * Error codes the REST layer itself returns. Failed jobs report the SDK's `OlxErrorCode`s.
 * Both are stable: clients branch on `error.code`.
 */
export type RestErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'invalid_product_id'
  | 'invalid_listing'
  | 'invalid_resolution'
  | 'link_conflict'
  | 'healthy_link'
  | 'queue_full'
  | 'shutting_down'
  | 'payload_too_large'
  | 'bad_request'
  | 'internal_error';

export const API_PREFIX = '/v1';

const PRODUCT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** Routes that need no API key. */
const PUBLIC = new Set([`${API_PREFIX}/health`, `${API_PREFIX}/openapi.json`]);

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

/** `{ error: { code, message, details?, requestId } }`: the one error shape of the API. */
function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: RestErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
}

const zodIssues = (issues: z.ZodIssue[]) => issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/**
 * The REST API for store backends in any language (see the OpenAPI document at
 * GET /v1/openapi.json). Writes are accepted at once (202) and run by the queue; poll
 * GET /v1/jobs/:id or set a webhook for the outcome.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_000_000,
    // Echo a caller's request id when it's safe, so logs on both sides can be matched.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    void reply.header('x-request-id', req.id);
    if (req.method === 'GET' && PUBLIC.has(req.url.split('?')[0]!)) return;
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !safeEqual(key, deps.apiKey)) {
      return fail(req, reply, 401, 'unauthorized', 'Missing or wrong X-Api-Key header');
    }
  });

  app.register(
    async (v1) => {
      v1.get('/health', async () => ({ ok: true }));

      v1.get('/openapi.json', async () => openApiDocument);

      v1.get('/status', async () => deps.status());

      v1.get('/listings', async () => ({ listings: await deps.store.all() }));

      v1.get<{ Params: { productId: string } }>('/products/:productId/listing', async (req, reply) => {
        const record = await deps.store.get(req.params.productId);
        if (!record) return fail(req, reply, 404, 'not_found', `No listing for product "${req.params.productId}"`);
        return record;
      });

      v1.put<{ Params: { productId: string }; Querystring: { force?: string } }>(
        '/products/:productId/listing',
        async (req, reply) => {
          const { productId } = req.params;
          if (!PRODUCT_ID.test(productId)) return invalidProductId(req, reply);
          const parsed = RestListingSchema.safeParse(req.body);
          if (!parsed.success) {
            return fail(req, reply, 400, 'invalid_listing', 'The listing body is invalid', {
              issues: zodIssues(parsed.error.issues),
            });
          }
          const force = req.query.force === 'true' || req.query.force === '1';
          const job = deps.queue.enqueue('upsert', productId, parsed.data, { force });
          return reply.code(202).send({ jobId: job.id, status: job.status });
        },
      );

      v1.delete<{ Params: { productId: string } }>('/products/:productId/listing', async (req, reply) => {
        const { productId } = req.params;
        if (!PRODUCT_ID.test(productId)) return invalidProductId(req, reply);
        const job = deps.queue.enqueue('remove', productId);
        return reply.code(202).send({ jobId: job.id, status: job.status });
      });

      /**
       * Resolve a product parked as needs_reconcile / gone:
       *   { "action": "link", "adId": "…" }  — the ad exists on OLX; manage it from now on
       *   { "action": "forget" }             — no ad exists; the next sync creates one
       */
      v1.post<{ Params: { productId: string } }>('/products/:productId/listing/resolve', async (req, reply) => {
        const { productId } = req.params;
        if (!PRODUCT_ID.test(productId)) return invalidProductId(req, reply);
        const parsed = ResolveSchema.safeParse(req.body);
        if (!parsed.success) {
          return fail(req, reply, 400, 'invalid_resolution', 'The resolution body is invalid', {
            issues: zodIssues(parsed.error.issues),
          });
        }
        try {
          if (parsed.data.action === 'link') {
            return await deps.resolve.link(productId, parsed.data.adId, { replace: parsed.data.replace });
          }
          return { forgotten: await deps.resolve.forget(productId, { force: parsed.data.force }) };
        } catch (err) {
          if (err instanceof LinkConflictError || err instanceof ForgetConflictError) {
            const info = toErrorInfo(err);
            return fail(req, reply, 409, info.code as RestErrorCode, info.message, info.details);
          }
          throw err;
        }
      });

      v1.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (req, reply) => {
        const job = deps.queue.get(req.params.jobId);
        if (!job) return fail(req, reply, 404, 'not_found', `No job "${req.params.jobId}" (finished jobs are kept for a while)`);
        // Raw OLX responses can carry tokens or personal data; they never leave the process.
        return stripRaw(job);
      });
    },
    { prefix: API_PREFIX },
  );

  app.setNotFoundHandler((req, reply) =>
    fail(req, reply, 404, 'not_found', `No route ${req.method} ${req.url.split('?')[0]} (the API is under ${API_PREFIX})`),
  );

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof QueueFullError) {
      void reply.header('retry-after', '60');
      return fail(req, reply, 429, 'queue_full', err.message);
    }
    if (err instanceof QueueStoppedError) {
      void reply.header('retry-after', '30');
      return fail(req, reply, 503, 'shutting_down', err.message);
    }
    if (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return fail(req, reply, 413, 'payload_too_large', 'The request body is too large (1 MB max)');
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    // Client errors (bad JSON, wrong content type) are safe to explain; internal errors are not.
    if (status === 500) {
      deps.logger?.error('Request failed', {
        requestId: req.id,
        method: req.method,
        path: req.routeOptions.url,
        error: err.message,
        stack: err.stack,
      });
      return fail(req, reply, 500, 'internal_error', 'Internal error');
    }
    return fail(req, reply, status, 'bad_request', err.message);
  });

  return app;
}

function invalidProductId(req: FastifyRequest, reply: FastifyReply) {
  return fail(req, reply, 400, 'invalid_product_id', 'Product ids are 1-128 letters, digits and . _ : -');
}
