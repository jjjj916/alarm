'use strict';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const hasRedis = Boolean((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
  const hasVapid = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const hasQStash = Boolean(process.env.QSTASH_TOKEN);
  return res.status(hasRedis && hasVapid ? 200 : 503).json({
    ok: hasRedis && hasVapid,
    storageConfigured: hasRedis,
    pushConfigured: hasVapid,
    exactTimeWakeUp: hasQStash,
    note: hasQStash ? '정각 발송 예약(QStash) 사용 중' : 'QSTASH_TOKEN이 없어 1분 주기 호출에만 의존합니다(정각보다 늦을 수 있음).',
    serverTime: Date.now()
  });
};
