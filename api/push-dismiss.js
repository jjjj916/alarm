import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { subscription, alarmId, scheduleKey } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Missing subscription' });
    }
    const subKey = `push_sub:${Buffer.from(subscription.endpoint).toString('base64url')}`;
    const record = await redis.get(subKey);
    if (record) {
      const dismissed = new Set(Array.isArray(record.dismissedKeys) ? record.dismissedKeys : []);
      if (scheduleKey) dismissed.add(scheduleKey);
      record.dismissedKeys = [...dismissed].slice(-50);
      if (Array.isArray(record.alarms)) {
        record.alarms = record.alarms.map((a) => {
          if (!alarmId || String(a.id) === String(alarmId)) {
            return { ...a, enabled: a.isRepeating ? a.enabled : false };
          }
          return a;
        });
      }
      await redis.set(subKey, record);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
