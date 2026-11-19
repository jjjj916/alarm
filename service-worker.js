const CACHE_NAME = 'smart-clock-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', (event) => {
  let payload = {
    title: '스마트 시계 알람',
    body: '설정된 알람 시간이 되었습니다.',
    url: './index.html',
    tag: 'smart-clock-alarm'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const baseUrl = payload.url || './index.html';
  const separator = baseUrl.includes('?') ? '&' : '?';
  const triggerUrl = `${baseUrl}${separator}triggerAlarm=1&label=${encodeURIComponent(payload.title)}&body=${encodeURIComponent(payload.body)}`;

  const options = {
    body: payload.body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: payload.tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [500, 200, 500, 200, 500],
    data: {
      url: triggerUrl
    }
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html?triggerAlarm=1';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
