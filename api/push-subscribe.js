export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) return res.status(500).json({ error: 'Redis 환경 변수가 없습니다.' });
  try {
    const { subscription, alarms, timeZone, timer } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: '유효하지 않은 구독 정보' });
    const key = 'push_sub:' + Buffer.from(subscription.endpoint).toString('base64');
    const payload = JSON.stringify({ subscription, alarms: Array.isArray(alarms) ? alarms : [], timer: timer || null, timeZone: timeZone || 'Asia/Seoul', updatedAt: Date.now() });
    await fetch(`${redisUrl}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` }, body: payload });
    await fetch(`${redisUrl}/sadd/push_subscribers/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` } });
    return res.status(200).json({ ok: true, alarms });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
