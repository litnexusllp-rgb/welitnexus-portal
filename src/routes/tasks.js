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

const PRI = ['LOW', 'MEDIUM', 'HIGH'];
const STATUS = ['TODO', 'IN_PROGRESS', 'DONE'];

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
  res.json({ task: getTask.get(info.lastInsertRowid) });
});

// My tasks.
router.get('/mine', requireAuth, (req, res) => res.json({ tasks: tasksForUser.all(req.user.id) }));

// ADMIN: every task.
router.get('/all', requireAdmin, (_req, res) => res.json({ tasks: allTasks.all() }));

// Assignee (or admin) updates status.
router.post('/:id/status', requireAuth, (req, res) => {
  const status = String(req.body.status || '').toUpperCase();
  if (!STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const task = getTask.get(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'ADMIN' && task.assignee_id !== req.user.id) {
    return res.status(403).json({ error: 'Not your task' });
  }
  setStatus.run(status, now().toMillis(), task.id);
  res.json({ task: getTask.get(task.id) });
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
  res.json({ task: getTask.get(task.id) });
});

// ADMIN: delete task.
router.delete('/:id', requireAdmin, (req, res) => {
  deleteTask.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
