'use strict';

const CACHE_NAME = 'smart-clock-ios-clean-v20261121';

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
  const options = {
    body: data.body || '알람 시각입니다.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: data.tag || `smart-clock-${Date.now()}`,
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
