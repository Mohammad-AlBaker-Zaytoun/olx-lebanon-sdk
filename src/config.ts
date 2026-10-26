import { z } from 'zod';
import { OlxSdkError } from './errors.js';
import type { LogLevel } from './logger.js';

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
const list = (v?: string): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** https anywhere; plain http only for a local test server. */
export const isSecureOrLocal = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));

/** For refinements: zod runs every check even after `.url()` fails, so parsing must not throw. */
const secureOrLocalUrl = (u: string): boolean => {
  try {
    return isSecureOrLocal(new URL(u));
  } catch {
    return false;
  }
};

const EnvSchema = z.object({
  OLX_BASE_URL: z
    .string()
    .url()
    .refine(secureOrLocalUrl, 'OLX_BASE_URL must use https (plain http is only allowed for localhost, for testing)')
    .default('https://www.olx.com.lb'),
  OLX_ACCESS_TOKEN: z
    .string()
    .refine((t) => /^\S{20,}$/.test(t.trim().replace(/^bearer\s+/i, '')), 'OLX_ACCESS_TOKEN looks empty or malformed')
    .optional(),
  OLX_SESSION_FILE: z.string().default('.olx-session/session.json'),
  OLX_ENDPOINTS_FILE: z.string().default('config/endpoints.json'),
  OLX_CATALOG_FILE: z.string().default('config/catalog.json'),
  OLX_SYNC_STORE_FILE: z.string().default('data/sync-store.json'),
  OLX_REQUEST_LOG_FILE: z.string().default('logs/requests.jsonl'),
  OLX_MIN_WRITE_INTERVAL_MS: int(60_000),
  OLX_WRITE_JITTER_MS: int(15_000),
  OLX_MAX_WRITES_PER_HOUR: z.coerce.number().int().positive().default(20),
  OLX_IMAGE_HOSTS: z.string().optional(),
  OLX_EXTRA_HOSTS: z.string().optional(),
  OLX_CAPTURE_HEADERS: z.string().optional(),
  OLX_ADAPTER: z.enum(['olx-lebanon', 'placeholder']).default('olx-lebanon'),
  OLX_CONTACT_NAME: z.string().optional(),
  OLX_CONTACT_PHONE: z.string().optional(),
  OLX_CONTACT_METHOD: z.string().optional(),
  SERVER_HOST: z.string().default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  SERVER_API_KEY: z.string().min(16, 'SERVER_API_KEY must be at least 16 characters').optional(),
  WEBHOOK_URL: z
    .string()
    .url()
    .refine(secureOrLocalUrl, 'WEBHOOK_URL must use https (plain http is only allowed for localhost)')
    .optional(),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters').optional(),
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
  /** From OLX_ACCESS_TOKEN. When set, it is used instead of the session file. */
  accessToken?: string;
  sessionFile: string;
  endpointsFile: string;
  catalogFile: string;
  syncStoreFile: string;
  requestLogFile: string;
  writeLimits: WriteLimits;
  /** Image URLs may only come from these hosts (or subdomains). Unset: any public https host. */
  allowedImageHosts?: string[];
  /** Non-OLX hosts the web app talks to (e.g. an image CDN), recorded by login/capture. */
  extraHosts: string[];
  /** Extra request header names to capture at login, on top of the defaults. */
  captureHeaders: string[];
  /** Built-in wire format: `olx-lebanon` (default) or `placeholder` (for custom adapters). */
  adapter: 'olx-lebanon' | 'placeholder';
  /** Who buyers contact; empty fields fall back to the account profile. */
  contact: { name?: string; phone?: string; method?: string };
  logLevel: LogLevel;
  server: { host: string; port: number; apiKey?: string };
  webhook?: { url: string; secret: string };
}

/** Reads configuration from environment variables (load a `.env` file first with `loadEnvFile()`). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): OlxConfig {
  // Treat empty values (`FOO=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  if (parsed.success) {
    const e = parsed.data;
    if (e.WEBHOOK_URL && !e.WEBHOOK_SECRET) {
      issues.push('WEBHOOK_SECRET: required when WEBHOOK_URL is set (used to sign webhook payloads)');
    }
    if (e.WEBHOOK_SECRET && e.WEBHOOK_SECRET === e.SERVER_API_KEY) {
      issues.push('WEBHOOK_SECRET: must be different from SERVER_API_KEY');
    }
  }
  if (!parsed.success || issues.length > 0) {
    throw new OlxSdkError(`Invalid configuration:\n  ${issues.join('\n  ')}`);
  }

  const e = parsed.data;
  const imageHosts = list(e.OLX_IMAGE_HOSTS);

  return {
    baseUrl: e.OLX_BASE_URL,
    accessToken: e.OLX_ACCESS_TOKEN,
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
    allowedImageHosts: imageHosts.length > 0 ? imageHosts : undefined,
    extraHosts: list(e.OLX_EXTRA_HOSTS),
    captureHeaders: list(e.OLX_CAPTURE_HEADERS),
    adapter: e.OLX_ADAPTER,
    contact: { name: e.OLX_CONTACT_NAME, phone: e.OLX_CONTACT_PHONE, method: e.OLX_CONTACT_METHOD },
    logLevel: e.LOG_LEVEL,
    server: { host: e.SERVER_HOST, port: e.SERVER_PORT, apiKey: e.SERVER_API_KEY },
    webhook: e.WEBHOOK_URL && e.WEBHOOK_SECRET ? { url: e.WEBHOOK_URL, secret: e.WEBHOOK_SECRET } : undefined,
  };
}
