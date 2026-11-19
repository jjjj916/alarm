export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: '허용되지 않은 요청 방식입니다.' });
  }
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
  return res.status(200).json({
    enabled: Boolean(vapidPublicKey),
    vapidPublicKey
  });
}