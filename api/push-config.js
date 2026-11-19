'use strict';

const { getVapidConfig } = require('../lib/server');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const cfg = getVapidConfig();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    enabled: Boolean(cfg.publicKey && cfg.privateKey),
    vapidPublicKey: cfg.publicKey || null
  });
};
