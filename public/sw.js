// Service worker mínimo: guarda la "cáscara" de la app para abrirla rápido; nunca toca /api.
const V = 'dma-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/fondo.jpg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== V).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // red primero (para que las actualizaciones lleguen), caché como respaldo sin conexión
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(V).then((ca) => ca.put(e.request, c)); } return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});
