'use strict';

const S = require('../lib/server');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String((req.query && req.query.action) || 'check').toLowerCase();
  const body = readBody(req);

  try {
    if (action === 'config') {
      return res.status(200).json({
        enabled: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
        vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
        exactWakeUp: Boolean(process.env.QSTASH_TOKEN)
      });
    }

    if (action === 'check') {
      // 예전 주소 호환: /api/push?action=check 도 발송 확인으로 동작
      if (!S.isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
      return res.status(200).json(await S.dispatchDue(req));
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { subscription } = body;
    if (!S.validateSubscription(subscription)) return res.status(400).json({ error: '잘못된 구독 정보입니다.' });

    const redis = S.getRedis();
    const id = S.subscriptionId(subscription);
    const key = S.recordKey(id);

    if (action === 'subscribe') {
      const existing = (await redis.get(key)) || {};
      const alarms = (Array.isArray(body.alarms) ? body.alarms : []).slice(0, 100).map(S.sanitizeAlarm).filter(Boolean);
      const record = {
        subscription,
        alarms,
        timeZone: S.validTimeZone(body.timeZone) ? body.timeZone : 'Asia/Seoul',
        refDeltaMs: Math.max(-600000, Math.min(600000, Number(body.refDeltaMs) || 0)),
        urgentBurstMode: Boolean(body.urgentBurstMode),
        activeRinging: existing.activeRinging || null,
        skipUntil: existing.skipUntil || {},
        timer: body.timer && Number(body.timer.endAt) > Date.now() - 60000
          ? { endAt: Number(body.timer.endAt), totalMs: Number(body.timer.totalMs) || 0 } : null,
        updatedAt: Date.now()
      };
      if (!record.urgentBurstMode) record.activeRinging = null;
      // 삭제된 알람이거나 앱에서 이미 끈 경우 반복 발송 즉시 중단
      if (body.clearRinging || (record.activeRinging &&
          !alarms.some((a) => String(a.id) === String(record.activeRinging.alarmId)))) {
        record.activeRinging = null;
      }
      await redis.set(key, record);
      await redis.sadd(S.SUBSCRIPTIONS_SET, id);

      const next = S.nextOccurrence(record, Date.now());
      const wakeScheduled = next ? await S.scheduleWakeUp(req, next) : false;
      return res.status(200).json({
        ok: true, nextAlarmAt: next, wakeScheduled, exactWakeUp: Boolean(process.env.QSTASH_TOKEN),
        qstashScheduled: wakeScheduled, nextExactTriggerAt: next
      });
    }

    if (action === 'dismiss') {
      const record = await redis.get(key);
      if (record) {
        const now = Date.now();
        const alarmId = body.alarmId ? String(body.alarmId) : null;
        record.activeRinging = null;
        record.skipUntil = record.skipUntil || {};
        for (const a of record.alarms || []) {
          if (alarmId && String(a.id) !== alarmId) continue;
          record.skipUntil[a.id] = now + 1000; // 이미 울린 회차는 다시 보내지 않음
          if (!a.isRepeating && a.singleShotAt && a.singleShotAt <= now + 1000) a.enabled = false;
        }
        for (const k of Object.keys(record.skipUntil)) {
          if (Number(record.skipUntil[k]) < now - S.GRACE_MS * 2) delete record.skipUntil[k];
        }
        record.updatedAt = now;
        await redis.set(key, record);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'status') {
      const record = await redis.get(key);
      if (!record) return res.status(200).json({ registered: false });
      const next = S.nextOccurrence(record, Date.now());
      const wakeScheduled = next ? await S.scheduleWakeUp(req, next) : false;
      return res.status(200).json({
        registered: true,
        enabledAlarms: (record.alarms || []).filter((x) => x.enabled).length,
        nextAlarmAt: next,
        urgentBurstMode: Boolean(record.urgentBurstMode),
        wakeScheduled
      });
    }

    if (action === 'unsubscribe') {
      await redis.srem(S.SUBSCRIPTIONS_SET, id);
      await redis.del(key);
      return res.status(200).json({ ok: true });
    }

    if (action === 'test') {
      const sound = Number(body.sound) || 0;
      const now = Date.now();
      const payload = S.buildPayload({ id: 'test', name: '테스트 알람', time: '', sound }, now, false);
      payload.body = '푸시 알림이 정상적으로 도착했어요.';
      const result = await S.sendPush(redis, id, subscription, payload, null);
      return res.status(result === 'sent' ? 200 : 502).json({ ok: result === 'sent', result });
    }

    return res.status(400).json({ error: '알 수 없는 요청입니다.' });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message || '서버 오류' });
  }
};
