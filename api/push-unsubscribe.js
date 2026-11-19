'use strict';

const {
  getRedis, SUBSCRIPTIONS_SET, subscriptionId, recordKey,
  validateSubscription, setCorsForSameSite
} = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!setCorsForSameSite(req, res)) {
    return res.status(403).json({ error: '허용되지 않은 출처입니다.' });
  }

  try {
    const subscription = req.body && req.body.subscription;
    if (!validateSubscription(subscription)) {
      return res.status(400).json({ error: '푸시 구독 정보가 올바르지 않습니다.' });
    }

    const redis = getRedis();
    const id = subscriptionId(subscription);
    await Promise.all([
      redis.del(recordKey(id)),
      redis.srem(SUBSCRIPTIONS_SET, id)
    ]);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, unsubscribed: true });
  } catch (error) {
    console.error('push-unsubscribe error:', error);
    return res.status(error.statusCode || 500).json({
      error: error.message || '푸시 구독 해제에 실패했습니다.'
    });
  }
};
