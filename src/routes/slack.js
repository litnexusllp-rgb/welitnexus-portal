'use strict';

const express = require('express');
const { requireAdmin } = require('../auth');
const { buildDailySummary, sendDailySummary } = require('../slack');

const router = express.Router();

// Preview the text that would be posted (no Slack call).
router.get('/preview', requireAdmin, (_req, res) => {
  res.json({ configured: !!process.env.SLACK_WEBHOOK_URL, text: buildDailySummary() });
});

// Send the summary to Slack right now (to verify the webhook works).
router.post('/send', requireAdmin, async (_req, res) => {
  try {
    const r = await sendDailySummary();
    if (r.skipped) return res.status(400).json({ error: 'SLACK_WEBHOOK_URL is not set on the server yet' });
    if (!r.ok) return res.status(502).json({ error: `Slack rejected the message (HTTP ${r.status})` });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not reach Slack: ' + e.message });
  }
});

module.exports = router;
