'use strict';

const {
  getRedis, SUBSCRIPTIONS_SET, subscriptionId, recordKey,
  validTimeZone, sanitizeAlarm, validateSubscription,
  computeNextOneShotAt, setCorsForSameSite
} = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!setCorsForSameSite(req, res)) return res.status(403).json({ error: '허용되지 않은 출처입니다.' });

  try {
    const body = req.body || {};
    if (Buffer.byteLength(JSON.stringify(body)) > 250 * 1024) {
      return res.status(413).json({ error: '요청 데이터가 너무 큽니다.' });
    }
    const subscription = body.subscription;
    if (!validateSubscription(subscription)) {
      return res.status(400).json({ error: '푸시 구독 정보가 올바르지 않습니다.' });
    }
    const timeZone = validTimeZone(body.timeZone) ? body.timeZone : 'Asia/Seoul';
    if (!Array.isArray(body.alarms) || body.alarms.length > 100) {
      return res.status(400).json({ error: '알람 목록 형식이 올바르지 않습니다.' });
    }

    const redis = getRedis();
    const id = subscriptionId(subscription);
    const key = recordKey(id);
    const previous = await redis.get(key);
    const previousAlarms = new Map((previous?.alarms || []).map(a => [String(a.id), a]));
    const now = Date.now();
    const clearRinging = Boolean(body.clearRinging);

    const alarms = body.alarms.map(sanitizeAlarm).filter(Boolean).map((alarm, idx) => {
      const raw = body.alarms[idx] || {};
      const old = previousAlarms.get(alarm.id);
      const sCount = Number.isFinite(Number(raw.snoozeCount)) ? Math.max(1, Math.min(20, Number(raw.snoozeCount))) : (alarm.snoozeCount || 3);
      const sInterval = Number.isFinite(Number(raw.snoozeInterval)) ? Math.max(1, Math.min(60, Number(raw.snoozeInterval))) : (alarm.snoozeInterval || 5);
      const remainingSnooze = Number.isFinite(Number(raw.remainingSnooze)) ? Math.max(0, Math.min(sCount, Number(raw.remainingSnooze))) : sCount;
      const snoozeLevel = Number.isFinite(Number(raw.snoozeLevel)) ? Math.max(0, Math.min(10, Number(raw.snoozeLevel))) : 0;

      alarm.snoozeCount = sCount;
      alarm.snoozeInterval = sInterval;
      alarm.remainingSnooze = remainingSnooze;
      alarm.snoozeLevel = snoozeLevel;
      alarm.nextSnoozeAt = Number.isFinite(Number(raw.nextSnoozeAt)) ? Number(raw.nextSnoozeAt) : null;
      alarm.nextSnoozeTime = typeof raw.nextSnoozeTime === 'string' && raw.nextSnoozeTime ? raw.nextSnoozeTime : null;
      alarm.userDismissedAt = Number.isFinite(Number(raw.userDismissedAt)) ? Number(raw.userDismissedAt) : (old?.userDismissedAt || null);
      alarm.dismissedScheduleKey = typeof raw.dismissedScheduleKey === 'string' && raw.dismissedScheduleKey
        ? raw.dismissedScheduleKey
        : (old?.dismissedScheduleKey || null);

      if (alarm.isRepeating) {
        alarm.singleShotAt = null;
        alarm.serverFiredAt = null;
      } else {
        const sameSchedule = old && !old.isRepeating && old.time === alarm.time &&
          JSON.stringify(old.days || []) === JSON.stringify(alarm.days || []);
        const sameSingleShot = sameSchedule && Number.isFinite(Number(old.singleShotAt)) &&
          Number(old.singleShotAt) === Number(alarm.singleShotAt);
        if (sameSingleShot) {
          alarm.singleShotAt = Number(old.singleShotAt);
          if (old.serverFiredAt || old.userDismissedAt) {
            alarm.serverFiredAt = Number(old.serverFiredAt || old.userDismissedAt);
            alarm.enabled = false;
          }
        } else if (!alarm.singleShotAt) {
          alarm.singleShotAt = computeNextOneShotAt(alarm, timeZone, now);
        }
      }
      return alarm;
    });

    let timer = null;
    if (body.timer && typeof body.timer === 'object') {
      const endAt = Number(body.timer.endAt);
      const totalMs = Number(body.timer.totalMs);
      if (Number.isFinite(endAt) && endAt > now && Number.isFinite(totalMs) && totalMs > 0 && totalMs <= 100 * 3600 * 1000) {
        timer = { endAt, totalMs, label: '카운트다운 타이머 완료' };
      }
    }

    const activeRinging = clearRinging ? null : (previous?.activeRinging || null);

    const record = {
      subscription,
      timeZone,
      alarms,
      timer,
      urgentBurstMode: Boolean(body.urgentBurstMode),
      activeRinging,
      updatedAt: now
    };
    await redis.set(key, record);
    await redis.sadd(SUBSCRIPTIONS_SET, id);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, alarms, timer, urgentBurstMode: record.urgentBurstMode, syncedAt: now });
  } catch (error) {
    console.error('push-subscribe error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || '푸시 설정 저장에 실패했습니다.' });
  }
};
// api/push-subscribe.js 내부에 추가할 QStash 정각 예약 헬퍼 예시
async function scheduleExactPushWithQStash(targetUrl, cronSecret, triggerAtMs) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !triggerAtMs || triggerAtMs <= Date.now()) return;

  // Unix timestamp(초 단위)로 정확한 발송 시각 지정
  const notBeforeSec = Math.floor(triggerAtMs / 1000);

  await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(targetUrl)}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${qstashToken}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(notBeforeSec),
      'Upstash-Forward-Authorization': `Bearer ${cronSecret}`
    },
    body: JSON.stringify({ source: 'qstash-exact-alarm' })
  });
}
