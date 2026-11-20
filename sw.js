// Service worker: la app abre al instante y funciona sin conexión.
// Sube VERSION cada vez que publiques cambios para que el iPhone descargue la nueva versión.
const VERSION = 'nest-v2';
const APP_SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/tailwind.css', './css/app.css', './vendor/chart.umd.min.js',
  './js/app.js', './js/store.js', './js/parser.js', './js/insights.js',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/goal-default.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Nunca cachear la API de Apps Script (los datos viven en localStorage + cola)
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;
  if (url.origin === self.location.origin && url.pathname.startsWith('/__')) return; // endpoints del simulador de pruebas

  // Navegación: index.html desde caché (arranque instantáneo), se actualiza en segundo plano
  if (request.mode === 'navigate') {
    e.respondWith(cacheFirst(new Request(new URL('./index.html', self.registration.scope))));
    return;
  }
  e.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => cached || Response.error());
  return cached || network;
}
