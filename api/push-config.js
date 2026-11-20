export default function handler(req, res) {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
  return res.status(200).json({ enabled: Boolean(vapidPublicKey), vapidPublicKey });
}
