import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { isAllowedHost, isAllowedOrigin, parseOrigins, requestGuard } from './request-guard';

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
    const r = await a.fetch(req({ host: 'console.example.test', origin: 'https://console.example.test' }));
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
