'use strict';

/*
 * 스마트 시계 서버 공통 모듈
 * - 모든 API(push / cron-check / push-cron)가 같은 Redis 키 구조를 사용합니다.
 *   (이전에는 구독 저장 키와 발송 확인 키가 서로 달라 푸시가 오지 않았습니다.)
 * - 알람 발송은 "예약 시각 - PUSH_LEAD_MS"까지 기다렸다가 보내므로 정각 00초에 도착하도록 맞춥니다.
 * - QStash(QSTASH_TOKEN)가 설정되어 있으면 다음 알람 5초 전에 이 서버를 정확히 깨웁니다.
 *   설정이 없으면 Apps Script/GitHub Actions의 1분 호출에만 의존하므로 늦을 수 있습니다.
 */

const crypto = require('crypto');
const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

const SUBSCRIPTIONS_SET = 'smart-clock:subscriptions';
const RECORD_PREFIX = 'smart-clock:sub:';
const SENT_PREFIX = 'smart-clock:sent:';

const GRACE_MS = 3 * 60 * 1000;          // 늦게 깨어난 경우에도 3분 안이면 발송
const LOOKAHEAD_MS = 9 * 1000;           // 9초 이내에 울릴 알람은 기다렸다가 정각에 발송
const WAKE_BEFORE_MS = 6 * 1000;         // QStash로 알람 6초 전에 서버를 깨움
const URGENT_REPEAT_MS = 10 * 1000;
const URGENT_MAX_MS = 10 * 60 * 1000;
const PUSH_LEAD_MS = Math.max(0, Math.min(3000, Number(process.env.PUSH_LEAD_MS) || 300));

let redisClient = null;
function getRedis() {
  if (redisClient) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    const error = new Error('Upstash Redis 환경 변수(UPSTASH_REDIS_REST_URL / TOKEN)가 설정되지 않았습니다.');
    error.statusCode = 503;
    throw error;
  }
  redisClient = new Redis({ url, token });
  return redisClient;
}

let vapidReady = false;
function configureWebPush() {
  if (vapidReady) return webpush;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const error = new Error('VAPID_PUBLIC_KEY 또는 VAPID_PRIVATE_KEY가 설정되지 않았습니다.');
    error.statusCode = 503;
    throw error;
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', pub, priv);
  vapidReady = true;
  return webpush;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function subscriptionId(subscription) {
  return crypto.createHash('sha256').update(String(subscription.endpoint)).digest('hex').slice(0, 40);
}
const recordKey = (id) => `${RECORD_PREFIX}${id}`;

function validTime(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}
function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 80) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()); return true; } catch { return false; }
}
// 진짜 브라우저 푸시 서비스 주소만 허용 (가짜 주소로 이 서버가 아무 곳에나 요청을 보내지 못하게)
const PUSH_HOST_RE = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)$/i;
function validateSubscription(s) {
  if (!(s && typeof s === 'object' && typeof s.endpoint === 'string' && s.endpoint.length < 1000 &&
    s.keys && typeof s.keys.p256dh === 'string' && s.keys.p256dh.length < 200 &&
    typeof s.keys.auth === 'string' && s.keys.auth.length < 100)) return false;
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && PUSH_HOST_RE.test(u.hostname);
  } catch { return false; }
}

