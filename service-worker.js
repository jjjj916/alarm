'use strict';

const dismissedTokens = new Set();

function rememberDismissed(alarmId, scheduleKey) {
  if (alarmId) dismissedTokens.add(`id:${alarmId}`);
  if (scheduleKey) dismissedTokens.add(`key:${scheduleKey}`);
}

function isDismissed(payload) {
  if (!payload) return false;
  if (payload.alarmId && dismissedTokens.has(`id:${payload.alarmId}`)) return true;
  if (payload.scheduleKey && dismissedTokens.has(`key:${payload.scheduleKey}`)) return true;
  return false;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'STOP_INFINITE_PUSH') {
    rememberDismissed(data.alarmId, data.scheduleKey);
    self.registration.getNotifications().then((list) => {
      list.forEach((n) => n.close());
    });
  } else if (data.type === 'TRIGGER_BG_VIBRATION' && data.payload) {
    if (isDismissed(data.payload)) return;
    showAlarmNotification(data.payload);
  }
});

async function showAlarmNotification(payload) {
  if (isDismissed(payload)) return;
  const title = payload.title || '⏰ 알람';
  const body = payload.body || '알람 시간이 되었습니다.';
  const tag = payload.alarmId ? `smart-clock-alarm-${payload.alarmId}` : (payload.tag || 'smart-clock-alarm');

  await self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [500, 150, 500, 150, 500],
    data: payload,
    actions: [
      { action: 'dismiss', title: '✕ 알람 끄기' },
      { action: 'open', title: '앱 열기' }
    ]
  });
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: '⏰ 알람', body: event.data ? event.data.text() : '알람 시간입니다.' };
  }

  if (isDismissed(payload)) return;

  event.waitUntil((async () => {
    await showAlarmNotification(payload);
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload });
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
      await fetch('/api/push-dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: sub.toJSON(),
          alarmId,
          scheduleKey
        })
      });
    }
  } catch (e) {}
}

self.addEventListener('notificationclick', (event) => {
  const payload = event.notification.data || {};
  event.notification.close();

  if (event.action === 'dismiss') {
    event.waitUntil(dismissAlarmFromWorker(payload));
    return;
  }

  event.waitUntil((async () => {
    await dismissAlarmFromWorker(payload);
    const params = new URLSearchParams({
      triggerAlarm: payload.type === 'timer' ? '0' : '1',
      triggerTimer: payload.type === 'timer' ? '1' : '0',
      alarmId: payload.alarmId || '',
      scheduleKey: payload.scheduleKey || '',
      label: payload.label || '알람'
    });
    const targetUrl = `/?${params.toString()}`;
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if ('focus' in client) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
