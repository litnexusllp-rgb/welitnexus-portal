'use strict';

// Portal messaging backed by Slack: channels, history, threads, sending,
// file download, and a live stream (Server-Sent Events).

const express = require('express');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { requireAuth } = require('../auth');
const { requireOwner, audit } = require('../v2/roles');
const slack = require('../v2/slack');

const router = express.Router();
router.use(requireAuth);

const channelOk = (id) => /^[CG][A-Z0-9]{6,}$/.test(String(id));
const tsOk = (ts) => !ts || /^\d{10}\.\d{6}$/.test(String(ts));

router.get('/status', (_req, res) => res.json({ slack: slack.enabled(), signing: Boolean(process.env.SLACK_SIGNING_SECRET) }));

router.get('/channels', asyncRoute(async (req, res) => {
  if (!slack.enabled()) return res.json({ enabled: false, channels: [] });
  const channels = await slack.channelsFor(req.user);
  const links = db.prepare('SELECT * FROM int_channel_links').all();
  res.json({ enabled: true, channels: channels.map(c => ({ ...c, link: links.find(l => l.channel_id === c.id) || null })) });
}));

router.get('/channels/:id', asyncRoute(async (req, res) => {
  if (!channelOk(req.params.id) || !tsOk(req.query.thread)) return res.status(400).json({ error: 'Invalid channel' });
  res.json(await slack.history(req.user, req.params.id, { cursor: req.query.cursor ? String(req.query.cursor) : undefined, thread: req.query.thread ? String(req.query.thread) : undefined }));
}));

router.post('/channels/:id', asyncRoute(async (req, res) => {
  if (!channelOk(req.params.id) || !tsOk(req.body.thread_ts)) return res.status(400).json({ error: 'Invalid channel' });
  const message = await slack.post(req.user, req.params.id, req.body.text, req.body.thread_ts || undefined);
  res.json({ message });
}));

router.get('/files/:fileId', asyncRoute(async (req, res) => {
  if (!/^F[A-Z0-9]{6,}$/.test(req.params.fileId)) return res.status(400).json({ error: 'Invalid file' });
  const f = await slack.downloadFile(req.user, req.params.fileId);
  res.set({ 'Content-Type': f.mimetype, 'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(f.body);
}));

// Live updates. Only events for channels this person can see are forwarded.
router.get('/stream', asyncRoute(async (req, res) => {
  const visible = new Set(slack.enabled() ? (await slack.channelsFor(req.user)).map(c => c.id) : []);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const onMessage = (m) => { if (visible.has(m.channel)) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`); };
  const onTasks = (t) => res.write(`event: tasks\ndata: ${JSON.stringify(t)}\n\n`);
  slack.bus.on('message', onMessage); slack.bus.on('tasks', onTasks);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); slack.bus.off('message', onMessage); slack.bus.off('tasks', onTasks); });
}));

// OWNER: link a channel to an Asana project and/or client (used for "Create task" and invoices).
router.put('/channels/:id/link', requireOwner, (req, res) => {
  if (!channelOk(req.params.id)) return res.status(400).json({ error: 'Invalid channel' });
  const gid = String(req.body.asana_project_gid || '').trim();
  if (gid && !/^\d+$/.test(gid)) return res.status(400).json({ error: 'Asana project ID must be numeric' });
  const clientId = req.body.client_id ? Number(req.body.client_id) : null;
  if (clientId && !db.prepare('SELECT id FROM clients WHERE id=?').get(clientId)) return res.status(400).json({ error: 'Unknown client' });
  db.prepare(`INSERT INTO int_channel_links(channel_id, asana_project_gid, client_id, updated_ts) VALUES (?,?,?,?)
    ON CONFLICT(channel_id) DO UPDATE SET asana_project_gid=excluded.asana_project_gid, client_id=excluded.client_id, updated_ts=excluded.updated_ts`).run(req.params.id, gid, clientId, Date.now());
  audit(req, 'slack.channel_linked', `channel:${req.params.id}`, { gid, clientId });
  res.json({ ok: true });
});

module.exports = router;
