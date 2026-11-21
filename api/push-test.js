'use strict';

const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return new Redis({ url, token });
}

module.exports = async function handler(req, res) {
  try {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
    const hasQstash = Boolean(process.env.QSTASH_TOKEN);

    if (!pub || !priv) {
      return res.status(500).json({ ok: false, step: 'ENV_CHECK', error: 'VAPID 키 누락' });
    }

    webpush.setVapidDetails(subject, pub, priv);
    const redis = getRedis();
    const keys = await redis.keys('smart-clock:sub:*');

    if (keys.length === 0) {
      return res.status(200).json({
        ok: false,
        step: 'REDIS_SUB_CHECK',
        error: 'Redis에 저장된 기기 푸시 구독이 0개입니다. 앱에서 [🔔 푸시 알림: ON]을 먼저 눌러주세요.',
        hasQstash
      });
    }

    const results = [];
    for (const k of keys) {
      const rec = await redis.get(k);
      if (!rec || !rec.subscription) continue;
      try {
        await webpush.sendNotification(
          rec.subscription,
          JSON.stringify({
            type: 'alarm',
            alarmId: 'diag-test',
            title: '🚨 [iOS 푸시 진단 성공]',
            body: '이 배너와 알림음이 들리면 APNs 푸시 경로는 정상입니다!',
            tag: `diag-${Date.now()}`,
            silent: false,
            renotify: true
          }),
          { TTL: 60, headers: { Urgency: 'high' } }
        );
        results.push({ key: k.slice(-8), sent: true, urgentBurstMode: Boolean(rec.urgentBurstMode) });
      } catch (e) {
        results.push({ key: k.slice(-8), sent: false, statusCode: e.statusCode, message: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      hasQstash,
      subscribedDevices: keys.length,
      results
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};
