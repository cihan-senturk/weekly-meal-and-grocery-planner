// Service worker: lets the site open without signal (e.g. in the shop) and be installed on the home screen.
//
// Strategy: the site's own files are network-first with a short timeout, so an online visit always gets
// the latest version (no cache version to bump on deploy) and a weak or missing connection falls back to
// the copy saved on the last visit. The Firebase SDK files are versioned in their URL, so they are
// cache-first. Firestore's own traffic is left alone (it has its own offline cache).
// When adding a file to the site, add it to APP_FILES too.

const CACHE = 'ne-pisirsem';
const NETWORK_TIMEOUT_MS = 3000;
const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/app.js', 'js/dates.js', 'js/export.js', 'js/firebase-config.js', 'js/i18n.js', 'js/nutrition.js',
  'js/qr.js', 'js/shopping.js', 'js/storage.js', 'js/sync.js', 'js/sync-firebase.js',
  'locales/tr.json',
  'data/catalog.json',
  'fonts/sofia-sans.woff', 'fonts/sofia-sans-italic.woff', 'fonts/sofia-sans-condensed.woff', 'fonts/sofia-sans-condensed-italic.woff',
  'icons/favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One by one, so a single missing file does not stop the rest from being saved.
    await Promise.all(APP_FILES.map((path) => cache.add(new Request(path, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.href.startsWith(FIREBASE_SDK)) {
    event.respondWith(cacheFirst(request));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const isPage = request.mode === 'navigate';
  const network = fetch(request).then((response) => {
    // Pages are stored without their query or hash, so a scanned #sync= link opens offline too.
    if (response.ok) cache.put(isPage ? new Request(self.registration.scope) : request, response.clone());
    return response;
  });
  network.catch(() => {}); // a late failure after the timeout is not an error
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch { /* offline: use the saved copy */ }
  const cached = isPage
    ? await cache.match(self.registration.scope) ?? await cache.match('index.html')
    : await cache.match(request, { ignoreSearch: true });
  return cached ?? network; // nothing saved yet: wait for the network after all
}
