'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');
const { notify } = require('../notify');
const { generateDueTasks } = require('../recurring');

const router = express.Router();

const TASK_SELECT = `SELECT t.*, a.name AS assignee_name, b.name AS assigner_name, c.name AS client_name, pc.name AS client_parent_name, pc.id AS client_parent_id
   FROM tasks t JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.assigned_by
   LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN clients pc ON pc.id = c.parent_id`;

const insertTask = db.prepare(
  `INSERT INTO tasks (title, description, assignee_id, assigned_by, priority, status, due_date, client_id, created_ts, updated_ts)
   VALUES (@title, @description, @assignee_id, @assigned_by, @priority, 'TODO', @due_date, @client_id, @ts, @ts)`
);
const getTask = db.prepare(`${TASK_SELECT} WHERE t.id = ?`);
const tasksForUser = db.prepare(
  `${TASK_SELECT} WHERE t.assignee_id = ? ORDER BY
     CASE t.status WHEN 'TODO' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
     (t.due_date = '') ASC, t.due_date ASC, t.created_ts DESC`
);
const allTasks = db.prepare(`${TASK_SELECT} ORDER BY t.updated_ts DESC LIMIT 500`);
const setStatus = db.prepare(`UPDATE tasks SET status = ?, updated_ts = ? WHERE id = ?`);
const updateTask = db.prepare(
  `UPDATE tasks SET title=@title, description=@description, assignee_id=@assignee_id,
   priority=@priority, due_date=@due_date, client_id=@client_id, updated_ts=@ts WHERE id=@id`
);
const deleteTask = db.prepare(`DELETE FROM tasks WHERE id = ?`);

