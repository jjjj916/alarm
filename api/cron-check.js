'use strict';

const {
  getRedis, SUBSCRIPTIONS_SET, recordKey, configureWebPush,
  getZonedParts, zonedWallTimeToUtc, validTimeZone, isCronAuthorized
} = require('../lib/server');

function localDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

const DELIVERY_GRACE_MS = 90 * 1000;

function alarmIsDue(alarm, parts, nowMs, timeZone) {
  if (!alarm.enabled) return null;

  if (Number.isFinite(Number(alarm.nextSnoozeAt))) {
    const dueAt = Number(alarm.nextSnoozeAt);
    if (dueAt <= nowMs && nowMs - dueAt <= DELIVERY_GRACE_MS) {
      return { kind: 'snooze', scheduledAt: dueAt, displayTime: alarm.nextSnoozeTime || alarm.time };
    }
    if (dueAt > nowMs) return null;
  }

  if (alarm.nextSnoozeTime && !Number.isFinite(Number(alarm.nextSnoozeAt))) {
    if (parts.hour === Number(alarm.nextSnoozeTime.slice(0, 2)) &&
        parts.minute === Number(alarm.nextSnoozeTime.slice(3, 5))) {
      return { kind: 'snooze', scheduledAt: `${localDateKey(parts)}T${alarm.nextSnoozeTime}`, displayTime: alarm.nextSnoozeTime };
    }
  }

  if (alarm.isRepeating) {
    const [hour, minute] = alarm.time.split(':').map(Number);
    if (!(alarm.days || []).includes(parts.weekday)) return null;
    const scheduledAt = zonedWallTimeToUtc({
      year: parts.year, month: parts.month, day: parts.day, hour, minute
    }, timeZone);
    if (nowMs >= scheduledAt && nowMs - scheduledAt <= DELIVERY_GRACE_MS) {
      return { kind: 'repeat', scheduledAt, displayTime: alarm.time };
    }
    return null;
  }

  const singleShotAt = Number(alarm.singleShotAt);
  if (Number.isFinite(singleShotAt) && singleShotAt > 0 && nowMs >= singleShotAt && nowMs - singleShotAt <= DELIVERY_GRACE_MS) {
    return { kind: 'single', scheduledAt: singleShotAt, displayTime: alarm.time };
  }
  return null;
}

async function sendPush(webpush, redis, id, record, payload, dedupeKey) {
  const reserved = await redis.set(dedupeKey, '1', { nx: true, ex: 14 * 86400 });
  if (reserved !== 'OK') return false;
  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload), {
      TTL: 90,
      urgency: 'high'
    });
    return true;
  } catch (error) {
    await redis.del(dedupeKey).catch(() => {});
    const status = error.statusCode || error.status;
    if (status === 404 || status === 410) {
      await redis.srem(SUBSCRIPTIONS_SET, id);
      await redis.del(recordKey(id));
    }
    console.error('web push delivery failed:', status || '', error.message || error);
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const redis = getRedis();
    const webpush = configureWebPush();
    const ids = await redis.smembers(SUBSCRIPTIONS_SET);
    const now = Date.now();
    let sent = 0;
    let checked = 0;
    let expired = 0;

    for (const id of ids) {
      const key = recordKey(id);
      const record = await redis.get(key);
      if (!record || !record.subscription) {
        await redis.srem(SUBSCRIPTIONS_SET, id);
        expired++;
        continue;
      }
      checked++;
      const timeZone = validTimeZone(record.timeZone) ? record.timeZone : 'Asia/Seoul';
      const parts = getZonedParts(new Date(now), timeZone);
      const isUrgent = Boolean(record.urgentBurstMode);
      let changed = false;

      for (const alarm of (record.alarms || [])) {
        const due = alarmIsDue(alarm, parts, now, timeZone);
        if (!due) continue;
        const dedupeKey = `smart-clock:sent:${id}:${String(alarm.id)}:${String(due.scheduledAt)}`;
        const delivered = await sendPush(webpush, redis, id, record, {
          type: 'alarm',
          urgentBurstMode: isUrgent,
          title: isUrgent ? `🚨 [긴급 알람] ${alarm.name || '스마트 시계 알람'}` : `⏰ ${alarm.name || '스마트 시계 알람'}`,
          body: `[${alarm.group || '알람'}] ${due.displayTime} 알람이 울립니다. 터치하여 끄세요.`,
          label: alarm.name || '스마트 시계 알람',
          alarmId: String(alarm.id),
          time: due.displayTime,
          tag: isUrgent
            ? `smart-clock-urgent-${alarm.id}-${now}`
            : `smart-clock-alarm-${alarm.id}-${String(due.scheduledAt).replace(/[^0-9]/g, '')}`
        }, dedupeKey);

        if (delivered) {
          sent++;
          alarm.serverLastSentAt = now;
          if (due.kind === 'single') {
            alarm.enabled = false;
            alarm.serverFiredAt = now;
          }
          if (due.kind === 'snooze') {
            alarm.nextSnoozeAt = null;
            alarm.nextSnoozeTime = null;
          }
          changed = true;
        }
      }

      if (record.timer && Number(record.timer.endAt) <= now) {
        const timer = record.timer;
        const dedupeKey = `smart-clock:timer-sent:${id}:${timer.endAt}`;
        const delivered = await sendPush(webpush, redis, id, record, {
          type: 'timer',
          urgentBurstMode: isUrgent,
          title: '⏳ 타이머 완료',
          body: '설정한 카운트다운 시간이 종료되었습니다.',
          label: '카운트다운 타이머 완료',
          totalMs: Number(timer.totalMs) || 0,
          tag: `smart-clock-timer-${timer.endAt}`
        }, dedupeKey);
        if (delivered) {
          sent++;
          record.timer = null;
          changed = true;
        }
      }

      if (changed) {
        record.updatedAt = now;
        await redis.set(key, record);
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, checked, sent, expired, checkedAt: new Date(now).toISOString() });
  } catch (error) {
    console.error('cron-check error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || '알람 확인 중 오류가 발생했습니다.' });
  }
};
