'use strict';

// Asana write-back. Asana stays the source of truth for tasks; the portal can
// now create tasks, complete them, change
// due dates and comment. Uses the existing ASANA_TOKEN / ASANA_PROJECT_GID.

const crypto = require('node:crypto');
const { db } = require('../db');

const { API, cfg, enabled } = require('../asana');

async function request(method, path, data, timeoutMs = 15000) {
  if (!enabled())
    throw Object.assign(new Error('Asana is not connected. Add ASANA_TOKEN and ASANA_PROJECT_GID in Railway.'), {
      status: 503,
    });
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg().token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: data ? JSON.stringify({ data }) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error('Asana: ' + (body.errors?.[0]?.message || `HTTP ${res.status}`)), {
      status: res.status === 404 ? 404 : 502,
    });
  return body.data;
}

const userRow = db.prepare('SELECT id, name, email, asana_email FROM users WHERE id=? AND active=1');

// Asana accepts an email address as the assignee.
function assigneeFor(userId) {
  if (!userId) return undefined;
  const u = userRow.get(Number(userId));
  if (!u) throw Object.assign(new Error('Assignee must be an active employee'), { status: 400 });
  return u.asana_email || u.email;
}

const isoDay = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

async function createTask({ name, notes, assigneeId, dueOn, projectGid }) {
  const title = String(name || '')
    .trim()
    .slice(0, 500);
  if (!title) throw Object.assign(new Error('Give the task a name'), { status: 400 });
  const task = await request('POST', '/tasks?opt_fields=name,permalink_url,due_on,assignee.name', {
    name: title,
    notes: String(notes || '').slice(0, 10000),
    projects: [projectGid || cfg().project],
    assignee: assigneeFor(assigneeId),
    due_on: isoDay(dueOn),
  });
  return {
    gid: task.gid,
    name: task.name,
    url: task.permalink_url,
    due_on: task.due_on,
    assignee: task.assignee?.name || null,
  };
}

async function updateTask(gid, { completed, dueOn, assigneeId }) {
  if (!/^\d+$/.test(String(gid))) throw Object.assign(new Error('Invalid task'), { status: 400 });
  const data = {};
  if (completed !== undefined) data.completed = Boolean(completed);
  if (dueOn !== undefined) data.due_on = isoDay(dueOn) || null;
  if (assigneeId !== undefined) data.assignee = assigneeId ? assigneeFor(assigneeId) : null;
  const t = await request('PUT', `/tasks/${gid}?opt_fields=name,completed,due_on,permalink_url,assignee.name`, data);
  return {
    gid: t.gid,
    name: t.name,
    completed: t.completed,
    due_on: t.due_on,
    url: t.permalink_url,
    assignee: t.assignee?.name || null,
  };
}

async function comment(gid, text, author) {
  if (!/^\d+$/.test(String(gid))) throw Object.assign(new Error('Invalid task'), { status: 400 });
  const body = String(text || '')
    .trim()
    .slice(0, 5000);
  if (!body) throw Object.assign(new Error('Write a comment first'), { status: 400 });
  const story = await request('POST', `/tasks/${gid}/stories`, { text: `${body}\n— ${author} (via portal)` });
  return { gid: story.gid };
}

// Ask Asana to call the portal whenever the project changes.
const createWebhook = (target) => request('POST', '/webhooks', { resource: cfg().project, target }, 30000);

// Asana webhooks: first request carries X-Hook-Secret (handshake); later ones are signed.
function webhookSecret() {
  const row = db.prepare("SELECT value FROM int_settings WHERE key='asana_webhook_secret'").get();
  return row ? require('./crypto').decrypt(row.value) : '';
}
function saveWebhookSecret(secret) {
  db.prepare(
    "INSERT INTO int_settings(key,value,updated_ts) VALUES ('asana_webhook_secret',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts",
  ).run(require('./crypto').encrypt(secret), Date.now());
}
function verifyWebhook(rawBody, signature) {
  const secret = webhookSecret();
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return require('./crypto').safeEqual(expected, signature);
}

module.exports = {
  enabled,
  createTask,
  updateTask,
  comment,
  createWebhook,
  verifyWebhook,
  saveWebhookSecret,
};
