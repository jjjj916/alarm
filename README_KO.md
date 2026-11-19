# 스마트 시계 — 앱을 닫아도 푸시 알림 받기

이 프로젝트는 제공된 `index.html`, `service-worker.js`, `manifest.json`, 아이콘을 유지하면서 앱이 닫힌 뒤에도 서버가 예약을 확인해 Web Push 알림을 보내도록 보완한 버전입니다.

## 먼저 알아둘 점

- 브라우저의 JavaScript 타이머(`setInterval`)나 오디오 재생은 앱이 종료되면 실행되지 않습니다.
- 이 버전은 알람과 실행 중인 카운트다운 타이머를 서버 저장소에 동기화하고, 서버가 예약 시각에 푸시 알림을 전송합니다.
- Colab은 노트북 런타임이 종료·정지될 수 있어 상시 알람 서버로 쓰지 않습니다. 웹 앱/API는 Vercel에 배포하고, 정기 호출은 Google Apps Script가 담당합니다.
- 푸시 알림은 OS의 알림 설정·절전 정책·네트워크 상태에 영향을 받습니다. 일반 휴대전화 기본 알람처럼 항상 큰 소리로 울리거나 초 단위 정각을 보장하는 방식은 아닙니다. 이 방식은 앱이 닫혀도 알림을 전달하는 Web Push 방식입니다.
- 반복 알람은 요일과 시각을 기준으로 동작합니다. 1회성 알람은 예약 시각을 서버에 저장해 한 번만 발송합니다. 카운트다운 타이머는 실행/재개 시 종료 시각을 서버에 저장하고, 일시정지/취소하면 서버 예약을 지웁니다.

## 구성

- `index.html`: 기존 스마트 시계 화면과 알람/타이머 기능
- `service-worker.js`: 백그라운드 푸시 수신 및 알림 클릭 처리
- `api/push-config.js`: 브라우저에 공개 VAPID 공개키 제공
- `api/push-subscribe.js`: 기기 구독, 알람, 타이머 정보를 Upstash Redis에 저장
- `api/cron-check.js`: 호출될 때 예약 시각을 확인하고 Web Push 발송
- `api/server-time.js`: 기존 웹사이트 서버 시간 동기화 기능
- `google-apps-script/Code.gs`: Google Apps Script에서 1분마다 알람 확인 API 호출

## 1. Vercel에 프로젝트 배포

1. ZIP 압축을 풉니다.
2. 폴더 전체를 GitHub 저장소에 올립니다.
3. Vercel에서 **Add New → Project**로 해당 저장소를 가져와 배포합니다.
4. 프로젝트의 **Settings → Environment Variables**에 아래 환경 변수를 추가합니다.

| 변수 | 값 |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis 데이터베이스의 REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST 토큰 |
| `VAPID_PUBLIC_KEY` | VAPID 공개키 |
| `VAPID_PRIVATE_KEY` | VAPID 개인키 |
| `VAPID_SUBJECT` | `mailto:본인 이메일 주소` 형식 |
| `CRON_SECRET` | 충분히 길고 임의적인 비밀 문자열 |

### Upstash Redis 만들기

1. Upstash에서 Redis 데이터베이스를 생성합니다.
2. 데이터베이스의 REST URL과 REST Token을 복사합니다.
3. 두 값을 Vercel 환경 변수에 각각 등록합니다.

Redis는 앱이 종료되어도 알람 정보가 유지되도록 하는 저장소입니다. Vercel 함수의 메모리나 브라우저 `localStorage`만으로는 이 동작을 보장할 수 없습니다.

### VAPID 키 만들기

컴퓨터에 Node.js가 있다면 프로젝트 폴더에서 다음을 실행합니다.

```bash
npm install
npx web-push generate-vapid-keys
```

출력된 **Public Key**를 `VAPID_PUBLIC_KEY`, **Private Key**를 `VAPID_PRIVATE_KEY`에 입력합니다. 개인키는 브라우저 코드나 GitHub에 올리지 마세요.

`VAPID_SUBJECT`는 아래처럼 입력합니다.

```text
mailto:your-email@example.com
```

`CRON_SECRET`은 긴 임의 문자열로 설정합니다. 이 값은 Google Apps Script에도 같은 값으로 입력해야 합니다.

환경 변수 등록 후 Vercel에서 다시 배포합니다.

## 2. API 설정 확인

배포 주소가 `https://your-project.vercel.app`이라면 브라우저에서 아래 주소를 엽니다.

```text
https://your-project.vercel.app/api/health
```

정상 설정이면 다음과 비슷한 JSON을 보여줍니다.

```json
{
  "ok": true,
  "storageConfigured": true,
  "pushConfigured": true
}
```

