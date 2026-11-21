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
    const result = await S.dispatchDue(req);
    return res.status(200).json({ ...result, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('cron-check error:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || '알람 확인 중 오류가 발생했습니다.' });
  }
};
