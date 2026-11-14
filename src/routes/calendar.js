'use strict';

// Unified calendar API.

const express = require('express');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { requireAuth, hasAdminAccess } = require('../auth');
const { adminLevel, audit } = require('../v2/roles');
const cal = require('../v2/calendar');

const router = express.Router();

// The OAuth redirect lands here in the browser (cookie present), then returns to the app.
router.get(
  '/oauth/:provider/callback',
  requireAuth,
  asyncRoute(async (req, res) => {
    const provider = req.params.provider;
    if (!['google', 'microsoft'].includes(provider)) return res.status(404).end();
    if (req.query.error) {
      const blocked = /admin|consent|access_denied|policy/i.test(
        String(req.query.error) + String(req.query.error_description || ''),
      );
      return res.redirect(`/?connect=${blocked ? 'blocked' : 'cancelled'}#/schedule`);
    }
    try {
      const r = await cal.finishOAuth(req.user, provider, { code: req.query.code, state: req.query.state });
      audit(req, 'calendar.connected', `${provider}:${r.email}`, { calendars: r.calendars });
      res.redirect(`/?connect=ok&added=${r.added}#/schedule`);
    } catch (e) {
      console.error('Calendar connect failed:', e.message);
      res.redirect(`/?connect=${e.adminBlock ? 'blocked' : 'failed'}#/schedule`);
    }
  }),
);

router.use(requireAuth);

const range = (q) => {
  const from = Date.parse(q.from),
    to = Date.parse(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 100 * 86400000)
    throw Object.assign(new Error('Choose a date range of up to 100 days'), { status: 400 });
  return { from, to };
};

router.get('/status', (_req, res) => res.json(cal.status()));

router.get('/sources', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.kind, s.label, s.color, s.visible, s.read_only, s.client_id, s.last_sync_ts, s.last_error, t.account_email
    FROM int_calendar_sources s LEFT JOIN int_oauth_tokens t ON t.id=s.token_id WHERE s.user_id=? ORDER BY s.kind, s.label`,
    )
    .all(req.user.id);
  res.json({ sources: rows.map((r) => ({ ...r, visible: Boolean(r.visible), read_only: Boolean(r.read_only) })) });
});

router.post('/sources/:provider/connect', (req, res) => {
  res.json({ url: cal.startOAuth(req.user, req.params.provider) });
});

router.post(
  '/sources/ics',
  asyncRoute(async (req, res) => {
    const id = await cal.addIcs(req.user, {
      url: req.body.url,
      label: req.body.label,
      color: req.body.color,
      client_id: req.body.client_id ? Number(req.body.client_id) : null,
    });
    audit(req, 'calendar.ics_added', `source:${id}`, { label: req.body.label });
    res.json({ ok: true, id });
  }),
);

router.put('/sources/:id', (req, res) => {
  const src = db
    .prepare('SELECT * FROM int_calendar_sources WHERE id=? AND user_id=?')
    .get(Number(req.params.id), req.user.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : src.color;
  const label = req.body.label !== undefined ? String(req.body.label).trim().slice(0, 120) || src.label : src.label;
  const visible = req.body.visible !== undefined ? (req.body.visible ? 1 : 0) : src.visible;
  db.prepare('UPDATE int_calendar_sources SET color=?, label=?, visible=? WHERE id=?').run(
    color,
    label,
    visible,
    src.id,
  );
  res.json({ ok: true });
});

// Disconnect: removes the cached events and the stored sign-in for that account
// once no calendar uses it. Nothing is deleted at Google/Microsoft.
router.delete('/sources/:id', (req, res) => {
  const src = db
    .prepare('SELECT * FROM int_calendar_sources WHERE id=? AND user_id=?')
    .get(Number(req.params.id), req.user.id);
  if (!src) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM int_calendar_events_cache WHERE source_id=?').run(src.id);
    db.prepare('DELETE FROM int_calendar_sources WHERE id=?').run(src.id);
    if (src.token_id && !db.prepare('SELECT 1 FROM int_calendar_sources WHERE token_id=?').get(src.token_id))
      db.prepare('DELETE FROM int_oauth_tokens WHERE id=?').run(src.token_id);
  })();
  audit(req, 'calendar.removed', `source:${src.id}`, { label: src.label });
  res.json({ ok: true });
});

router.get(
  '/events',
  asyncRoute(async (req, res) => {
    const { from, to } = range(req.query);
    res.json(
      await cal.events(req.user, from, to, {
        // Same rules as the billing pages and the rest of the admin data.
        billing: Boolean(adminLevel(req.user) && req.adminConsole),
        admin: hasAdminAccess(req),
        refresh: req.query.refresh === '1',
      }),
    );
  }),
);

router.post(
  '/events',
  asyncRoute(async (req, res) => {
    const out = await cal.createEvent(req.user, req.body);
    audit(req, 'calendar.event_created', `source:${req.body.source_id}`, { title: req.body.title });
    res.json(out);
  }),
);

router.get('/free-busy', (req, res) => {
  const { from, to } = range(req.query);
  const ids = String(req.query.user_ids || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 50);
  res.json({ busy: cal.freeBusy(ids, from, to) });
});

module.exports = router;
