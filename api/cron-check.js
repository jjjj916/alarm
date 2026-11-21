'use strict';

const {
  getRedis, SUBSCRIPTIONS_SET, recordKey, configureWebPush,
  getZonedParts, zonedWallTimeToUtc, validTimeZone, isCronAuthorized
} = require('../lib/server');

function localDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

const DELIVERY_GRACE_MS = 360 * 1000;
const EARLY_TOLERANCE_MS = 5 * 1000;

function computeNextEarliestAfterDispatch(alarms, timer, timeZone, nowMs) {
  let earliest = Infinity;
  if (timer && Number.isFinite(Number(timer.endAt)) && Number(timer.endAt) > nowMs + 1000) {
    earliest = Number(timer.endAt);
  }
  const parts = getZonedParts(new Date(nowMs), timeZone);
  for (const alarm of (alarms || [])) {
    if (!alarm || !alarm.enabled) continue;
    if (Number.isFinite(Number(alarm.nextSnoozeAt)) && Number(alarm.nextSnoozeAt) > nowMs + 1000) {
      if (Number(alarm.nextSnoozeAt) < earliest) earliest = Number(alarm.nextSnoozeAt);
      continue;
    }
    if (!alarm.isRepeating) {
      const singleAt = Number(alarm.singleShotAt);
      if (Number.isFinite(singleAt) && singleAt > nowMs + 1000 && singleAt < earliest) {
        earliest = singleAt;
      }
      continue;
    }
    const days = Array.isArray(alarm.days) ? alarm.days : [];
    const [hour, minute] = String(alarm.time || '08:00').split(':').map(Number);
    for (let offset = 0; offset <= 7; offset++) {
      const checkWeekday = (parts.weekday + offset) % 7;
      if (!days.includes(checkWeekday)) continue;
      const baseUtc = Date.UTC(parts.year, parts.month - 1, parts.day + offset);
      const targetDate = new Date(baseUtc);
      const candidateUtc = zonedWallTimeToUtc({
        year: targetDate.getUTCFullYear(),
        month: targetDate.getUTCMonth() + 1,
        day: targetDate.getUTCDate(),
        hour: hour || 0,
        minute: minute || 0
      }, timeZone);
      if (candidateUtc > nowMs + 1000 && candidateUtc < earliest) {
        earliest = candidateUtc;
        break;
      }
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
}

async function chainNextQStashPush(req, triggerAtMs) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !triggerAtMs) return null;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (!host) return null;

  const targetUrl = `${proto}://${host}/api/cron-check`;
  const cronSecret = process.env.CRON_SECRET || '';
  const notBeforeSec = Math.max(Math.floor(Date.now() / 1000) + 2, Math.floor(triggerAtMs / 1000));

  const headers = {
    'Authorization': `Bearer ${qstashToken}`,
    'Content-Type': 'application/json',
    'Upstash-Not-Before': String(notBeforeSec),
    'Upstash-Retries': '2'
  };
  if (cronSecret) headers['Upstash-Forward-Authorization'] = `Bearer ${cronSecret}`;

  try {
    const res = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(targetUrl)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'qstash-chain-next', scheduledFor: notBeforeSec })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { messageId: data.messageId || null, scheduledAt: notBeforeSec * 1000 };
  } catch (e) {
    return null;
  }
}

