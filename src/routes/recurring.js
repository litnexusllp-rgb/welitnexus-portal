'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');
const { generateDueTasks } = require('../recurring');

const router = express.Router();

const FREQ = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
const PRI = ['LOW', 'MEDIUM', 'HIGH'];

const SELECT = `SELECT r.*, u.name AS assignee_name, c.name AS client_name
   FROM recurring_tasks r
   JOIN users u ON u.id = r.assignee_id
   LEFT JOIN clients c ON c.id = r.client_id`;
const listAll = db.prepare(`${SELECT} ORDER BY r.active DESC, c.name COLLATE NOCASE, r.next_due`);
const listMine = db.prepare(`${SELECT} WHERE r.created_by = ? ORDER BY r.active DESC, r.next_due`);
const getOne = db.prepare(`SELECT * FROM recurring_tasks WHERE id = ?`);

// Admins see/return all schedules; employees only their own.
const listFor = (req) => (req.user.role === 'ADMIN' ? listAll.all() : listMine.all(req.user.id));
const canManage = (req, rec) => req.user.role === 'ADMIN' || rec.created_by === req.user.id;
const insertRec = db.prepare(
  `INSERT INTO recurring_tasks (title, description, client_id, assignee_id, priority, frequency, step, lead_days, next_due, checklist_json, active, created_by, created_ts)
   VALUES (@title, @description, @client_id, @assignee_id, @priority, @frequency, @step, @lead_days, @next_due, @checklist_json, 1, @created_by, @created_ts)`
);
const updateRec = db.prepare(
  `UPDATE recurring_tasks SET title=@title, description=@description, client_id=@client_id, assignee_id=@assignee_id,
   priority=@priority, frequency=@frequency, step=@step, lead_days=@lead_days, next_due=@next_due, checklist_json=@checklist_json WHERE id=@id`
);
const setActive = db.prepare(`UPDATE recurring_tasks SET active = ? WHERE id = ?`);
const delRec = db.prepare(`DELETE FROM recurring_tasks WHERE id = ?`);

function clean(body, existing) {
  return {
    title: String(body.title ?? existing?.title ?? '').trim(),
    description: String(body.description ?? existing?.description ?? '').slice(0, 2000),
    client_id: body.client_id === undefined
      ? (existing?.client_id ?? null)
      : (body.client_id ? Number(body.client_id) : null),
    assignee_id: Number(body.assignee_id ?? existing?.assignee_id),
    priority: PRI.includes(String(body.priority || '').toUpperCase()) ? String(body.priority).toUpperCase() : (existing?.priority || 'MEDIUM'),
    frequency: FREQ.includes(String(body.frequency || '').toUpperCase()) ? String(body.frequency).toUpperCase() : (existing?.frequency || 'MONTHLY'),
    step: Math.max(1, Number(body.step ?? existing?.step ?? 1)),
    lead_days: Math.max(0, Number(body.lead_days ?? existing?.lead_days ?? 7)),
    next_due: String(body.next_due ?? existing?.next_due ?? ''),
    checklist_json: body.checklist !== undefined ? JSON.stringify(parseChecklistLines(body.checklist)) : (existing?.checklist_json ?? ''),
  };
}

// Normalise a checklist payload (array or newline text) to clean lines.
function parseChecklistLines(input) {
  let lines = [];
  if (Array.isArray(input)) lines = input;
  else if (typeof input === 'string') lines = input.split('\n');
  return lines.map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
}

// ADMIN: all schedules. Employees use /mine.
router.get('/', requireAdmin, (_req, res) => res.json({ recurring: listAll.all() }));
router.get('/mine', requireAuth, (req, res) => res.json({ recurring: listMine.all(req.user.id) }));

// Create a schedule. Admins assign to anyone; employees create for
// themselves and must pick a client.
router.post('/', requireAuth, (req, res) => {
  const admin = req.user.role === 'ADMIN';
  const r = clean(req.body);
  if (!admin) {
    r.assignee_id = req.user.id;
    if (!r.client_id) return res.status(400).json({ error: 'Please choose a client' });
  }
  if (!r.title || !r.assignee_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.next_due)) {
    return res.status(400).json({ error: 'Title, client, and a valid first due date are required' });
  }
  insertRec.run({ ...r, created_by: req.user.id, created_ts: now().toMillis() });
  generateDueTasks(); // create the first instance immediately if it's already due
  res.json({ recurring: listFor(req) });
});

router.put('/:id', requireAuth, (req, res) => {
  const existing = getOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, existing)) return res.status(403).json({ error: 'Not your schedule' });
  const patch = clean(req.body, existing);
  if (req.user.role !== 'ADMIN') patch.assignee_id = existing.assignee_id; // employees can't reassign
  updateRec.run({ id: existing.id, ...patch });
  res.json({ recurring: listFor(req) });
});

router.post('/:id/active', requireAuth, (req, res) => {
  const existing = getOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, existing)) return res.status(403).json({ error: 'Not your schedule' });
  setActive.run(req.body.active ? 1 : 0, existing.id);
  res.json({ recurring: listFor(req) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const existing = getOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!canManage(req, existing)) return res.status(403).json({ error: 'Not your schedule' });
  delRec.run(existing.id); // generated tasks are kept
  res.json({ recurring: listFor(req) });
});

// Manually trigger generation now (useful after adding several schedules).
router.post('/run', requireAdmin, (_req, res) => {
  const created = generateDueTasks();
  res.json({ created, recurring: listAll.all() });
});

module.exports = router;
