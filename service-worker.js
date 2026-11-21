'use strict';

const CACHE_NAME = 'smart-clock-ios-infinite-v20261121-2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '⏰ 알람', body: event.data ? event.data.text() : '알람이 울립니다.' };
  }

  const title = data.title || '⏰ 스마트 시계 알람';
  // iOS에서 매번 기본 알림음이 울리도록 매회 고유 tag 부여
  const uniqueTag = data.tag || `smart-clock-ring-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const options = {
    body: data.body || '배너를 길게 눌러 [✕ 알람 끄기]를 누를 때까지 계속 울립니다.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: uniqueTag,
    renotify: true,
    silent: false,
    data: {
      alarmId: data.alarmId || '',
      scheduleKey: data.scheduleKey || '',
      url: './'
    },
    actions: [
      { action: 'dismiss', title: '✕ 알람 끄기' }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  const notifData = (event.notification && event.notification.data) || {};
  event.notification.close();

  if (event.action === 'dismiss') {
    event.waitUntil(
      self.registration.pushManager.getSubscription().then((sub) => {
        if (!sub) return;
        return fetch('/api/push-dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription: sub.toJSON(),
            alarmId: notifData.alarmId,
            scheduleKey: notifData.scheduleKey
          })
        }).catch(() => {});
      })
    );
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
