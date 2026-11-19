package com.smartclock.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmScheduler.ACTION_FIRE) return
        val isTimer = intent.getBooleanExtra(AlarmScheduler.EXTRA_IS_TIMER, false)
        if (isTimer) {
            val expectedEndAt = intent.getLongExtra(AlarmScheduler.EXTRA_END_AT, 0L)
            val snapshot = AlarmDataStore.getSnapshot(context)
            val timer = snapshot.optJSONObject("timer")
            if (timer == null || timer.optLong("endAt", 0L) != expectedEndAt || expectedEndAt > System.currentTimeMillis()) return
            snapshot.put("timer", JSONObject.NULL)
            AlarmDataStore.saveSnapshot(context, snapshot)
            startRingingService(context, Intent(context, AlarmRingingService::class.java).apply {
                putExtra(AlarmScheduler.EXTRA_IS_TIMER, true)
                putExtra(AlarmScheduler.EXTRA_TOTAL_MS, intent.getLongExtra(AlarmScheduler.EXTRA_TOTAL_MS, 0L))
            })
            return
        }

        val alarmId = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID) ?: return
        val isSnooze = intent.getBooleanExtra(AlarmScheduler.EXTRA_IS_SNOOZE, false)
        val snapshot = AlarmDataStore.getSnapshot(context)
        val alarms = AlarmDataStore.getAlarmArray(snapshot)
        var matched: JSONObject? = null
        for (i in 0 until alarms.length()) {
            val item = alarms.optJSONObject(i) ?: continue
            if (item.optString("id") == alarmId) {
                // A stale pending intent must not ring after the user has disabled or replaced the alarm.
                if (!item.optBoolean("enabled", false)) return
                if (isSnooze) {
                    val expectedAt = intent.getLongExtra(AlarmScheduler.EXTRA_END_AT, 0L)
                    if (item.optLong("nextSnoozeAt", 0L) != expectedAt || expectedAt <= 0L) return
                    item.put("nextSnoozeAt", JSONObject.NULL)
                    item.put("nextSnoozeTime", JSONObject.NULL)
                } else if (!item.optBoolean("isRepeating", false)) {
                    item.put("enabled", false)
                    item.put("singleShotAt", JSONObject.NULL)
                }
                matched = item
                alarms.put(i, item)
                break
            }
        }
        val alarm = matched ?: return
        snapshot.put("alarms", alarms)
        AlarmDataStore.saveSnapshot(context, snapshot)

        // A repeating alarm is queued for its next selected day immediately.
        if (alarm.optBoolean("isRepeating", false) && !isSnooze) {
            AlarmScheduler.scheduleAlarm(context, alarm)
        }

        startRingingService(context, Intent(context, AlarmRingingService::class.java).apply {
            putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId)
            putExtra(AlarmScheduler.EXTRA_IS_TIMER, false)
            putExtra(AlarmScheduler.EXTRA_IS_SNOOZE, isSnooze)
        })
    }

    private fun startRingingService(context: Context, serviceIntent: Intent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (error: Exception) {
            android.util.Log.e("SmartClock", "Unable to start alarm service", error)
        }
    }
}
