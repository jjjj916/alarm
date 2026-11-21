'use strict';

const CACHE_NAME = 'smart-clock-v20261121-ios-stop-fix';
const dismissedTokens = new Set();
let pendingRepeatTimer = null;

function rememberDismissed(alarmId, scheduleKey) {
  if (alarmId) dismissedTokens.add(`id:${alarmId}`);
  if (scheduleKey) dismissedTokens.add(`key:${scheduleKey}`);
  if (pendingRepeatTimer) {
    clearTimeout(pendingRepeatTimer);
    pendingRepeatTimer = null;
  }
}

function isDismissed(payload) {
  if (!payload) return false;
  if (payload.alarmId && dismissedTokens.has(`id:${payload.alarmId}`)) return true;
  if (payload.scheduleKey && dismissedTokens.has(`key:${payload.scheduleKey}`)) return true;
  return false;
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
    rememberDismissed(data.alarmId, data.scheduleKey);
    self.registration.getNotifications().then((list) => list.forEach((n) => n.close()));
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: '⏰ 알람', body: event.data ? event.data.text() : '알람 시간입니다.' };
  }

  if (isDismissed(payload)) return;

  event.waitUntil((async () => {
    const title = payload.title || '⏰ 알람';
    const body = payload.body || '알람 시간이 되었습니다.';
    await self.registration.showNotification(title, {
      body,
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

    if (payload.urgentBurstMode && !isDismissed(payload)) {
      if (pendingRepeatTimer) clearTimeout(pendingRepeatTimer);
      pendingRepeatTimer = setTimeout(async () => {
        pendingRepeatTimer = null;
        if (isDismissed(payload)) return;
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

async function dismissAlarmFromWorker(payload) {
  const alarmId = payload && payload.alarmId ? String(payload.alarmId) : '';
  const scheduleKey = payload && payload.scheduleKey ? String(payload.scheduleKey) : '';
  rememberDismissed(alarmId, scheduleKey);

  const notifications = await self.registration.getNotifications();
  notifications.forEach((n) => n.close());

  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of allClients) {
    client.postMessage({ type: 'ALARM_DISMISSED_FROM_PUSH', alarmId, scheduleKey });
  }

  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push?action=dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), alarmId, scheduleKey, stopAllUrgent: true })
      });
    }
  } catch {}
}

self.addEventListener('notificationclick', (event) => {
  const payload = event.notification.data || {};
  event.notification.close();

  if (event.action === 'dismiss') {
    event.waitUntil(dismissAlarmFromWorker(payload));
    return;
  }

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload });
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow('/');
    }
  })());
});
