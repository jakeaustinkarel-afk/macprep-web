// MACPrep service worker — installable PWA with an app-shell cache.
// Strategy: network-first for HTML + app.js (so deploys land immediately, with an
// offline fallback to the cached shell), stale-while-revalidate for static assets
// (icons/fonts/images load instantly), and API calls always go to the network.
const CACHE = 'macprep-v3';
const OFFLINE = '/offline.html';
const SHELL = ['/', '/src/app.js', OFFLINE, '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req) {
  return fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  }).catch(() => caches.match(req).then((m) => {
    if (m) return m;
    if (req.mode === 'navigate') return caches.match('/').then((s) => s || caches.match(OFFLINE));
    return Response.error();
  }));
}

function staleWhileRevalidate(req) {
  return caches.open(CACHE).then((c) => c.match(req).then((cached) => {
    const fetching = fetch(req).then((res) => {
      if (res && res.ok) c.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || fetching;
  }));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // API responses are never cached — always fresh (offline studying is a later phase).
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // HTML shell + app logic → network-first so a deploy is picked up right away;
  // falls back to the cached shell (then the offline page) when there's no network.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname === '/src/app.js') {
    e.respondWith(networkFirst(req));
    return;
  }

  // Everything else same-origin (icons, images, css) + cross-origin fonts → fast,
  // cache-first with a background refresh.
  e.respondWith(staleWhileRevalidate(req));
});

// --- Push notifications (Level 5 scaffold) --------------------------------------
// The send-side (VAPID keys + a server job) is not wired yet; these handlers make the
// SW ready to receive/display pushes once it is, so no client change is needed later.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'MACPrep';
  const options = {
    body: data.body || 'Time for a quick review session.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    tag: data.tag || 'macprep',
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
