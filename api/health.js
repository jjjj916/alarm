'use strict';

const S = require('../lib/server');

const kst = (ms) => (ms ? new Date(Number(ms)).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : null);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const hasRedis = Boolean((process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN));
  const hasVapid = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const hasQStash = Boolean(process.env.QSTASH_TOKEN);
  const out = {
    ok: hasRedis && hasVapid,
    storageConfigured: hasRedis,
    pushConfigured: hasVapid,
    exactTimeWakeUp: hasQStash,
    cronProtected: Boolean(process.env.CRON_SECRET),
    serverTime: Date.now()
  };

  if (hasRedis) {
    try {
      const redis = S.getRedis();
      // 가장 최근 정각 예약(QStash) 결과: ok:false 면 정각 발송이 안 되고 1분 이상 늦어짐
      const w = await redis.get(S.WAKE_LAST_KEY);
      if (w) {
        out.lastWakeSchedule = {
          ok: Boolean(w.ok), status: w.status, error: w.error || undefined,
          requestedAt: kst(w.at), wakeAt: kst(w.wakeAt), alarmAt: kst(w.alarmAt), qstash: w.base, target: w.target
        };
        if (!w.ok) {
          out.problem = w.status === 429 ? 'QStash 하루 사용 한도 초과 → 정각 예약 실패'
            : w.status === 401 || w.status === 403 ? 'QSTASH_TOKEN이 틀렸거나 다른 지역용 토큰 → Vercel에 QSTASH_URL도 함께 넣어 주세요'
            : 'QStash 예약 실패 (error 참고)';
        }
      }
      // 최근 알람 확인 실행 기록: by 가 qstash 인 줄이 알람 몇 초 전에 있어야 정상
      const log = await redis.lrange(S.DISPATCH_LOG_KEY, 0, 14);
      out.recentDispatch = (log || []).map((x) => {
        const e = typeof x === 'string' ? JSON.parse(x) : x;
        return { at: kst(e.at), by: e.by, sent: e.sent, lateMs: e.lateMs && e.lateMs.length ? e.lateMs : undefined };
      });
    } catch (e) {
      out.diagnosticsError = String(e.message || e);
    }
  }

  return res.status(out.ok ? 200 : 503).json(out);
};
