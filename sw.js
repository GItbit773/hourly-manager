// Offline cache, push notifications and notification taps. Bump CACHE when files change.
const CACHE = 'time-keeper-v10';
const FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/lines.js', 'icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so an update never installs stale files
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // ?checkin / ?priorities links from notifications still load the cached app
  e.respondWith(caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })).then(hit => hit || fetch(e.request)));
});

// A push from the Time Keeper server: { title, body, url, tag }
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Time Keeper', {
    body: d.body || 'Time to check in.',
    tag: d.tag || 'time-keeper',
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: d.url || './?checkin' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './?checkin';
  const type = url.includes('priorities') ? 'open-priorities' : url.includes('checkin') ? 'open-checkin' : null;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list[0];
    if (c) { c.focus(); if (type) c.postMessage({ type }); }
    else self.clients.openWindow(url);
  }));
});
