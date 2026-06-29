// sw.js — Spark Homes Repair Estimator
// Cache-first precache of the app shell + the 2 heavy CDN libs, so the whole
// app works fully offline after the first visit. Bump CACHE to ship updates.

const CACHE = 'spark-estimator-v2';

const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './data.js',
  './sw.js',
  './assets/icon-180.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll fails atomically if any request fails; add individually so a
      // single flaky CDN response can't block install of the rest.
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // runtime-cache same-origin + the known libs for next time offline
          if (res && res.status === 200 && (req.url.startsWith(self.location.origin) || PRECACHE.includes(req.url))) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html')); // navigation fallback
    })
  );
});
