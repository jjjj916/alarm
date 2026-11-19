package com.smartclock.app

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.PowerManager
import android.net.Uri
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

class AlarmRingingService : Service() {
    private var audioTrack: AudioTrack? = null
    private var vibrator: Vibrator? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var activeAlarmId: String = ""
    private var isTimer: Boolean = false
    private var alarmName: String = "스마트 시계 알람"
    private var alarmTime: String = ""
    private var soundIndex: Int = 0
    private var soundLevel: Int = 0

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || intent?.action == ACTION_SNOOZE) {
            AlarmActions.perform(this, intent.action!!, intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID).orEmpty(), intent.getBooleanExtra(AlarmScheduler.EXTRA_IS_TIMER, false))
            return START_NOT_STICKY
        }

        isTimer = intent?.getBooleanExtra(AlarmScheduler.EXTRA_IS_TIMER, false) ?: false
        activeAlarmId = intent?.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID).orEmpty()
        val alarm = if (!isTimer && activeAlarmId.isNotBlank()) AlarmDataStore.findAlarm(this, activeAlarmId) else null
        alarmName = if (isTimer) "카운트다운 타이머 완료" else alarm?.optString("name", "스마트 시계 알람") ?: "스마트 시계 알람"
        alarmTime = alarm?.optString("nextSnoozeTime")?.takeIf { it.isNotBlank() && it != "null" }
            ?: alarm?.optString("time", "") ?: ""
        soundIndex = if (alarm?.optBoolean("randomDaily", false) == true) {
            DailySoundPicker.pick(activeAlarmId, java.time.LocalDate.now())
        } else {
            alarm?.optInt("sound", 0)?.coerceIn(0, 11) ?: 0
        }
        soundLevel = alarm?.optInt("snoozeLevel", 0)?.coerceIn(0, 3) ?: 0

        val notification = buildAlarmNotification()
        startForeground(NOTIFICATION_ID, notification)
        acquireWakeLock()
        startAlarmAudio(soundIndex, soundLevel)
        startVibration()
        return START_REDELIVER_INTENT
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(CHANNEL_ID, "스마트 시계 알람", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "예약한 알람과 타이머가 울릴 때 표시합니다."
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setSound(null, null) // 알람음은 AudioTrack에서 재생합니다.
                enableVibration(false)
            }
            manager.createNotificationChannel(channel)
        }
    }

    private fun actionPendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, AlarmActionReceiver::class.java).apply {
            this.action = action
            data = Uri.parse("smartclock://action/$action/$activeAlarmId/${if (isTimer) 1 else 0}")
            putExtra(AlarmScheduler.EXTRA_ALARM_ID, activeAlarmId)
            putExtra(AlarmScheduler.EXTRA_IS_TIMER, isTimer)
        }
        return PendingIntent.getBroadcast(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun buildAlarmNotification(): Notification {
        val activityIntent = Intent(this, AlarmRingingActivity::class.java).apply {
            data = Uri.parse("smartclock://ring/$activeAlarmId/${if (isTimer) 1 else 0}")
            putExtra(AlarmScheduler.EXTRA_ALARM_ID, activeAlarmId)
            putExtra(AlarmScheduler.EXTRA_IS_TIMER, isTimer)
            putExtra("alarmName", alarmName)
            putExtra("alarmTime", alarmTime)
        }
        val activityPending = PendingIntent.getActivity(
            this,
            7001,
            activityIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        builder.setSmallIcon(R.drawable.ic_stat_alarm)
            .setContentTitle(if (isTimer) "⏳ 타이머 완료" else "⏰ $alarmName")
            .setContentText(if (isTimer) "설정한 시간이 종료되었습니다." else "${alarmTime} 알람이 울립니다.")
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(activityPending)
            .setColor(Color.rgb(3, 129, 254))
            .setWhen(System.currentTimeMillis())
            .addAction(R.drawable.ic_stat_alarm, "끄기", actionPendingIntent(ACTION_STOP, 7002))

        if (!isTimer) {
            builder.addAction(R.drawable.ic_stat_alarm, "다시 울림", actionPendingIntent(ACTION_SNOOZE, 7003))
        }

        if (Build.VERSION.SDK_INT >= 29 && canUseFullScreenIntent()) {
            builder.setFullScreenIntent(activityPending, true)
        }
        return builder.build()
    }

    private fun canUseFullScreenIntent(): Boolean {
        if (Build.VERSION.SDK_INT < 34) return true
        val manager = getSystemService(NotificationManager::class.java)
        return manager.canUseFullScreenIntent()
    }

    private fun startAlarmAudio(index: Int, level: Int) {
        stopAlarmAudio()
        val manager = audioManager ?: return
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener { }
                .build()
            manager.requestAudioFocus(focusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN)
        }

        val pcm = makeAlarmWave(index, level)
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        try {
            val track = AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(format)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track.write(pcm, 0, pcm.size, AudioTrack.WRITE_BLOCKING)
            track.setLoopPoints(0, pcm.size, -1)
            track.setVolume(AudioTrack.getMaxVolume())
            track.play()
            audioTrack = track
        } catch (error: Exception) {
            android.util.Log.e("SmartClock", "Alarm audio could not start", error)
        }
    }

    private fun makeAlarmWave(soundIndex: Int, level: Int): ShortArray {
        val scales = arrayOf(
            doubleArrayOf(523.25, 659.25, 783.99, 1046.50, 1318.51),
            doubleArrayOf(440.00, 554.37, 659.25, 880.00, 1108.73),
            doubleArrayOf(587.33, 739.99, 880.00, 1174.66, 1479.98),
            doubleArrayOf(698.46, 880.00, 1046.50, 1396.91),
            doubleArrayOf(783.99, 987.77, 1174.66, 1567.98),
            doubleArrayOf(659.25, 783.99, 987.77, 1318.51),
            doubleArrayOf(880.00, 1046.50, 1318.51, 1760.00),
            doubleArrayOf(523.25, 659.25, 880.00, 1046.50),
            doubleArrayOf(440.00, 659.25, 880.00, 1318.51),
            doubleArrayOf(783.99, 1174.66, 1567.98, 2093.00),
            doubleArrayOf(523.25, 659.25, 783.99, 987.77),
            doubleArrayOf(392.00, 523.25, 659.25, 783.99, 1046.50)
        )
        val waveTypes = arrayOf("sine", "triangle", "square", "sine", "sine", "triangle", "saw", "triangle", "sine", "square", "sine", "triangle")
        val freqs = scales[soundIndex.coerceIn(0, 11)]
        val step = max(0.11 - level * 0.02, 0.05)
        val noteLength = 0.5
        val duration = step * (freqs.size - 1) + noteLength + 0.15
        val count = (SAMPLE_RATE * duration).toInt()
        val result = ShortArray(count)
        val wave = if (level >= 2) "saw" else waveTypes[soundIndex.coerceIn(0, 11)]
        val pitchMultiplier = if (level >= 2) 1.25 else 1.0
        val peak = min(0.82, 0.30 + level * 0.18)

        for (i in 0 until count) {
            val time = i.toDouble() / SAMPLE_RATE
            var sample = 0.0
            for (noteIndex in freqs.indices) {
                val elapsed = time - noteIndex * step
                if (elapsed < 0.0 || elapsed > noteLength) continue
                val envelope = if (elapsed < 0.03) elapsed / 0.03 else exp(-5.5 * (elapsed - 0.03))
                val phase = 2.0 * PI * freqs[noteIndex] * pitchMultiplier * elapsed
                val normalized = when (wave) {
                    "square" -> if (sin(phase) >= 0) 1.0 else -1.0
                    "saw" -> 2.0 * ((phase / (2.0 * PI)) - kotlin.math.floor(phase / (2.0 * PI) + 0.5))
                    "triangle" -> (2.0 / PI) * kotlin.math.asin(sin(phase))
                    else -> sin(phase)
                }
                sample += normalized * envelope * peak * 0.55
            }
            val clipped = max(-0.95, min(0.95, sample))
            result[i] = (clipped * Short.MAX_VALUE).toInt().toShort()
        }
        return result
    }

    private fun acquireWakeLock() {
        try {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (wakeLock == null) {
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SmartClock:AlarmAudio").apply {
                    setReferenceCounted(false)
                }
            }
            if (wakeLock?.isHeld != true) wakeLock?.acquire()
        } catch (error: Exception) {
            android.util.Log.w("SmartClock", "Could not acquire alarm wake lock", error)
        }
    }

    private fun startVibration() {
        val vib = vibrator ?: return
        try {
            val pattern = longArrayOf(0, 500, 150, 500, 350)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createWaveform(pattern, 0))
            } else {
                @Suppress("DEPRECATION")
                vib.vibrate(pattern, 0)
            }
        } catch (_: Exception) { }
    }

    private fun stopAlarmAudio() {
        try {
            audioTrack?.pause()
            audioTrack?.flush()
            audioTrack?.release()
        } catch (_: Exception) { }
        audioTrack = null
        try {
            vibrator?.cancel()
        } catch (_: Exception) { }
        val manager = audioManager
        if (manager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { manager.abandonAudioFocusRequest(it) }
                focusRequest = null
            } else {
                @Suppress("DEPRECATION")
                manager.abandonAudioFocus(null)
            }
        }
    }

    override fun onDestroy() {
        stopAlarmAudio()
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) { }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "com.smartclock.app.ACTION_STOP_ALARM"
        const val ACTION_SNOOZE = "com.smartclock.app.ACTION_SNOOZE_ALARM"
        private const val CHANNEL_ID = "smart_clock_alarm_channel"
        private const val NOTIFICATION_ID = 4101
        private const val SAMPLE_RATE = 44100
    }
}
