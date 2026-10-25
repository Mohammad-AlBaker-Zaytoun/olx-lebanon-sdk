import { describe, expect, it, vi } from 'vitest';
import { parseEndpoints } from '../src/endpoints.js';
import { AuthError, EndpointNotConfiguredError, OlxHttpError, OlxSdkError } from '../src/errors.js';
import { OlxHttpClient, type Transport } from '../src/http/HttpClient.js';
import { WriteRateLimiter } from '../src/http/rateLimiter.js';
import { MemoryRequestLog } from '../src/logger.js';
import { fakeClock, jsonResponse, session } from './helpers.js';

const endpoints = parseEndpoints({
  createAd: { method: 'POST', path: '/api/ads' },
  getAd: { method: 'GET', path: '/api/ads/{id}' },
});

function makeClient(transport: Transport) {
  const clock = fakeClock();
  const limiter = new WriteRateLimiter({ minIntervalMs: 1000, jitterMs: 0, maxPerHour: 100 }, clock);
  const acquire = vi.spyOn(limiter, 'acquire');
  const requestLog = new MemoryRequestLog();
  const client = new OlxHttpClient({
    baseUrl: 'https://www.olx.com.lb',
    endpoints,
    session: { getSession: async () => session },
    limiter,
    requestLog,
    transport,
    retryBaseMs: 1,
    sleep: async () => {},
  });
  return { client, acquire, requestLog };
}

describe('OlxHttpClient', () => {
  it('refuses to call an endpoint that is not mapped', async () => {
    const { client } = makeClient(async () => jsonResponse({}));
    await expect(client.call('deleteAd', { params: { id: '1' } })).rejects.toBeInstanceOf(EndpointNotConfiguredError);
  });

  it('sends session cookies, captured headers and JSON body; rate-limits writes', async () => {
    const transport = vi.fn<Transport>(async () => jsonResponse({ id: 'ad-1' }));
    const { client, acquire, requestLog } = makeClient(transport);
    const result = await client.call('createAd', { json: { title: 'x' } });

    expect(result).toEqual({ id: 'ad-1' });
    expect(acquire).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://www.olx.com.lb/api/ads');
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe('sid=abc'); // example.com cookie not leaked
    expect(headers.authorization).toBe('Bearer test-token');
    expect(headers['user-agent']).toBe('TestAgent/1.0');
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"title":"x"}');
    expect(requestLog.entries[0]).toMatchObject({ endpoint: 'createAd', method: 'POST', status: 200 });
  });

  it('does not rate-limit reads', async () => {
    const { client, acquire } = makeClient(async () => jsonResponse({ id: '1' }));
    await client.call('getAd', { params: { id: '1' } });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('maps 401/403 to AuthError', async () => {
    const { client } = makeClient(async () => jsonResponse({ error: 'nope' }, 401));
    await expect(client.call('getAd', { params: { id: '1' } })).rejects.toBeInstanceOf(AuthError);
  });

  it('retries reads on 503 then succeeds', async () => {
    const transport = vi
      .fn<Transport>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ id: '1' }));
    const { client } = makeClient(transport);
    await expect(client.call('getAd', { params: { id: '1' } })).resolves.toEqual({ id: '1' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('never retries writes (avoids duplicate ads)', async () => {
    const transport = vi.fn<Transport>(async () => jsonResponse({ error: 'busy' }, 503));
    const { client } = makeClient(transport);
    await expect(client.call('createAd', { json: {} })).rejects.toBeInstanceOf(OlxHttpError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('wraps network failures', async () => {
    const { client } = makeClient(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(client.call('createAd', { json: {} })).rejects.toBeInstanceOf(OlxSdkError);
  });

  it('keeps query strings out of the request log', async () => {
    const { client, requestLog } = makeClient(async () => jsonResponse({ id: '1' }));
    await client.call('getAd', { params: { id: '1' }, query: { phone: '70123456' } });
    expect(requestLog.entries[0]!.url).toBe('https://www.olx.com.lb/api/ads/1');
  });
});
