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
    const scheduleKey = body.scheduleKey ? String(body.scheduleKey) : null;
    const dismissedAt = Date.now();
    const redis = getRedis();
    const id = subscriptionId(subscription);
    const key = recordKey(id);
    const record = await redis.get(key);

    if (record) {
      record.activeRinging = null;
      if (Array.isArray(record.alarms)) {
        record.alarms = record.alarms.map(a => {
          if (!alarmId || String(a.id) === alarmId) {
            return Object.assign({}, a, {
              enabled: Boolean(a.isRepeating),
              remainingSnooze: Number(a.snoozeCount) || 3,
              snoozeLevel: 0,
              nextSnoozeAt: null,
              nextSnoozeTime: null,
              userDismissedAt: dismissedAt,
              dismissedScheduleKey: scheduleKey || a.dismissedScheduleKey || `${a.time}_${a.singleShotAt || ''}`,
              serverFiredAt: a.isRepeating ? null : dismissedAt
            });
          }
          return a;
        });
      }
      record.updatedAt = dismissedAt;
      await redis.set(key, record);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, dismissedAt });
  } catch (error) {
    console.error('push-dismiss error:', error);
    return res.status(500).json({ error: error.message || 'Dismiss failed' });
  }
};
