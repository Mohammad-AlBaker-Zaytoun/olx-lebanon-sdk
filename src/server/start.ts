import { OlxClient } from '../client.js';
import { loadConfig, type OlxConfig } from '../config.js';
import { OlxSdkError } from '../errors.js';
import { createLogger, type Logger } from '../logger.js';
import { buildServer } from './app.js';
import { JobQueue } from './queue.js';
import { createWebhookNotifier } from './webhook.js';

export interface StartServerOptions {
  /** Defaults to `loadConfig()` (environment variables). */
  config?: OlxConfig;
  logger?: Logger;
  /** Use your own client (e.g. with a database-backed sync store). */
  client?: OlxClient;
  /** Stop cleanly on SIGINT / SIGTERM (default true). */
  handleSignals?: boolean;
}

export interface RunningServer {
  /** Base URL the service listens on. */
  url: string;
  /** Finishes the running job, cancels queued ones, and closes the server. */
  stop(): Promise<void>;
}

/** Starts the REST service and returns once it is listening. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  const logger = opts.logger ?? createLogger(config.logLevel);
  const apiKey = config.server.apiKey;
  if (!apiKey) {
    throw new OlxSdkError('SERVER_API_KEY is not set. Run `olx-lb init`, or generate one and add it to .env.');
  }

  const client = opts.client ?? OlxClient.fromConfig(config, { logger });
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
      link: (productId, adId, o) => client.sync.link(productId, adId, o),
      forget: (productId, o) => client.sync.forget(productId, o),
    },
    status: async () => ({
      session: await client.session.status(),
      endpoints: client.endpointStatus(),
      missingEndpoints: client.missingEndpoints(),
      queue: queue.stats(),
      writesLastHour: client.limiter.recentCount,
      // A `creating` marker for a create that is running right now is expected, not a problem.
      needsAttention: (await client.syncStore.all())
        .filter((r) => r.syncState && !(r.syncState === 'creating' && client.sync.isBusy(r.productId)))
        .map((r) => ({ productId: r.productId, syncState: r.syncState, lastError: r.lastError })),
    }),
  });

  const missing = client.missingEndpoints();
  if (missing.length > 0) logger.warn('Some OLX endpoints are not configured; those operations will fail', { missing });
  if (!(await client.session.status()).loggedIn) {
    logger.warn('No OLX session saved yet. Run `olx-lb login` before syncing listings.');
  }

  await app.listen({ host: config.server.host, port: config.server.port });
  const url = `http://${config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host}:${config.server.port}`;
  logger.info('olx-lebanon-sdk server listening', { url });

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const cancelled = queue.stop();
      logger.info('Shutting down; finishing the running job, queued jobs cancelled', {
        cancelled: cancelled.map((j) => j.productId),
      });
      await app.close();
      await queue.idle();
      await webhook?.flush();
    })());

  if (opts.handleSignals !== false) {
    const onSignal = (signal: string) => {
      logger.info('Received signal', { signal });
      void stop().then(() => process.exit(0));
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }
  return { url, stop };
}
