import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

function getSubscriptionKey(endpoint) {
  return `push:sub:${Buffer.from(endpoint).toString('base64url')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않은 요청 방식입니다.' });
  }

  try {
    const { subscription, alarms = [], timeZone = 'Asia/Seoul' } = req.body || {};

    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return res.status(400).json({ error: '유효하지 않은 PushSubscription 형식입니다.' });
    }

    const subKey = getSubscriptionKey(subscription.endpoint);
    const existing = await redis.get(subKey);

    const record = {
      subscription,
      timeZone,
      alarms: Array.isArray(alarms)
        ? alarms
            .filter((a) => a && a.enabled && typeof a.time === 'string')
            .map((a) => {
              const idStr = String(a.id || Date.now());
              const prev = existing?.alarms?.find((p) => String(p.id) === idStr && p.time === a.time);
              return {
                id: idStr,
                name: String(a.name || '알람').slice(0, 30),
                group: String(a.group || '기본 그룹').slice(0, 20),
                time: a.time,
                days: Array.isArray(a.days) ? a.days : [],
                lastPushedKey: prev?.lastPushedKey || null
              };
            })
        : [],
      updatedAt: Date.now()
    };

    await redis.set(subKey, record);
    await redis.sadd('push:sub:index', subKey);

    return res.status(200).json({ ok: true, key: subKey });
  } catch (err) {
    return res.status(500).json({ error: '구독 정보 저장 중 오류가 발생했습니다.' });
  }
}