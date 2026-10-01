import path from 'path';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env from repo root so PORT from .env is available
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiPort = env.PORT ?? '3090';
  // HK-47 fork: the dev console runs beside the live one, so its port is set per
  // instance (WEB_PORT) and handed to the client, which bypasses this server's
  // SSE-buffering proxy only when the page really is served from it.
  const webPort = Number(env.WEB_PORT ?? '55173');

  // Read version from root package.json
  const rootPkgPath = path.resolve(__dirname, '../../package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as { version: string };
  const appVersion = rootPkg.version;

  // Get short git commit hash (fallback to 'unknown' if git unavailable)
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '../..') })
      .toString()
      .trim();
  } catch {
    // git not available in this build environment
  }

  return {
    plugins: [react(), tailwindcss()],
    define: {
      // Inject API port so browser code can access it via import.meta.env.VITE_API_PORT
      'import.meta.env.VITE_API_PORT': JSON.stringify(apiPort),
      'import.meta.env.VITE_WEB_PORT': JSON.stringify(String(webPort)),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
      dedupe: [
        'mdast-util-find-and-replace',
        'mdast-util-gfm-autolink-literal',
        'mdast-util-gfm',
        'remark-gfm',
      ],
    },
    server: {
      port: webPort,
      strictPort: true,
      // HK-47 fork: reachable through a reverse proxy, whose hostnames come from
      // ARCHON_ALLOWED_HOSTS in the untracked repo-root .env (comma-separated).
      // Binding every interface is safe only behind a host firewall that admits
      // the proxy alone to this port.
      host: true,
      allowedHosts: env.ARCHON_ALLOWED_HOSTS ? env.ARCHON_ALLOWED_HOSTS.split(',') : [],
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          // HK-47 fork (PERS-35): this hop reaches the API over loopback, which
          // the server trusts without the proxy secret, so it serves loopback
          // clients only. The reverse proxy routes /api to the server directly.
          bypass: req => {
            const peer = req.socket.remoteAddress ?? '';
            return peer === '::1' || /^(::ffff:)?127\./.test(peer) ? undefined : false;
          },
        },
      },
    },
    // HK-47 fork (PERS-30): live serves the built bundle through `vite preview`.
    // No framing (clickjacking of run/approve buttons), no sniffing, and a CSP
    // that would contain a future XSS: scripts and connections only to this
    // origin. Dev keeps none of this, since HMR needs inline script.
    preview: {
      headers: {
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self'",
          "connect-src 'self'",
          "img-src 'self' data: blob:",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          'font-src https://fonts.gstatic.com',
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join('; '),
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    },
    build: {
      outDir: 'dist',
      // Maps stay on disk for debugging but are not referenced by the bundle.
      sourcemap: 'hidden',
    },
  };
});
