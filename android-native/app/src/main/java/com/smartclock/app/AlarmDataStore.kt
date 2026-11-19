package com.smartclock.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object AlarmDataStore {
    private const val PREFS = "smart_clock_native"
    private const val KEY_SNAPSHOT = "web_snapshot"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun getSnapshot(context: Context): JSONObject {
        val raw = prefs(context).getString(KEY_SNAPSHOT, null)
        return try {
            if (raw.isNullOrBlank()) {
                JSONObject().put("alarms", JSONObject.NULL).put("timer", JSONObject.NULL)
            } else {
                JSONObject(raw)
            }
        } catch (_: Exception) {
            JSONObject().put("alarms", JSONObject.NULL).put("timer", JSONObject.NULL)
        }
    }

    fun saveSnapshot(context: Context, snapshot: JSONObject) {
        prefs(context).edit().putString(KEY_SNAPSHOT, snapshot.toString()).apply()
    }

    fun getAlarmArray(snapshot: JSONObject): JSONArray =
        snapshot.optJSONArray("alarms") ?: JSONArray()

    fun findAlarm(context: Context, alarmId: String): JSONObject? {
        val alarms = getAlarmArray(getSnapshot(context))
        for (i in 0 until alarms.length()) {
            val alarm = alarms.optJSONObject(i) ?: continue
            if (alarm.optString("id") == alarmId) return alarm
        }
        return null
    }

    fun updateAlarm(context: Context, alarmId: String, update: (JSONObject) -> Unit): Boolean {
        val snapshot = getSnapshot(context)
        val alarms = getAlarmArray(snapshot)
        for (i in 0 until alarms.length()) {
            val alarm = alarms.optJSONObject(i) ?: continue
            if (alarm.optString("id") == alarmId) {
                update(alarm)
                alarms.put(i, alarm)
                snapshot.put("alarms", alarms)
                saveSnapshot(context, snapshot)
                return true
            }
        }
        return false
    }

    fun hasSavedAlarms(context: Context): Boolean {
        return getSnapshot(context).optJSONArray("alarms") != null
    }
}
