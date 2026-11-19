# 스마트 시계 Android 네이티브 알람

이 폴더는 기존 스마트 시계 웹 화면을 Android 앱 안에 띄우고, 알람 예약은 Android 운영체제의 `AlarmManager`가 담당하도록 만든 Android Studio 프로젝트입니다.

## 구현된 기능

- 앱 화면은 현재 배포된 스마트 시계 웹 앱을 WebView로 표시합니다.
- 웹 화면에서 알람을 추가·수정·삭제·ON/OFF 하면 네이티브 Android 알람 예약을 동기화합니다.
- 요일별 반복 알람, 1회성 알람, 빠른 알람, 다시 울림(스누즈)을 지원합니다.
- 카운트다운 타이머의 시작·일시정지·재개·취소를 네이티브 예약에 반영합니다.
- 알람 시각이 되면 앱 화면이 열려 있지 않아도 BroadcastReceiver가 실행되고, 미디어 재생 전경 서비스가 기기의 `USAGE_ALARM` 오디오 스트림으로 알람음을 반복 재생합니다.
- 12개 웹 사운드의 음계/파형 구성을 Android 오디오로 다시 구현했습니다.
- 알람 화면과 다시 울림/끄기 버튼을 제공합니다.
- 기기 재부팅, 시간 변경, 시간대 변경 후 저장된 알람을 다시 예약합니다.

## 먼저 알아둘 제한

- 이것은 **Android 앱 프로젝트 소스**입니다. 이 작업 환경에는 Android SDK가 없어 APK를 직접 빌드하거나 실제 휴대폰에서 검증하지 못했습니다. Android Studio에서 APK를 빌드해야 합니다.
- 앱을 Android Studio로 설치한 다음 알람을 새로 등록하세요. Chrome/PWA의 `localStorage`는 Android 앱 WebView와 별개이므로 기존 브라우저 알람이 자동으로 옮겨지지는 않습니다.
- Android 설정에서 앱을 **강제 종료(Force stop)** 하면 운영체제가 예약된 알람을 중지할 수 있습니다. 최근 앱 화면에서 앱을 닫는 것과 설정에서 강제 종료하는 것은 다릅니다.
- 정확한 시각에 울리려면 Android의 **알람 및 리마인더** 특별 접근 권한이 필요합니다. 잠금 화면을 전체 화면으로 표시하려면 Android 14 이상에서 **전체 화면 알림** 권한도 필요할 수 있습니다.
- 알람음은 휴대폰의 알람 음량, 방해 금지 설정, 제조사 절전 정책의 영향을 받습니다. 앱이 시스템의 사용자 설정을 임의로 우회하지 않습니다.
- 이 프로젝트는 로컬 APK 설치/개인 테스트를 위한 시작점입니다. Google Play에 공개할 계획이라면 정확한 알람 및 전체 화면 알림 권한의 Play 정책 적합성을 별도로 검토해야 합니다.

## 1. 먼저 웹 프로젝트를 업데이트

Android 앱은 웹 프로젝트의 수정된 `index.html`을 사용해야 `AndroidAlarmBridge`를 통해 알람 정보를 Android에 전달할 수 있습니다.

1. 이 ZIP 안의 `smart-clock-push-ready/index.html`을 엽니다.
2. 기존 GitHub 저장소의 최상위 `index.html`을 이 파일로 교체합니다.
3. GitHub `main` 브랜치에 커밋하고 푸시합니다.
4. Vercel에서 새 배포가 `Ready`가 될 때까지 확인합니다.
5. 기존 웹 앱 주소에서 페이지가 열리는지 확인합니다.

기존 Vercel 주소는 `MainActivity.kt`의 `APP_URL`/`APP_HOST`에 미리 넣어 두었습니다. 도메인이 달라졌다면 두 값을 모두 바꿔야 합니다.

## 2. Android Studio에서 프로젝트 열기

1. Android Studio를 설치하고 실행합니다.
2. **Open**을 선택합니다.
3. 압축을 푼 프로젝트 안의 `smart-clock-push-ready/android-native` 폴더를 선택합니다.
4. Gradle Sync를 진행합니다. 처음 실행할 때 Gradle과 Android Gradle Plugin, Android SDK 35 구성요소를 다운로드할 수 있습니다.
5. SDK 35가 설치되어 있지 않으면 Android Studio의 SDK Manager 안내에 따라 설치합니다.

프로젝트의 `gradlew.bat`은 Windows에서 공식 Gradle 배포본 8.9를 처음 한 번 내려받아 실행하는 간단한 부트스트랩 스크립트입니다. Android Studio가 Gradle 실행을 요청하면 다운로드에 잠시 시간이 걸릴 수 있습니다.

## 3. APK 만들기

Android Studio 메뉴에서:

1. **Build → Build Bundle(s) / APK(s) → Build APK(s)** 를 선택합니다.
2. 빌드가 끝나면 `locate`를 눌러 APK 파일을 찾습니다.
3. 보통 경로는 `app/build/outputs/apk/debug/app-debug.apk` 입니다.
4. APK를 본인 Android 휴대폰에 옮겨 설치합니다.

프로젝트 패키지 이름은 `com.smartclock.app`입니다.

## 4. 처음 실행할 때 권한 허용

앱을 처음 열면 권한 안내가 나타날 수 있습니다.

1. **알림 권한** 허용
2. **알람 및 리마인더** 특별 접근에서 스마트 시계 허용
3. Android 14 이상이라면 **전체 화면 알림** 특별 접근도 허용

권한을 나중에 설정하려면 앱 상단의 `기기 알람: ON` 또는 `알람 권한 설정` 버튼을 누르세요. 권한 상태에 따라 버튼 문구가 달라집니다.

## 5. 테스트 방법

1. Android 앱을 실행합니다.
2. 앱 화면에서 `+5분`을 눌러 테스트 알람을 등록합니다.
3. 내 알람 목록에 알람이 보이고 기기 알람 상태가 ON인지 확인합니다.
4. 홈으로 나가거나 최근 앱 화면에서 스마트 시계를 닫습니다. 설정의 강제 종료는 누르지 마세요.
5. 예약 시각에 잠금 화면/알림/알람음이 작동하는지 확인합니다.
6. 알람 화면에서 다시 울림 또는 알람 끄기를 시험합니다.

## 코드 구조

- `MainActivity.kt`: 기존 Vercel 웹 앱을 WebView로 표시하고 Android 권한을 안내합니다.
- `AlarmBridge.kt`: 웹 페이지와 Android 알람 스케줄러를 연결합니다.
- `AlarmScheduler.kt`: AlarmManager의 정확한 알람 예약/취소를 담당합니다.
- `AlarmReceiver.kt`: 예약 시각에 실행됩니다.
- `AlarmRingingService.kt`: 알람 오디오와 진동을 전경 서비스에서 유지합니다.
- `AlarmRingingActivity.kt`: 잠금 화면/알람 화면 UI입니다.
- `AlarmActionReceiver.kt`: 알림의 다시 울림/끄기 동작을 처리합니다.
- `BootReceiver.kt`: 재부팅·시간대 변경 후 알람을 다시 등록합니다.

## 보안

- 이 Android 프로젝트에는 `CRON_SECRET`, `VAPID_PRIVATE_KEY`, Upstash 토큰을 넣지 않습니다.
- Vercel 서버의 기존 비밀 환경 변수는 기존처럼 Vercel에만 보관합니다.
- WebView는 지정된 스마트 시계 도메인만 앱 내부에서 열고 다른 페이지 이동은 외부 브라우저로 보냅니다.
