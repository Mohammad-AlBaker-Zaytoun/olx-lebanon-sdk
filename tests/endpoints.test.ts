import { describe, expect, it } from 'vitest';
import { buildUrl, endpointStatus, parseEndpoints, requireEndpoint } from '../src/endpoints.js';
import { EndpointNotConfiguredError, OlxSdkError } from '../src/errors.js';

describe('endpoints', () => {
  it('parses specs, ignores _comment keys and leaves unknown ones null', () => {
    const map = parseEndpoints({ _comment: 'x', createAd: { method: 'POST', path: '/api/ads' }, getAd: null });
    expect(map.createAd).toEqual({ method: 'POST', path: '/api/ads' });
    expect(map.getAd).toBeNull();
    expect(endpointStatus(map)).toMatchObject({ createAd: true, deleteAd: false });
  });

  it('rejects unknown endpoint names and bad specs', () => {
    expect(() => parseEndpoints({ postAd: { method: 'POST', path: '/x' } })).toThrow(OlxSdkError);
    expect(() => parseEndpoints({ createAd: { method: 'FETCH', path: '/x' } })).toThrow(/Invalid spec/);
  });

  it('throws a helpful error for unconfigured endpoints', () => {
    expect(() => requireEndpoint(parseEndpoints({}), 'createAd')).toThrow(EndpointNotConfiguredError);
  });

  it('builds URLs with encoded params and query', () => {
    const url = buildUrl('https://www.olx.com.lb', { method: 'GET', path: '/api/ads/{id}' }, { id: 'a b' }, {
      page: 2,
      skip: undefined,
    });
    expect(url).toBe('https://www.olx.com.lb/api/ads/a%20b?page=2');
  });

  it('accepts absolute paths on other hosts', () => {
    expect(buildUrl('https://www.olx.com.lb', { method: 'POST', path: 'https://api.olx.com.lb/v1/upload' })).toBe(
      'https://api.olx.com.lb/v1/upload',
    );
  });

  it('fails on missing path params', () => {
    expect(() => buildUrl('https://x.test', { method: 'GET', path: '/ads/{id}' })).toThrow(/Missing path parameter/);
  });
});
