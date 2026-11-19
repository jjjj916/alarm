package com.smartclock.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

object AlarmScheduler {
    const val ACTION_FIRE = "com.smartclock.app.ACTION_FIRE_ALARM"
    const val EXTRA_ALARM_ID = "alarmId"
    const val EXTRA_IS_TIMER = "isTimer"
    const val EXTRA_IS_SNOOZE = "isSnooze"
    const val EXTRA_TOTAL_MS = "totalMs"
    const val EXTRA_END_AT = "endAt"

    fun exactPermissionGranted(context: Context): Boolean {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()
    }

    fun syncFromWebJson(context: Context, json: String): JSONObject {
        val incoming = JSONObject(json)
        val oldSnapshot = AlarmDataStore.getSnapshot(context)
        cancelSnapshot(context, oldSnapshot)
        AlarmDataStore.saveSnapshot(context, incoming)
        val scheduled = scheduleSnapshot(context, incoming)
        return JSONObject()
            .put("ok", true)
            .put("scheduled", scheduled)
            .put("exactAlarmPermission", exactPermissionGranted(context))
    }

    fun rescheduleFromSavedState(context: Context): Int {
        val snapshot = AlarmDataStore.getSnapshot(context)
        cancelSnapshot(context, snapshot)
        return scheduleSnapshot(context, snapshot)
    }

    private fun scheduleSnapshot(context: Context, snapshot: JSONObject): Int {
        if (!exactPermissionGranted(context)) return 0
        var count = 0
        val alarms = snapshot.optJSONArray("alarms") ?: JSONArray()
        for (i in 0 until alarms.length()) {
            val alarm = alarms.optJSONObject(i) ?: continue
            if (scheduleAlarm(context, alarm)) count++
        }

        val timer = snapshot.optJSONObject("timer")
        if (timer != null) {
            val endAt = timer.optLong("endAt", 0L)
            val totalMs = timer.optLong("totalMs", 0L)
            if (endAt > System.currentTimeMillis() && totalMs > 0L) {
                if (scheduleTimer(context, endAt, totalMs)) count++
            }
        }
        return count
    }

    fun scheduleAlarm(context: Context, alarm: JSONObject): Boolean {
        if (!alarm.optBoolean("enabled", false)) {
            cancelAlarm(context, alarm.optString("id"))
            return false
        }
        val id = alarm.optString("id")
        if (id.isBlank()) return false
        val nextAt = nextAlarmTime(alarm, System.currentTimeMillis()) ?: return false
        val isSnooze = alarm.optLong("nextSnoozeAt", 0L) > 0L
        return scheduleExact(
            context = context,
            requestKey = "alarm:$id",
            triggerAt = nextAt,
            alarmId = id,
            isTimer = false,
            isSnooze = isSnooze
        )
    }

    private fun scheduleTimer(context: Context, endAt: Long, totalMs: Long): Boolean {
        return scheduleExact(
            context = context,
            requestKey = "timer",
            triggerAt = endAt,
            alarmId = "",
            isTimer = true,
            isSnooze = false,
            totalMs = totalMs
        )
    }

    private fun scheduleExact(
        context: Context,
        requestKey: String,
        triggerAt: Long,
        alarmId: String,
        isTimer: Boolean,
        isSnooze: Boolean,
        totalMs: Long = 0L
    ): Boolean {
        if (!exactPermissionGranted(context)) return false
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val fireIntent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_FIRE
            data = Uri.parse("smartclock://schedule/$requestKey")
            putExtra(EXTRA_ALARM_ID, alarmId)
            putExtra(EXTRA_IS_TIMER, isTimer)
            putExtra(EXTRA_IS_SNOOZE, isSnooze)
            putExtra(EXTRA_TOTAL_MS, totalMs)
            putExtra(EXTRA_END_AT, triggerAt)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val operation = PendingIntent.getBroadcast(context, requestKey.hashCode() and 0x7fffffff, fireIntent, flags)

        val showIntent = Intent(context, MainActivity::class.java)
        val showPending = PendingIntent.getActivity(
            context,
            ("show:$requestKey").hashCode() and 0x7fffffff,
            showIntent,
            flags
        )

        return try {
            val alarmClockInfo = AlarmManager.AlarmClockInfo(triggerAt, showPending)
            manager.setAlarmClock(alarmClockInfo, operation)
            true
        } catch (_: SecurityException) {
            false
        }
    }

    fun cancelAlarm(context: Context, alarmId: String) {
        cancelRequest(context, "alarm:$alarmId")
    }

    fun cancelTimer(context: Context) {
        cancelRequest(context, "timer")
    }

    private fun cancelRequest(context: Context, requestKey: String) {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_FIRE
            data = Uri.parse("smartclock://schedule/$requestKey")
        }
        val pending = PendingIntent.getBroadcast(
            context,
            requestKey.hashCode() and 0x7fffffff,
            intent,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        )
        if (pending != null) {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            manager.cancel(pending)
            pending.cancel()
        }
    }

    private fun cancelSnapshot(context: Context, snapshot: JSONObject) {
        val alarms = snapshot.optJSONArray("alarms") ?: JSONArray()
        for (i in 0 until alarms.length()) {
            val alarm = alarms.optJSONObject(i) ?: continue
            cancelAlarm(context, alarm.optString("id"))
        }
        cancelTimer(context)
    }

    private fun nextAlarmTime(alarm: JSONObject, nowMs: Long): Long? {
        val snoozeAt = alarm.optLong("nextSnoozeAt", 0L)
        if (snoozeAt > nowMs + 500L) return snoozeAt
        if (snoozeAt > 0L && snoozeAt <= nowMs + 500L) return nowMs + 1500L

        if (alarm.optBoolean("isRepeating", false)) {
            return nextWeeklyOccurrence(alarm, nowMs)
        }

        val singleShotAt = alarm.optLong("singleShotAt", 0L)
        if (singleShotAt > nowMs + 500L) return singleShotAt
        if (singleShotAt > 0L && singleShotAt <= nowMs + 5 * 60 * 1000L) return nowMs + 1500L
        return nextSelectedDayOccurrence(alarm, nowMs)
    }

    private fun nextWeeklyOccurrence(alarm: JSONObject, nowMs: Long): Long? =
        nextSelectedDayOccurrence(alarm, nowMs)

    private fun nextSelectedDayOccurrence(alarm: JSONObject, nowMs: Long): Long? {
        val time = alarm.optString("time", "08:00")
        val parts = time.split(":")
        if (parts.size != 2) return null
        val hour = parts[0].toIntOrNull() ?: return null
        val minute = parts[1].toIntOrNull() ?: return null
        val days = alarm.optJSONArray("days") ?: JSONArray()
        val selectedDays = (0 until days.length()).mapNotNull { days.optInt(it, -1).takeIf { d -> d in 0..6 } }.toSet()
            .ifEmpty { setOf(Calendar.getInstance().get(Calendar.DAY_OF_WEEK) - 1) }

        val base = Calendar.getInstance().apply {
            timeInMillis = nowMs
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        for (offset in 0..14) {
            val candidate = base.clone() as Calendar
            candidate.add(Calendar.DAY_OF_YEAR, offset)
            val weekday = candidate.get(Calendar.DAY_OF_WEEK) - 1
            if (weekday !in selectedDays) continue
            if (candidate.timeInMillis >= nowMs + 1000L) return candidate.timeInMillis
        }
        return null
    }
}
