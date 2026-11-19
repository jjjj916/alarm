'use strict';

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const webpush = require('web-push');

const SUBSCRIPTIONS_SET = 'smart-clock:subscription-ids';
const RECORD_PREFIX = 'smart-clock:subscription:';

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const error = new Error('Upstash Redis 환경 변수가 설정되지 않았습니다.');
    error.statusCode = 503;
    throw error;
  }
  return new Redis({ url, token, enableTelemetry: false });
}

function getVapidConfig() {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com'
  };
}

function configureWebPush() {
  const cfg = getVapidConfig();
  if (!cfg.publicKey || !cfg.privateKey) {
    const error = new Error('VAPID_PUBLIC_KEY 또는 VAPID_PRIVATE_KEY가 설정되지 않았습니다.');
    error.statusCode = 503;
    throw error;
  }
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  return webpush;
}

function subscriptionId(subscription) {
  return crypto.createHash('sha256').update(subscription.endpoint).digest('hex');
}

function recordKey(id) {
  return `${RECORD_PREFIX}${id}`;
}

function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    weekday: weekdayMap[parts.weekday], hour: Number(parts.hour),
    minute: Number(parts.minute), second: Number(parts.second)
  };
}

function zonedWallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desiredUtc;
  for (let i = 0; i < 4; i++) {
    const p = getZonedParts(new Date(guess), timeZone);
    const representedUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const correction = desiredUtc - representedUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

function computeNextOneShotAt(alarm, timeZone, nowMs = Date.now()) {
  const nowParts = getZonedParts(new Date(nowMs), timeZone);
  const [hour, minute] = alarm.time.split(':').map(Number);
  const days = Array.isArray(alarm.days) && alarm.days.length
    ? alarm.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
    : [nowParts.weekday];
  const baseUtcDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);

  for (let offset = 0; offset <= 14; offset++) {
    const date = new Date(baseUtcDay + offset * 86400000);
    if (!days.includes(date.getUTCDay())) continue;
    const candidate = zonedWallTimeToUtc({
      year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
      day: date.getUTCDate(), hour, minute
    }, timeZone);
    // The browser app historically accepted up to five minutes of lateness.
    if (candidate >= nowMs - 5 * 60 * 1000) return candidate;
  }
  return nowMs + 7 * 86400000;
}

function sanitizeAlarm(input) {
  if (!input || typeof input !== 'object' || !validTime(input.time)) return null;
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))]
    : [];
  const alarm = {
    id: String(input.id ?? crypto.randomUUID()).slice(0, 80),
    name: String(input.name ?? '알람').slice(0, 30),
    group: String(input.group ?? '기본 그룹').slice(0, 20),
    time: input.time,
    sound: Number.isInteger(Number(input.sound)) ? Math.max(0, Math.min(11, Number(input.sound))) : 0,
    days: days.length ? days : [new Date().getDay()],
    isRepeating: Boolean(input.isRepeating),
    enabled: Boolean(input.enabled),
    snoozeInterval: Math.max(1, Math.min(60, Number(input.snoozeInterval) || 5)),
    snoozeCount: Math.max(1, Math.min(20, Number(input.snoozeCount) || 1)),
    remainingSnooze: Math.max(0, Math.min(20, Number(input.remainingSnooze) || 0)),
    snoozeLevel: Math.max(0, Math.min(3, Number(input.snoozeLevel) || 0)),
    nextSnoozeTime: validTime(input.nextSnoozeTime) ? input.nextSnoozeTime : null,
    nextSnoozeAt: Number.isFinite(Number(input.nextSnoozeAt)) ? Number(input.nextSnoozeAt) : null,
    lastTriggeredKey: typeof input.lastTriggeredKey === 'string' ? input.lastTriggeredKey.slice(0, 40) : null,
    singleShotAt: Number.isFinite(Number(input.singleShotAt)) && Number(input.singleShotAt) > 0
      ? Number(input.singleShotAt) : null,
    serverFiredAt: Number.isFinite(Number(input.serverFiredAt)) ? Number(input.serverFiredAt) : null,
    serverLastSentAt: Number.isFinite(Number(input.serverLastSentAt)) ? Number(input.serverLastSentAt) : null
  };
  if (alarm.isRepeating) alarm.singleShotAt = null;
  return alarm;
}

function validateSubscription(subscription) {
  return Boolean(
    subscription && typeof subscription === 'object' &&
    typeof subscription.endpoint === 'string' && subscription.endpoint.startsWith('https://') &&
    subscription.keys && typeof subscription.keys.p256dh === 'string' &&
    typeof subscription.keys.auth === 'string'
  );
}

function isCronAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return req.headers.authorization === `Bearer ${expected}`;
}

function setCorsForSameSite(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return originHost === requestHost;
  } catch {
    return false;
  }
}

module.exports = {
  SUBSCRIPTIONS_SET,
  getRedis,
  getVapidConfig,
  configureWebPush,
  subscriptionId,
  recordKey,
  validTime,
  validTimeZone,
  getZonedParts,
  computeNextOneShotAt,
  sanitizeAlarm,
  validateSubscription,
  isCronAuthorized,
  setCorsForSameSite
};
