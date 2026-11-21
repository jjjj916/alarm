'use strict';

const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis 환경 변수(UPSTASH_REDIS_REST_URL/TOKEN)가 없습니다.');
  return new Redis({ url, token });
}

module.exports = async function handler(req, res) {
  try {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

    if (!pub || !priv) {
      return res.status(500).json({ ok: false, error: 'Vercel 환경 변수에 VAPID_PUBLIC_KEY 또는 VAPID_PRIVATE_KEY가 없습니다.' });
    }

    webpush.setVapidDetails(subject, pub, priv);
    const redis = getRedis();
    const keys = await redis.keys('smart-clock:sub:*');

    if (!keys || keys.length === 0) {
      return res.status(200).json({
        ok: false,
        subscribedDevices: 0,
        error: '서버(Redis)에 등록된 기기가 0개입니다. 홈 화면 아이콘으로 실행 후 [🔔 푸시 알림: ON]을 눌러주세요.'
      });
    }

    const results = [];
    for (const k of keys) {
      const rec = await redis.get(k);
      if (!rec || !rec.subscription || !rec.subscription.endpoint) continue;
      const isApple = rec.subscription.endpoint.includes('apple.com');

      try {
        const pushRes = await webpush.sendNotification(
          rec.subscription,
          JSON.stringify({
            type: 'alarm',
            alarmId: 'instant-test',
            title: '⏰ [iOS 푸시 테스트 성공]',
            body: '이 배너와 알림음이 울리면 유튜브 시청 중에도 알람이 정상 작동합니다!',
            tag: `test-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
          }),
          { TTL: 60 }
        );
        results.push({
          device: isApple ? 'iOS (Apple APNs)' : 'Android/PC',
          sent: true,
          statusCode: pushRes.statusCode
        });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await redis.del(k);
        }
        results.push({
          device: isApple ? 'iOS (Apple APNs)' : 'Android/PC',
          sent: false,
          statusCode: e.statusCode || 500,
          detail: e.body || e.message
        });
      }
    }

    return res.status(200).json({
      ok: results.some((r) => r.sent),
      hasQstashToken: Boolean(process.env.QSTASH_TOKEN),
      results
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
