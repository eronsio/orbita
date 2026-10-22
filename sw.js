// Orbita service worker: lets the app open with no connection and load faster.
// The page itself is fetched network-first, so a new deploy is never hidden behind an old copy.
// Anything that talks to Supabase (sign-in, sync) is never touched or cached.
const SHELL = 'orbita-shell-v1';
const LIBS = 'orbita-libs-v1';
const TILES = 'orbita-tiles-v1';
const KEEP = [SHELL, LIBS, TILES];
const LIB_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];
const TILE_HOSTS = ['services.arcgisonline.com', 'tile.openstreetmap.org'];
const MAX_TILES = 500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icon-192.png'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Fetch with CORS where we can, so what we cache is a normal response (opaque ones are counted at ~7 MB each by browsers)
const fetchCors = (req) => fetch(req.url, { mode: 'cors', credentials: 'omit' }).catch(() => fetch(req));

const staleWhileRevalidate = async (cacheName, req, { trim = 0 } = {}) => {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  const refresh = fetchCors(req).then(async (res) => {
    if (res && res.ok && res.type !== 'opaque') {
      await cache.put(req.url, res.clone());
      if (trim) cache.keys().then((keys) => { if (keys.length > trim) keys.slice(0, keys.length - trim).forEach((k) => cache.delete(k)); });
    }
    return res;
  });
  if (hit) { refresh.catch(() => {}); return hit; }
  return refresh;
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol) || url.hostname.endsWith('supabase.co')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(async (res) => {
        if (res.ok) (await caches.open(SHELL)).put('./', res.clone());
        return res;
      }).catch(async () => (await caches.match('./', { ignoreSearch: true })) || Response.error()),
    );
  } else if (url.origin === self.location.origin) {
    event.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req);
      const refresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; });
      if (hit) { refresh.catch(() => {}); return hit; }
      return refresh;
    }));
  } else if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(LIBS, req));
  } else if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    event.respondWith(staleWhileRevalidate(TILES, req, { trim: MAX_TILES }));
  }
});
