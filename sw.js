// Offline cache + notification click handling. Bump CACHE when files change.
const CACHE = 'time-keeper-v6';
const FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/lines.js', 'icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list[0];
    if (c) { c.focus(); c.postMessage({ type: 'open-checkin' }); }
    else self.clients.openWindow('./?checkin');
  }));
});
