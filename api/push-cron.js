'use strict';

const webpush = require('web-push');
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis 환경 변수가 설정되지 않았습니다.');
  return new Redis({ url, token });
}

function initWebPush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  if (!pub || !priv) throw new Error('VAPID 키 환경 변수가 설정되지 않았습니다.');
  webpush.setVapidDetails(subject, pub, priv);
}

function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${hour}:${parts.minute}`,
    dayIndex: dayMap[parts.weekday] ?? date.getDay()
  };
}

async function scheduleQStashNextBurst(req, delaySec = 4) {
  const qstashToken = process.env.QSTASH_TOKEN;
  if (!qstashToken) return false;

  const qstashUrl = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  if (!host) return false;
  const proto = String(host).includes('localhost') ? 'http' : 'https';
  const targetUrl = `${proto}://${host}/api/push-cron`;

  try {
    const res = await fetch(`${qstashUrl}/v2/publish/${encodeURIComponent(targetUrl)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Content-Type': 'application/json',
        'Upstash-Delay': `${Math.max(1, Math.round(delaySec))}s`,
        'Upstash-Deduplication-Id': `burst-${Math.floor(Date.now() / 3000)}`
      },
      body: JSON.stringify({ source: 'infinite-alarm-chain', scheduledAt: Date.now() })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  try {
    initWebPush();
    const redis = getRedis();
    const now = Date.now();
    const subKeys = await redis.keys('smart-clock:sub:*');

    let sentCount = 0;
    let hasOngoingUrgentBurst = false;

    for (const key of subKeys) {
      const record = await redis.get(key);
      if (!record || !record.subscription || !record.subscription.endpoint) continue;

      const tz = record.timeZone || 'Asia/Seoul';
      const zoned = getZonedParts(new Date(now), tz);
      const alarms = Array.isArray(record.alarms) ? record.alarms : [];
      const isBurstEnabled = record.urgentBurstMode !== false;
      let dirty = false;
      const payloadsToSend = [];

      if (record.activeRinging && isBurstEnabled) {
        const ar = record.activeRinging;
        const startedAt = Number(ar.startedAt) || now;
        const lastSent = Number(ar.lastSentAt) || 0;

        if (now - startedAt > 30 * 60 * 1000) {
          record.activeRinging = null;
          dirty = true;
        } else {
          hasOngoingUrgentBurst = true;
          if (now - lastSent >= 3500) {
            const burstSeq = (Number(ar.burstSeq) || 1) + 1;
            ar.lastSentAt = now;
            ar.burstSeq = burstSeq;
            dirty = true;
            payloadsToSend.push({
              type: 'alarm',
              alarmId: String(ar.alarmId || ''),
              name: ar.name || '알람',
              group: ar.group || '기본 그룹',
              time: ar.time || zoned.hm,
              scheduleKey: ar.scheduleKey || '',
              title: `⏰ [${burstSeq}회 울림] ${ar.label || ar.name || '알람'}`,
              body: `${ar.time || zoned.hm} 알람! 배너를 길게 눌러 [✕ 알람 끄기]를 누를 때까지 계속 울립니다.`,
              tag: `smart-clock-ring-${ar.alarmId || 'all'}-${now}`
            });
          }
        }
      }

      for (const alarm of alarms) {
        if (!alarm || !alarm.enabled) continue;
        if (alarm.userDismissedAt && now - Number(alarm.userDismissedAt) < 120 * 1000 && !alarm.nextSnoozeAt) continue;

        let shouldTrigger = false;
        let scheduleKey = '';

        if (alarm.nextSnoozeAt) {
          const diff = now - Number(alarm.nextSnoozeAt);
          if (diff >= -15000 && diff <= 90000) {
            scheduleKey = `${zoned.dateKey}_snooze_${alarm.nextSnoozeAt}`;
            if (alarm.lastServerPushedKey !== scheduleKey && alarm.dismissedScheduleKey !== scheduleKey) {
              shouldTrigger = true;
              alarm.nextSnoozeAt = null;
              alarm.nextSnoozeTime = null;
            }
          }
        } else if (!alarm.isRepeating && alarm.singleShotAt) {
          const diff = now - Number(alarm.singleShotAt);
          if (diff >= -15000 && diff <= 90000) {
            scheduleKey = `${zoned.dateKey}_${alarm.time}_${alarm.singleShotAt}`;
            if (alarm.lastServerPushedKey !== scheduleKey && alarm.dismissedScheduleKey !== scheduleKey) {
              shouldTrigger = true;
              alarm.enabled = false;
              alarm.serverFiredAt = now;
            }
          }
        } else if (Array.isArray(alarm.days) && alarm.days.includes(zoned.dayIndex)) {
          if (alarm.time === zoned.hm) {
            scheduleKey = `${zoned.dateKey}_${alarm.time}`;
            if (alarm.lastServerPushedKey !== scheduleKey && alarm.dismissedScheduleKey !== scheduleKey) {
              shouldTrigger = true;
            }
          }
        }

        if (shouldTrigger) {
          alarm.lastServerPushedKey = scheduleKey;
          dirty = true;
          const label = `[${alarm.group || '기본 그룹'}] ${alarm.name || '알람'}`;
          if (isBurstEnabled) {
            hasOngoingUrgentBurst = true;
            record.activeRinging = {
              alarmId: String(alarm.id),
              name: alarm.name || '알람',
              group: alarm.group || '기본 그룹',
              label,
              time: alarm.time,
              scheduleKey,
              startedAt: now,
              lastSentAt: now,
              burstSeq: 1
            };
          }
          payloadsToSend.push({
            type: 'alarm',
            alarmId: String(alarm.id),
            name: alarm.name || '알람',
            group: alarm.group || '기본 그룹',
            label,
            time: alarm.time,
            scheduleKey,
            title: `⏰ [1회 울림] ${label}`,
            body: `${alarm.time} 알람! 배너를 길게 눌러 [✕ 알람 끄기]를 누를 때까지 계속 울립니다.`,
            tag: `smart-clock-ring-${alarm.id}-${now}`
          });
        }
      }

      if (record.timer && record.timer.endAt) {
        const diff = now - Number(record.timer.endAt);
        if (diff >= -15000 && diff <= 90000) {
          const totalMs = Number(record.timer.totalMs) || 0;
          record.timer = null;
          dirty = true;
          if (isBurstEnabled) {
            hasOngoingUrgentBurst = true;
            record.activeRinging = {
              alarmId: 'timer',
              name: '타이머 완료',
              group: '타이머',
              label: '카운트다운 타이머 완료',
              time: zoned.hm,
              scheduleKey: `timer_${now}`,
              startedAt: now,
              lastSentAt: now,
              burstSeq: 1
            };
          }
          payloadsToSend.push({
            type: 'timer',
            alarmId: 'timer',
            totalMs,
            title: '⏳ [1회 울림] 타이머 완료',
            body: '설정한 타이머가 종료되었습니다. [✕ 알람 끄기]를 누를 때까지 계속 울립니다.',
            tag: `smart-clock-timer-${now}`
          });
        }
      }

      if (dirty) {
        record.alarms = alarms;
        record.updatedAt = now;
        await redis.set(key, record);
      }

      for (const payload of payloadsToSend) {
        try {
          await webpush.sendNotification(
            record.subscription,
            JSON.stringify(payload),
            { TTL: 60 }
          );
          sentCount++;
        } catch (pushErr) {
          if (pushErr && (pushErr.statusCode === 404 || pushErr.statusCode === 410)) {
            await redis.del(key);
            hasOngoingUrgentBurst = false;
            break;
          }
        }
      }
    }

    let nextBurstScheduled = false;
    if (hasOngoingUrgentBurst) {
      nextBurstScheduled = await scheduleQStashNextBurst(req, 4);
    }

    return res.status(200).json({ ok: true, sentCount, hasOngoingUrgentBurst, nextBurstScheduled });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Cron execution failed' });
  }
};
