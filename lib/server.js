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
// 무제한 긴급알림: 끄기 전까지 계속 반복 (환경 변수 URGENT_MAX_MIN에 분을 넣으면 그 시간까지만)
const URGENT_MAX_MS = Number(process.env.URGENT_MAX_MIN) > 0 ? Number(process.env.URGENT_MAX_MIN) * 60 * 1000 : Infinity;
// QStash 무료 사용량을 아끼려고, 10초 반복용 정밀 예약은 처음 10분만 사용
// (그 뒤에도 반복은 계속되고, 1분마다 오는 Apps Script 호출이 이어서 보냄)
const URGENT_QSTASH_MS = 10 * 60 * 1000;
// 휴대폰까지 전달되는 데 걸리는 시간(구글·애플 서버 → 기기). 실제 '보내는 데 걸린 시간'은 자동으로 측정해 더함
const PUSH_LEAD_MS = Math.max(0, Math.min(3000, Number(process.env.PUSH_LEAD_MS) || 250));
const https = require('https');
// 푸시 서버와 연결을 미리 열어 두고 재사용 (정각 순간에 연결 맺는 시간 제거)
const pushAgent = new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 10000 });
function warmPushConnection(endpoint) {
  return new Promise((resolve) => {
    try {
      const u = new URL(endpoint);
      const req = https.request({ host: u.hostname, method: 'HEAD', path: '/', agent: pushAgent, timeout: 1200 }, (res) => {
        res.resume(); res.on('end', resolve); res.on('error', resolve);
      });
      req.on('error', resolve);
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    } catch { resolve(); }
  });
}
// 푸시 서비스별 '보내는 데 걸린 시간' 평균 (구글/애플이 다름)
const sendMsMemo = {};
async function sendLatency(redis, endpoint) {
  let host = 'unknown';
  try { host = new URL(endpoint).hostname; } catch {}
  if (sendMsMemo[host] === undefined) {
    const v = Number(await redis.get(`smart-clock:sendms:${host}`).catch(() => null));
    sendMsMemo[host] = Number.isFinite(v) && v > 0 ? v : 150;
  }
  return { host, ms: sendMsMemo[host] };
}
async function recordLatency(redis, host, tookMs) {
  const prev = sendMsMemo[host] ?? 150;
  const next = Math.round(Math.max(20, Math.min(2000, prev * 0.7 + tookMs * 0.3)));
  sendMsMemo[host] = next;
  await redis.set(`smart-clock:sendms:${host}`, next, { ex: 30 * 86400 }).catch(() => {});
}

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
  if (record.activeRinging && record.urgentBurstMode && afterMs - Number(record.activeRinging.startedAt || 0) < URGENT_QSTASH_MS) {
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
      ? `${timeText} 스마트 시계 알람 · 끄기 전까지 10초마다 다시 알려드려요${repeatCount ? ` (${repeatCount}회째)` : ''}`
      : `${timeText} 스마트 시계 알람`,
    tag: `alarm-${alarm.id}-${at}`
  };
}

/* ---------------- QStash: 다음 알람 직전에 서버를 정확히 깨움 ---------------- */
function originFromReq(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  // Vercel 운영 주소 (개별 배포 주소는 '배포 보호'로 막혀 QStash 호출이 401로 실패할 수 있음)
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return host ? `${proto}://${host}` : null;
}

let workingQStashBase = null;
const DISPATCH_LOG_KEY = 'smart-clock:dispatch-log';
const WAKE_LAST_KEY = 'smart-clock:wake-last';

/**
 * 알람 6초 전에 서버를 깨우는 QStash 예약.
 * - 같은 시각 예약은 Redis에 기억해 두고 다시 보내지 않음
 *   (이전에는 1분마다 오는 Apps Script 호출 때마다 예약을 새로 보내 하루 1,400건 이상 →
 *    QStash 무료 한도 초과 → 정각 예약이 조용히 실패하고 1분 이상 늦게 울렸음)
 * - 지역별 QStash 주소가 다른 토큰도 자동으로 맞춰 봄
 * - 성공/실패 결과를 저장해 /api/health 에서 바로 확인 가능
 */
