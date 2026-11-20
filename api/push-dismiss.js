'use strict';

const {
  getRedis, subscriptionId, recordKey, validateSubscription
} = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body || {};
    const subscription = body.subscription;
    if (!validateSubscription(subscription)) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    const alarmId = body.alarmId ? String(body.alarmId) : null;
    const redis = getRedis();
    const id = subscriptionId(subscription);
    const key = recordKey(id);
    const record = await redis.get(key);

    if (record) {
      record.activeRinging = null;
      if (alarmId && Array.isArray(record.alarms)) {
        record.alarms = record.alarms.map(a => {
          if (String(a.id) === alarmId) {
            return Object.assign({}, a, {
              enabled: Boolean(a.isRepeating),
              remainingSnooze: Number(a.snoozeCount) || 3,
              snoozeLevel: 0,
              nextSnoozeAt: null,
              nextSnoozeTime: null,
              serverFiredAt: a.isRepeating ? null : Date.now()
            });
          }
          return a;
        });
      }
      record.updatedAt = Date.now();
      await redis.set(key, record);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('push-dismiss error:', error);
    return res.status(500).json({ error: error.message || 'Dismiss failed' });
  }
};
