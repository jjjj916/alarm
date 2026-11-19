package com.smartclock.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID).orEmpty()
        val isTimer = intent.getBooleanExtra(AlarmScheduler.EXTRA_IS_TIMER, false)
        AlarmActions.perform(context, intent.action ?: AlarmRingingService.ACTION_STOP, alarmId, isTimer)
    }
}

object AlarmActions {
    fun perform(context: Context, action: String, alarmId: String, isTimer: Boolean) {
        if (!isTimer && alarmId.isNotBlank()) {
            AlarmDataStore.updateAlarm(context, alarmId) { alarm ->
                if (action == AlarmRingingService.ACTION_SNOOZE) {
                    val remaining = alarm.optInt("remainingSnooze", alarm.optInt("snoozeCount", 1))
                    if (remaining > 0) {
                        val interval = alarm.optInt("snoozeInterval", 5).coerceIn(1, 60)
                        val snoozeAt = System.currentTimeMillis() + interval * 60_000L
                        val cal = java.util.Calendar.getInstance().apply { timeInMillis = snoozeAt }
                        alarm.put("remainingSnooze", remaining - 1)
                        alarm.put("snoozeLevel", (alarm.optInt("snoozeLevel", 0) + 1).coerceAtMost(3))
                        alarm.put("nextSnoozeAt", snoozeAt)
                        alarm.put("nextSnoozeTime", String.format(java.util.Locale.US, "%02d:%02d", cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE)))
                        alarm.put("enabled", true)
                        val soundChoices = intArrayOf(2, 6, 9, 11)
                        if (alarm.optInt("snoozeLevel", 0) >= 2) {
                            alarm.put("sound", soundChoices[java.util.Random().nextInt(soundChoices.size)])
                        }
                    } else {
                        alarm.put("enabled", alarm.optBoolean("isRepeating", false))
                        alarm.put("remainingSnooze", alarm.optInt("snoozeCount", 1))
                        alarm.put("snoozeLevel", 0)
                        alarm.put("nextSnoozeAt", JSONObjectNull.value)
                        alarm.put("nextSnoozeTime", JSONObjectNull.value)
                    }
                } else {
                    alarm.put("enabled", alarm.optBoolean("isRepeating", false))
                    alarm.put("remainingSnooze", alarm.optInt("snoozeCount", 1))
                    alarm.put("snoozeLevel", 0)
                    alarm.put("nextSnoozeAt", JSONObjectNull.value)
                    alarm.put("nextSnoozeTime", JSONObjectNull.value)
                }
            }
        } else if (isTimer) {
            val snapshot = AlarmDataStore.getSnapshot(context)
            snapshot.put("timer", JSONObjectNull.value)
            AlarmDataStore.saveSnapshot(context, snapshot)
        }

        AlarmScheduler.rescheduleFromSavedState(context)
        context.stopService(Intent(context, AlarmRingingService::class.java))
        context.sendBroadcast(Intent(AlarmRingingActivity.ACTION_FINISH).setPackage(context.packageName))
    }
}

private object JSONObjectNull {
    val value: Any = org.json.JSONObject.NULL
}
