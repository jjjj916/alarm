package com.smartclock.app

import android.webkit.JavascriptInterface
import org.json.JSONObject

class AlarmBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun syncState(json: String): String {
        return try {
            AlarmScheduler.syncFromWebJson(activity.applicationContext, json).toString()
        } catch (error: Exception) {
            JSONObject().put("ok", false).put("error", error.message ?: "native alarm sync failed").toString()
        }
    }

    @JavascriptInterface
    fun getState(): String = AlarmDataStore.getSnapshot(activity.applicationContext).toString()

    @JavascriptInterface
    fun getStatus(): String {
        val notificationAllowed = android.os.Build.VERSION.SDK_INT < 33 ||
            activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val fullScreenAllowed = android.os.Build.VERSION.SDK_INT < 34 ||
            activity.getSystemService(android.app.NotificationManager::class.java).canUseFullScreenIntent()
        return JSONObject()
            .put("exactAlarm", AlarmScheduler.exactPermissionGranted(activity))
            .put("notifications", notificationAllowed)
            .put("fullScreen", fullScreenAllowed)
            .toString()
    }

    @JavascriptInterface
    fun openAlarmSettings() {
        activity.runOnUiThread { activity.openAlarmPermissionFlow() }
    }
}