// 붙여넣을 때 같이 들어가기 쉬운 따옴표·공백·'Bearer ' 제거
function qstashToken() {
  return String(process.env.QSTASH_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').replace(/^Bearer\s+/i, '').trim();
}
const QSTASH_BASES = ['https://qstash.upstash.io', 'https://qstash-us-east-1.upstash.io', 'https://qstash-eu-central-1.upstash.io'];

async function scheduleWakeUp(req, alarmAtMs) {
  const token = qstashToken();
  if (!token || !alarmAtMs) return false;
  const origin = originFromReq(req);
  if (!origin) return false;
  const wakeAt = Math.max(Date.now() + 1000, alarmAtMs - WAKE_BEFORE_MS);
  const notBeforeSec = Math.floor(wakeAt / 1000);
  const redis = getRedis();
  // 토큰이 틀려 계속 실패하는 중이면 10분 동안은 다시 시도하지 않음 (불필요한 요청 방지)
  const failKey = `smart-clock:wake-fail:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  if (await redis.get(failKey).catch(() => null)) return false;
  // '예약 성공' 표시는 실제로 성공했을 때만 남김 (실패한 예약이 표시만 남아 다시 시도하지 않던 문제 수정)
  const memoKey = `smart-clock:wake-ok:${notBeforeSec}`;
  if (await redis.get(memoKey).catch(() => null)) return true; // 이미 같은 시각으로 예약 성공
  const lock = await redis.set(`${memoKey}:lock`, '1', { nx: true, ex: 15 }).catch(() => 'OK');
  if (lock !== 'OK') return true; // 다른 호출이 지금 예약 중

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Upstash-Not-Before': String(notBeforeSec),
    'Upstash-Retries': '2',
    'Upstash-Deduplication-Id': `smart-clock-wake-${notBeforeSec}`
  };
  if (process.env.CRON_SECRET) headers['Upstash-Forward-Authorization'] = `Bearer ${process.env.CRON_SECRET}`;

  const bases = [...new Set([
    workingQStashBase,
    process.env.QSTASH_URL ? process.env.QSTASH_URL.trim().replace(/\/$/, '') : null,
    ...QSTASH_BASES
  ].filter(Boolean))];

  let last = { ok: false, status: 0, error: '' };
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/v2/publish/${origin}/api/cron-check`, {
        method: 'POST', headers, body: JSON.stringify({ source: 'qstash', wakeAt })
      });
      const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
      last = { ok: res.ok, status: res.status, error: text, base };
      if (res.ok) { workingQStashBase = base; break; }
      if (![401, 403, 404].includes(res.status)) break; // 한도 초과(429) 등은 다른 지역으로 바꿔도 같음
    } catch (e) {
      last = { ok: false, status: 0, error: String(e.message || e).slice(0, 200), base };
    }
  }
  if (last.ok) {
    await redis.set(memoKey, '1', { ex: 2 * 86400 }).catch(() => {});
  } else if ([401, 403].includes(last.status)) {
    await redis.set(failKey, '1', { ex: 600 }).catch(() => {});
  }
  await redis.del(`${memoKey}:lock`).catch(() => {});
  await redis.set(WAKE_LAST_KEY, {
    ...last, at: Date.now(), wakeAt: notBeforeSec * 1000, alarmAt: alarmAtMs, target: `${origin}/api/cron-check`
  }).catch(() => {});
  return last.ok;
}

