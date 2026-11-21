'use strict';

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const SUBSCRIPTIONS_SET = 'smart-clock:subscriptions';

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Redis 환경 변수(UPSTASH_REDIS_REST_URL / TOKEN)가 설정되지 않았습니다.');
  }
  return new Redis({ url, token });
}

function subscriptionId(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);
}

function recordKey(id) {
  return `smart-clock:sub:${id}`;
}

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: wdMap[map.weekday] ?? 0,
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 3; i++) {
    const p = getZonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const diff = targetUtc - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function computeEarliestTriggerMs(alarms, timer, timeZone, nowMs) {
  let earliest = Infinity;

  if (timer && Number.isFinite(Number(timer.endAt))) {
    const endAt = Number(timer.endAt);
    if (endAt > nowMs - 5000 && endAt < earliest) earliest = endAt;
  }

  const parts = getZonedParts(new Date(nowMs), timeZone);

  for (const alarm of (alarms || [])) {
    if (!alarm || !alarm.enabled) continue;

    if (Number.isFinite(Number(alarm.nextSnoozeAt)) && Number(alarm.nextSnoozeAt) > nowMs - 5000) {
      const due = Number(alarm.nextSnoozeAt);
      if (due < earliest) earliest = due;
      continue;
    }

    if (!alarm.isRepeating) {
      const singleAt = Number(alarm.singleShotAt);
      if (Number.isFinite(singleAt) && singleAt > nowMs - 5000 && singleAt < earliest) {
        earliest = singleAt;
      }
      continue;
    }

    const days = Array.isArray(alarm.days) ? alarm.days : [];
    if (days.length === 0) continue;

    const [hour, minute] = String(alarm.time || '08:00').split(':').map(Number);
    for (let offset = 0; offset <= 7; offset++) {
      const checkWeekday = (parts.weekday + offset) % 7;
      if (!days.includes(checkWeekday)) continue;

      const baseUtc = Date.UTC(parts.year, parts.month - 1, parts.day + offset);
      const targetDate = new Date(baseUtc);
      const candidateUtc = zonedWallTimeToUtc({
        year: targetDate.getUTCFullYear(),
        month: targetDate.getUTCMonth() + 1,
        day: targetDate.getUTCDate(),
        hour: hour || 0,
        minute: minute || 0
      }, timeZone);

      const schedKey = `${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDate.getUTCDate()).padStart(2, '0')}_${alarm.time}_${candidateUtc}`;
      if (alarm.dismissedScheduleKey === schedKey) continue;

      if (candidateUtc > nowMs - 5000 && candidateUtc < earliest) {
        earliest = candidateUtc;
        break;
      }
    }
  }

  return Number.isFinite(earliest) ? earliest : null;
}

async function cancelPreviousQStashMessage(qstashToken, messageId) {
  if (!qstashToken || !messageId) return;
  try {
    await fetch(`https://qstash.upstash.io/v2/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${qstashToken}` }
    });
  } catch {}
}

async function scheduleExactQStashPush(req, triggerAtMs) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken || !triggerAtMs) return null;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (!host) return null;

  const targetUrl = `${proto}://${host}/api/cron-check`;
  const cronSecret = process.env.CRON_SECRET || '';
  const notBeforeSec = Math.max(Math.floor(Date.now() / 1000) + 1, Math.floor(triggerAtMs / 1000));

  const headers = {
    'Authorization': `Bearer ${qstashToken}`,
    'Content-Type': 'application/json',
    'Upstash-Not-Before': String(notBeforeSec),
    'Upstash-Retries': '2'
  };
  if (cronSecret) headers['Upstash-Forward-Authorization'] = `Bearer ${cronSecret}`;

  try {
    const res = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(targetUrl)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'qstash-exact-alarm', scheduledFor: notBeforeSec })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { messageId: data.messageId || null, scheduledAt: notBeforeSec * 1000 };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const subscription = body.subscription;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: '유효한 푸시 구독 정보가 필요합니다.' });
    }

    const redis = getRedis();
    const id = subscriptionId(subscription.endpoint);
    const key = recordKey(id);
    const existing = await redis.get(key);

    const now = Date.now();
    const timeZone = validTimeZone(body.timeZone)
      ? body.timeZone
      : (existing && validTimeZone(existing.timeZone) ? existing.timeZone : 'Asia/Seoul');

    const rawAlarms = Array.isArray(body.alarms) ? body.alarms : (existing && Array.isArray(existing.alarms) ? existing.alarms : []);
    const alarms = rawAlarms.slice(0, 50).map(a => ({
      id: String(a.id || Date.now()),
      name: String(a.name || '알람').slice(0, 40),
      group: String(a.group || '기본 그룹').slice(0, 30),
      time: String(a.time || '08:00'),
      sound: Number(a.sound) || 0,
      randomDaily: Boolean(a.randomDaily),
      days: Array.isArray(a.days) ? a.days.map(Number) : [],
      isRepeating: Boolean(a.isRepeating),
      snoozeInterval: Number(a.snoozeInterval) || 5,
      snoozeCount: Number(a.snoozeCount) || 3,
      remainingSnooze: Number.isFinite(Number(a.remainingSnooze)) ? Number(a.remainingSnooze) : (Number(a.snoozeCount) || 3),
      snoozeLevel: Number(a.snoozeLevel) || 0,
      nextSnoozeTime: a.nextSnoozeTime || null,
      nextSnoozeAt: a.nextSnoozeAt ? Number(a.nextSnoozeAt) : null,
      singleShotAt: a.singleShotAt ? Number(a.singleShotAt) : null,
      userDismissedAt: a.userDismissedAt ? Number(a.userDismissedAt) : null,
      dismissedScheduleKey: a.dismissedScheduleKey || null,
      lastTriggeredKey: a.lastTriggeredKey || null,
      enabled: Boolean(a.enabled)
    }));

    const timer = (body.timer && Number.isFinite(Number(body.timer.endAt)))
      ? { endAt: Number(body.timer.endAt), totalMs: Number(body.timer.totalMs) || 0 }
      : (body.timer === null ? null : (existing ? existing.timer || null : null));

    const urgentBurstMode = body.urgentBurstMode !== undefined
      ? Boolean(body.urgentBurstMode)
      : Boolean(existing && existing.urgentBurstMode);

    const activeRinging = body.clearRinging ? null : (existing ? existing.activeRinging || null : null);

    const qstashToken = process.env.QSTASH_TOKEN;
    if (qstashToken && existing && existing.qstashMessageId) {
      await cancelPreviousQStashMessage(qstashToken, existing.qstashMessageId);
    }

    const earliestTriggerMs = computeEarliestTriggerMs(alarms, timer, timeZone, now);
    const qstashResult = await scheduleExactQStashPush(req, earliestTriggerMs);

    const record = {
      id,
      subscription,
      alarms,
      timer,
      timeZone,
      urgentBurstMode,
      activeRinging,
      qstashMessageId: qstashResult ? qstashResult.messageId : null,
      qstashScheduledAt: qstashResult ? qstashResult.scheduledAt : null,
      updatedAt: now
    };

    await redis.set(key, record);
    await redis.sadd(SUBSCRIPTIONS_SET, id);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      id,
      alarmCount: alarms.length,
      qstashScheduled: Boolean(qstashResult),
      nextExactTriggerAt: qstashResult ? new Date(qstashResult.scheduledAt).toISOString() : null
    });
  } catch (error) {
    console.error('push-subscribe error:', error);
    return res.status(500).json({ error: error.message || '푸시 구독 저장 중 오류가 발생했습니다.' });
  }
};