function alarmIsDue(alarm, parts, nowMs, timeZone) {
  if (!alarm.enabled) return null;
  if (alarm.userDismissedAt && nowMs - Number(alarm.userDismissedAt) < DELIVERY_GRACE_MS && !alarm.nextSnoozeAt) {
    return null;
  }

  if (Number.isFinite(Number(alarm.nextSnoozeAt))) {
    const dueAt = Number(alarm.nextSnoozeAt);
    if (nowMs + EARLY_TOLERANCE_MS >= dueAt && nowMs - dueAt <= DELIVERY_GRACE_MS) {
      return { kind: 'snooze', scheduledAt: dueAt, displayTime: alarm.nextSnoozeTime || alarm.time };
    }
    if (dueAt > nowMs + EARLY_TOLERANCE_MS) return null;
  }

  if (alarm.nextSnoozeTime && !Number.isFinite(Number(alarm.nextSnoozeAt))) {
    const [sh, sm] = alarm.nextSnoozeTime.split(':').map(Number);
    const scheduledAt = zonedWallTimeToUtc({
      year: parts.year, month: parts.month, day: parts.day, hour: sh, minute: sm
    }, timeZone);
    if (nowMs + EARLY_TOLERANCE_MS >= scheduledAt && nowMs - scheduledAt <= DELIVERY_GRACE_MS) {
      return { kind: 'snooze', scheduledAt: `${localDateKey(parts)}T${alarm.nextSnoozeTime}`, displayTime: alarm.nextSnoozeTime };
    }
  }

  if (alarm.isRepeating) {
    const [hour, minute] = alarm.time.split(':').map(Number);
    if (!(alarm.days || []).includes(parts.weekday)) return null;
    const scheduledAt = zonedWallTimeToUtc({
      year: parts.year, month: parts.month, day: parts.day, hour, minute
    }, timeZone);
    const schedKey = `${localDateKey(parts)}_${alarm.time}_${scheduledAt}`;
    if (alarm.dismissedScheduleKey === schedKey || alarm.dismissedScheduleKey === `${localDateKey(parts)}_${alarm.time}`) return null;
    if (nowMs + EARLY_TOLERANCE_MS >= scheduledAt && nowMs - scheduledAt <= DELIVERY_GRACE_MS) {
      return { kind: 'repeat', scheduledAt, scheduleKey: schedKey, displayTime: alarm.time };
    }
    return null;
  }

  const singleShotAt = Number(alarm.singleShotAt);
  const schedKey = `single_${alarm.time}_${singleShotAt}`;
  if (alarm.dismissedScheduleKey === schedKey) return null;
  if (Number.isFinite(singleShotAt) && singleShotAt > 0 && nowMs + EARLY_TOLERANCE_MS >= singleShotAt && nowMs - singleShotAt <= DELIVERY_GRACE_MS) {
    return { kind: 'single', scheduledAt: singleShotAt, scheduleKey: schedKey, displayTime: alarm.time };
  }
  return null;
}