/* ---------------- 발송 ---------------- */
async function sendPush(redis, id, subscription, payload, dedupeKey, reserved = false) {
  const wp = configureWebPush();
  if (dedupeKey && !reserved) {
    const reserved = await redis.set(dedupeKey, '1', { nx: true, ex: 3 * 86400 });
    if (reserved !== 'OK') return 'duplicate';
  }
  try {
    await wp.sendNotification(subscription, JSON.stringify(payload), { TTL: 120, urgency: 'high', agent: pushAgent, timeout: 8000 });
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
async function dispatchDue(req, opts = {}) {
  const redis = getRedis();
  configureWebPush();
  const startedAt = Date.now();
  // 기다릴 수 있는 범위: QStash/GitHub는 9초, 1분마다 오는 Apps Script는 45초까지 기다렸다가 정각에 발송
  const lookahead = Math.max(LOOKAHEAD_MS, Math.min(50000, Number(opts.lookaheadMs) || LOOKAHEAD_MS));
  const windowEnd = startedAt + lookahead;
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
        if (at < startedAt - GRACE_MS || at > windowEnd) continue;
        if (skip[alarm.id] && at <= Number(skip[alarm.id])) continue;
        jobs.push({ id, kind: 'alarm', alarm, at });
      }
    }

    const tm = record.timer;
    if (tm && Number(tm.endAt) >= startedAt - GRACE_MS && Number(tm.endAt) <= windowEnd) {
      jobs.push({ id, kind: 'timer', alarm: tm, at: Number(tm.endAt) });
    }

    const ar = record.activeRinging;
    if (ar && record.urgentBurstMode) {
      const nextAt = Math.max(startedAt, Number(ar.lastSentAt || 0) + URGENT_REPEAT_MS);
      if (startedAt - Number(ar.startedAt || 0) > URGENT_MAX_MS) {
        record.activeRinging = null;
        await redis.set(recordKey(id), record);
      } else if (nextAt <= windowEnd) {
        jobs.push({ id, kind: 'urgent', at: nextAt });
      }
    }
  }

  let sent = 0;
  const lateMs = [];
  const results = [];

  // 같은 시각(50ms 이내) 발송은 기기별로 동시에 처리 → 여러 기기여도 모두 정각에
  const runJob = async (job) => {
    // ① 발송 1.5초 전까지 대기 → 상태 확인·중복 예약·연결 준비를 미리 끝내고
    // ② 남은 시간만 정밀하게 기다려 '정각 - (보내는 시간 + 전달 시간)'에 바로 발송
    const baseRecord = records[job.id];
    const lat = await sendLatency(redis, baseRecord && baseRecord.subscription ? baseRecord.subscription.endpoint : '');
    const sendAt = job.at - PUSH_LEAD_MS - lat.ms;
    const pre = sendAt - 1500 - Date.now();
    if (pre > 0) await sleep(pre);

    // 보내기 직전에 최신 상태 확인 (그 사이 사용자가 끄거나 바꿨을 수 있음)
    const cur = (await redis.get(recordKey(job.id))) || records[job.id];
    if (!cur || !cur.subscription) return;
    records[job.id] = cur;
    const urgent = Boolean(cur.urgentBurstMode);
    let payload, dedupeKey;

    if (job.kind === 'alarm') {
      const live = (cur.alarms || []).find((x) => String(x.id) === String(job.alarm.id));
      if (!live || !live.enabled) return;
      if (cur.skipUntil && cur.skipUntil[live.id] && job.at <= Number(cur.skipUntil[live.id])) return;
      payload = buildPayload(live, job.at, urgent);
      dedupeKey = `${SENT_PREFIX}${job.id}:${live.id}:${job.at}`;
      job.alarm = live;
    } else if (job.kind === 'timer') {
      if (!cur.timer || Number(cur.timer.endAt) !== job.at) return;
      payload = { type: 'timer', alarmId: 'timer', at: job.at, totalMs: Number(cur.timer.totalMs) || 0,
        title: '⏳ 타이머 완료', body: '설정한 타이머 시간이 끝났어요.', tag: `timer-${job.at}` };
      dedupeKey = `${SENT_PREFIX}${job.id}:timer:${job.at}`;
    } else {
      const ar = cur.activeRinging;
      if (!ar || !urgent || Date.now() - Number(ar.startedAt || 0) > URGENT_MAX_MS) return;
      if (Number(cur.dismissedAt || 0) >= Number(ar.startedAt || 0)) return; // 이미 끈 알람
      // 여러 호출이 겹쳐도 반복 알림이 몰려 가지 않게 9초 잠금
      const lock = await redis.set(`smart-clock:urgent-lock:${job.id}`, '1', { nx: true, ex: 9 });
      if (lock !== 'OK') return;
      const count = Number(ar.count || 1) + 1;
      payload = buildPayload(ar, ar.at, true, count);
      payload.tag = `alarm-${ar.alarmId}-${ar.at}-r${count}`;
      dedupeKey = null;
    }

    if (dedupeKey) {
      const ok = await redis.set(dedupeKey, '1', { nx: true, ex: 3 * 86400 });
      if (ok !== 'OK') return;
    }
    await warmPushConnection(cur.subscription.endpoint);
    const rest = sendAt - Date.now();
    if (rest > 0) await sleep(rest);
    const t0 = Date.now();
    const result = await sendPush(redis, job.id, cur.subscription, payload, dedupeKey, true);
    results.push(result);
    if (result !== 'sent') return;
    sent++;
    const sentAt = Date.now();
    const took = sentAt - t0;
    await recordLatency(redis, lat.host, took);
    // 기기 도착 예상 시각 - 정각 (0에 가까울수록 정확)
    lateMs.push(sentAt + PUSH_LEAD_MS - job.at);

    const fresh = (await redis.get(recordKey(job.id))) || cur;
    if (job.kind === 'timer') {
      if (fresh.timer && Number(fresh.timer.endAt) === job.at) fresh.timer = null;
    } else if (job.kind === 'alarm') {
      const a = (fresh.alarms || []).find((x) => String(x.id) === String(job.alarm.id));
      if (a && !a.isRepeating && Number(a.singleShotAt) === job.at && !a.nextSnoozeAt) { a.enabled = false; }
      if (a && Number(a.nextSnoozeAt) === job.at) { a.nextSnoozeAt = null; }
      // 보내는 사이 사용자가 이미 껐다면(앱에서 먼저 울려서 바로 끈 경우 등) 반복 알림을 다시 살리지 않음
      if (fresh.urgentBurstMode && !(Number(fresh.dismissedAt || 0) >= job.at - 60 * 1000)) {
        fresh.activeRinging = {
          alarmId: String(job.alarm.id), id: String(job.alarm.id), name: job.alarm.name, time: job.alarm.time,
          sound: job.alarm.sound, at: job.at, startedAt: job.at, lastSentAt: sentAt, count: 1
        };
        if (sentAt + URGENT_REPEAT_MS <= windowEnd) jobs.push({ id: job.id, kind: 'urgent', at: sentAt + URGENT_REPEAT_MS });
      }
    } else if (fresh.activeRinging) {
      // 실제로 보낸 시각을 기록 (예전에는 예정 시각을 기록해서 반복 알림이 점점 밀렸음)
      fresh.activeRinging.lastSentAt = sentAt;
      fresh.activeRinging.count = Number(fresh.activeRinging.count || 1) + 1;
      if (sentAt + URGENT_REPEAT_MS <= windowEnd) jobs.push({ id: job.id, kind: 'urgent', at: sentAt + URGENT_REPEAT_MS });
    }
    fresh.updatedAt = Date.now();
    // 쓰기 직전에 한 번 더 확인: 그 사이 '끄기'가 들어왔으면 끈 상태를 지킴
    const latest = await redis.get(recordKey(job.id));
    if (latest && Number(latest.dismissedAt || 0) > Number(fresh.dismissedAt || 0)) {
      fresh.dismissedAt = latest.dismissedAt;
      fresh.activeRinging = null;
      fresh.skipUntil = { ...(fresh.skipUntil || {}), ...(latest.skipUntil || {}) };
    }
    records[job.id] = fresh;
    await redis.set(recordKey(job.id), fresh);
    };
  while (jobs.length) {
    jobs.sort((a, b) => a.at - b.at);
    const first = jobs[0].at;
    const batch = jobs.filter((j) => j.at - first < 50);
    for (const j of batch) jobs.splice(jobs.indexOf(j), 1);
    await Promise.all(batch.map((j) => runJob(j).catch((e) => console.error('job error', e))));
  }

  // 다음 알람 직전에 다시 깨우기
  let next = null;
  for (const id of Object.keys(records)) {
    const t = nextOccurrence(records[id], Date.now() + 500);
    if (t && (next === null || t < next)) next = t;
  }
  const wakeScheduled = next ? await scheduleWakeUp(req, next) : false;

  const ua = String(req.headers['user-agent'] || '');
  const by = /qstash/i.test(ua) || req.headers['upstash-message-id'] ? 'qstash'
    : /google-apps-script/i.test(ua) ? 'apps-script' : /curl|github/i.test(ua) ? 'github-actions' : 'other';
  try {
    await redis.lpush(DISPATCH_LOG_KEY, JSON.stringify({ at: startedAt, by, sent, lateMs }));
    await redis.ltrim(DISPATCH_LOG_KEY, 0, 29);
  } catch {}
  return { ok: true, checked: Object.keys(records).length, sent, results, nextAlarmAt: next, wakeScheduled, lookaheadMs: lookahead };
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
  sendPush, dispatchDue, isCronAuthorized, WAKE_LAST_KEY, DISPATCH_LOG_KEY, qstashToken, QSTASH_BASES
};
