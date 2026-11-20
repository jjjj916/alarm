const CACHE_NAME = 'smart-clock-v22';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './privacy.html',
  './terms.html'
];

let isAlarmDismissed = false;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dismissOnServer() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch('./api/push-dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() })
    });
  } catch (e) {}
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'STOP_INFINITE_PUSH') {
    isAlarmDismissed = true;
    self.registration.getNotifications().then(list => list.forEach(n => n.close()));
    dismissOnServer();
  }
});

self.addEventListener('push', (event) => {
  isAlarmDismissed = false;

  let payload = {
    type: 'alarm',
    urgentBurstMode: false,
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

  const baseOptions = {
    body: payload.body || '알람이 울립니다!',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [800, 150, 800, 150, 800, 150, 800],
    requireInteraction: true,
    renotify: true,
    silent: false,
    tag: payload.tag || `smart-clock-${payload.type || 'alarm'}-${Date.now()}`,
    actions: [
      { action: 'dismiss_alarm', title: '✕ 알람 끄기' },
      { action: 'open_app', title: '📱 시계 열기' }
    ],
    data: { url: targetUrl, payload }
  };

  const notifyClients = clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      client.postMessage({ type: 'PUSH_ALARM_TRIGGER', payload });
    }
  });

  const deliverNotifications = async () => {
    await self.registration.showNotification(payload.title || '⏰ 스마트 시계 알람', baseOptions);

    if (payload.urgentBurstMode) {
      let count = 1;
      while (!isAlarmDismissed) {
        await sleep(3500);
        if (isAlarmDismissed) break;
        count++;
        await self.registration.showNotification(
          `🚨 (${count}회차 긴급 알림) ${payload.label || '스마트 시계 알람'}`,
          Object.assign({}, baseOptions, {
            tag: `smart-clock-urgent-burst-${Date.now()}-${count}`,
            body: '다른 앱 사용 중 알람이 울리고 있습니다! [✕ 알람 끄기]를 누르기 전까지 무제한 반복됩니다.'
          })
        );
      }
    }
  };

  event.waitUntil(Promise.all([deliverNotifications(), notifyClients]));
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  event.notification.close();

  if (action === 'dismiss_alarm') {
    isAlarmDismissed = true;
    event.waitUntil(
      Promise.all([
        self.registration.getNotifications().then(list => list.forEach(n => n.close())),
        dismissOnServer(),
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
          for (const client of clientList) {
            client.postMessage({ type: 'ALARM_DISMISSED_FROM_PUSH' });
          }
        })
      ])
    );
    return;
  }

  isAlarmDismissed = true;
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    Promise.all([
      self.registration.getNotifications().then(list => list.forEach(n => n.close())),
      dismissOnServer(),
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        for (const client of clientList) {
          if ('focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
    ])
  );
});
