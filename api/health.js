'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  const hasVapid = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  return res.status(hasRedis && hasVapid ? 200 : 503).json({
    ok: hasRedis && hasVapid,
    storageConfigured: hasRedis,
    pushConfigured: hasVapid
  });
};
