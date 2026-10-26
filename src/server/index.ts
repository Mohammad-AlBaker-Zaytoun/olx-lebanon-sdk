#!/usr/bin/env node
import 'dotenv/config';
import { OlxClient } from '../client.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { buildServer } from './app.js';
import { JobQueue } from './queue.js';
import { createWebhookNotifier } from './webhook.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const apiKey = config.server.apiKey;
  if (!apiKey) {
    logger.error('SERVER_API_KEY is not set. Generate one and add it to .env (see .env.example).', {
      cwd: process.cwd(),
      hint: 'Run the service from the project folder so .env and config/ are found',
    });
    process.exit(1);
  }

  const client = OlxClient.fromConfig(config, { logger });
  const webhook = config.webhook ? createWebhookNotifier(config.webhook, logger) : undefined;

  const queue = new JobQueue(
    async (job, payload) => {
      if (job.type === 'upsert') {
        if (!payload) throw new Error('upsert job without payload');
        return client.sync.upsert(job.productId, payload, { force: job.force });
      }
      return client.sync.remove(job.productId);
    },
    { logger, onSettled: webhook ? (job) => webhook.send(job) : undefined },
  );

  const app = buildServer({
    apiKey,
    queue,
    store: client.syncStore,
    resolve: {
      link: (productId, adId, opts) => client.sync.link(productId, adId, opts),
      forget: (productId) => client.sync.forget(productId),
    },
    status: async () => ({
      session: await client.session.status(),
      endpoints: client.endpointStatus(),
      queue: queue.stats(),
      writesLastHour: client.limiter.recentCount,
      needsAttention: (await client.syncStore.all())
        .filter((r) => r.syncState)
        .map((r) => ({ productId: r.productId, syncState: r.syncState, lastError: r.lastError })),
    }),
  });

  const missing = Object.entries(client.endpointStatus())
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.warn('Some OLX endpoints are not configured yet; those operations will fail', { missing });
  }
  if (!(await client.session.status()).loggedIn) {
    logger.warn('No OLX session saved yet. Run `npm run login` before syncing listings.');
  }

  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info('olx-lebanon-sdk server listening', { host: config.server.host, port: config.server.port });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down; finishing the current job first', { signal });
    await app.close();
    await queue.idle();
    await webhook?.flush();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
