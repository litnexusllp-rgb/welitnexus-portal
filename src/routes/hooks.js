'use strict';

// Endpoints that need the raw request body: signed webhooks from Slack and
// Asana, and file uploads from the portal to Slack. Mounted in server.js
// BEFORE the JSON parser's validation middleware.

const express = require('express');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { requireAuth } = require('../auth');
const slack = require('../v2/slack');
const asanaWrite = require('../v2/asanaWrite');

const router = express.Router();
const raw = (limit) => express.raw({ type: () => true, limit });

// Uploads are mounted ahead of the app-wide write limiter (they need the raw
// body), so they get their own: each one can be 50 MB held in memory.
const uploadLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u:${req.user.id}`,
  message: { error: 'Too many files shared in a short time. Please wait a few minutes and try again.' },
});

// Header values arrive URI-encoded; a malformed one is the sender's mistake, not a server error.
function headerText(req, name, fallback = '') {
  try {
    return decodeURIComponent(String(req.get(name) || fallback));
  } catch (_e) {
    throw Object.assign(
      new Error('The file name or comment could not be read. Please rename the file and try again.'),
      {
        status: 400,
      },
    );
  }
}

router.post(
  '/hooks/slack/events',
  raw('1mb'),
  asyncRoute(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!slack.verifySignature(body, req.get('x-slack-request-timestamp'), req.get('x-slack-signature')))
      return res.status(401).json({ error: 'Bad signature' });
    if (req.get('x-slack-retry-num')) return res.json({ ok: true }); // already processed the first delivery
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (_e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    const out = await slack.handleEvent(payload);
    res.json(out);
  }),
);

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
  slack.bus.emit('tasks', { at: Date.now() });
  res.json({ ok: true });
});

// Share a file into a Slack channel. Body = the raw file; name in X-Filename.
router.post(
  '/messages/channels/:id/files',
  requireAuth,
  uploadLimiter,
  raw('50mb'),
  asyncRoute(async (req, res) => {
    if (!/^[CG][A-Z0-9]{6,}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid channel' });
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      return res.status(400).json({ error: 'Choose a file to share' });
    const filename = headerText(req, 'x-filename', 'file').slice(0, 200);
    const comment = headerText(req, 'x-comment').slice(0, 2000);
    const threadTs = String(req.get('x-thread-ts') || '') || undefined;
    const out = await slack.upload(req.user, req.params.id, { filename, buffer: req.body, comment, threadTs });
    require('../v2/roles').audit(req, 'slack.file_shared', `channel:${req.params.id}`, {
      filename,
      bytes: req.body.length,
    });
    res.json(out);
  }),
);

module.exports = router;