const insertChecklistItem = db.prepare(
  `INSERT INTO task_checklist (task_id, text, position) VALUES (?, ?, ?)`
);
const checklistForTask = db.prepare(`SELECT id, text, done FROM task_checklist WHERE task_id = ? ORDER BY position, id`);
const getChecklistItem = db.prepare(`SELECT * FROM task_checklist WHERE id = ? AND task_id = ?`);
const setChecklistDone = db.prepare(`UPDATE task_checklist SET done = ? WHERE id = ?`);
const setChecklistText = db.prepare(`UPDATE task_checklist SET text = ? WHERE id = ?`);
const deleteChecklistItem = db.prepare(`DELETE FROM task_checklist WHERE id = ?`);
const nextChecklistPos = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM task_checklist WHERE task_id = ?`);
const countOpenItems = db.prepare(`SELECT COUNT(*) AS c FROM task_checklist WHERE task_id = ? AND done = 0`);

// The assignee or an admin may manage a task's checklist.
function loadManageableTask(req, res) {
  const task = getTask.get(Number(req.params.id));
  if (!task) { res.status(404).json({ error: 'Not found' }); return null; }
  if (req.user.role !== 'ADMIN' && task.assignee_id !== req.user.id) {
    res.status(403).json({ error: 'Not your task' }); return null;
  }
  return task;
}

const PRI = ['LOW', 'MEDIUM', 'HIGH'];
const STATUS = ['TODO', 'IN_PROGRESS', 'DONE'];

// Normalise a checklist payload (array of strings, or newline text) to clean lines.
function parseChecklist(input) {
  let lines = [];
  if (Array.isArray(input)) lines = input;
  else if (typeof input === 'string') lines = input.split('\n');
  return lines.map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
}

// Add the checklist array (of item rows) onto each task object.
function withChecklist(task) {
  if (task) task.checklist = checklistForTask.all(task.id);
  return task;
}
function withChecklists(tasks) {
  for (const t of tasks) t.checklist = checklistForTask.all(t.id);
  return tasks;
}

// Create a task. Admins can assign to anyone; employees create for
// themselves and must tie it to a client (no "random" tasks).
router.post('/', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const admin = req.user.role === 'ADMIN';
  const assignee_id = admin ? Number(req.body.assignee_id) : req.user.id;
  if (!assignee_id) return res.status(400).json({ error: 'Assignee is required' });
  const client_id = req.body.client_id ? Number(req.body.client_id) : null;
  if (!admin && !client_id) return res.status(400).json({ error: 'Please choose a client for your task' });
  const priority = PRI.includes(String(req.body.priority || '').toUpperCase()) ? String(req.body.priority).toUpperCase() : 'MEDIUM';
  const checklist = parseChecklist(req.body.checklist);
  const create = db.transaction(() => {
    const info = insertTask.run({
      title,
      description: String(req.body.description || '').slice(0, 2000),
      assignee_id,
      assigned_by: req.user.id,
      priority,
      due_date: String(req.body.due_date || ''),
      client_id,
      ts: now().toMillis(),
    });
    checklist.forEach((text, i) => insertChecklistItem.run(info.lastInsertRowid, text, i));
    return info.lastInsertRowid;
  });
  const created = getTask.get(create());
  // Tell the assignee (unless they created it for themselves).
  if (created.assignee_id !== req.user.id) {
    notify(created.assignee_id, { type: 'TASK', title: 'New task assigned', body: `${req.user.name} assigned you "${created.title}".`, link: 'tasks' });
  }
  res.json({ task: withChecklist(created) });
});

// My tasks.
router.get('/mine', requireAuth, (req, res) => res.json({ tasks: withChecklists(tasksForUser.all(req.user.id)) }));

// ADMIN: every task.
// The whole-team board. Read-only for employees (mutations below stay guarded:
// edit/delete/reassign are admin-only; status changes require admin or assignee).
router.get('/all', requireAuth, (_req, res) => res.json({ tasks: withChecklists(allTasks.all()) }));

// ADMIN: bulk-import a task list for one client (e.g. from a spreadsheet).
// Frequency Weekly/Monthly/Quarterly/Yearly -> a recurring schedule; Daily,
// "As needed", one-time or blank -> a single task. Owner is matched to a user
// by name, falling back to the chosen default assignee.
const findClientByName = db.prepare(`SELECT id FROM clients WHERE LOWER(name) = LOWER(?) LIMIT 1`);
const insertClientBulk = db.prepare(
  `INSERT INTO clients (name, approval, created_by, active, created_ts) VALUES (?, 'APPROVED', ?, 1, ?)`
);
const clientExists = db.prepare(`SELECT 1 FROM clients WHERE id = ?`);
const activeUserExists = db.prepare(`SELECT 1 FROM users WHERE id = ? AND active = 1`);
const activeUsersForMatch = db.prepare(`SELECT id, name FROM users WHERE active = 1`);
const insertRecurringBulk = db.prepare(
  `INSERT INTO recurring_tasks (title, description, client_id, assignee_id, priority, frequency, step, lead_days, next_due, checklist_json, active, created_by, created_ts)
   VALUES (@title, @description, @client_id, @assignee_id, @priority, @frequency, 1, 0, @next_due, '', 1, @created_by, @ts)`
);
const RECURRING_FREQ = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

router.post('/bulk', requireAdmin, (req, res) => {
  // Resolve the client: an existing id, or a name (reused if it exists, else created).
  let clientId = req.body.client_id ? Number(req.body.client_id) : null;
  const clientName = String(req.body.client_name || '').trim();
  if (!clientId && clientName) {
    const existing = findClientByName.get(clientName);
    clientId = existing ? existing.id : insertClientBulk.run(clientName.slice(0, 120), req.user.id, now().toMillis()).lastInsertRowid;
  }
  if (clientId && !clientExists.get(clientId)) return res.status(400).json({ error: 'Unknown client' });
  if (!clientId) return res.status(400).json({ error: 'Pick or name a client' });

  const defaultAssignee = Number(req.body.default_assignee_id);
  if (!defaultAssignee || !activeUserExists.get(defaultAssignee)) return res.status(400).json({ error: 'A valid default assignee is required' });

  const items = (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 500);
  if (!items.length) return res.status(400).json({ error: 'No tasks to import' });

  const users = activeUsersForMatch.all();
  const matchOwner = (name) => {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return defaultAssignee;
    const u = users.find((x) => x.name.toLowerCase() === n)
      || users.find((x) => x.name.toLowerCase().split(' ')[0] === n || x.name.toLowerCase().startsWith(n));
    return u ? u.id : defaultAssignee;
  };
  const today = now().toFormat('yyyy-LL-dd');
  let schedules = 0; let tasks = 0; const skipped = [];

  const run = db.transaction(() => {
    for (const it of items) {
      const title = String(it.title || '').trim().slice(0, 200);
      if (!title) continue;
      const freq = String(it.frequency || '').trim().toUpperCase();
      const priority = PRI.includes(String(it.priority || '').toUpperCase()) ? String(it.priority).toUpperCase() : 'MEDIUM';
      const assignee = matchOwner(it.owner);
      const baseDesc = String(it.description || it.details || '').slice(0, 2000);
      if (RECURRING_FREQ.includes(freq)) {
        insertRecurringBulk.run({ title, description: baseDesc, client_id: clientId, assignee_id: assignee, priority, frequency: freq, next_due: today, created_by: req.user.id, ts: now().toMillis() });
        schedules += 1;
      } else {
        // Daily / As-needed / blank -> one-time task; keep the cadence label in the description.
        const label = freq && freq !== 'ONE-TIME' ? `[${cap(freq.toLowerCase())}] ` : '';
        insertTask.run({ title, description: (label + baseDesc).slice(0, 2000), assignee_id: assignee, assigned_by: req.user.id, priority, due_date: '', client_id: clientId, ts: now().toMillis() });
        tasks += 1;
      }
    }
  });
  run();
  if (schedules) { try { generateDueTasks(); } catch (_e) { /* first instances will still generate on the next scheduler run */ } }
  res.json({ ok: true, client_id: clientId, schedulesCreated: schedules, tasksCreated: tasks, skipped });
});

// ADMIN: persist a manual ordering (drag-and-drop within a client group).
// Body: { ids: [taskId, ...] } in the desired display order.
const setSortOrder = db.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ?`);
router.post('/reorder', requireAdmin, (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean).slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const apply = db.transaction(() => { ids.forEach((id, i) => setSortOrder.run(i, id)); });
  apply();
  res.json({ ok: true });
});

