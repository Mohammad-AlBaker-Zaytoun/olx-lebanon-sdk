/**
 * Runs the PHP, Python and shell REST examples against a real (local, fake-OLX) service, so the
 * examples in the docs keep working. Each language is skipped when it isn't installed.
 */
import { execFile, execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/app.js';
import { JobQueue } from '../src/server/queue.js';
import { signWebhook } from '../src/server/webhook.js';
import { MemorySyncStore } from '../src/sync/SyncStore.js';
import type { SyncRecord } from '../src/sync/SyncStore.js';

const run = promisify(execFile);
const KEY = 'example-key-0123456789abcdef';

function has(cmd: string, args = ['--version']): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const python = ['python3', 'python'].find((c) => has(c));
const php = has('php', ['-r', 'exit(function_exists("curl_init") ? 0 : 1);']) ? 'php' : undefined;
const bash = process.platform !== 'win32' && has('bash') && has('curl') ? 'bash' : undefined;

let app: FastifyInstance;
let url: string;
const received: Array<{ productId: string; price: unknown }> = [];

beforeAll(async () => {
  const store = new MemorySyncStore();
  const queue = new JobQueue(async (job, payload) => {
    received.push({ productId: job.productId, price: payload?.price });
    const record: SyncRecord = {
      productId: job.productId,
      adId: '117146151',
      status: 'active',
      contentHash: 'h',
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };
    await store.set(record);
    return { action: 'created', record, ad: { id: record.adId, status: 'active', raw: { secret: 'never leaves' } } };
  });
  app = buildServer({ apiKey: KEY, queue, store, resolve: { link: async () => ({}) as never, forget: async () => true }, status: async () => ({}) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(() => app.close());

const env = () => ({ ...process.env, OLX_SDK_API_KEY: KEY, OLX_SDK_URL: url });

describe('REST examples', () => {
  it.skipIf(!python)('examples/rest/client.py syncs a product and reads the job', async () => {
    const { stdout } = await run(python!, ['examples/rest/client.py'], { env: env() });
    expect(stdout.trim()).toBe('created 117146151 active');
  });

  it.skipIf(!php)('examples/rest/client.php syncs a product (decimal-string price) and reads the job', async () => {
    const { stdout } = await run(php!, ['examples/rest/client.php'], { env: env() });
    expect(stdout.trim()).toBe('created 117146151 active');
    expect(received.some((r) => r.price === 899)).toBe(true);
  });

  it.skipIf(!bash)('examples/rest/curl.sh runs end to end', async () => {
    const { stdout } = await run(bash!, ['examples/rest/curl.sh'], { env: env() });
    expect(stdout).toContain('"status":"succeeded"');
    expect(stdout).toContain('"adId":"117146151"');
    expect(stdout).not.toContain('never leaves');
  });

  it.skipIf(!python)('the Python client raises the stable error code', async () => {
    const code = `
import sys; sys.path.insert(0, 'examples/rest')
from client import OlxSdkClient, OlxSdkError
try:
    OlxSdkClient('wrong-key', '${url}').status()
except OlxSdkError as e:
    print(e.status, e.code)
`;
    const { stdout } = await run(python!, ['-c', code], { env: env() });
    expect(stdout.trim()).toBe('401 unauthorized');
  });
});

describe('webhook verification examples', () => {
  const secret = 'webhook-secret-0123456789';
  const body = JSON.stringify({ id: 'j1', type: 'upsert', productId: 'SKU-1', status: 'succeeded' });

  it.skipIf(!python)('webhook.py accepts a signed request and rejects a forged or stale one', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${signWebhook(secret, ts, body)}`;
    const code = `
import sys, json; sys.path.insert(0, 'examples/rest')
from webhook import verify_webhook
a = json.loads(sys.argv[1])
ok = verify_webhook(a['secret'], a['body'].encode(), a['ts'], a['sig'])
forged = verify_webhook(a['secret'], a['body'].encode() + b' ', a['ts'], a['sig'])
stale = verify_webhook(a['secret'], a['body'].encode(), str(int(a['ts']) - 600), a['sig'])
print(ok['productId'], forged, stale)
`;
    const { stdout } = await run(python!, ['-c', code, JSON.stringify({ secret, body, ts, sig })]);
    expect(stdout.trim()).toBe('SKU-1 None None');
  });

  it.skipIf(!php)('webhook.php accepts a signed request and rejects a forged or stale one', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${signWebhook(secret, ts, body)}`;
    const code = `
require 'examples/rest/webhook.php';
$a = json_decode($argv[1], true);
$ok = olxVerifyWebhook($a['secret'], $a['body'], $a['ts'], $a['sig']);
$forged = olxVerifyWebhook($a['secret'], $a['body'] . ' ', $a['ts'], $a['sig']);
$stale = olxVerifyWebhook($a['secret'], $a['body'], (string) ((int) $a['ts'] - 600), $a['sig']);
echo $ok['productId'], ' ', var_export($forged, true), ' ', var_export($stale, true);
`;
    const { stdout } = await run(php!, ['-r', code, '--', JSON.stringify({ secret, body, ts, sig })]);
    expect(stdout.trim()).toBe('SKU-1 NULL NULL');
  });
});
