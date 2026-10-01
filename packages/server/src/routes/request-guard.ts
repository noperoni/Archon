/**
 * HK-47 fork (PERS-30): browser-borne attacks on an unauthenticated API.
 *
 * CORS only hides the reply from a foreign page; it does not stop the request.
 * A text/plain or multipart POST is a "simple" request with no preflight, and
 * the message and run handlers parse their body whatever the Content-Type, so
 * any page open in the browser could start an agent. A rebinding domain that
 * resolves to 127.0.0.1 goes further and becomes same-origin. Two checks close
 * both, and neither touches local scripts, which send no Origin header:
 *
 *   - Host must name this server (loopback, or a configured console hostname),
 *     which defeats DNS rebinding and direct hits on the LAN IP.
 *   - A state-changing request carrying Origin must come from a console origin.
 *
 * PERS-35 adds a third: with ARCHON_PROXY_SECRET set, a request from any peer
 * but loopback must carry it in X-Archon-Proxy-Secret, which only the Traefik
 * route injects. Host and Origin are client-chosen, so without it anything on
 * the proxy host could reach the API around the proxy's IP allowlist.
 */
import { timingSafeEqual } from 'crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** WEB_UI_ORIGIN, comma-separated. Empty when unset. */
export function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** Hostname without port; IPv6 literals keep their brackets. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0] ?? '';
}

export function isAllowedHost(hostHeader: string | undefined, origins: string[]): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader);
  if (LOOPBACK_HOSTS.has(name)) return true;
  return origins.some(o => {
    try {
      return new URL(o).hostname.toLowerCase() === name;
    } catch {
      return false;
    }
  });
}

export function isAllowedOrigin(origin: string, origins: string[]): boolean {
  const o = origin.replace(/\/+$/, '');
  if (origins.length > 0) return origins.includes(o);
  // Unconfigured install: only loopback pages, whatever their port.
  try {
    const u = new URL(o);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false; // includes the literal "null" origin
  }
}

export const PROXY_SECRET_HEADER = 'x-archon-proxy-secret';

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === '::1' ||
    address?.startsWith('127.') === true ||
    address?.startsWith('::ffff:127.') === true
  );
}

/** True when the request came over loopback, or carries the proxy secret. */
export function hasProxyTrust(
  peer: string | undefined,
  presented: string | undefined,
  secret: string
): boolean {
  if (isLoopbackAddress(peer)) return true;
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined; // no Bun server in env (tests, app.request): not loopback
  }
}

export function requestGuard(origins: string[], proxySecret?: string): MiddlewareHandler {
  return async (c, next) => {
    if (
      proxySecret &&
      !hasProxyTrust(peerAddress(c), c.req.header(PROXY_SECRET_HEADER), proxySecret)
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!isAllowedHost(c.req.header('host'), origins)) {
      return c.json({ error: 'Unknown host' }, 421);
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const fetchSite = c.req.header('sec-fetch-site');
      if (origin !== undefined ? !isAllowedOrigin(origin, origins) : fetchSite === 'cross-site') {
        return c.json({ error: 'Cross-origin request refused' }, 403);
      }
    }
    return next();
  };
}
