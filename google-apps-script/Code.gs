/**
 * 스마트 시계: 1분마다 Vercel의 푸시 예약 확인 API를 호출합니다.
 * 아래 두 값을 본인의 배포 주소와 CRON_SECRET으로 바꾼 다음
 * configureSmartClock()을 1회 실행하고 installMinuteTrigger()를 1회 실행하세요.
 */
const SMART_CLOCK_CRON_URL = 'https://YOUR-PROJECT.vercel.app/api/cron-check';
const SMART_CLOCK_CRON_SECRET = 'PASTE_THE_SAME_CRON_SECRET_HERE';

function configureSmartClock() {
  if (SMART_CLOCK_CRON_URL.includes('YOUR-PROJECT') ||
      SMART_CLOCK_CRON_SECRET.includes('PASTE_')) {
    throw new Error('Code.gs 상단의 URL과 CRON_SECRET을 먼저 입력하세요.');
  }
  PropertiesService.getScriptProperties().setProperties({
    SMART_CLOCK_CRON_URL: SMART_CLOCK_CRON_URL,
    SMART_CLOCK_CRON_SECRET: SMART_CLOCK_CRON_SECRET
  });
  Logger.log('설정 저장 완료');
}

function installMinuteTrigger() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SMART_CLOCK_CRON_URL') ||
      !props.getProperty('SMART_CLOCK_CRON_SECRET')) {
    throw new Error('먼저 configureSmartClock()을 실행하세요.');
  }

  // 같은 핸들러의 기존 트리거가 있다면 중복 생성을 막기 위해 삭제합니다.
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'runSmartClockCron')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('runSmartClockCron')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('1분 간격 확인 트리거 설치 완료');
}

function runSmartClockCron() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('SMART_CLOCK_CRON_URL');
  const secret = props.getProperty('SMART_CLOCK_CRON_SECRET');
  if (!url || !secret) throw new Error('서버 호출 설정이 없습니다.');

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
    followRedirects: false
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  console.log('Smart Clock API:', status, body);
  if (status < 200 || status >= 300) {
    throw new Error('알람 확인 API 오류: HTTP ' + status + ' / ' + body);
  }
}

function removeMinuteTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'runSmartClockCron')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  Logger.log('스마트 시계 트리거 삭제 완료');
}
