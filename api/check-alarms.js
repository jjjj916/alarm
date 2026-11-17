
import webpush from 'web-push';
import { Redis } from '@upstash/redis';

webpush.setVapidDetails(
  'mailto:admin@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DB_KEY = 'alarm_push_subscriptions';

export default async function handler(req, res) {
  try {
    const now = new Date(new Date().getTime() + 9 * 3600 * 1000);
    const currentHours = String(now.getUTCHours()).padStart(2, '0');
    const currentMins = String(now.getUTCMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHours}:${currentMins}`;
    const currentDay = now.getUTCDay();

    let list = (await redis.get(DB_KEY)) || [];
    let sentCount = 0;
    let isModified = false;

    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      for (const alarm of item.alarms) {
        const targetTime = alarm.nextSnoozeTime || alarm.time;
        if (alarm.enabled && targetTime === currentTimeStr && alarm.days.includes(currentDay)) {
          const payload = JSON.stringify({
            title: `⏰ [${alarm.group}] ${alarm.name}`,
            body: `${targetTime} 알람 시간입니다! 터치하여 확인하세요.`,
            alarmId: alarm.id,
          });
          try {
            await webpush.sendNotification(item.subscription, payload);
            sentCount++;
            if (!alarm.isRepeating) {
              alarm.enabled = false;
              isModified = true;
            }
          } catch (err) {
            if (err.statusCode === 410 || err.statusCode === 404) {
              list.splice(i, 1);
              isModified = true;
            }
          }
        }
      }
    }

    if (isModified) await redis.set(DB_KEY, list);
    return res.status(200).json({ checkedTime: currentTimeStr, sentCount });
  } catch (error) {
    return res.status(500).json({ error: '크론 실행 실패' });
  }
}
