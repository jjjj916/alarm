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

    const alarms = body.alarms.map(sanitizeAlarm).filter(Boolean).map(alarm => {
      const old = previousAlarms.get(alarm.id);
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
          if (old.serverFiredAt) {
            alarm.serverFiredAt = Number(old.serverFiredAt);
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

    const record = {
      subscription,
      timeZone,
      alarms,
      timer,
      urgentBurstMode: Boolean(body.urgentBurstMode),
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
