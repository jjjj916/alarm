import webpush from 'web-push';

export default async function handler(req, res) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!redisUrl || !redisToken || !publicKey || !privateKey) return res.status(500).json({ error: '환경 변수 누락' });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey, privateKey);
  try {
    const membersRes = await fetch(`${redisUrl}/smembers/push_subscribers`, { headers: { Authorization: `Bearer ${redisToken}` } });
    const keys = (await membersRes.json()).result || [];
    let sentCount = 0;

    for (const key of keys) {
      const subRes = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${redisToken}` } });
      const subData = await subRes.json();
      if (!subData.result) continue;
      const record = JSON.parse(subData.result);
      const { subscription, alarms, timer, timeZone } = record;
      if (!subscription) continue;

      let recordChanged = false;
      const now = new Date();

      if (timer && Number(timer.endAt) > 0 && now.getTime() >= Number(timer.endAt)) {
        try {
          await webpush.sendNotification(subscription, JSON.stringify({
            type: 'timer', totalMs: timer.totalMs || 0, title: '⏳ 스마트 시계 타이머 종료',
            body: '설정한 타이머 시간이 완료되었습니다!', label: '타이머 종료', tag: `smart-clock-timer-${timer.endAt}`
          }));
          sentCount++;
        } catch (e) {}
        record.timer = null;
        recordChanged = true;
      }

      if (Array.isArray(alarms)) {
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Asia/Seoul', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });
        const parts = formatter.formatToParts(now);
        const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const currentDay = dayMap[parts.find((p) => p.type === 'weekday')?.value];
        const hourStr = parts.find((p) => p.type === 'hour')?.value;
        const currentHM = `${hourStr === '24' ? '00' : hourStr}:${parts.find((p) => p.type === 'minute')?.value}`;

        for (const alarm of alarms) {
          if (!alarm.enabled || !Array.isArray(alarm.days) || !alarm.days.includes(currentDay)) continue;
          const targetTime = alarm.nextSnoozeTime || alarm.time;
          if (targetTime === currentHM) {
            if (alarm.serverLastSentAt && now.getTime() - Number(alarm.serverLastSentAt) < 55000) continue;
            try {
              await webpush.sendNotification(subscription, JSON.stringify({
                type: 'alarm', alarmId: alarm.id, title: `⏰ [${alarm.group || '알람'}] ${alarm.name || '알람'}`,
                body: `${targetTime} 알람이 울립니다!`, label: `[${alarm.group || '알람'}] ${alarm.name || '알람'}`,
                tag: `smart-clock-alarm-${alarm.id}-${currentHM}`
              }));
              sentCount++;
              alarm.serverLastSentAt = now.getTime();
              if (!alarm.isRepeating) { alarm.enabled = false; alarm.serverFiredAt = now.getTime(); }
              recordChanged = true;
            } catch (pushErr) {
              if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
                await fetch(`${redisUrl}/srem/push_subscribers/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` } });
              }
            }
          }
        }
      }

      if (recordChanged) {
        await fetch(`${redisUrl}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` }, body: JSON.stringify(record) });
      }
    }
    return res.status(200).json({ ok: true, sentCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
