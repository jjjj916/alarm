import webpush from 'web-push';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function scheduleNextQStash(origin, delaySeconds = 15) {
  if (!process.env.QSTASH_TOKEN) return false;
  const targetUrl = `${origin}/api/push?action=check`;
  const res = await fetch(`https://qstash.upstash.io/v2/publish/${targetUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      'Upstash-Delay': `${delaySeconds}s`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ trigger: 'urgent-repeat' })
  }).catch(() => null);
  return Boolean(res && res.ok);
}

export default async function handler(req, res) {
  const action = String(req.query.action || 'check').toLowerCase();
  const origin = `https://${req.headers.host}`;
  const body = req.body || {};

  try {
    if (action === 'config') {
      return res.status(200).json({
        enabled: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY || ''
      });
    }

    if (action === 'subscribe') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { subscription, alarms = [], timeZone = 'Asia/Seoul', urgentBurstMode = false, clearRinging = false } = body;
      if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

      const subKey = `push_sub:${Buffer.from(subscription.endpoint).toString('base64url')}`;
      const existing = (await redis.get(subKey)) || {};
      const record = {
        subscription,
        alarms,
        timeZone,
        urgentBurstMode: Boolean(urgentBurstMode),
        dismissedUntil: clearRinging ? Date.now() + 90000 : (existing.dismissedUntil || 0),
        updatedAt: Date.now()
      };
      await redis.set(subKey, record);

      let nextExactTriggerAt = null;
      for (const a of alarms) {
        if (a.enabled && !a.isRepeating && a.singleShotAt && Number(a.singleShotAt) > Date.now()) {
          if (!nextExactTriggerAt || Number(a.singleShotAt) < nextExactTriggerAt) {
            nextExactTriggerAt = Number(a.singleShotAt);
          }
        }
      }
      if (nextExactTriggerAt) {
        const delaySec = Math.max(1, Math.ceil((nextExactTriggerAt - Date.now()) / 1000));
        await scheduleNextQStash(origin, delaySec);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'dismiss') {
      const { subscription, alarmId } = body;
      if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
      const subKey = `push_sub:${Buffer.from(subscription.endpoint).toString('base64url')}`;
      const record = await redis.get(subKey);
      if (record) {
        record.dismissedUntil = Date.now() + 90000;
        if (Array.isArray(record.alarms)) {
          record.alarms = record.alarms.map((a) => (!alarmId || String(a.id) === String(alarmId))
            ? { ...a, enabled: false, singleShotAt: null }
            : a
          );
        }
        await redis.set(subKey, record);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'test') {
      const { subscription, sound = 0 } = body;
      if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });
      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title: '📡 테스트 푸시 알람',
          body: '설정된 12종 알람음과 동일한 사운드로 작동합니다.',
          alarmId: 'test',
          name: '테스트 알람',
          group: '테스트',
          sound: Number(sound) || 0
        }),
        { urgency: 'high', TTL: 60 }
      );
      return res.status(200).json({ ok: true });
    }

    if (body.subscription && body.subscription.endpoint) {
      const subKey = `push_sub:${Buffer.from(body.subscription.endpoint).toString('base64url')}`;
      const record = await redis.get(subKey);
      if (!record || !record.urgentBurstMode) return res.status(200).json({ ok: true, stopped: true });
      if (record.dismissedUntil && Date.now() < Number(record.dismissedUntil)) {
        return res.status(200).json({ ok: true, stoppedByDismiss: true });
      }
      const targetAlarm = (record.alarms || []).find(a => String(a.id) === String(body.repeatAlarmId));
      if (!targetAlarm || !targetAlarm.enabled) return res.status(200).json({ ok: true, disabled: true });

      await webpush.sendNotification(
        record.subscription,
        JSON.stringify({
          title: `🚨 [반복] ${targetAlarm.name || '알람'}`,
          body: '[✕ 알람 끄기]를 누르기 전까지 15초마다 반복 발송됩니다.',
          alarmId: String(targetAlarm.id),
          name: targetAlarm.name || '알람',
          group: targetAlarm.group || '긴급 알람',
          time: targetAlarm.time || '',
          sound: targetAlarm.sound ?? 0,
          scheduleKey: body.scheduleKey || '',
          urgentBurstMode: true
        }),
        { urgency: 'high', TTL: 60 }
      );
      return res.status(200).json({ ok: true, repeated: true });
    }

    const keys = await redis.keys('push_sub:*');
    const nowMs = Date.now();
    let sentCount = 0;
    let hasActiveUrgent = false;

    for (const key of keys) {
      const record = await redis.get(key);
      if (!record || !record.subscription || !Array.isArray(record.alarms)) continue;
      if (record.dismissedUntil && nowMs < Number(record.dismissedUntil)) continue;

      const tz = record.timeZone || 'Asia/Seoul';
      const urgentBurstMode = Boolean(record.urgentBurstMode);
      let updated = false;

      for (const alarm of record.alarms) {
        if (!alarm.enabled) continue;
        let due = false;
        let scheduleKey = '';

        if (!alarm.isRepeating && alarm.singleShotAt) {
          const diff = nowMs - Number(alarm.singleShotAt);
          scheduleKey = `oneshot_${alarm.id}_${alarm.singleShotAt}`;
          if (diff >= -5000 && diff <= 180000) due = true;
        } else if (alarm.isRepeating) {
          const localDate = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: tz }));
          const curHM = `${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`;
          const dateTag = `${localDate.getFullYear()}-${localDate.getMonth() + 1}-${localDate.getDate()}`;
          scheduleKey = `rep_${alarm.id}_${dateTag}_${curHM}`;
          if ((alarm.days || []).includes(localDate.getDay()) && alarm.time === curHM) due = true;
        }

        if (due) {
          if (!urgentBurstMode && alarm.lastSentKey === scheduleKey) continue;
          if (urgentBurstMode && alarm.lastSentAt && nowMs - Number(alarm.lastSentAt) < 12000) continue;

          await webpush.sendNotification(
            record.subscription,
            JSON.stringify({
              title: `⏰ [${alarm.group || '알람'}] ${alarm.name || '알람'}`,
              body: urgentBurstMode ? `${alarm.time} 알람 · [✕ 알람 끄기]를 누르기 전까지 반복됩니다.` : `${alarm.time} 알람이 울립니다.`,
              alarmId: String(alarm.id),
              name: alarm.name || '알람',
              group: alarm.group || '알람',
              time: alarm.time || '',
              sound: alarm.sound ?? 0,
              scheduleKey,
              urgentBurstMode
            }),
            { urgency: 'high', TTL: 60 }
          ).catch(() => {});

          alarm.lastSentKey = scheduleKey;
          alarm.lastSentAt = nowMs;
          if (!urgentBurstMode && !alarm.isRepeating) alarm.enabled = false;
          if (urgentBurstMode) hasActiveUrgent = true;
          updated = true;
          sentCount++;
        }
      }
      if (updated) await redis.set(key, record);
    }

    if (hasActiveUrgent) await scheduleNextQStash(origin, 15);
    return res.status(200).json({ ok: true, sentCount, hasActiveUrgent });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
