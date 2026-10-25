import { z } from 'zod';
import { OlxSdkError } from './errors.js';
import type { LogLevel } from './logger.js';

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const EnvSchema = z.object({
  OLX_BASE_URL: z.string().url().default('https://www.olx.com.lb'),
  OLX_SESSION_FILE: z.string().default('.olx-session/session.json'),
  OLX_ENDPOINTS_FILE: z.string().default('config/endpoints.json'),
  OLX_CATALOG_FILE: z.string().default('config/catalog.json'),
  OLX_SYNC_STORE_FILE: z.string().default('data/sync-store.json'),
  OLX_REQUEST_LOG_FILE: z.string().default('logs/requests.jsonl'),
  OLX_MIN_WRITE_INTERVAL_MS: int(60_000),
  OLX_WRITE_JITTER_MS: int(15_000),
  OLX_MAX_WRITES_PER_HOUR: z.coerce.number().int().positive().default(20),
  OLX_IMAGE_HOSTS: z.string().optional(),
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  SERVER_API_KEY: z.string().min(16, 'SERVER_API_KEY must be at least 16 characters').optional(),
  WEBHOOK_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface WriteLimits {
  /** Minimum gap between two write calls (create/edit/delete). */
  minIntervalMs: number;
  /** Random extra delay (0..jitterMs) added to each gap so traffic is not perfectly regular. */
  jitterMs: number;
  /** Hard cap on write calls in any rolling hour. */
  maxPerHour: number;
}

export interface OlxConfig {
  baseUrl: string;
  sessionFile: string;
  endpointsFile: string;
  catalogFile: string;
  syncStoreFile: string;
  requestLogFile: string;
  writeLimits: WriteLimits;
  allowedImageHosts?: string[];
  logLevel: LogLevel;
  server: { host: string; port: number; apiKey?: string };
  webhookUrl?: string;
}

/** Reads configuration from environment variables (load `.env` first with `dotenv/config`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OlxConfig {
  // Treat empty values (`FOO=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new OlxSdkError(`Invalid configuration:\n  ${issues}`);
  }
  const e = parsed.data;
  const hosts = e.OLX_IMAGE_HOSTS?.split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  return {
    baseUrl: e.OLX_BASE_URL,
    sessionFile: e.OLX_SESSION_FILE,
    endpointsFile: e.OLX_ENDPOINTS_FILE,
    catalogFile: e.OLX_CATALOG_FILE,
    syncStoreFile: e.OLX_SYNC_STORE_FILE,
    requestLogFile: e.OLX_REQUEST_LOG_FILE,
    writeLimits: {
      minIntervalMs: e.OLX_MIN_WRITE_INTERVAL_MS,
      jitterMs: e.OLX_WRITE_JITTER_MS,
      maxPerHour: e.OLX_MAX_WRITES_PER_HOUR,
    },
    allowedImageHosts: hosts && hosts.length > 0 ? hosts : undefined,
    logLevel: e.LOG_LEVEL,
    server: { host: e.SERVER_HOST, port: e.SERVER_PORT, apiKey: e.SERVER_API_KEY },
    webhookUrl: e.WEBHOOK_URL,
  };
}
