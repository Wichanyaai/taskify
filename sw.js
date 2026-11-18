// Taskify service worker: offline app shell + push notifications
const CACHE = 'taskify-v2';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/db.js', 'js/config.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // pinned CDN modules never change: cache first
  if (req.url.startsWith(CDN)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }
  // own files: network first, fall back to cache when offline
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))),
    );
  }
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Taskify', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Taskify', {
    body: data.body || '',
    tag: data.tag,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope);
  const taskId = target.searchParams.get('task');
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find(c => c.url.startsWith(self.registration.scope));
    if (client) {
      await client.focus();
      if (taskId) client.postMessage({ type: 'open-task', id: taskId });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
