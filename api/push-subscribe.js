'use strict';

const {
  getRedis, SUBSCRIPTIONS_SET, subscriptionId, recordKey,
  sanitizeAlarms, sanitizeTimer, validTimeZone,
  getZonedParts, zonedWallTimeToUtc
} = require('../lib/server');

function computeEarliestTriggerMs(alarms, timer, timeZone, nowMs) {
  let earliest = Infinity;

  if (timer && Number.isFinite(Number(timer.endAt))) {
    const endAt = Number(timer.endAt);
    if (endAt > nowMs - 5000 && endAt < earliest) {
      earliest = endAt;
    }
  }

  const parts = getZonedParts(new Date(nowMs), timeZone);

  for (const alarm of (alarms || [])) {
    if (!alarm || !alarm.enabled) continue;

    // 1) 스누즈(다시 울림) 예약 시각
    if (Number.isFinite(Number(alarm.nextSnoozeAt)) && Number(alarm.nextSnoozeAt) > nowMs - 5000) {
      const due = Number(alarm.nextSnoozeAt);
      if (due < earliest) earliest = due;
      continue;
    }

    // 2) 1회성 알람 예약 시각
    if (!alarm.isRepeating) {
      const singleAt = Number(alarm.singleShotAt);
      if (Number.isFinite(singleAt) && singleAt > nowMs - 5000 && singleAt < earliest) {
        earliest = singleAt;
      }
      continue;
    }

    // 3) 요일 반복 알람 (향후 8일 중 가장 빠른 시각 계산)
    const days = Array.isArray(alarm.days) ? alarm.days : [];
    if (days.length === 0) continue;

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

      const schedKey = `${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDate.getUTCDate()).padStart(2, '0')}_${alarm.time}_${candidateUtc}`;
      if (alarm.dismissedScheduleKey === schedKey) continue;

      if (candidateUtc > nowMs - 5000 && candidateUtc < earliest) {
        earliest = candidateUtc;
        break;
      }
    }
  }

  return Number.isFinite(earliest) ? earliest : null;
}

async function cancelPreviousQStashMessage(qstashToken, messageId) {
  if (!qstashToken || !messageId) return;
  try {
    await fetch(`https://qstash.upstash.io/v2/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${qstashToken}` }
    });
  } catch (e) {
    // 이미 실행되었거나 만료된 메시지는 무시
  }
}

async function scheduleExactQStashPush(req, triggerAtMs) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !triggerAtMs) return null;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (!host) return null;

  const targetUrl = `${proto}://${host}/api/cron-check`;
  const cronSecret = process.env.CRON_SECRET || '';
  const notBeforeSec = Math.max(Math.floor(Date.now() / 1000) + 1, Math.floor(triggerAtMs / 1000));

  const headers = {
    'Authorization': `Bearer ${qstashToken}`,
    'Content-Type': 'application/json',
    'Upstash-Not-Before': String(notBeforeSec),
    'Upstash-Retries': '2'
  };

  if (cronSecret) {
    headers['Upstash-Forward-Authorization'] = `Bearer ${cronSecret}`;
  }

  try {
    const res = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(targetUrl)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'qstash-exact-alarm', scheduledFor: notBeforeSec })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('QStash publish failed:', res.status, errText);
      return null;
    }
    const data = await res.json();
    return {
      messageId: data.messageId || null,
      scheduledAt: notBeforeSec * 1000
    };
  } catch (err) {
    console.error('QStash fetch error:', err.message || err);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const subscription = body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: '유효한 푸시 구독 정보가 필요합니다.' });
    }

    const redis = getRedis();
    const id = subscriptionId(subscription.endpoint);
    const key = recordKey(id);
    const existing = await redis.get(key);

    const now = Date.now();
    const timeZone = validTimeZone(body.timeZone)
      ? body.timeZone
      : (existing && validTimeZone(existing.timeZone) ? existing.timeZone : 'Asia/Seoul');

    const alarms = sanitizeAlarms(body.alarms !== undefined ? body.alarms : (existing ? existing.alarms : []));
    const timer = body.timer !== undefined ? sanitizeTimer(body.timer) : (existing ? existing.timer : null);
    const urgentBurstMode = body.urgentBurstMode !== undefined
      ? Boolean(body.urgentBurstMode)
      : Boolean(existing && existing.urgentBurstMode);

    const activeRinging = body.clearRinging ? null : (existing ? existing.activeRinging || null : null);

    // 이전 QStash 예약 메시지 취소 후 가장 빠른 알람 시각 정각(00초)에 새 예약 등록
    const qstashToken = process.env.QSTASH_TOKEN;
    if (qstashToken && existing && existing.qstashMessageId) {
      await cancelPreviousQStashMessage(qstashToken, existing.qstashMessageId);
    }

    const earliestTriggerMs = computeEarliestTriggerMs(alarms, timer, timeZone, now);
    const qstashResult = await scheduleExactQStashPush(req, earliestTriggerMs);

    const record = {
      id,
      subscription,
      alarms,
      timer,
      timeZone,
      urgentBurstMode,
      activeRinging,
      qstashMessageId: qstashResult ? qstashResult.messageId : null,
      qstashScheduledAt: qstashResult ? qstashResult.scheduledAt : null,
      updatedAt: now
    };

    await redis.set(key, record);
    await redis.sadd(SUBSCRIPTIONS_SET, id);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      id,
      alarmCount: alarms.length,
      qstashScheduled: Boolean(qstashResult),
      nextExactTriggerAt: qstashResult ? new Date(qstashResult.scheduledAt).toISOString() : null
    });
  } catch (error) {
    console.error('push-subscribe error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || '푸시 구독 저장 중 오류가 발생했습니다.' });
  }
};
