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

module.exports = async function handler(req, res) {
  try {
    initWebPush();
    const redis = getRedis();
    const now = Date.now();
    const subKeys = await redis.keys('smart-clock:sub:*');

    let sentCount = 0;
    let checkedSubs = 0;

    for (const key of subKeys) {
      checkedSubs++;
      const record = await redis.get(key);
      if (!record || !record.subscription || !record.subscription.endpoint) continue;

      const tz = record.timeZone || 'Asia/Seoul';
      const zoned = getZonedParts(new Date(now), tz);
      const alarms = Array.isArray(record.alarms) ? record.alarms : [];
      let dirty = false;
      const payloadsToSend = [];

      // 1. 무제한 긴급알림(activeRinging) 재발송 처리
      if (record.activeRinging && record.urgentBurstMode) {
        const ar = record.activeRinging;
        const lastSent = Number(ar.lastSentAt) || 0;
        if (now - lastSent >= 12000 && now - (Number(ar.startedAt) || now) <= 10 * 60 * 1000) {
          ar.lastSentAt = now;
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
            title: `🚨 [긴급 반복] ${ar.label || ar.name || '알람'}`,
            body: `${ar.time || zoned.hm} 알람이 울리고 있습니다 · [✕ 알람 끄기]를 눌러 종료하세요.`,
            tag: `smart-clock-urgent-${ar.alarmId || 'all'}-${now}`,
            silent: false,
            renotify: true
          });
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
              lastSentAt: now
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
            title: `⏰ ${label}`,
            body: `${alarm.time} 알람입니다 · 눌러서 확인하거나 [✕ 알람 끄기]를 누르세요.`,
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
            break;
          }
          console.error('webpush send error:', pushErr && pushErr.message);
        }
      }
    }

    return res.status(200).json({ ok: true, checkedSubs, sentCount, timestamp: now });
  } catch (error) {
    console.error('push-cron error:', error);
    return res.status(500).json({ error: error.message || 'Cron execution failed' });
  }
};
