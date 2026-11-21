'use strict';

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis 환경 변수가 설정되지 않았습니다.');
  return new Redis({ url, token });
}

function getSubKey(endpoint) {
  const hash = crypto.createHash('sha256').update(String(endpoint)).digest('hex');
  return `smart-clock:sub:${hash}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const endpoint = body.subscription && body.subscription.endpoint;
    if (!endpoint) {
      return res.status(400).json({ error: 'subscription endpoint is required' });
    }

    const redis = getRedis();
    const key = getSubKey(endpoint);
    const record = await redis.get(key);
    if (!record) {
      return res.status(200).json({ ok: true, cleared: false });
    }

    const alarmId = body.alarmId ? String(body.alarmId) : '';
    const scheduleKey = body.scheduleKey ? String(body.scheduleKey) : '';
    const now = Date.now();

    // 5초 연속 긴급알림 상태 즉시 종료
    record.activeRinging = null;

    if (Array.isArray(record.alarms)) {
      record.alarms = record.alarms.map((a) => {
        const idMatch = alarmId && String(a.id) === alarmId;
        const keyMatch = scheduleKey && (a.lastServerPushedKey === scheduleKey || a.lastTriggeredKey === scheduleKey);
        if (idMatch || keyMatch || (!alarmId && !scheduleKey && a.enabled)) {
          return Object.assign({}, a, {
            enabled: false,
            nextSnoozeAt: null,
            nextSnoozeTime: null,
            userDismissedAt: now,
            dismissedScheduleKey: scheduleKey || a.lastServerPushedKey || a.lastTriggeredKey || ''
          });
        }
        return a;
      });
    }

    record.updatedAt = now;
    await redis.set(key, record);

    return res.status(200).json({ ok: true, cleared: true });
  } catch (error) {
    console.error('push-dismiss error:', error);
    return res.status(500).json({ error: error.message || 'Failed to dismiss alarm' });
  }
};
