'use strict';

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis 환경 변수가 설정되지 않았습니다.');
  return new Redis({ url, token });
}

function getSubKey(endpoint) {
  const hash = crypto.createHash('sha256').update(String(endpoint)).digest('hex');
  return `smart-clock:sub:${hash}`;
}

function findNextAlarmTimestamp(alarms, timer, timeZone) {
  let minTs = Infinity;
  const now = Date.now();

  if (timer && Number(timer.endAt) > now - 5000) {
    minTs = Math.min(minTs, Number(timer.endAt));
  }

  for (const a of alarms || []) {
    if (!a || !a.enabled) continue;
    if (a.nextSnoozeAt && Number(a.nextSnoozeAt) > now - 5000) {
      minTs = Math.min(minTs, Number(a.nextSnoozeAt));
      continue;
    }
    if (!a.isRepeating && a.singleShotAt && Number(a.singleShotAt) > now - 5000) {
      minTs = Math.min(minTs, Number(a.singleShotAt));
      continue;
    }
    if (Array.isArray(a.days) && a.days.length > 0 && a.time) {
      const [th, tm] = String(a.time).split(':').map(Number);
      for (let d = 0; d < 7; d++) {
        const cand = new Date(now + d * 86400000);
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: timeZone || 'Asia/Seoul',
          year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
        });
        const parts = {};
        for (const p of fmt.formatToParts(cand)) parts[p.type] = p.value;
        const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        if (a.days.includes(dayMap[parts.weekday])) {
          // KST(+09:00) 기준 정각 계산 보정
          const iso = `${parts.year}-${parts.month}-${parts.day}T${String(th).padStart(2, '0')}:${String(tm).padStart(2, '0')}:00+09:00`;
          const ts = Date.parse(iso);
          if (!Number.isNaN(ts) && ts > now - 5000) {
            minTs = Math.min(minTs, ts);
          }
        }
      }
    }
  }
  return Number.isFinite(minTs) ? minTs : null;
}

async function scheduleQStashExact(req, targetTs) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !targetTs) return { scheduled: false, reason: 'NO_TOKEN_OR_TARGET' };

  const qstashUrl = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  if (!host) return { scheduled: false, reason: 'NO_HOST' };
  const proto = String(host).includes('localhost') ? 'http' : 'https';
  const targetUrl = `${proto}://${host}/api/push-cron`;
  const delaySec = Math.max(0, Math.floor((targetTs - Date.now()) / 1000));

  try {
    const res = await fetch(`${qstashUrl}/v2/publish/${encodeURIComponent(targetUrl)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Content-Type': 'application/json',
        'Upstash-Delay': `${delaySec}s`,
        'Upstash-Deduplication-Id': `exact-${Math.floor(targetTs / 1000)}`
      },
      body: JSON.stringify({ source: 'subscribe-exact', targetTs })
    });
    const text = await res.text();
    return { scheduled: res.ok, status: res.status, detail: text.slice(0, 120) };
  } catch (e) {
    return { scheduled: false, reason: e.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const subscription = body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'subscription endpoint is required' });
    }

    const redis = getRedis();
    const key = getSubKey(subscription.endpoint);
    const existing = (await redis.get(key)) || {};

    const alarms = Array.isArray(body.alarms) ? body.alarms : [];
    const timeZone = body.timeZone || 'Asia/Seoul';
    const timer = body.timer || null;
    const urgentBurstMode = Boolean(body.urgentBurstMode);

    const record = {
      subscription,
      alarms,
      timeZone,
      timer,
      urgentBurstMode,
      activeRinging: body.clearRinging ? null : (existing.activeRinging || null),
      updatedAt: Date.now()
    };

    await redis.set(key, record);

    const nextExactTriggerAt = findNextAlarmTimestamp(alarms, timer, timeZone);
    const qstashRes = nextExactTriggerAt ? await scheduleQStashExact(req, nextExactTriggerAt) : { scheduled: false };

    return res.status(200).json({
      ok: true,
      qstashScheduled: qstashRes.scheduled,
      qstashDetail: qstashRes,
      nextExactTriggerAt
    });
  } catch (error) {
    console.error('push-subscribe error:', error);
    return res.status(500).json({ error: error.message || 'Subscribe failed' });
  }
};
