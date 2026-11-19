'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

function isPrivateIPv4(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0) || (a === 192 && b === 0 && p[2] === 2) ||
    (a === 198 && b === 51 && p[2] === 100) ||
    (a === 203 && b === 0 && p[2] === 113);
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family !== 6) return true;
  const value = address.toLowerCase();
  if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:')) return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    let raw = String(req.query.url || '').trim();
    if (!raw) return res.status(400).json({ error: '주소를 입력해주세요.' });
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    const target = new URL(raw);
    if (target.protocol !== 'https:' || target.username || target.password || target.port && target.port !== '443') {
      return res.status(400).json({ error: '보안상 HTTPS 기본 포트(443) 주소만 확인할 수 있습니다.' });
    }
    const hostname = target.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || net.isIP(hostname)) {
      return res.status(400).json({ error: '공개 웹사이트 주소만 사용할 수 있습니다.' });
    }

    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      return res.status(400).json({ error: '공개 IP 주소로 연결되는 웹사이트만 확인할 수 있습니다.' });
    }
    const chosen = addresses[0];

    const result = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname,
        port: 443,
        method: 'HEAD',
        path: `${target.pathname}${target.search}`,
        servername: hostname,
        timeout: 5000,
        headers: { 'User-Agent': 'SmartClock-TimeCheck/1.0' },
        lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family)
      }, response => {
        const dateHeader = response.headers.date;
        response.resume();
        if (!dateHeader) return reject(new Error('대상 사이트가 표준 Date 응답 헤더를 제공하지 않습니다.'));
        const timestamp = Date.parse(dateHeader);
        if (!Number.isFinite(timestamp)) return reject(new Error('사이트의 시간 응답을 해석할 수 없습니다.'));
        resolve({ timestamp, statusCode: response.statusCode || 0 });
      });
      request.on('timeout', () => request.destroy(new Error('대상 사이트 응답 시간이 초과되었습니다.')));
      request.on('error', reject);
      request.end();
    });

    return res.status(200).json({
      serverTimestamp: result.timestamp,
      targetUrl: target.origin,
      rtt: 0,
      statusCode: result.statusCode
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || '대상 사이트 시간 확인에 실패했습니다.' });
  }
};
