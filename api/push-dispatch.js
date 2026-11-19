import webpush from 'web-push';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

function getNowInTimeZone(timeZone = 'Asia/Seoul') {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekdayShort = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short'
  }).format(now);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeHM: `${map.hour}:${map.minute}`,
    dayIndex: dayMap[weekdayShort] ?? now.getDay()
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않은 요청 방식입니다.' });
  }

  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: '인증되지 않은 요청입니다.' });
    }
  }

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_SUBJECT) {
    return res.status(500).json({ error: 'VAPID 환경 변수가 설정되지 않았습니다.' });
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  try {
    const keys = await redis.smembers('push:sub:index');
    let sentCount = 0;

    for (const subKey of keys || []) {
      const record = await redis.get(subKey);
      if (!record || !record.subscription || !Array.isArray(record.alarms)) continue;

      const { dateKey, timeHM, dayIndex } = getNowInTimeZone(record.timeZone || 'Asia/Seoul');
      let mutated = false;

      for (const alarm of record.alarms) {
        const matchesDay = !alarm.days || alarm.days.length === 0 || alarm.days.includes(dayIndex);
        const dispatchKey = `${dateKey}_${timeHM}`;

        if (matchesDay && alarm.time === timeHM && alarm.lastPushedKey !== dispatchKey) {
          const payload = JSON.stringify({
            title: `[${alarm.group || '알람'}] ${alarm.name || '알람'}`,
            body: `${alarm.time} 설정된 알람 시간입니다.`,
            url: './index.html',
            tag: `alarm-${alarm.id}`
          });

          try {
            await webpush.sendNotification(record.subscription, payload);
            alarm.lastPushedKey = dispatchKey;
            mutated = true;
            sentCount++;
          } catch (pushErr) {
            if (pushErr.statusCode === 404 || pushErr.statusCode === 410) {
              await redis.del(subKey);
              await redis.srem('push:sub:index', subKey);
              mutated = false;
              break;
            }
          }
        }
      }

      if (mutated) {
        await redis.set(subKey, record);
      }
    }

    return res.status(200).json({ ok: true, sentCount });
  } catch (err) {
    return res.status(500).json({ error: '푸시 발송 처리 중 오류가 발생했습니다.' });
  }
}