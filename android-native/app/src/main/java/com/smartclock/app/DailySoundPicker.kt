package com.smartclock.app

import java.time.LocalDate

/** Stable daily sound selection shared with the web/iOS bridge. */
object DailySoundPicker {
    fun pick(alarmId: String, date: LocalDate): Int {
        fun hash(day: LocalDate): Int {
            val key = "$alarmId|$day"
            var value = 2166136261L
            for (character in key) {
                value = value xor character.code.toLong()
                value = (value * 16777619L) and 0xffffffffL
            }
            return (value % 12L).toInt()
        }
        val today = hash(date)
        val yesterday = hash(date.minusDays(1))
        return if (today == yesterday) (today + 1) % 12 else today
    }
}