// Assignee (or admin) adds a checklist item to an existing task.
router.post('/:id/checklist', requireAuth, (req, res) => {
  const task = loadManageableTask(req, res); if (!task) return;
  const text = String(req.body.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'Item text is required' });
  insertChecklistItem.run(task.id, text, nextChecklistPos.get(task.id).p);
  res.json({ task: withChecklist(getTask.get(task.id)) });
});

// Assignee (or admin) ticks/unticks or renames a checklist item.
router.post('/:id/checklist/:itemId', requireAuth, (req, res) => {
  const task = loadManageableTask(req, res); if (!task) return;
  const item = getChecklistItem.get(Number(req.params.itemId), task.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  if (req.body.text !== undefined) {
    const text = String(req.body.text).trim().slice(0, 200);
    if (text) setChecklistText.run(text, item.id);
  }
  if (req.body.done !== undefined) setChecklistDone.run(req.body.done ? 1 : 0, item.id);
  res.json({ task: withChecklist(getTask.get(task.id)) });
});

// Assignee (or admin) removes a checklist item.
router.delete('/:id/checklist/:itemId', requireAuth, (req, res) => {
  const task = loadManageableTask(req, res); if (!task) return;
  const item = getChecklistItem.get(Number(req.params.itemId), task.id);
  if (!item) return res.status(404).json({ error: 'Checklist item not found' });
  deleteChecklistItem.run(item.id);
  res.json({ task: withChecklist(getTask.get(task.id)) });
});

// Assignee (or admin) updates status. Can't mark DONE with open checklist items.
router.post('/:id/status', requireAuth, (req, res) => {
  const status = String(req.body.status || '').toUpperCase();
  if (!STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const task = getTask.get(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'ADMIN' && task.assignee_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your task' });
  }
  if (status === 'DONE' && countOpenItems.get(task.id).c > 0) {
    return res.status(409).json({ error: 'Complete every checklist item before marking this task done.' });
  }
  setStatus.run(status, now().toMillis(), task.id);
  res.json({ task: withChecklist(getTask.get(task.id)) });
});

// ADMIN: edit task.
router.put('/:id', requireAdmin, (req, res) => {
  const task = getTask.get(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  updateTask.run({
    id: task.id,
    title: String(req.body.title ?? task.title),
    description: String(req.body.description ?? task.description),
    assignee_id: Number(req.body.assignee_id ?? task.assignee_id),
    priority: PRI.includes(String(req.body.priority || '').toUpperCase()) ? String(req.body.priority).toUpperCase() : task.priority,
    due_date: String(req.body.due_date ?? task.due_date),
    client_id: req.body.client_id === undefined ? task.client_id : (req.body.client_id ? Number(req.body.client_id) : null),
    ts: now().toMillis(),
  });
  if (req.body.checklist !== undefined) {
    db.prepare('DELETE FROM task_checklist WHERE task_id = ?').run(task.id);
    parseChecklist(req.body.checklist).forEach((text, i) => insertChecklistItem.run(task.id, text, i));
  }
  const updated = getTask.get(task.id);
  // Notify on a genuine reassignment to someone other than the editing admin.
  if (updated.assignee_id !== task.assignee_id && updated.assignee_id !== req.user.id) {
    notify(updated.assignee_id, { type: 'TASK', title: 'Task assigned to you', body: `${req.user.name} assigned you "${updated.title}".`, link: 'tasks' });
  }
  res.json({ task: withChecklist(updated) });
});

// ADMIN: delete task.
router.delete('/:id', requireAdmin, (req, res) => {
  deleteTask.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
