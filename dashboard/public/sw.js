// Caches the app's own files so the dashboard opens offline. Trading data is never cached:
// a stale price or position shown as current would be worse than an error.
const CACHE = "mahoraga-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png"];
const LIVE_PATHS = ["/api", "/agent", "/mcp", "/health"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function store(request, response) {
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (LIVE_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) return;

  if (request.mode === "navigate") {
    // Always try the network first so a new deploy is picked up; fall back to the cached shell offline.
    event.respondWith(
      fetch(request)
        .then((response) => store("/", response))
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error()))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    // Built files have a content hash in their name, so a cached copy never goes stale.
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetch(request).then((response) => store(request, response)))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => store(request, response))
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error()))
  );
});
