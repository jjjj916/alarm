# 기존 스마트 시계 화면을 사용하는 iOS AlarmKit 연결 코드

이 폴더는 새 디자인의 알람 앱을 만드는 것이 아닙니다. 현재 Vercel에 배포된 동일한 `index.html`을 WKWebView로 표시하고, 기존 웹 화면에서 저장한 알람을 iOS 26+ AlarmKit에 전달하는 네이티브 연결 코드입니다.

## 중요 제한

- AlarmKit은 iOS 26 이상에서만 사용할 수 있습니다.
- iOS 앱 빌드는 macOS의 Xcode가 필요합니다. Google Colab/Windows만으로 iOS 앱을 빌드할 수 없습니다.
- iOS 26+ 기기에서 AlarmKit 권한을 승인해야 합니다.
- 이 소스는 아직 Xcode에서 빌드하거나 실제 iPhone에서 테스트하지 않았습니다. Apple SDK/Xcode 버전에 따라 API 서명이나 프로젝트 설정을 조정해야 할 수 있습니다.
- 랜덤 알람은 다음 7일의 날짜별 일회성 알람을 미리 예약합니다. 앱을 열어 동기화하면 다음 7일 예약이 갱신됩니다. 앱을 7일 넘게 한 번도 열지 않으면 예약 창이 소진될 수 있습니다.
- AlarmKit은 OS가 알람 UI와 소리를 관리합니다. 사용자 지정 CAF 파일 재생은 OS 버전별 실제 기기 테스트가 필요하며, 이 프로젝트는 7초짜리 맞춤 소리 12개를 포함합니다. OS/기기 정책에 따라 기본 시스템 소리로 대체될 수 있습니다.
- 현재 구현은 AlarmKit 시스템 알람의 '끄기' 버튼을 제공합니다. 웹 화면의 기존 스누즈 카운트/간격을 AlarmKit 버튼 동작과 완전히 동기화하는 것은 다음 통합 단계에서 추가해야 합니다.

## Xcode에 넣는 방법

1. Mac에서 Xcode 26 이상으로 iOS App 프로젝트를 새로 만듭니다.
2. Product Name은 `SmartClock`, Interface는 SwiftUI, Language는 Swift로 설정합니다.
3. 프로젝트의 deployment target을 iOS 26.0 이상으로 설정합니다.
4. 이 폴더의 `Sources/SmartClockIOSApp.swift`, `Sources/SmartClockWebView.swift`, `Sources/IOSAlarmKitBridge.swift`를 Xcode 프로젝트에 추가합니다. 기존 생성된 `App.swift`는 중복되지 않도록 제거하거나 교체합니다.
5. `Resources/AlarmSounds` 폴더의 `.caf` 파일 12개를 프로젝트에 추가하고 Target Membership을 앱 타깃으로 체크합니다.
6. `Info.plist`의 `NSAlarmKitUsageDescription` 키를 앱 타깃의 Info 설정에 추가합니다.
7. Signing & Capabilities에서 본인 Apple 개발 서명 팀을 선택합니다.
8. 실제 iPhone iOS 26 이상에서 실행하고 AlarmKit 권한을 허용합니다.
9. 웹 앱에서 알람을 저장하면 WKWebView 브리지가 AlarmKit에 다음 7일의 알람을 등록합니다.

## 웹 코드 연결

`index.html`의 `syncAlarmsToNative()`가 다음 메시지를 전송합니다.

```js
window.webkit.messageHandlers.smartClock.postMessage({
  action: 'syncState',
  payload: { alarms, timer, timeZone }
});
```

`SmartClockWebView.swift`가 이를 받아 `IOSAlarmKitBridge`에 전달합니다.

## 사용자 지정 알람음

`alarm_00.caf`부터 `alarm_11.caf`까지 12개가 포함되어 있습니다. `randomDaily: true`인 알람은 날짜/알람 ID 기반으로 소리를 선택하고 전날과 같은 소리가 연속되지 않도록 합니다. 고정 알람음은 웹 화면에서 선택한 `sound` 번호를 사용합니다.
