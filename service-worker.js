'use strict';

const CACHE_NAME = 'smart-clock-v20261121-wakelock-ios-fix';
let dismissedUntil = 0;
let pendingRepeatTimer = null;

function stopAllWorkerLoops() {
  dismissedUntil = Date.now() + 90000;
  if (pendingRepeatTimer) {
    clearTimeout(pendingRepeatTimer);
    pendingRepeatTimer = null;
  }
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'STOP_INFINITE_PUSH') {
    stopAllWorkerLoops();
    self.registration.getNotifications().then((list) => list.forEach((n) => n.close()));
  }
});

self.addEventListener('push', (event) => {
  if (Date.now() < dismissedUntil) return;

  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: '⏰ 알람', body: event.data ? event.data.text() : '알람 시간입니다.' };
  }

  event.waitUntil((async () => {
    if (Date.now() < dismissedUntil) return;
    await self.registration.showNotification(payload.title || '⏰ 알람', {
      body: payload.body || '알람 시간이 되었습니다.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: `smart-clock-${payload.alarmId || 'ring'}-${Date.now()}`,
      silent: false,
      renotify: true,
      requireInteraction: true,
      vibrate: [600, 150, 600, 150, 600],
      data: payload,
      actions: [
        { action: 'dismiss', title: '✕ 알람 끄기' },
        { action: 'ring', title: '🔊 알람음 켜기' }
      ]
    });

    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload });
    }

    if (payload.urgentBurstMode && Date.now() >= dismissedUntil) {
      if (pendingRepeatTimer) clearTimeout(pendingRepeatTimer);
      pendingRepeatTimer = setTimeout(async () => {
        pendingRepeatTimer = null;
        if (Date.now() < dismissedUntil) return;
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/push?action=check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subscription: sub.toJSON(),
              repeatAlarmId: payload.alarmId || '',
              scheduleKey: payload.scheduleKey || ''
            })
          }).catch(() => {});
        }
      }, 15000);
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  const payload = event.notification.data || {};
  event.notification.close();

  if (event.action === 'dismiss') {
    stopAllWorkerLoops();
    event.waitUntil((async () => {
      const list = await self.registration.getNotifications();
      list.forEach((n) => n.close());
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({ type: 'ALARM_DISMISSED_FROM_PUSH', alarmId: payload.alarmId || '' });
      }
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push?action=dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), alarmId: payload.alarmId || '', stopAllUrgent: true })
        }).catch(() => {});
      }
    })());
    return;
  }

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload });
      if ('focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow('/');
  })());
});
