package com.smartclock.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.Toast

class MainActivity : Activity() {
    private var webView: WebView? = null
    private var permissionPromptShown = false
    private var requestedNotificationPermission = false
    private var pageLoaded = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(android.graphics.Color.rgb(246, 247, 249)) }
        val web = WebView(this)
        webView = web
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        web.settings.loadsImagesAutomatically = true
        web.settings.javaScriptCanOpenWindowsAutomatically = false
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        web.settings.mediaPlaybackRequiresUserGesture = true
        web.addJavascriptInterface(AlarmBridge(this), "AndroidAlarmBridge")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == APP_HOST) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                pageLoaded = true
                view.evaluateJavascript("window.refreshNativeAlarmStateFromBridge && window.refreshNativeAlarmStateFromBridge();", null)
            }
        }
        web.webChromeClient = WebChromeClient()
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)

        if (savedInstanceState == null) {
            web.loadUrl(APP_URL)
        } else {
            web.restoreState(savedInstanceState)
            if (web.url.isNullOrBlank()) web.loadUrl(APP_URL)
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.postDelayed({
            webView?.evaluateJavascript("window.refreshNativeAlarmStateFromBridge && window.refreshNativeAlarmStateFromBridge();", null)
        }, 250)
        if (!permissionPromptShown) {
            window.decorView.post { checkAndPromptPermissions() }
        }
        AlarmScheduler.rescheduleFromSavedState(this)
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView?.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    fun openAlarmPermissionFlow() {
        permissionPromptShown = false
        checkAndPromptPermissions(force = true)
    }

    private fun checkAndPromptPermissions(force: Boolean = false) {
        if (isFinishing) return
        if (!force && permissionPromptShown) return

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            permissionPromptShown = true
            if (!requestedNotificationPermission) {
                requestedNotificationPermission = true
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
            } else {
                showAppSettingsDialog(
                    "알림 권한이 필요해요",
                    "휴대폰에 알람 알림을 표시하려면 스마트 시계의 알림 권한을 허용해 주세요. 앱 설정에서 알림을 켤 수 있어요."
                )
            }
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = getSystemService(ALARM_SERVICE) as android.app.AlarmManager
            if (!manager.canScheduleExactAlarms()) {
                permissionPromptShown = true
                AlertDialog.Builder(this)
                    .setTitle("정확한 알람 권한이 필요해요")
                    .setMessage("앱을 닫거나 화면이 꺼져도 예약한 시간에 울리려면 ‘알람 및 리마인더’ 권한을 허용해야 해요.")
                    .setPositiveButton("설정 열기") { _, _ ->
                        try {
                            startActivityForResult(
                                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")),
                                REQUEST_EXACT_ALARM
                            )
                        } catch (_: Exception) {
                            showAppSettingsDialog("권한 설정", "설정 > 앱 > 스마트 시계 > 알람 및 리마인더에서 허용해 주세요.")
                        }
                    }
                    .setNegativeButton("나중에", null)
                    .show()
                return
            }
        }

        if (Build.VERSION.SDK_INT >= 34) {
            val manager = getSystemService(NotificationManager::class.java)
            if (!manager.canUseFullScreenIntent()) {
                permissionPromptShown = true
                AlertDialog.Builder(this)
                    .setTitle("잠금 화면 알람 권한")
                    .setMessage("잠금 화면에서 알람 화면을 바로 표시하려면 전체 화면 알림 권한을 허용해 주세요. 허용하지 않아도 알림은 표시되지만 전체 화면 알람은 제한될 수 있어요.")
                    .setPositiveButton("설정 열기") { _, _ ->
                        try {
                            startActivityForResult(
                                Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")),
                                REQUEST_FULL_SCREEN
                            )
                        } catch (_: Exception) {
                            showAppSettingsDialog("권한 설정", "설정 > 앱 > 특별한 앱 접근 > 전체 화면 알림에서 허용해 주세요.")
                        }
                    }
                    .setNegativeButton("나중에", null)
                    .show()
                return
            }
        }
        permissionPromptShown = true
        Toast.makeText(this, "스마트 시계의 기기 알람 권한이 준비됐어요.", Toast.LENGTH_SHORT).show()
    }

    private fun showAppSettingsDialog(title: String, message: String) {
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton("앱 설정 열기") { _, _ ->
                permissionPromptShown = false
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
            .setNegativeButton("닫기", null)
            .show()
    }

    @Deprecated("Legacy callback used for special app access settings")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_EXACT_ALARM || requestCode == REQUEST_FULL_SCREEN) {
            permissionPromptShown = false
            if (pageLoaded) {
                webView?.evaluateJavascript("window.refreshNativeAlarmStateFromBridge && window.refreshNativeAlarmStateFromBridge();", null)
            }
            checkAndPromptPermissions()
        }
    }

    @Deprecated("Deprecated in Android API 23")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) {
            permissionPromptShown = false
            if (grantResults.isNotEmpty() && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                checkAndPromptPermissions()
            } else {
                showAppSettingsDialog("알림 권한이 꺼져 있어요", "기기 알람을 표시하려면 알림 권한을 허용해 주세요.")
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val web = webView
        if (web != null && web.canGoBack()) {
            web.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView?.apply {
            removeJavascriptInterface("AndroidAlarmBridge")
            stopLoading()
            loadUrl("about:blank")
            destroy()
        }
        webView = null
        super.onDestroy()
    }

    companion object {
        // The production web app already deployed for this project.
        const val APP_URL = "https://alarm-lemon-omega.vercel.app"
        const val APP_HOST = "alarm-lemon-omega.vercel.app"
        private const val REQUEST_NOTIFICATIONS = 9001
        private const val REQUEST_EXACT_ALARM = 9002
        private const val REQUEST_FULL_SCREEN = 9003
    }
}
