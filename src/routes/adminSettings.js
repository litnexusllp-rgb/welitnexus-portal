'use strict';

// Admin console: which integrations are configured (never returns secret values).

const express = require('express');
const { requireOwner } = require('../v2/roles');
const ai = require('../v2/ai');
const cal = require('../v2/calendar');

const router = express.Router();
const set = (k) => Boolean(process.env[k]);

router.get('/integrations', requireOwner, (_req, res) => {
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  res.json({
    publicBaseUrl: base || null,
    encryptionKey: set('INTEGRATIONS_KEY'),
    adminConsoleRequired: require('../auth').consoleRequired(),
    twoStep: require('../auth').twoStepRequired(),
    slack: {
      bot: set('SLACK_BOT_TOKEN'),
      signingSecret: set('SLACK_SIGNING_SECRET'),
      eventsUrl: base ? `${base}/api/hooks/slack/events` : null,
    },
    asana: {
      token: set('ASANA_TOKEN'),
      project: set('ASANA_PROJECT_GID'),
      webhookUrl: base ? `${base}/api/hooks/asana` : null,
    },
    ai: { providers: ai.available(), default: ai.defaultProvider() },
    calendar: {
      ...cal.status(),
      googleRedirect: base ? `${base}/api/calendar/oauth/google/callback` : null,
      microsoftRedirect: base ? `${base}/api/calendar/oauth/microsoft/callback` : null,
    },
    email: { smtp: set('SMTP_HOST') && set('SMTP_USER') && set('SMTP_PASS') },
  });
});

module.exports = router;
