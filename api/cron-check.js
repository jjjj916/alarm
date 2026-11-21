'use strict';

const S = require('../lib/server');

// Apps Script / GitHub Actions / QStash가 호출하는 알람 발송 확인 API
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  if (!S.isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // Apps Script(1분마다)는 45초 앞까지 기다렸다가 정각에 보냄 → QStash가 안 돼도 정각 발송
    const ua = String(req.headers['user-agent'] || '');
    const lookaheadMs = /google-apps-script/i.test(ua) || req.query.wait === 'long' ? 45000 : 0;
    const result = await S.dispatchDue(req, { lookaheadMs });
    return res.status(200).json({ ...result, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('cron-check error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || '알람 확인 중 오류가 발생했습니다.' });
  }
};
