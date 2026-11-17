
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DB_KEY = 'alarm_push_subscriptions';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { subscription, alarms } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: '유효하지 않은 구독 정보입니다.' });
    }

    let list = (await redis.get(DB_KEY)) || [];
    list = list.filter((item) => item.subscription.endpoint !== subscription.endpoint);
    list.push({ subscription, alarms, updatedAt: new Date().toISOString() });

    await redis.set(DB_KEY, list);
    return res.status(200).json({ message: '동기화 완료', count: alarms.length });
  } catch (error) {
    console.error('Redis 저장 오류:', error);
    return res.status(500).json({ error: '서버 저장 오류' });
  }
}
