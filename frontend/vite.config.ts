import { createHash } from 'node:crypto';
import { type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Emit a service worker that precaches exactly the files of this build.
 * It never caches /api responses (see public/sw-template.js).
 */
function serviceWorker(): Plugin {
  return {
    name: 'cadence-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Precache code, styles and woff2 fonts; old .woff fallbacks are fetched only if needed.
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.endsWith('.woff') && f !== 'sw.js');
      const assets = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
        ...files.map((f) => '/' + f)];
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
      const source = SW_SOURCE.replace('__VERSION__', version).replace('__ASSETS__', JSON.stringify(assets));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

const SW_SOURCE = `// Generated at build time. Caches the app shell only, never API data.
const VERSION = 'cadence-__VERSION__';
const ASSETS = __ASSETS__;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always network, never cached
  if (req.mode === 'navigate') {
    // Network first so updates arrive; fall back to the cached shell offline.
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && url.pathname.startsWith('/assets/')) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  })));
});
`;

export default defineConfig({
  plugins: [serviceWorker()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
  },
});
