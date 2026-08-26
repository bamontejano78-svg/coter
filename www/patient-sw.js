const CACHE_NAME = 'coter-patient-shell-v1';
const SHELL = [
  '/paciente.html',
  '/css/patient.css?v=5',
  '/css/widgets.css?v=3',
  '/js/shared-ui.js?v=3',
  '/js/exercise-forms.js?v=3',
  '/js/interactive-widgets.js?v=3',
  '/js/push-notifications.js?v=1',
  '/js/patient.js?v=5',
  '/favicon.svg',
  '/patient-manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (event.request.method === 'GET' && response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
