
export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: '웹페이지 주소를 입력해주세요.' });
  }

  let targetUrl = url.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const startTime = Date.now();
    const response = await fetch(targetUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ServerTimeSync/1.0)'
      }
    });
    const endTime = Date.now();

    const dateHeader = response.headers.get('date');
    if (!dateHeader) {
      return res.status(404).json({ error: '해당 서버에서 시간 정보(Date)를 제공하지 않습니다.' });
    }

    const rtt = endTime - startTime;
    const serverTimestamp = new Date(dateHeader).getTime() + Math.round(rtt / 2);

    return res.status(200).json({
      targetUrl,
      serverTimestamp,
      rtt
    });
  } catch (error) {
    return res.status(500).json({ error: '주소가 잘못되었거나 해당 서버에 연결할 수 없습니다.' });
  }
}
