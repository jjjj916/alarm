
function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  // IPv4 사설망 및 루프백/링크로컬 대역 차단
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      return true;
    }
  }

  // IPv6 내부망 및 특수 주소 차단
  if (host.includes(':')) {
    return true;
  }

  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: '허용되지 않은 요청 방식입니다.' });
  }

  // 동일 출처(Origin/Referer) 검증으로 외부 사이트 무단 API 호출 방지
  const host = req.headers.host;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin && !origin.includes(host)) {
    return res.status(403).json({ error: '허용되지 않은 출처의 요청입니다.' });
  }
  if (!origin && referer && !referer.includes(host)) {
    return res.status(403).json({ error: '허용되지 않은 경로의 요청입니다.' });
  }

  const { url } = req.query;
  if (!url || typeof url !== 'string' || url.length > 200) {
    return res.status(400).json({ error: '올바른 웹페이지 주소를 입력해주세요.' });
  }

  let rawUrl = url.trim();
  if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
    rawUrl = 'https://' + rawUrl;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: '유효하지 않은 URL 형식입니다.' });
  }

  // HTTP/HTTPS 프로토콜 및 표준 포트만 허용
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'HTTP 또는 HTTPS 주소만 지원합니다.' });
  }
  if (parsedUrl.port && parsedUrl.port !== '80' && parsedUrl.port !== '443') {
    return res.status(403).json({ error: '비표준 포트 번호는 보안상 차단됩니다.' });
  }
  if (!parsedUrl.hostname.includes('.') || isBlockedHost(parsedUrl.hostname)) {
    return res.status(403).json({ error: '접근이 제한된 내부망 또는 잘못된 도메인입니다.' });
  }

  const safeTargetUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${parsedUrl.pathname}`;

  try {
    const startTime = Date.now();
    const response = await fetch(safeTargetUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ServerTimeSync/1.0)'
      }
    });
    const endTime = Date.now();

    const dateHeader = response.headers.get('date');
    if (!dateHeader) {
      return res.status(404).json({ error: '해당 서버에서 시간 정보(Date)를 제공하지 않습니다.' });
    }

    const parsedDate = new Date(dateHeader).getTime();
    if (Number.isNaN(parsedDate)) {
      return res.status(502).json({ error: '서버의 시간 형식을 해석할 수 없습니다.' });
    }

    const rtt = endTime - startTime;
    const serverTimestamp = parsedDate + Math.round(rtt / 2);

    return res.status(200).json({
      targetUrl: safeTargetUrl,
      serverTimestamp,
      rtt
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return res.status(504).json({ error: '대상 서버 응답 시간이 초과되었습니다(3초).' });
    }
    return res.status(500).json({ error: '주소가 잘못되었거나 해당 서버에 연결할 수 없습니다.' });
  }
}
