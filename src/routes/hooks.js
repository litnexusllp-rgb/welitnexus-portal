'use strict';

// Endpoints that need the raw request body: the signed Asana webhook. Mounted
// in server.js BEFORE the JSON parser so the signature is checked on the exact
// bytes received.

const express = require('express');
const { db } = require('../db');
const asanaWrite = require('../v2/asanaWrite');

const router = express.Router();
const raw = (limit) => express.raw({ type: () => true, limit });

router.post('/hooks/asana', raw('1mb'), (req, res) => {
  const handshake = req.get('x-hook-secret');
  if (handshake) {
    const pending = db
      .prepare("SELECT value FROM int_settings WHERE key='asana_webhook_pending' AND updated_ts > ?")
      .get(Date.now() - 10 * 60 * 1000);
    if (!pending) return res.status(403).json({ error: 'No webhook setup in progress' });
    asanaWrite.saveWebhookSecret(handshake);
    db.prepare("DELETE FROM int_settings WHERE key='asana_webhook_pending'").run();
    res.set('X-Hook-Secret', handshake);
    return res.status(200).end();
  }
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!asanaWrite.verifyWebhook(body, req.get('x-hook-signature')))
    return res.status(401).json({ error: 'Bad signature' });
  // Something changed in Asana: refresh the shared task cache in the background.
  require('../asana')
    .allTasks(true)
    .catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