`ok`가 `false`이면 환경 변수 이름과 값을 다시 확인한 뒤 재배포하세요.

## 3. 1분마다 알람 확인하도록 Google Apps Script 설정

Vercel Hobby(무료) 요금제의 Cron은 1분 단위 실행을 지원하지 않고 하루 한 번, 시간 단위 정밀도로 제한됩니다. 그래서 이 프로젝트는 무료 개인 프로젝트에서도 정기 확인을 사용할 수 있도록 Google Apps Script의 시간 기반 트리거를 함께 제공합니다.

1. [Google Apps Script](https://script.google.com/)에서 새 프로젝트를 만듭니다.
2. `google-apps-script/Code.gs`의 내용을 편집기에 붙여넣습니다.
3. 코드 맨 위의 `SMART_CLOCK_CRON_URL`을 실제 Vercel 주소로 바꿉니다.
4. `SMART_CLOCK_CRON_SECRET`에 Vercel 환경 변수 `CRON_SECRET`과 똑같은 값을 입력합니다.
5. 함수 선택에서 `configureSmartClock`을 선택하고 **실행**을 눌러 권한을 승인합니다.
6. 함수 선택에서 `installMinuteTrigger`를 선택하고 **실행**합니다.
7. 왼쪽 **트리거** 메뉴에 `runSmartClockCron`이 1분 간격으로 등록되었는지 확인합니다.

Google Apps Script는 `everyMinutes(1)` 시간 기반 트리거를 지원하지만, 외부 스케줄 실행이므로 정확히 00초에 도착한다고 보장하지는 않습니다. 일반적으로 분 단위로 확인하고 네트워크/서비스 상황에 따라 지연될 수 있습니다.

필요 없으면 `removeMinuteTrigger` 함수를 실행해 트리거를 삭제할 수 있습니다.

## 4. 휴대전화/컴퓨터에서 알림 켜기

1. HTTPS로 배포된 웹 앱을 엽니다.
2. 브라우저 알림 권한을 허용합니다.
3. 가능하면 브라우저 메뉴에서 **앱 설치 / 홈 화면에 추가**를 선택합니다. iPhone/iPad는 Safari에서 홈 화면에 추가한 PWA로 실행해야 Web Push를 사용할 수 있습니다.
4. 앱 상단의 **🔔 푸시 알림: OFF** 버튼을 눌러 ON으로 바꿉니다.
5. 테스트용 알람을 2~3분 뒤로 설정하고 저장합니다.
6. 앱을 닫고 기기의 알림 설정에서 이 앱/브라우저 알림이 허용되어 있는지 확인합니다.

알람 목록을 추가·수정·삭제·ON/OFF 하거나 타이머를 시작/일시정지/재개하면 서버 정보도 자동 동기화됩니다.

## 5. Colab에서 실행할 때

Colab은 코드를 확인하거나 파일을 다루는 데는 쓸 수 있지만, 런타임이 종료되면 알람 확인 작업도 멈출 수 있습니다. 따라서 **Colab을 닫아도 알림을 받는 목적에는 Colab 런타임을 알람 서버로 사용하지 마세요.** 이 프로젝트는 Vercel + Upstash + Google Apps Script 조합으로 배포해야 합니다.

## 문제 해결

- `푸시 알림: OFF` 상태: 알림 권한, VAPID 키, HTTPS, 홈 화면 설치 조건을 확인합니다.
- `/api/health`가 `ok:false`: Upstash 또는 VAPID 환경 변수가 누락된 상태입니다.
- 알람이 오지 않음: Google Apps Script의 트리거가 활성화되어 있는지, 실행 기록에서 HTTP 200을 받는지 확인합니다.
- `401 Unauthorized`: Apps Script의 `SMART_CLOCK_CRON_SECRET`과 Vercel의 `CRON_SECRET`이 서로 다릅니다.
- 알람은 오지만 소리가 나지 않음: OS의 알림 사운드, 방해 금지 모드, 절전/배터리 설정을 확인합니다.
- 앱이 완전히 종료된 상태에서는 웹페이지 내부의 맞춤 오디오/긴 벨소리를 실행할 수 없습니다. 이 경우 OS가 표시하는 푸시 알림이 작동합니다. 알림 클릭으로 앱을 열면 앱 화면의 알람 모달과 소리 재생을 시도합니다.

## 보안 주의

- `VAPID_PRIVATE_KEY`, `UPSTASH_REDIS_REST_TOKEN`, `CRON_SECRET`은 비밀로 보관하세요.
- `.env` 파일이나 비밀값을 GitHub에 올리지 마세요.
- 공개 저장소를 쓰는 경우 `.env`와 개인키를 커밋하지 마세요.
