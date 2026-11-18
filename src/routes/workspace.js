'use strict';

// Asana write-back: /api/asana-tasks/... create, update and comment.

const express = require('express');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { requireAuth, hasAdminAccess } = require('../auth');
const { audit, requireOwner } = require('../v2/roles');
const asanaWrite = require('../v2/asanaWrite');

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

module.exports = { tasks };
