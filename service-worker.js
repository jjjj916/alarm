const CACHE_NAME = 'smart-clock-v11';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './privacy.html',
  './terms.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname.includes('/api/')) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.ok && event.request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', (event) => {
  let payload = {
    type: 'alarm',
    title: '⏰ 스마트 시계 알람',
    body: '알람이 울립니다!',
    label: '스마트 시계 알람'
  };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (error) {
    if (event.data) payload.body = event.data.text();
  }

  const params = new URLSearchParams();
  if (payload.type === 'timer') {
    params.set('triggerTimer', '1');
    params.set('timerMs', String(Number(payload.totalMs) || 0));
  } else {
    params.set('triggerAlarm', '1');
    if (payload.alarmId) params.set('alarmId', String(payload.alarmId));
  }
  params.set('label', payload.label || payload.title || '스마트 시계 알람');
  params.set('body', payload.body || '알람이 울립니다!');
  const targetUrl = `./index.html?${params.toString()}`;

  const options = {
    body: payload.body || '알람이 울립니다!',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [500, 150, 500, 150, 500],
    requireInteraction: true,
    renotify: true,
    silent: false,
    tag: payload.tag || `smart-clock-${payload.type || 'alarm'}-${Date.now()}`,
    data: { url: targetUrl }
  };

  event.waitUntil(self.registration.showNotification(payload.title || '⏰ 스마트 시계 알람', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
