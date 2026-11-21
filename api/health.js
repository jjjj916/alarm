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

  // 상세 진단(알람 발송 시각 기록, 토큰 점검)은 주인만: /api/health?key=CRON_SECRET값
  // (누구나 보면 사용자 알람 시각이 드러나고, 열 때마다 QStash 확인 요청이 나가므로)
  const secret = process.env.CRON_SECRET;
  const key = String((req.query && req.query.key) || '');
  const detailed = !secret || (key.length === secret.length &&
    require('crypto').timingSafeEqual(Buffer.from(key), Buffer.from(secret)));
  if (!detailed) {
    out.detail = '상세 진단은 /api/health?key=CRON_SECRET값 으로 확인하세요';
    return res.status(out.ok ? 200 : 503).json(out);
  }

  // QStash 토큰 점검 (토큰 값은 노출하지 않고 형태와 실제 인증 결과만 표시)
  if (hasQStash) {
    const raw = String(process.env.QSTASH_TOKEN);
    const token = S.qstashToken();
    const check = {
      length: token.length,
      hadQuotesOrSpaces: raw !== token,
      looksLike: /^sig_/i.test(token) ? '❌ Signing Key(서명 키)예요 — QSTASH_TOKEN 값을 넣어야 해요'
        : /^AX|^AY|^A[A-Za-z0-9]{10,}$/.test(token) && token.length < 60 ? '❌ Redis 토큰처럼 보여요 — QStash 메뉴의 QSTASH_TOKEN을 넣어야 해요'
        : /^ey/.test(token) ? 'QStash 토큰 형태 맞음' : '형태를 알 수 없음',
      qstashUrlEnv: process.env.QSTASH_URL || null,
      regions: {}
    };
    const bases = [...new Set([process.env.QSTASH_URL ? process.env.QSTASH_URL.trim().replace(/\/$/, '') : null, ...S.QSTASH_BASES].filter(Boolean))];
    await Promise.all(bases.map(async (b) => {
      try {
        const r = await fetch(`${b}/v2/schedules`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
        check.regions[b] = r.ok ? '✅ 인증 성공' : `❌ ${r.status}`;
      } catch (e) { check.regions[b] = `❌ ${e.name || 'error'}`; }
    }));
    check.result = Object.values(check.regions).some((v) => v.startsWith('✅'))
      ? '✅ 토큰 정상' : '❌ 모든 지역에서 인증 실패 → 토큰 값이 틀렸어요 (Upstash 콘솔 QStash 탭의 QSTASH_TOKEN을 다시 복사 → Vercel에 저장 → Redeploy)';
    out.qstashTokenCheck = check;
  }

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
