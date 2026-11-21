'use strict';

/*
 * 중요: 푸시를 받으면 "항상" 알림을 표시합니다.
 * iOS Safari/Chrome은 알림 없이 끝나는 푸시가 몇 번 쌓이면 푸시 구독을 끊어 버립니다.
 * (이전 버전은 알람을 끈 직후 도착한 푸시를 알림 없이 무시해서 이후 푸시가 오지 않는 문제가 있었습니다.)
 */

const CACHE_NAME = 'smart-clock-v20261121-b';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CLOSE_ALARM_NOTIFICATIONS') {
    event.waitUntil(
      self.registration.getNotifications().then((list) => list.forEach((n) => {
        if (!data.alarmId || (n.data && String(n.data.alarmId) === String(data.alarmId))) n.close();
      }))
    );
  }
});

function isIOSWorker() {
  const ua = self.navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Firefox|Edg/.test(ua));
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: '⏰ 알람', body: event.data ? event.data.text() : '알람 시간입니다.' };
  }

  event.waitUntil((async () => {
    const options = {
      body: payload.body || '알람 시간입니다.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: payload.tag || `alarm-${payload.alarmId || 'ring'}-${payload.at || Date.now()}`,
      renotify: true,
      silent: false,
      requireInteraction: true,
      vibrate: [800, 200, 800, 200, 800, 200, 800],
      timestamp: Number(payload.at) || Date.now(),
      data: payload
    };
    if (!isIOSWorker()) {
      options.actions = [{ action: 'dismiss', title: '✕ 알람 끄기' }];
    }
    // 반드시 알림을 먼저 띄웁니다.
    await self.registration.showNotification(payload.title || '⏰ 알람', options);

    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload });
  })());
});

async function sendDismiss(alarmId) {
  const sub = await self.registration.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push?action=dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON(), alarmId: alarmId || '' })
  }).catch(() => {});
}

self.addEventListener('notificationclick', (event) => {
  const payload = event.notification.data || {};
  event.notification.close();

  if (event.action === 'dismiss') {
    event.waitUntil((async () => {
      const list = await self.registration.getNotifications();
      list.forEach((n) => { if (!n.data || String(n.data.alarmId) === String(payload.alarmId)) n.close(); });
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) client.postMessage({ type: 'ALARM_DISMISSED_FROM_PUSH', alarmId: payload.alarmId || '' });
      await sendDismiss(payload.alarmId);
    })());
    return;
  }

  event.waitUntil((async () => {
    const params = new URLSearchParams({
      ring: '1',
      alarmId: payload.alarmId || '',
      at: payload.at ? String(payload.at) : '',
      name: payload.name || '알람',
      time: payload.time || '',
      sound: payload.sound !== undefined ? String(payload.sound) : '0'
    });
    const targetUrl = `/?${params.toString()}`;
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload, fromClick: true });
      if ('focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
