'use strict';

// Asana write-back and the AI assistant.
//   /api/asana-tasks/...   create / update / comment / from Slack message
//   /api/ai/...            Claude or ChatGPT, permission-aware context

const express = require('express');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { requireAuth, hasAdminAccess } = require('../auth');
const { audit, requireOwner, adminLevel } = require('../v2/roles');
const asanaWrite = require('../v2/asanaWrite');
const slack = require('../v2/slack');
const ai = require('../v2/ai');

const tasks = express.Router();
tasks.use(requireAuth);

// The portal talks to Asana with one shared token that can reach every task,
// so the portal itself must decide who may change what. Admins may act on any
// task; everyone else only on tasks assigned to them in the portal's project.
async function assertCanChangeTask(req, gid) {
  if (!/^\d+$/.test(String(gid))) throw Object.assign(new Error('Invalid task'), { status: 400 });
  if (hasAdminAccess(req)) return;
  if (!asanaWrite.enabled()) throw Object.assign(new Error('Asana is not connected.'), { status: 503 });
  let mine = false;
  try {
    mine = await require('../asana').isAssignedTo(req.user.id, gid);
  } catch (_e) {
    throw Object.assign(new Error('Could not check this task with Asana. Please try again shortly.'), { status: 502 });
  }
  if (!mine) {
    audit(req, 'asana.task_change_refused', `asana:${gid}`);
    throw Object.assign(new Error('You can only change tasks that are assigned to you'), { status: 403 });
  }
}

tasks.get('/status', (_req, res) => res.json({ enabled: asanaWrite.enabled() }));

tasks.post(
  '/',
  asyncRoute(async (req, res) => {
    const t = await asanaWrite.createTask({
      name: req.body.name,
      notes: req.body.notes,
      assigneeId: req.body.assignee_id || req.user.id,
      dueOn: req.body.due_date,
      // Only admins may file a task into a project other than the portal's own.
      projectGid: hasAdminAccess(req) ? req.body.project_gid : undefined,
    });
    audit(req, 'asana.task_created', `asana:${t.gid}`, { name: t.name });
    require('../asana')
      .allTasks(true)
      .catch(() => {});
    res.json({ task: t });
  }),
);

tasks.post(
  '/:gid/update',
  asyncRoute(async (req, res) => {
    await assertCanChangeTask(req, req.params.gid);
    const t = await asanaWrite.updateTask(req.params.gid, {
      completed: req.body.completed,
      dueOn: req.body.due_date,
      // Reassigning a task to someone else is an admin action.
      assigneeId: hasAdminAccess(req) ? req.body.assignee_id : undefined,
    });
    audit(req, 'asana.task_updated', `asana:${t.gid}`, { completed: t.completed, due_on: t.due_on });
    require('../asana')
      .allTasks(true)
      .catch(() => {});
    res.json({ task: t });
  }),
);

tasks.post(
  '/:gid/comments',
  asyncRoute(async (req, res) => {
    await assertCanChangeTask(req, req.params.gid);
    res.json(await asanaWrite.comment(req.params.gid, req.body.text, req.user.name));
  }),
);

// Turn a Slack message into an Asana task, and post the link back in the thread.
tasks.post(
  '/from-message',
  asyncRoute(async (req, res) => {
    const channel = String(req.body.channel || ''),
      ts = String(req.body.ts || '');
    if (!/^[CG][A-Z0-9]{6,}$/.test(channel) || !/^\d{10}\.\d{6}$/.test(ts))
      return res.status(400).json({ error: 'Invalid message' });
    await slack.assertMember(req.user, channel);
    const cached = db.prepare('SELECT text FROM int_messages WHERE channel_id=? AND ts=?').get(channel, ts);
    let permalink = '';
    try {
      permalink = (await slack.call('chat.getPermalink', { channel, message_ts: ts }, { json: false })).permalink;
    } catch (_e) {
      /* optional */
    }
    const t = await asanaWrite.createTask({
      name: req.body.name || (cached?.text || 'Follow up').split('\n')[0].slice(0, 120),
      notes: `${cached?.text || ''}\n\nFrom Slack: ${permalink}`.trim(),
      assigneeId: req.body.assignee_id || req.user.id,
      dueOn: req.body.due_date,
      projectGid: asanaWrite.projectForChannel(channel),
    });
    try {
      await slack.post(
        req.user,
        channel,
        `Created Asana task: <${t.url}|${t.name}>${t.due_on ? ` · due ${t.due_on}` : ''}`,
        ts,
      );
    } catch (_e) {
      /* task still created */
    }
    audit(req, 'asana.task_from_message', `asana:${t.gid}`, { channel, ts });
    res.json({ task: t });
  }),
);

// OWNER: register an Asana webhook so changes appear in the portal immediately.
tasks.post(
  '/webhook/setup',
  requireOwner,
  asyncRoute(async (req, res) => {
    const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return res.status(400).json({ error: 'Set PUBLIC_BASE_URL in Railway first' });
    if (!asanaWrite.enabled()) return res.status(503).json({ error: 'Asana is not connected' });
    db.prepare(
      "INSERT INTO int_settings(key,value,updated_ts) VALUES ('asana_webhook_pending','1',?) ON CONFLICT(key) DO UPDATE SET updated_ts=excluded.updated_ts",
    ).run(Date.now());
    const hook = await asanaWrite.createWebhook(`${base}/api/hooks/asana`);
    audit(req, 'asana.webhook_created', `asana:${hook?.gid}`);
    res.json({ ok: true, gid: hook?.gid });
  }),
);

// ---------- AI ----------
const aiRouter = express.Router();
aiRouter.use(requireAuth);

aiRouter.get('/providers', (_req, res) => res.json({ providers: ai.available(), default: ai.defaultProvider() }));

async function contextFor(req, ctx = {}) {
  if (ctx.channel) {
    const h = await slack.history(req.user, String(ctx.channel), {
      thread: ctx.thread_ts ? String(ctx.thread_ts) : undefined,
    });
    return h.messages
      .slice(-60)
      .map(
        (m) => `${m.user_name}: ${m.text}${m.files.length ? ` [files: ${m.files.map((f) => f.name).join(', ')}]` : ''}`,
      )
      .join('\n');
  }
  if (ctx.invoice_id) {
    if (!adminLevel(req.user) || !req.adminConsole)
      throw Object.assign(new Error('Admin console access required'), { status: 403 });
    const lines = db
      .prepare('SELECT description, quantity FROM int_invoice_lines WHERE invoice_id=? ORDER BY position')
      .all(Number(ctx.invoice_id));
    const client = db
      .prepare('SELECT c.name FROM int_invoices i JOIN clients c ON c.id=i.client_id WHERE i.id=?')
      .get(Number(ctx.invoice_id));
    return `Client: ${client?.name || ''}\n` + lines.map((l) => `- ${l.description} (qty ${l.quantity})`).join('\n');
  }
  return '';
}

aiRouter.post(
  '/complete',
  asyncRoute(async (req, res) => {
    const context = await contextFor(req, req.body.context || {});
    const out = await ai.complete({
      user: req.user,
      provider: req.body.provider,
      action: String(req.body.action || ''),
      context,
      prompt: req.body.prompt,
    });
    res.json(out);
  }),
);

module.exports = { tasks, ai: aiRouter };
