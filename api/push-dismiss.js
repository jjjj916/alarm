'use strict';

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis 환경 변수가 설정되지 않았습니다.');
  return new Redis({ url, token });
}

function subscriptionId(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);
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
      return res.status(400).json({ error: '구독 정보가 없습니다.' });
    }

    const redis = getRedis();
    const id = subscriptionId(subscription.endpoint);
    const key = `smart-clock:sub:${id}`;
    const record = await redis.get(key);
    if (!record) return res.status(200).json({ ok: true });

    const now = Date.now();
    const alarmId = body.alarmId ? String(body.alarmId) : '';
    const scheduleKey = body.scheduleKey ? String(body.scheduleKey) : '';

    record.activeRinging = null;
    if (Array.isArray(record.alarms)) {
      record.alarms = record.alarms.map((a) => {
        if (!alarmId || String(a.id) === alarmId) {
          return Object.assign({}, a, {
            enabled: false,
            nextSnoozeAt: null,
            nextSnoozeTime: null,
            userDismissedAt: now,
            dismissedScheduleKey: scheduleKey || a.dismissedScheduleKey || ''
          });
        }
        return a;
      });
    }

    if (process.env.QSTASH_TOKEN && record.qstashMessageId) {
      await fetch(`https://qstash.upstash.io/v2/messages/${encodeURIComponent(record.qstashMessageId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.QSTASH_TOKEN}` }
      }).catch(() => {});
      record.qstashMessageId = null;
      record.qstashScheduledAt = null;
    }

    record.updatedAt = now;
    await redis.set(key, record);

    return res.status(200).json({ ok: true, dismissedAlarmId: alarmId });
  } catch (error) {
    console.error('push-dismiss error:', error);
    return res.status(500).json({ error: error.message || '알람 종료 처리 실패' });
  }
};