async function sendPush(webpush, redis, id, record, payload, dedupeKey) {
  if (dedupeKey) {
    const reserved = await redis.set(dedupeKey, '1', { nx: true, ex: 14 * 86400 });
    if (reserved !== 'OK') return false;
  }
  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload), {
      TTL: 360,
      urgency: 'high'
    });
    return true;
  } catch (error) {
    if (dedupeKey) await redis.del(dedupeKey).catch(() => {});
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

      if (isUrgent && record.activeRinging) {
        const ringInfo = record.activeRinging;
        const sCount = Number(ringInfo.snoozeCount) || 3;
        const rSnooze = Number.isFinite(Number(ringInfo.remainingSnooze)) ? Number(ringInfo.remainingSnooze) : sCount;
        const sLevel = Number(ringInfo.snoozeLevel) || 0;
        const delivered = await sendPush(webpush, redis, id, record, {
          type: ringInfo.type || 'alarm',
          urgentBurstMode: true,
          title: `🚨 [긴급 Lv.${sLevel + 1}] ${ringInfo.label}`,
          body: `다시 울림 ${rSnooze}/${sCount}회 남음 · 알림의 [✕ 알람 끄기]를 누르기 전까지 반복됩니다.`,
          label: ringInfo.label,
          name: ringInfo.name || ringInfo.label,
          group: ringInfo.group || '알람',
          time: ringInfo.time || '',
          sound: Number.isFinite(Number(ringInfo.sound)) ? Number(ringInfo.sound) : 0,
          isRepeating: Boolean(ringInfo.isRepeating),
          snoozeInterval: Number(ringInfo.snoozeInterval) || 5,
          snoozeCount: sCount,
          remainingSnooze: rSnooze,
          snoozeLevel: sLevel,
          scheduleKey: ringInfo.scheduleKey || '',
          alarmId: ringInfo.alarmId || '',
          tag: `smart-clock-urgent-${ringInfo.alarmId || 'timer'}-${now}`
        }, null);
        if (delivered) sent++;
      }

      for (const alarm of (record.alarms || [])) {
        const due = alarmIsDue(alarm, parts, now, timeZone);
        if (!due) continue;
        const dedupeKey = `smart-clock:sent:${id}:${String(alarm.id)}:${String(due.scheduledAt)}`;
        const name = alarm.name || '알람';
        const group = alarm.group || '기본 그룹';
        const label = `[${group}] ${name}`;
        const sCount = Number(alarm.snoozeCount) || 3;
        const rSnooze = Number.isFinite(Number(alarm.remainingSnooze)) ? Number(alarm.remainingSnooze) : sCount;
        const sLevel = Number(alarm.snoozeLevel) || 0;
        const sInterval = Number(alarm.snoozeInterval) || 5;

        const delivered = await sendPush(webpush, redis, id, record, {
          type: 'alarm',
          urgentBurstMode: isUrgent,
          title: isUrgent ? `🚨 [Lv.${sLevel + 1}] ${label}` : `⏰ [Lv.${sLevel + 1}] ${label}`,
          body: `${due.displayTime} 알람 · 다시 울림 ${sInterval}분 (${rSnooze}/${sCount}회 남음)`,
          label,
          name,
          group,
          time: due.displayTime,
          sound: Number.isFinite(Number(alarm.sound)) ? Number(alarm.sound) : 0,
          isRepeating: Boolean(alarm.isRepeating),
          days: Array.isArray(alarm.days) ? alarm.days : [],
          snoozeInterval: sInterval,
          snoozeCount: sCount,
          remainingSnooze: rSnooze,
          snoozeLevel: sLevel,
          scheduleKey: due.scheduleKey || '',
          alarmId: String(alarm.id),
          tag: isUrgent
            ? `smart-clock-urgent-${alarm.id}-${now}`
            : `smart-clock-alarm-${alarm.id}-${String(due.scheduledAt).replace(/[^0-9]/g, '')}`
        }, dedupeKey);

        if (delivered) {
          sent++;
          alarm.serverLastSentAt = now;
          if (isUrgent) {
            record.activeRinging = {
              type: 'alarm',
              alarmId: String(alarm.id),
              name,
              group,
              label,
              time: due.displayTime,
              sound: Number.isFinite(Number(alarm.sound)) ? Number(alarm.sound) : 0,
              isRepeating: Boolean(alarm.isRepeating),
              snoozeInterval: sInterval,
              snoozeCount: sCount,
              remainingSnooze: rSnooze,
              snoozeLevel: sLevel,
              scheduleKey: due.scheduleKey || '',
              startedAt: now
            };
          }
          if (due.kind === 'single') {
            alarm.enabled = false;
            alarm.serverFiredAt = now;
            alarm.nextSnoozeAt = null;
            alarm.nextSnoozeTime = null;
          }
          if (due.kind === 'snooze') {
            alarm.nextSnoozeAt = null;
            alarm.nextSnoozeTime = null;
          }
          changed = true;
        }
      }

      if (record.timer && Number(record.timer.endAt) <= now + EARLY_TOLERANCE_MS && now - Number(record.timer.endAt) <= DELIVERY_GRACE_MS) {
        const timer = record.timer;
        const dedupeKey = `smart-clock:timer-sent:${id}:${timer.endAt}`;
        const delivered = await sendPush(webpush, redis, id, record, {
          type: 'timer',
          urgentBurstMode: isUrgent,
          title: '⏳ 타이머 완료',
          body: '설정한 카운트다운 시간이 종료되었습니다.',
          label: '카운트다운 타이머 완료',
          name: '카운트다운 타이머 완료',
          group: '타이머',
          totalMs: Number(timer.totalMs) || 0,
          tag: `smart-clock-timer-${timer.endAt}`
        }, dedupeKey);
        if (delivered) {
          sent++;
          if (isUrgent) {
            record.activeRinging = {
              type: 'timer',
              alarmId: 'timer',
              name: '카운트다운 타이머 완료',
              group: '타이머',
              label: '카운트다운 타이머 완료',
              startedAt: now
            };
          }
          record.timer = null;
          changed = true;
        }
      }

      if (changed) {
        // 다음 남은 알람(반복 알람 또는 다른 예약 알람)이 있으면 QStash 정각 체이닝 예약
        const nextTriggerMs = computeNextEarliestAfterDispatch(record.alarms, record.timer, timeZone, now + 5000);
        if (nextTriggerMs) {
          const chained = await chainNextQStashPush(req, nextTriggerMs);
          record.qstashMessageId = chained ? chained.messageId : null;
          record.qstashScheduledAt = chained ? chained.scheduledAt : null;
        } else {
          record.qstashMessageId = null;
          record.qstashScheduledAt = null;
        }
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
