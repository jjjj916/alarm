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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${hour}:${parts.minute}`,
    dayIndex: dayMap[parts.weekday] ?? date.getDay()
  };
}

async function scheduleQStashNextBurst(req, delaySec = 5) {
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
        'Upstash-Deduplication-Id': `burst-${Math.floor(Date.now() / 4000)}`
      },
      body: JSON.stringify({ source: 'urgent-burst-chain', scheduledAt: Date.now() })
    });
    return res.ok;
  } catch (e) {
    console.error('QStash burst chain error:', e && e.message);
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
    let checkedSubs = 0;
    let hasOngoingUrgentBurst = false;

    for (const key of subKeys) {
      checkedSubs++;
      const record = await redis.get(key);
      if (!record || !record.subscription || !record.subscription.endpoint) continue;

      const tz = record.timeZone || 'Asia/Seoul';
      const zoned = getZonedParts(new Date(now), tz);
      const alarms = Array.isArray(record.alarms) ? record.alarms : [];
      let dirty = false;
      const payloadsToSend = [];

      // 1. 무제한 긴급알림(activeRinging) 5초 단위 연속 재발송 처리
      if (record.activeRinging && record.urgentBurstMode) {
        const ar = record.activeRinging;
        const startedAt = Number(ar.startedAt) || now;
        const lastSent = Number(ar.lastSentAt) || 0;
        const elapsedTotal = now - startedAt;

        if (elapsedTotal > 10 * 60 * 1000) {
          // 10분 경과 시 자동 종료
          record.activeRinging = null;
          dirty = true;
        } else {
          hasOngoingUrgentBurst = true;
          if (now - lastSent >= 4500) {
            const burstSeq = (Number(ar.burstSeq) || 1) + 1;
            ar.lastSentAt = now;
            ar.burstSeq = burstSeq;
            dirty = true;
            payloadsToSend.push({
              type: 'alarm',
              alarmId: String(ar.alarmId || ''),
              name: ar.name || '긴급 알람',
              group: ar.group || '기본 그룹',
              time: ar.time || zoned.hm,
              sound: Number(ar.sound) || 0,
              isRepeating: Boolean(ar.isRepeating),
              snoozeLevel: Number(ar.snoozeLevel) || 2,
              scheduleKey: ar.scheduleKey || '',
              title: `🚨 [긴급 ${burstSeq}회차] ${ar.label || ar.name || '알람'}`,
              body: `${ar.time || zoned.hm} 알람! 배너를 길게 눌러 [✕ 알람 끄기]를 누를 때까지 계속 울립니다.`,
              tag: `smart-clock-urgent-${ar.alarmId || 'all'}-${now}`,
              silent: false,
              renotify: true
            });
          }
        }
      }

      // 2. 알람 스케줄 검사
      for (const alarm of alarms) {
        if (!alarm || !alarm.enabled) continue;
        if (alarm.userDismissedAt && now - Number(alarm.userDismissedAt) < 120 * 1000 && !alarm.nextSnoozeAt) {
          continue;
        }

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
          if (record.urgentBurstMode) {
            hasOngoingUrgentBurst = true;
            record.activeRinging = {
              alarmId: String(alarm.id),
              name: alarm.name || '알람',
              group: alarm.group || '기본 그룹',
              label,
              time: alarm.time,
              sound: Number(alarm.sound) || 0,
              isRepeating: Boolean(alarm.isRepeating),
              snoozeLevel: Number(alarm.snoozeLevel) || 0,
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
            sound: Number(alarm.sound) || 0,
            isRepeating: Boolean(alarm.isRepeating),
            snoozeInterval: Number(alarm.snoozeInterval) || 5,
            snoozeCount: Number(alarm.snoozeCount) || 3,
            remainingSnooze: Number(alarm.remainingSnooze) || 3,
            snoozeLevel: Number(alarm.snoozeLevel) || 0,
            scheduleKey,
            title: record.urgentBurstMode ? `🚨 [긴급 1회차] ${label}` : `⏰ ${label}`,
            body: record.urgentBurstMode
              ? `${alarm.time} 알람! [✕ 알람 끄기]를 누를 때까지 5초마다 반복 알림이 울립니다.`
              : `${alarm.time} 알람입니다 · 눌러서 확인하거나 [✕ 알람 끄기]를 누르세요.`,
            tag: `smart-clock-alarm-${alarm.id}-${now}`,
            silent: false,
            renotify: true
          });
        }
      }

      // 3. 타이머 종료 검사
      if (record.timer && record.timer.endAt) {
        const diff = now - Number(record.timer.endAt);
        if (diff >= -15000 && diff <= 90000) {
          const totalMs = Number(record.timer.totalMs) || 0;
          record.timer = null;
          dirty = true;
          payloadsToSend.push({
            type: 'timer',
            alarmId: 'timer',
            totalMs,
            label: '카운트다운 타이머 완료',
            title: '⏳ 타이머 완료',
            body: '설정한 타이머 시간이 종료되었습니다.',
            tag: `smart-clock-timer-${now}`,
            silent: false,
            renotify: true
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
            {
              TTL: 60,
              headers: {
                Urgency: 'high'
              }
            }
          );
          sentCount++;
        } catch (pushErr) {
          if (pushErr && (pushErr.statusCode === 404 || pushErr.statusCode === 410)) {
            await redis.del(key);
            hasOngoingUrgentBurst = false;
            break;
          }
          console.error('webpush send error:', pushErr && pushErr.message);
        }
      }
    }

    // 무제한 긴급알림이 활성 상태라면 5초 뒤 QStash로 다음 푸시 체인 예약
    let nextBurstScheduled = false;
    if (hasOngoingUrgentBurst) {
      nextBurstScheduled = await scheduleQStashNextBurst(req, 5);
    }

    return res.status(200).json({
      ok: true,
      checkedSubs,
      sentCount,
      hasOngoingUrgentBurst,
      nextBurstScheduled,
      timestamp: now
    });
  } catch (error) {
    console.error('push-cron error:', error);
    return res.status(500).json({ error: error.message || 'Cron execution failed' });
  }
};
