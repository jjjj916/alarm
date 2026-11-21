'use strict';

/*
 * 서버 시간 API (네이비즘 방식)
 * - url 없이 호출: 이 서버의 표준시(ms)를 돌려줍니다. 앱이 기기 시계 오차를 보정하는 데 사용합니다.
 * - url=도메인: 해당 사이트의 Date 헤더가 "초가 바뀌는 순간"을 여러 번 요청해 찾아내서
 *   그 사이트 서버 시계가 표준시보다 몇 ms 빠르거나 느린지 계산합니다. (Date 헤더는 초 단위라
 *   한 번만 요청하면 최대 1초 오차가 나기 때문입니다.)
 */

const net = require('net');

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIP(h) === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

async function sampleOnce(url) {
  const t0 = Date.now();
  let response;
  try {
    response = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'SmartClockTimeSync/2.0', 'Cache-Control': 'no-cache' } });
  } catch {
    response = null;
  }
  if (!response || !response.headers.get('date')) {
    const ctrl = new AbortController();
    response = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'SmartClockTimeSync/2.0', 'Cache-Control': 'no-cache' } });
    ctrl.abort();
  }
  const t1 = Date.now();
  const date = response.headers.get('date');
  const sec = date ? Date.parse(date) : NaN;
  return { t0, t1, mid: (t0 + t1) / 2, sec };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const raw = String((req.query && req.query.url) || '').trim();
  if (!raw) return res.status(200).json({ now: Date.now() });

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return res.status(400).json({ error: '주소 형식이 올바르지 않습니다.' });
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    return res.status(400).json({ error: '확인할 수 없는 주소입니다.' });
  }

  try {
    const samples = [];
    const deadline = Date.now() + 2600;
    let transition = null;
    while (Date.now() < deadline && samples.length < 45) {
      const s = await sampleOnce(target.toString());
      if (!Number.isFinite(s.sec)) {
        return res.status(422).json({ error: '이 사이트는 서버 시간(Date 헤더)을 알려주지 않습니다.' });
      }
      samples.push(s);
      const n = samples.length;
      if (n >= 3 && samples[n - 1].sec > samples[n - 2].sec) { transition = [samples[n - 2], samples[n - 1]]; break; }
    }

    let offsetMs, accuracyMs;
    if (transition) {
      const [a, b] = transition;
      const boundaryLocal = (a.mid + b.mid) / 2;
      offsetMs = Math.round(b.sec - boundaryLocal);
      accuracyMs = Math.max(5, Math.round((b.mid - a.mid) / 2 + (b.t1 - b.t0) / 4));
    } else {
      const last = samples[samples.length - 1];
      offsetMs = Math.round(last.sec + 500 - last.mid);
      accuracyMs = 500;
    }
    return res.status(200).json({
      targetUrl: target.toString(),
      host: target.hostname,
      offsetMs,
      accuracyMs,
      samples: samples.length,
      now: Date.now()
    });
  } catch (err) {
    return res.status(502).json({ error: '서버 접속 실패: ' + (err.message || err) });
  }
};
