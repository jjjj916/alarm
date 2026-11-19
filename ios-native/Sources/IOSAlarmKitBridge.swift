import Foundation
import AlarmKit
import ActivityKit
import SwiftUI

private struct SmartClockMetadata: AlarmMetadata, Codable, Hashable {}

@MainActor
final class IOSAlarmKitBridge {
    static let shared = IOSAlarmKitBridge()
    private let manager = AlarmManager.shared
    private let defaultsKey = "smartclock.alarmkit.ids.v1"
    private let horizonDays = 7

    func sync(payload: [String: Any]) async throws {
        let state = try await manager.requestAuthorization()
        guard state == .authorized else {
            print("SmartClock: AlarmKit authorization not granted: \(state)")
            return
        }

        // Cancel only alarms previously created by this bridge.
        let oldIDs = UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
        for raw in oldIDs {
            if let id = UUID(uuidString: raw) { try? manager.cancel(id: id) }
        }
        var newIDs: [String] = []

        let alarms = payload["alarms"] as? [[String: Any]] ?? []
        let calendar = Calendar.current
        let now = Date()

        for alarm in alarms where (alarm["enabled"] as? Bool ?? false) {
            let alarmID = String(describing: alarm["id"] ?? UUID().uuidString)
            let time = (alarm["time"] as? String ?? "08:00").split(separator: ":").compactMap { Int($0) }
            guard time.count == 2 else { continue }
            let hour = time[0], minute = time[1]
            let isRepeating = alarm["isRepeating"] as? Bool ?? false
            let randomDaily = alarm["randomDaily"] as? Bool ?? false
            let sound = (alarm["sound"] as? Int ?? 0).clamped(to: 0...11)
            let name = alarm["name"] as? String ?? "스마트 시계 알람"
            let days = (alarm["days"] as? [Int] ?? []).filter { (0...6).contains($0) }

            if isRepeating {
                // Schedule the next seven occurrences as one-shot AlarmKit alarms.
                // This lets the sound be independently randomized for each date.
                for offset in 0..<horizonDays {
                    guard let day = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now)) else { continue }
                    let weekday = calendar.component(.weekday, from: day) - 1 // JS: Sunday = 0
                    guard days.contains(weekday) else { continue }
                    guard let fireDate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day), fireDate > now.addingTimeInterval(5) else { continue }
                    let selectedSound = randomDaily ? dailySound(alarmID: alarmID, date: day) : sound
                    let uuid = UUID()
                    try await schedule(id: uuid, title: name, date: fireDate, soundIndex: selectedSound)
                    newIDs.append(uuid.uuidString)
                }
            } else {
                let fireDate: Date
                if let timestamp = alarm["singleShotAt"] as? Double, timestamp > 0 {
                    fireDate = Date(timeIntervalSince1970: timestamp / 1000.0)
                } else {
                    guard let candidate = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: now) else { continue }
                    fireDate = candidate > now ? candidate : (calendar.date(byAdding: .day, value: 1, to: candidate) ?? candidate)
                }
                guard fireDate > now.addingTimeInterval(5) else { continue }
                let selectedSound = randomDaily ? dailySound(alarmID: alarmID, date: fireDate) : sound
                let uuid = UUID()
                try await schedule(id: uuid, title: name, date: fireDate, soundIndex: selectedSound)
                newIDs.append(uuid.uuidString)
            }
        }

        // Native timer scheduling: a one-shot AlarmKit alarm at the saved end timestamp.
        if let timer = payload["timer"] as? [String: Any],
           let endAt = timer["endAt"] as? Double, endAt > Date().timeIntervalSince1970 * 1000 {
            let uuid = UUID()
            try await schedule(id: uuid, title: "타이머 완료", date: Date(timeIntervalSince1970: endAt / 1000.0), soundIndex: dailySound(alarmID: "timer", date: Date()))
            newIDs.append(uuid.uuidString)
        }

        UserDefaults.standard.set(newIDs, forKey: defaultsKey)
        print("SmartClock: AlarmKit scheduled \(newIDs.count) upcoming alarms")
    }

    private func schedule(id: UUID, title: String, date: Date, soundIndex: Int) async throws {
        let stop = AlarmButton(text: "끄기", textColor: .white, systemImageName: "stop.fill")
        let alert = AlarmPresentation.Alert(title: title, stopButton: stop)
        let presentation = AlarmPresentation(alert: alert)
        let attributes = AlarmAttributes<SmartClockMetadata>(
            presentation: presentation,
            metadata: SmartClockMetadata(),
            tintColor: Color.blue
        )
        let soundFile = String(format: "alarm_%02d.caf", soundIndex)
        let config = AlarmManager.AlarmConfiguration.alarm(
            schedule: .fixed(date),
            attributes: attributes,
            stopIntent: nil,
            secondaryIntent: nil,
            sound: .named(soundFile)
        )
        _ = try await manager.schedule(id: id, configuration: config)
    }

    private func dailySound(alarmID: String, date: Date) -> Int {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        let dayKey = formatter.string(from: date)
        let previousKey = formatter.string(from: Calendar.current.date(byAdding: .day, value: -1, to: date) ?? date)
        let today = stableIndex(alarmID + "|" + dayKey)
        let yesterday = stableIndex(alarmID + "|" + previousKey)
        return today == yesterday ? (today + 1) % 12 : today
    }

    private func stableIndex(_ value: String) -> Int {
        var hash: UInt64 = 14695981039346656037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 1099511628211
        }
        return Int(hash % 12)
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}
