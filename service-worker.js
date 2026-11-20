const CACHE_NAME = 'smart-clock-v32';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './privacy.html',
  './terms.html'
];

const VIBE_BY_LEVEL = [
  [400, 150, 400, 150, 400],
  [550, 120, 550, 120, 550, 120, 550],
  [750, 100, 750, 100, 750, 100, 750],
  [1000, 80, 1000, 80, 1000, 80, 1000]
];

let isAlarmDismissed = false;
let isLocalVibeActive = false;
let latestAlarmPayload = null;
let dismissedAlarmIds = new Set();

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

async function dismissOnServer(alarmId = null, scheduleKey = null) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch('./api/push-dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), alarmId, scheduleKey })
    });
  } catch (e) {}
}

async function runLocalVibrationLoop(payload) {
  if (isLocalVibeActive) return;
  isLocalVibeActive = true;
  isAlarmDismissed = false;
  latestAlarmPayload = payload;

  const sLevel = Math.max(0, Number(payload.snoozeLevel) || 0);
  const vibePattern = VIBE_BY_LEVEL[Math.min(sLevel, VIBE_BY_LEVEL.length - 1)];
  const title = payload.title || `⏰ ${payload.label || '알람'}`;
  const body = payload.body || '알람이 울리고 있습니다 · [✕ 알람 끄기]를 눌러 종료하세요.';

  try {
    let count = 0;
    while (!isAlarmDismissed && count < 40) {
      count++;
      await self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: vibePattern,
        requireInteraction: true,
        renotify: true,
        silent: false,
        tag: `smart-clock-bg-vibe-${payload.alarmId || 'active'}`,
        actions: [
          { action: 'dismiss_alarm', title: '✕ 알람 끄기' },
          { action: 'open_app', title: '📱 시계 열기' }
        ],
        data: { url: './index.html', payload }
      });
      await sleep(3200);
    }
  } finally {
    isLocalVibeActive = false;
  }
}

self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'TRIGGER_BG_VIBRATION') {
    const payload = event.data.payload || {};
    if (payload.alarmId) dismissedAlarmIds.delete(String(payload.alarmId));
    event.waitUntil(runLocalVibrationLoop(payload));
  }

  if (event.data.type === 'STOP_INFINITE_PUSH') {
    isAlarmDismissed = true;
    isLocalVibeActive = false;
    const targetAlarmId = event.data.alarmId || (latestAlarmPayload && latestAlarmPayload.alarmId) || null;
    const scheduleKey = event.data.scheduleKey || (latestAlarmPayload && latestAlarmPayload.scheduleKey) || null;
    if (targetAlarmId) dismissedAlarmIds.add(String(targetAlarmId));
    self.registration.getNotifications().then(list => list.forEach(n => n.close()));
    dismissOnServer(targetAlarmId, scheduleKey);
  }
});

self.addEventListener('push', (event) => {
  let payload = {
    type: 'alarm',
    urgentBurstMode: false,
    title: '⏰ 알람',
    body: '알람이 울립니다!',
    label: '알람',
    name: '알람',
    group: '기본 그룹',
    sound: 0,
    isRepeating: false,
    snoozeInterval: 5,
    snoozeCount: 3,
    remainingSnooze: 3,
    snoozeLevel: 0
  };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (error) {
    if (event.data) payload.body = event.data.text();
  }

  if (payload.alarmId && dismissedAlarmIds.has(String(payload.alarmId)) && payload.urgentBurstMode) {
    return;
  }

  isAlarmDismissed = false;
  latestAlarmPayload = payload;

  const sLevel = Math.max(0, Number(payload.snoozeLevel) || 0);
  const sCount = Math.max(1, Number(payload.snoozeCount) || 3);
  const rSnooze = Number.isFinite(Number(payload.remainingSnooze)) ? Math.max(0, Number(payload.remainingSnooze)) : sCount;
  const sInterval = Math.max(1, Number(payload.snoozeInterval) || 5);
  const vibePattern = VIBE_BY_LEVEL[Math.min(sLevel, VIBE_BY_LEVEL.length - 1)];

  const params = new URLSearchParams();
  if (payload.type === 'timer') {
    params.set('triggerTimer', '1');
    params.set('timerMs', String(Number(payload.totalMs) || 0));
  } else {
    params.set('triggerAlarm', '1');
    if (payload.alarmId) params.set('alarmId', String(payload.alarmId));
    if (payload.name) params.set('name', String(payload.name));
    if (payload.group) params.set('group', String(payload.group));
    if (payload.time) params.set('time', String(payload.time));
    if (Number.isFinite(Number(payload.sound))) params.set('sound', String(Number(payload.sound)));
    params.set('isRepeating', payload.isRepeating ? '1' : '0');
    params.set('snoozeInterval', String(sInterval));
    params.set('snoozeCount', String(sCount));
    params.set('remainingSnooze', String(rSnooze));
    params.set('snoozeLevel', String(sLevel));
    if (payload.scheduleKey) params.set('scheduleKey', String(payload.scheduleKey));
  }
  params.set('label', payload.label || payload.title || '알람');
  params.set('body', payload.body || '알람이 울립니다!');
  const targetUrl = `./index.html?${params.toString()}`;

  const baseOptions = {
    body: payload.body || `다시 울림 ${sInterval}분 (${rSnooze}/${sCount}회 남음 · 강도 Lv.${sLevel + 1})`,
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: vibePattern,
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
    await self.registration.showNotification(payload.title || '⏰ 알람', baseOptions);

    if (payload.urgentBurstMode) {
      let count = 1;
      while (!isAlarmDismissed) {
        await sleep(3200);
        if (isAlarmDismissed) break;
        count++;
        await self.registration.showNotification(
          `🚨 (Lv.${sLevel + 1} · ${count}회차) ${payload.label || '알람'}`,
          Object.assign({}, baseOptions, {
            tag: `smart-clock-urgent-burst-${payload.alarmId || 'active'}`,
            renotify: true,
            vibrate: vibePattern,
            body: `다시 울림 ${rSnooze}/${sCount}회 남음 · [✕ 알람 끄기]를 누르기 전까지 반복됩니다.`
          })
        );
      }
    }
  };

  event.waitUntil(Promise.all([deliverNotifications(), notifyClients]));
});

self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  const data = event.notification.data || {};
  const payload = data.payload || latestAlarmPayload || {};
  const alarmId = payload.alarmId || null;
  const scheduleKey = payload.scheduleKey || null;
  event.notification.close();

  isAlarmDismissed = true;
  isLocalVibeActive = false;
  if (alarmId) dismissedAlarmIds.add(String(alarmId));

  if (action === 'dismiss_alarm') {
    event.waitUntil(
      Promise.all([
        self.registration.getNotifications().then(list => list.forEach(n => n.close())),
        dismissOnServer(alarmId, scheduleKey),
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
          for (const client of clientList) {
            client.postMessage({
              type: 'ALARM_DISMISSED_FROM_PUSH',
              alarmId,
              scheduleKey,
              payload
            });
          }
        })
      ])
    );
    return;
  }

  const targetUrl = data.url || './index.html';
  event.waitUntil(
    Promise.all([
      self.registration.getNotifications().then(list => list.forEach(n => n.close())),
      dismissOnServer(alarmId, scheduleKey),
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
