package com.smartclock.app

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class AlarmRingingActivity : Activity() {
    private var alarmId: String = ""
    private var isTimer: Boolean = false
    private var finishReceiverRegistered = false
    private val finishReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            finish()
        }
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(ACTION_FINISH)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(finishReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(finishReceiver, filter)
        }
        finishReceiverRegistered = true
    }

    override fun onStop() {
        if (finishReceiverRegistered) {
            unregisterReceiver(finishReceiver)
            finishReceiverRegistered = false
        }
        super.onStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON)

        alarmId = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID).orEmpty()
        isTimer = intent.getBooleanExtra(AlarmScheduler.EXTRA_IS_TIMER, false)
        val name = intent.getStringExtra("alarmName") ?: if (isTimer) "카운트다운 타이머 완료" else "스마트 시계 알람"
        val time = intent.getStringExtra("alarmTime").orEmpty()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(40), dp(28), dp(40))
            setBackgroundColor(Color.rgb(246, 247, 249))
        }
        val badge = TextView(this).apply {
            text = if (isTimer) "⏳ 타이머 종료" else "⏰ 스마트 시계 알람"
            textSize = 15f
            setTextColor(Color.rgb(3, 129, 254))
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        val timeView = TextView(this).apply {
            text = if (isTimer) "시간 완료" else time
            textSize = 46f
            setTextColor(Color.rgb(17, 24, 39))
            setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
            gravity = Gravity.CENTER
            setPadding(0, dp(24), 0, dp(12))
        }
        val nameView = TextView(this).apply {
            text = name
            textSize = 21f
            setTextColor(Color.rgb(31, 41, 55))
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        val subtitle = TextView(this).apply {
            text = "알람이 울리고 있습니다"
            textSize = 13f
            setTextColor(Color.rgb(107, 114, 128))
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(48))
        }
        root.addView(badge)
        root.addView(timeView)
        root.addView(nameView)
        root.addView(subtitle)

        if (!isTimer) {
            val snooze = Button(this).apply {
                text = "다시 울림"
                textSize = 16f
                isAllCaps = false
                setOnClickListener {
                    AlarmActions.perform(this@AlarmRingingActivity, AlarmRingingService.ACTION_SNOOZE, alarmId, false)
                    finish()
                }
            }
            root.addView(snooze, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(58)).apply {
                bottomMargin = dp(12)
            })
        }

        val stop = Button(this).apply {
            text = "알람 끄기"
            textSize = 16f
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(3, 129, 254)))
            setOnClickListener {
                AlarmActions.perform(this@AlarmRingingActivity, AlarmRingingService.ACTION_STOP, alarmId, isTimer)
                finish()
            }
        }
        root.addView(stop, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(60)))
        setContentView(root)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val ACTION_FINISH = "com.smartclock.app.ACTION_FINISH_RING_UI"
    }
}
