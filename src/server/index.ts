#!/usr/bin/env node
import 'dotenv/config';
import { OlxClient } from '../client.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { buildServer } from './app.js';
import { JobQueue, type Job } from './queue.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const apiKey = config.server.apiKey;
  if (!apiKey) {
    logger.error('SERVER_API_KEY is not set. Generate one and add it to .env (see .env.example).');
    process.exit(1);
  }

  const client = OlxClient.fromConfig(config, { logger });

  const notify = async (job: Job): Promise<void> => {
    if (!config.webhookUrl) return;
    try {
      await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn('Webhook delivery failed', { jobId: job.id, error: (err as Error).message });
    }
  };

  const queue = new JobQueue(
    async (job, payload) => {
      if (job.type === 'upsert') {
        if (!payload) throw new Error('upsert job without payload');
        return client.sync.upsert(job.productId, payload);
      }
      return client.sync.remove(job.productId);
    },
    { logger, onSettled: (job) => void notify(job) },
  );

  const app = buildServer({
    apiKey,
    queue,
    store: client.syncStore,
    status: async () => ({
      session: await client.session.status(),
      endpoints: client.endpointStatus(),
      queue: queue.stats(),
      writesLastHour: client.limiter.recentCount,
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

  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    await app.close();
    await queue.idle();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
