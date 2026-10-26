// lib/olx.ts: one OLX client for the whole app, server-side only.
import 'server-only';
import pg from 'pg';
import { createOlxClient, type OlxClient } from 'olx-lebanon-sdk';
import { SqlSyncStore } from '../../stores/sql-store';

// Keep one client (and one write pace) per process, also across hot reloads in `next dev`.
const globalForOlx = globalThis as unknown as { olx?: OlxClient; olxPool?: pg.Pool };

const pool = (globalForOlx.olxPool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL }));

export const olx = (globalForOlx.olx ??= createOlxClient({
  accessToken: process.env.OLX_ACCESS_TOKEN,
  // Serverless functions lose memory between requests: keep the links in your database.
  store: new SqlSyncStore(pool),
  contact: { name: process.env.OLX_CONTACT_NAME },
}));
