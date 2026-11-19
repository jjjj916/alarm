# 스마트 시계 크로스플랫폼 코드 업데이트

이 업데이트는 기존 스마트 시계 웹 화면을 유지하면서, `randomDaily` 랜덤 알람음과 네이티브 알람 연결 코드를 추가합니다.

## 이번 업데이트 내용

- 기존 `index.html` 화면과 알람/스톱워치/타이머 기능 유지
- 알람 생성 시 알람음을 `랜덤`으로 선택하면 `randomDaily: true` 저장
- 날짜와 알람 ID를 기준으로 같은 날 같은 기기에서 동일한 소리를 선택
- 전날과 같은 알람음이 연속 선택되지 않도록 처리
- Android 네이티브 알람은 실제 울리는 날의 날짜를 기준으로 소리 선택
- iOS 26+ AlarmKit 연결용 WKWebView 브리지 소스 추가
- iOS용 맞춤 알람 소리 CAF 12개 생성
- 기존 Vercel API 및 Apps Script 구조 유지

## 기존 웹 프로젝트를 업데이트하는 순서

1. ZIP을 압축 해제합니다.
2. `smart-clock-push-ready` 폴더의 내용을 기존 GitHub 저장소에 반영합니다.
3. GitHub의 기존 `index.html`과 `service-worker.js`를 교체합니다.
4. `android-native`와 `ios-native` 폴더도 저장소에 함께 올려 소스를 보관합니다.
5. GitHub 커밋 후 Vercel 배포가 `Ready`가 될 때까지 기다립니다.
6. 브라우저/PWA에서 기존 주소를 열어 화면과 웹 푸시가 유지되는지 확인합니다.

## 네이티브 알람에 관한 중요한 점

GitHub, Vercel, Google Apps Script, Colab만으로 iOS의 AlarmKit이나 Android AlarmManager를 웹페이지에 직접 주입할 수는 없습니다. 운영체제 알람 API는 네이티브 앱 컨테이너에서만 호출할 수 있습니다.

이 프로젝트의 네이티브 소스는 **새로운 디자인의 별도 시계 앱을 만드는 것이 아니라, 기존 Vercel 스마트 시계 URL을 그대로 표시하는 얇은 WebView 컨테이너**입니다. 사용자는 같은 스마트 시계 화면을 보며, 네이티브 컨테이너가 운영체제 알람을 예약합니다.

- Android: `android-native` 폴더를 Android Studio에서 열어 APK를 빌드합니다.
- iOS: `ios-native` 폴더의 Swift 소스와 CAF 파일을 macOS의 Xcode 프로젝트에 추가해야 합니다. iOS 26 이상 및 AlarmKit 권한이 필요합니다.
- iOS 빌드는 Colab/Windows에서 직접 할 수 없으며 Xcode가 설치된 Mac이 필요합니다.

## 랜덤 알람 동작 범위

- Android: `randomDaily` 알람은 알람 ID와 실제 울리는 날짜를 기준으로 12개 음색 중 하나를 선택합니다. 전날과 같은 소리가 연속되지 않게 합니다.
- iOS: 현재 브리지 코드는 다음 7일의 날짜별 알람을 일회성 AlarmKit 알람으로 미리 예약합니다. 앱을 열어 동기화하면 다음 7일 예약을 갱신합니다. 7일 이상 앱을 열지 않으면 예약 창이 소진될 수 있습니다.
- 웹 푸시: 앱을 열지 않은 상태의 브라우저 푸시는 OS 알림으로 전달됩니다. 웹 푸시만으로 12개 합성 알람음을 강제로 재생하거나 기본 시계 앱처럼 반복 재생할 수는 없습니다.

## 테스트 상태

JavaScript 구문 검사는 실행했습니다. Android/iOS 네이티브 코드는 이 환경에서 Android SDK/Xcode 및 실제 기기를 사용한 빌드·실행 검증을 하지 못했습니다. 실제 설치 전에 Android Studio/Xcode에서 빌드 오류를 확인하고 기기에서 테스트해야 합니다.
