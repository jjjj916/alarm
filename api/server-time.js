export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL을 입력해주세요.' });
  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
  try {
    const start = Date.now();
    const response = await fetch(targetUrl, { method: 'HEAD', headers: { 'User-Agent': 'SmartClockTimeSync/1.0' } });
    const rtt = Date.now() - start;
    const dateHeader = response.headers.get('date');
    if (!dateHeader) return res.status(422).json({ error: '표준시(Date) 헤더를 제공하지 않는 서버입니다.' });
    const serverTimestamp = new Date(dateHeader).getTime() + Math.round(rtt / 2);
    return res.status(200).json({ targetUrl, serverTimestamp, rtt });
  } catch (err) {
    return res.status(500).json({ error: '서버 접속 실패: ' + err.message });
  }
}
