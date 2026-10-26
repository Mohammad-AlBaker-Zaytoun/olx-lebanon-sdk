/**
 * Run the REST service from your own code, with product ↔ ad links in PostgreSQL instead of
 * a JSON file. Other settings (port, API key, webhook…) come from environment variables or .env.
 *
 *   SERVER_API_KEY=… OLX_ACCESS_TOKEN=… DATABASE_URL=… npx tsx examples/node/rest-service.ts
 */
import 'dotenv/config';
import pg from 'pg';
import { createLogger, createOlxClient } from 'olx-lebanon-sdk';
import { startServer } from 'olx-lebanon-sdk/server';
import { SqlSyncStore } from '../stores/sql-store.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const logger = createLogger('info');

const client = createOlxClient({
  accessToken: process.env.OLX_ACCESS_TOKEN,
  store: new SqlSyncStore(pool),
  logger,
});

// Handle Ctrl+C and service stops here, so the database pool is closed after the service.
const server = await startServer({ client, logger, handleSignals: false });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await server.stop(); // the running job finishes; waiting jobs are cancelled (and sent to the webhook)
    await pool.end();
    process.exit(0);
  });
}
