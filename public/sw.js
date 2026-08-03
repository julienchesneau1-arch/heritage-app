/*
 * Service Worker — Héritage.
 *
 * Stratégie : réseau d'abord, cache en secours.
 *
 * Le sens ici n'est pas la performance, c'est la dispensabilité (Constitution,
 * §7) : une famille en déplacement, dans une maison sans réseau, doit pouvoir
 * relire ce qu'elle a déjà lu. Le cache est une copie de courtoisie, jamais la
 * source de vérité — d'où le réseau en premier.
 *
 * Ce qui n'est JAMAIS mis en cache : les écritures, et l'export. Servir un
 * export périmé donnerait à la famille une image fausse de sa propre mémoire.
 */

const CACHE = 'heritage-v1';
const OFFLINE_URL = '/hors-ligne';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // L'export doit toujours être frais : il engage ce que la famille croit posséder.
  if (url.pathname.endsWith('/export')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match(OFFLINE_URL);
        return Response.error();
      }),
  );
});
