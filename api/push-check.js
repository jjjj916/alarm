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
  const targetUrl = `${origin}/api/push-check`;
  const publishUrl = `https://qstash.upstash.io/v2/publish/${targetUrl}`;
  const res = await fetch(publishUrl, {
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
  try {
    const origin = `https://${req.headers.host}`;
    const body = req.body || {};

    // 서비스 워커의 15초 체인 재호출인 경우 해당 구독자에게 즉시 재발송
    if (body.subscription && body.subscription.endpoint) {
      const subKey = `push_sub:${Buffer.from(body.subscription.endpoint).toString('base64url')}`;
      const record = await redis.get(subKey);
      if (!record || !record.urgentBurstMode) {
        return res.status(200).json({ ok: true, stopped: true });
      }
      const dismissedList = Array.isArray(record.dismissedKeys) ? record.dismissedKeys : [];
      if (body.scheduleKey && dismissedList.includes(body.scheduleKey)) {
        return res.status(200).json({ ok: true, dismissed: true });
      }

      const targetAlarm = (record.alarms || []).find(a => String(a.id) === String(body.repeatAlarmId)) || {
        id: body.repeatAlarmId || 'urgent',
        name: '긴급 반복 알람',
        group: '긴급 알람',
        sound: 2
      };

      await webpush.sendNotification(
        record.subscription,
        JSON.stringify({
          title: `🚨 [반복] ${targetAlarm.name || '알람'}`,
          body: '[✕ 알람 끄기]를 누르기 전까지 15초마다 반복 발송됩니다.',
          alarmId: String(targetAlarm.id),
          name: targetAlarm.name || '알람',
          group: targetAlarm.group || '긴급 알람',
          time: targetAlarm.time || '',
          sound: targetAlarm.sound ?? 2,
          scheduleKey: body.scheduleKey || '',
          urgentBurstMode: true
        }),
        { urgency: 'high', TTL: 60 }
      );
      return res.status(200).json({ ok: true, repeated: true });
    }

    // 일반 QStash/Cron 정각 체크
    const keys = await redis.keys('push_sub:*');
    const nowMs = Date.now();
    let sentCount = 0;
    let hasActiveUrgent = false;

    for (const key of keys) {
      const record = await redis.get(key);
      if (!record || !record.subscription || !Array.isArray(record.alarms)) continue;

      const tz = record.timeZone || 'Asia/Seoul';
      const urgentBurstMode = Boolean(record.urgentBurstMode);
      const dismissedKeys = Array.isArray(record.dismissedKeys) ? record.dismissedKeys : [];
      let updated = false;

      for (const alarm of record.alarms) {
        if (!alarm.enabled) continue;

        let due = false;
        let scheduleKey = '';

        if (!alarm.isRepeating && alarm.singleShotAt) {
          const diff = nowMs - Number(alarm.singleShotAt);
          scheduleKey = `oneshot_${alarm.id}_${alarm.singleShotAt}`;
          if (diff >= -5000 && diff <= 180000 && !dismissedKeys.includes(scheduleKey)) {
            due = true;
          }
        } else if (alarm.isRepeating) {
          const localStr = new Date(nowMs).toLocaleString('en-US', { timeZone: tz });
          const localDate = new Date(localStr);
          const curHM = `${String(localDate.getHours()).padStart(2, '0')}:${String(localDate.getMinutes()).padStart(2, '0')}`;
          const dateTag = `${localDate.getFullYear()}-${localDate.getMonth() + 1}-${localDate.getDate()}`;
          scheduleKey = `rep_${alarm.id}_${dateTag}_${curHM}`;
          if ((alarm.days || []).includes(localDate.getDay()) && alarm.time === curHM && !dismissedKeys.includes(scheduleKey)) {
            due = true;
          }
        }

        if (due) {
          if (!urgentBurstMode && alarm.lastSentKey === scheduleKey) continue;
          if (urgentBurstMode && alarm.lastSentAt && nowMs - Number(alarm.lastSentAt) < 12000) continue;

          await webpush.sendNotification(
            record.subscription,
            JSON.stringify({
              title: `⏰ [${alarm.group || '알람'}] ${alarm.name || '알람'}`,
              body: urgentBurstMode
                ? `${alarm.time} 알람 · [✕ 알람 끄기]를 누르기 전까지 반복됩니다.`
                : `${alarm.time} 알람이 울립니다.`,
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
          if (!urgentBurstMode && !alarm.isRepeating) {
            alarm.enabled = false;
          }
          if (urgentBurstMode) hasActiveUrgent = true;
          updated = true;
          sentCount++;
        }
      }

      if (updated) {
        await redis.set(key, record);
      }
    }

    // 무제한 긴급알림이 활성 상태면 서버 측에서도 15초 뒤 QStash를 연쇄 예약
    if (hasActiveUrgent) {
      await scheduleNextQStash(origin, 15);
    }

    return res.status(200).json({ ok: true, sentCount, hasActiveUrgent });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
