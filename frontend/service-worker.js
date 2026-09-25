// Bump this on every deploy where cached files changed, so old caches get evicted.
// AFTER:
// Bump this on every deploy where cached files changed, so old caches get evicted.
const CACHE_NAME = "affordable-rentals-v3";

const FILES_TO_CACHE = [
  "index.html",
  "auth.html",
  "change-password.html",
  "dashboard.html",
  "forgot-password.html",
  "listings.html",
  "privacy.html",
  "stacklord.html",
  "tenant.html",
  "terms.html",
  "public.css",
  "script.js",
  "auth.js",
  "config.js",
  "dashboard.js",
  "icons.js",
  "public.js",
  "session-manager.js",
  "stacklord.js",
  "tenant.js",
  "manifest.json",
  "public/affordablerentalsLogo.png",
  "icons/icon-192.png",
  "icons/icon-512.png"
];
// NOTE: CDN scripts (chart.js, leaflet) are deliberately left out of this list.
// cache.addAll() fails the ENTIRE install step if even one request in it fails,
// and cross-origin requests here can be flaky/opaque — so we let those load
// straight from the network/browser cache instead.

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// AFTER:
self.addEventListener("fetch", event => {
  const req = event.request;

  // Only handle same-origin GET requests. This deliberately skips:
  // - POST/PUT/etc (logins, form submissions, mutations) — never intercept these
  // - cross-origin requests (your backend API, chart.js/leaflet CDNs) — let the
  //   browser handle them normally, so live API data is never served from cache
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // NETWORK-FIRST: always try the network for current app-shell files first,
  // so a normal refresh sees code/markup changes immediately — no more
  // "only works after a hard refresh." Cache is now purely an offline
  // fallback, and stays opportunistically updated on every successful fetch.
  event.respondWith(
    fetch(req)
      .then(networkResponse => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(req)) // offline / network failure → serve last-known-good
  );
});