// 간단한 요청 횟수 제한 (IP별, Redis 카운터)
function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0, 64);
}
async function rateLimit(req, name, limit, windowSec) {
  try {
    const redis = getRedis();
    const key = `smart-clock:rl:${name}:${clientIp(req)}:${Math.floor(Date.now() / 1000 / windowSec)}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec + 5);
    return n <= limit;
  } catch {
    return true; // 저장소 오류 때문에 정상 사용자를 막지는 않음
  }
}
const MAX_SUBSCRIPTIONS = Number(process.env.MAX_SUBSCRIPTIONS) || 5000;

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day), weekday: wd[p.weekday] ?? 0,
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second)
  };
}

function zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = getZonedParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const diff = target - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function sanitizeAlarm(input) {
  if (!input || typeof input !== 'object' || !validTime(input.time)) return null;
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  const isRepeating = Boolean(input.isRepeating) && days.length > 0;
  const single = Number(input.singleShotAt);
  const snoozeAt = Number(input.nextSnoozeAt);
  return {
    id: String(input.id ?? crypto.randomUUID()).slice(0, 80),
    name: String(input.name ?? '알람').slice(0, 40) || '알람',
    group: String(input.group ?? '').slice(0, 20),
    time: input.time,
    nextSnoozeAt: Number.isFinite(snoozeAt) && snoozeAt > 0 ? snoozeAt : null,
    nextSnoozeTime: validTime(input.nextSnoozeTime) ? input.nextSnoozeTime : null,
    snoozeInterval: Math.max(1, Math.min(60, Number(input.snoozeInterval) || 5)),
    snoozeCount: Math.max(1, Math.min(20, Number(input.snoozeCount) || 3)),
    remainingSnooze: Math.max(0, Math.min(20, Number.isFinite(Number(input.remainingSnooze)) ? Number(input.remainingSnooze) : 3)),
    snoozeLevel: Math.max(0, Math.min(3, Number(input.snoozeLevel) || 0)),
    sound: Number.isInteger(Number(input.sound)) ? Math.max(0, Math.min(11, Number(input.sound))) : 0,
    days,
    isRepeating,
    enabled: Boolean(input.enabled),
    singleShotAt: !isRepeating && Number.isFinite(single) && single > 0 ? single : null
  };
}

/** 알람의 "실제(표준시) 발송 시각" 후보들. refDeltaMs = 사용자가 고른 기준 서버 시계 - 표준시 */
function occurrencesAround(alarm, timeZone, refDeltaMs, nowMs, daysBack = 1, daysAhead = 1) {
  if (!alarm || !alarm.enabled) return [];
  const extra = Number(alarm.nextSnoozeAt) > 0 ? [Number(alarm.nextSnoozeAt)] : [];
  if (!alarm.isRepeating) {
    return Number.isFinite(Number(alarm.singleShotAt)) && alarm.singleShotAt > 0 ? [Number(alarm.singleShotAt), ...extra] : extra;
  }
  const out = [...extra];
  const [hour, minute] = alarm.time.split(':').map(Number);
  const ref = getZonedParts(new Date(nowMs + refDeltaMs), timeZone);
  for (let off = -daysBack; off <= daysAhead; off++) {
    const d = new Date(Date.UTC(ref.year, ref.month - 1, ref.day + off));
    if (!alarm.days.includes(d.getUTCDay())) continue;
    const wall = zonedWallTimeToUtc({
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute
    }, timeZone);
    out.push(wall - refDeltaMs);
  }
  return out;
}

function nextOccurrence(record, afterMs) {
  const tz = validTimeZone(record.timeZone) ? record.timeZone : 'Asia/Seoul';
  const delta = Number(record.refDeltaMs) || 0;
  let best = null;
  for (const a of record.alarms || []) {
    for (const t of occurrencesAround(a, tz, delta, afterMs, 0, 8)) {
      if (t > afterMs && (best === null || t < best)) best = t;
    }
  }
  if (record.timer && Number(record.timer.endAt) > afterMs && (best === null || Number(record.timer.endAt) < best)) {
    best = Number(record.timer.endAt);
  }
  if (record.activeRinging && record.urgentBurstMode) {
    const t = Number(record.activeRinging.lastSentAt || 0) + URGENT_REPEAT_MS;
    if (best === null || t < best) best = Math.max(t, afterMs + 1000);
  }
  return best;
}

function formatKoreanTime(hm) {
  const [h, m] = String(hm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  return `${h >= 12 ? '오후' : '오전'} ${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')}`;
}

function buildPayload(alarm, at, urgent, repeatCount = 0) {
  const name = alarm.name || '알람';
  const timeText = formatKoreanTime(Number(alarm.nextSnoozeAt) === Number(at) && alarm.nextSnoozeTime ? alarm.nextSnoozeTime : alarm.time);
  const isSnooze = Number(alarm.nextSnoozeAt) === Number(at);
  const shownTime = isSnooze && alarm.nextSnoozeTime ? alarm.nextSnoozeTime : alarm.time;
  return {
    type: 'alarm',
    alarmId: String(alarm.id),
    at,
    name,
    group: alarm.group || '',
    time: shownTime,
    sound: alarm.sound ?? 0,
    isRepeating: Boolean(alarm.isRepeating),
    snoozeInterval: alarm.snoozeInterval || 5,
    snoozeCount: alarm.snoozeCount || 3,
    remainingSnooze: Number.isFinite(Number(alarm.remainingSnooze)) ? Number(alarm.remainingSnooze) : 3,
    snoozeLevel: alarm.snoozeLevel || 0,
    scheduleKey: `srv_${alarm.id}_${at}`,
    urgentBurstMode: Boolean(urgent),
    title: `⏰ ${name}`,
    body: urgent
      ? `${timeText} · 끄기 전까지 10초마다 다시 알려드려요${repeatCount ? ` (${repeatCount}회째)` : ''}`
      : `${timeText} 알람`,
    tag: `alarm-${alarm.id}-${at}`
  };
}

/* ---------------- QStash: 다음 알람 직전에 서버를 정확히 깨움 ---------------- */
function originFromReq(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? `${proto}://${host}` : null;
}

async function scheduleWakeUp(req, alarmAtMs) {
  const token = process.env.QSTASH_TOKEN;
  if (!token || !alarmAtMs) return false;
  const origin = originFromReq(req);
  if (!origin) return false;
  const wakeAt = Math.max(Date.now() + 1000, alarmAtMs - WAKE_BEFORE_MS);
  const notBeforeSec = Math.floor(wakeAt / 1000);
  const base = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Upstash-Not-Before': String(notBeforeSec),
    'Upstash-Retries': '1',
    'Upstash-Deduplication-Id': `smart-clock-wake-${notBeforeSec}`
  };
  if (process.env.CRON_SECRET) headers['Upstash-Forward-Authorization'] = `Bearer ${process.env.CRON_SECRET}`;
  try {
    const res = await fetch(`${base}/v2/publish/${origin}/api/cron-check`, {
      method: 'POST', headers, body: JSON.stringify({ source: 'qstash', wakeAt })
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------------- 발송 ---------------- */
async function sendPush(redis, id, subscription, payload, dedupeKey) {
  const wp = configureWebPush();
  if (dedupeKey) {
    const reserved = await redis.set(dedupeKey, '1', { nx: true, ex: 3 * 86400 });
    if (reserved !== 'OK') return 'duplicate';
  }
  try {
    await wp.sendNotification(subscription, JSON.stringify(payload), { TTL: 120, urgency: 'high' });
    return 'sent';
  } catch (error) {
    const status = error.statusCode || error.status;
    if (status === 404 || status === 410) {
      await redis.srem(SUBSCRIPTIONS_SET, id);
      await redis.del(recordKey(id));
      return 'expired';
    }
    if (dedupeKey) await redis.del(dedupeKey).catch(() => {});
    console.error('web push failed:', status || '', error.body || error.message || error);
    return 'failed';
  }
}

/**
 * 모든 구독을 확인해 지금(또는 몇 초 안에) 울려야 할 알람을 정각에 맞춰 발송합니다.
 * 여러 경로(QStash, Apps Script, GitHub Actions)가 동시에 불러도 Redis NX 키로 1번만 발송됩니다.
 */
async function dispatchDue(req) {
  const redis = getRedis();
  configureWebPush();
  const startedAt = Date.now();
  const ids = (await redis.smembers(SUBSCRIPTIONS_SET)) || [];
  const jobs = [];
  const records = {};

  for (const id of ids) {
    const record = await redis.get(recordKey(id));
    if (!record || !record.subscription) { await redis.srem(SUBSCRIPTIONS_SET, id); continue; }
    records[id] = record;
    const tz = validTimeZone(record.timeZone) ? record.timeZone : 'Asia/Seoul';
    const delta = Number(record.refDeltaMs) || 0;
    const skip = record.skipUntil || {};

    for (const alarm of record.alarms || []) {
      for (const at of occurrencesAround(alarm, tz, delta, startedAt)) {
        if (at < startedAt - GRACE_MS || at > startedAt + LOOKAHEAD_MS) continue;
        if (skip[alarm.id] && at <= Number(skip[alarm.id])) continue;
        jobs.push({ id, kind: 'alarm', alarm, at });
      }
    }

    const tm = record.timer;
    if (tm && Number(tm.endAt) >= startedAt - GRACE_MS && Number(tm.endAt) <= startedAt + LOOKAHEAD_MS) {
      jobs.push({ id, kind: 'timer', alarm: tm, at: Number(tm.endAt) });
    }

    const ar = record.activeRinging;
    if (ar && record.urgentBurstMode) {
      const nextAt = Number(ar.lastSentAt || 0) + URGENT_REPEAT_MS;
      if (startedAt - Number(ar.startedAt || 0) > URGENT_MAX_MS) {
        record.activeRinging = null;
        await redis.set(recordKey(id), record);
      } else if (nextAt <= startedAt + LOOKAHEAD_MS) {
        jobs.push({ id, kind: 'urgent', alarm: ar, at: nextAt });
      }
    }
  }

  jobs.sort((a, b) => a.at - b.at);
  let sent = 0;
  const results = [];

  for (const job of jobs) {
    const wait = job.at - PUSH_LEAD_MS - Date.now();
    if (wait > 0) await sleep(wait);
    const record = records[job.id];
    const urgent = Boolean(record.urgentBurstMode);
    let payload, dedupeKey;
    if (job.kind === 'alarm') {
      payload = buildPayload(job.alarm, job.at, urgent);
      dedupeKey = `${SENT_PREFIX}${job.id}:${job.alarm.id}:${job.at}`;
    } else if (job.kind === 'timer') {
      payload = { type: 'timer', alarmId: 'timer', at: job.at, totalMs: Number(job.alarm.totalMs) || 0,
        title: '⏳ 타이머 완료', body: '설정한 타이머 시간이 끝났어요.', tag: `timer-${job.at}` };
      dedupeKey = `${SENT_PREFIX}${job.id}:timer:${job.at}`;
    } else {
      const count = Number(job.alarm.count || 1) + 1;
      payload = buildPayload(job.alarm, job.alarm.at, true, count);
      payload.tag = `alarm-${job.alarm.alarmId || job.alarm.id}-${job.alarm.at}-r${count}`;
      dedupeKey = `${SENT_PREFIX}${job.id}:urgent:${job.alarm.alarmId}:${job.alarm.at}:${count}`;
    }
    const result = await sendPush(getRedis(), job.id, record.subscription, payload, dedupeKey);
    results.push(result);
    if (result !== 'sent') continue;
    sent++;

    // 최신 레코드를 다시 읽어 필요한 부분만 갱신 (동시에 저장한 알람 변경을 덮어쓰지 않도록)
    const fresh = await redis.get(recordKey(job.id));
    if (!fresh) continue;
    if (job.kind === 'timer') {
      if (fresh.timer && Number(fresh.timer.endAt) === job.at) fresh.timer = null;
    } else if (job.kind === 'alarm') {
      const a = (fresh.alarms || []).find((x) => String(x.id) === String(job.alarm.id));
      if (a && !a.isRepeating && Number(a.singleShotAt) === job.at && !a.nextSnoozeAt) { a.enabled = false; }
      if (a && Number(a.nextSnoozeAt) === job.at) { a.nextSnoozeAt = null; }
      if (fresh.urgentBurstMode) {
        fresh.activeRinging = {
          alarmId: String(job.alarm.id), id: String(job.alarm.id), name: job.alarm.name, time: job.alarm.time,
          sound: job.alarm.sound, at: job.at, startedAt: job.at, lastSentAt: job.at, count: 1
        };
      }
    } else if (fresh.activeRinging) {
      fresh.activeRinging.lastSentAt = job.at;
      fresh.activeRinging.count = Number(fresh.activeRinging.count || 1) + 1;
    }
    fresh.updatedAt = Date.now();
    records[job.id] = fresh;
    await redis.set(recordKey(job.id), fresh);
  }

  // 다음 알람 직전에 다시 깨우기
  let next = null;
  for (const id of Object.keys(records)) {
    const t = nextOccurrence(records[id], Date.now() + 500);
    if (t && (next === null || t < next)) next = t;
  }
  const wakeScheduled = next ? await scheduleWakeUp(req, next) : false;

  return { ok: true, checked: Object.keys(records).length, jobs: jobs.length, sent, results, nextAlarmAt: next, wakeScheduled };
}

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return (req.headers.authorization || '') === `Bearer ${secret}`;
}

module.exports = {
  SUBSCRIPTIONS_SET, GRACE_MS, getRedis, configureWebPush, subscriptionId, recordKey,
  validTime, validTimeZone, validateSubscription, rateLimit, MAX_SUBSCRIPTIONS, getZonedParts, zonedWallTimeToUtc,
  sanitizeAlarm, occurrencesAround, nextOccurrence, buildPayload, scheduleWakeUp,
  sendPush, dispatchDue, isCronAuthorized
};
