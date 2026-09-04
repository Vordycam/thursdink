/* Service worker: precache the app shell so everything works offline.
   Strategy: stale-while-revalidate — serve from cache instantly (offline-safe),
   refresh the cache in the background so the next load picks up updates. */
/* Bump this whenever js/ or styles.css changes, or installed apps keep
   serving the old files from cache and never see the update. */
var CACHE = 'pbr-v10';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/storage.js',
  './js/engine.js',
  './js/pdf.js',
  './js/app.js',
  './manifest.webmanifest',
  './logo.jpg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(e.request, { ignoreSearch: true }).then(function (cached) {
        var network = fetch(e.request).then(function (resp) {
          if (resp && resp.ok) cache.put(e.request, resp.clone());
          return resp;
        }).catch(function () { return cached; });
        return cached || network;
      });
    })
  );
});
