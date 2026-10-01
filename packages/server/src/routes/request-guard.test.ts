import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  hasProxyTrust,
  isAllowedHost,
  isAllowedOrigin,
  parseOrigins,
  PROXY_SECRET_HEADER,
  requestGuard,
} from './request-guard';

const LIVE = parseOrigins('https://console.example.test, http://localhost:55173/');

function app(origins: string[]): Hono {
  const a = new Hono();
  a.use('*', requestGuard(origins));
  a.all('/api/x', c => c.text('ran'));
  return a;
}

function req(headers: Record<string, string>, method = 'POST'): Request {
  return new Request('http://placeholder/api/x', { method, headers });
}

describe('parseOrigins', () => {
  test('splits, trims and drops trailing slashes', () => {
    expect(LIVE).toEqual(['https://console.example.test', 'http://localhost:55173']);
    expect(parseOrigins(undefined)).toEqual([]);
  });
});

describe('isAllowedHost', () => {
  test('loopback in any form, with or without port', () => {
    for (const h of ['localhost:53090', '127.0.0.1', '[::1]:53090', 'LOCALHOST'])
      expect(isAllowedHost(h, [])).toBe(true);
  });
  test('configured console hostname', () => {
    expect(isAllowedHost('console.example.test', LIVE)).toBe(true);
  });
  test('rebinding domain, LAN IP and missing Host are refused', () => {
    expect(isAllowedHost('evil.example', LIVE)).toBe(false);
    expect(isAllowedHost('192.168.1.2:53090', LIVE)).toBe(false);
    expect(isAllowedHost(undefined, LIVE)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  test('configured list is exact', () => {
    expect(isAllowedOrigin('https://console.example.test', LIVE)).toBe(true);
    expect(isAllowedOrigin('http://localhost:9999', LIVE)).toBe(false);
  });
  test('unconfigured allows loopback pages only', () => {
    expect(isAllowedOrigin('http://localhost:5173', [])).toBe(true);
    expect(isAllowedOrigin('https://evil.example', [])).toBe(false);
    expect(isAllowedOrigin('null', [])).toBe(false);
  });
});

describe('requestGuard', () => {
  const a = app(LIVE);
  test('hostile page POST (text/plain, no preflight) is refused before the handler', async () => {
    const r = await a.fetch(
      req({
        host: 'console.example.test',
        origin: 'https://evil.example',
        'content-type': 'text/plain',
      })
    );
    expect(r.status).toBe(403);
  });
  test('rebinding Host is refused even for GET', async () => {
    const r = await a.fetch(req({ host: 'evil.example' }, 'GET'));
    expect(r.status).toBe(421);
  });
  test('console POST passes', async () => {
    const r = await a.fetch(
      req({ host: 'console.example.test', origin: 'https://console.example.test' })
    );
    expect(await r.text()).toBe('ran');
  });
  test('local script POST without Origin passes', async () => {
    const r = await a.fetch(req({ host: '127.0.0.1:53090' }));
    expect(await r.text()).toBe('ran');
  });
  test('cross-site fetch metadata without Origin is refused', async () => {
    const r = await a.fetch(req({ host: 'localhost', 'sec-fetch-site': 'cross-site' }));
    expect(r.status).toBe(403);
  });
  test('opaque null origin is refused', async () => {
    const r = await a.fetch(req({ host: 'localhost', origin: 'null' }));
    expect(r.status).toBe(403);
  });
});

// HK-47 fork (PERS-35): only loopback peers or the proxy's secret get through.
describe('proxy secret', () => {
  const SECRET = 'a-long-shared-secret';

  test('loopback peers need no secret', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect(hasProxyTrust(peer, undefined, SECRET)).toBe(true);
  });

  test('other peers need the exact secret', () => {
    expect(hasProxyTrust('192.168.1.3', undefined, SECRET)).toBe(false);
    expect(hasProxyTrust('192.168.1.3', 'wrong', SECRET)).toBe(false);
    expect(hasProxyTrust('192.168.1.3', `${SECRET}x`, SECRET)).toBe(false);
    expect(hasProxyTrust('192.168.1.3', SECRET, SECRET)).toBe(true);
    expect(hasProxyTrust(undefined, SECRET, SECRET)).toBe(true);
  });

  test('the guard refuses a forged loopback Host without the secret', async () => {
    const a = new Hono();
    a.use('*', requestGuard([], SECRET));
    a.all('/api/x', c => c.text('ran'));
    const refused = await a.request(req({ host: 'localhost:53090' }, 'GET'));
    expect(refused.status).toBe(403);
    const admitted = await a.request(
      req({ host: 'localhost:53090', [PROXY_SECRET_HEADER]: SECRET }, 'GET')
    );
    expect(await admitted.text()).toBe('ran');
  });
});
