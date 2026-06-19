'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const TASK_SELECT = `SELECT t.*, a.name AS assignee_name, b.name AS assigner_name, c.name AS client_name
   FROM tasks t JOIN users a ON a.id = t.assignee_id JOIN users b ON b.id = t.assigned_by
   LEFT JOIN clients c ON c.id = t.client_id`;

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
  res.json({ task: withChecklist(getTask.get(create())) });
});

// My tasks.
router.get('/mine', requireAuth, (req, res) => res.json({ tasks: withChecklists(tasksForUser.all(req.user.id)) }));

// ADMIN: every task.
router.get('/all', requireAdmin, (_req, res) => res.json({ tasks: withChecklists(allTasks.all()) }));

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
  res.json({ task: withChecklist(getTask.get(task.id)) });
});

// ADMIN: delete task.
router.delete('/:id', requireAdmin, (req, res) => {
  deleteTask.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
