'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now } = require('../time');
const { generateDueTasks } = require('../recurring');

const router = express.Router();

const FREQ = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'];
const PRI = ['LOW', 'MEDIUM', 'HIGH'];

const listAll = db.prepare(
  `SELECT r.*, u.name AS assignee_name, c.name AS client_name
   FROM recurring_tasks r
   JOIN users u ON u.id = r.assignee_id
   LEFT JOIN clients c ON c.id = r.client_id
   ORDER BY r.active DESC, c.name COLLATE NOCASE, r.next_due`
);
const getOne = db.prepare(`SELECT * FROM recurring_tasks WHERE id = ?`);
const insertRec = db.prepare(
  `INSERT INTO recurring_tasks (title, description, client_id, assignee_id, priority, frequency, step, lead_days, next_due, active, created_by, created_ts)
   VALUES (@title, @description, @client_id, @assignee_id, @priority, @frequency, @step, @lead_days, @next_due, 1, @created_by, @created_ts)`
);
const updateRec = db.prepare(
  `UPDATE recurring_tasks SET title=@title, description=@description, client_id=@client_id, assignee_id=@assignee_id,
   priority=@priority, frequency=@frequency, step=@step, lead_days=@lead_days, next_due=@next_due WHERE id=@id`
);
const setActive = db.prepare(`UPDATE recurring_tasks SET active = ? WHERE id = ?`);
const delRec = db.prepare(`DELETE FROM recurring_tasks WHERE id = ?`);

function clean(body, existing) {
  return {
    title: String(body.title ?? existing?.title ?? '').trim(),
    description: String(body.description ?? existing?.description ?? '').slice(0, 2000),
    client_id: body.client_id ? Number(body.client_id) : (existing?.client_id ?? null),
    assignee_id: Number(body.assignee_id ?? existing?.assignee_id),
    priority: PRI.includes(String(body.priority || '').toUpperCase()) ? String(body.priority).toUpperCase() : (existing?.priority || 'MEDIUM'),
    frequency: FREQ.includes(String(body.frequency || '').toUpperCase()) ? String(body.frequency).toUpperCase() : (existing?.frequency || 'MONTHLY'),
    step: Math.max(1, Number(body.step ?? existing?.step ?? 1)),
    lead_days: Math.max(0, Number(body.lead_days ?? existing?.lead_days ?? 7)),
    next_due: String(body.next_due ?? existing?.next_due ?? ''),
  };
}

router.get('/', requireAdmin, (_req, res) => res.json({ recurring: listAll.all() }));

router.post('/', requireAdmin, (req, res) => {
  const r = clean(req.body);
  if (!r.title || !r.assignee_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.next_due)) {
    return res.status(400).json({ error: 'Title, assignee, and a valid first due date are required' });
  }
  insertRec.run({ ...r, created_by: req.user.id, created_ts: now().toMillis() });
  generateDueTasks(); // create the first instance immediately if it's already due
  res.json({ recurring: listAll.all() });
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = getOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  updateRec.run({ id: existing.id, ...clean(req.body, existing) });
  res.json({ recurring: listAll.all() });
});

router.post('/:id/active', requireAdmin, (req, res) => {
  setActive.run(req.body.active ? 1 : 0, Number(req.params.id));
  res.json({ recurring: listAll.all() });
});

router.delete('/:id', requireAdmin, (req, res) => {
  delRec.run(Number(req.params.id)); // generated tasks are kept
  res.json({ recurring: listAll.all() });
});

// Manually trigger generation now (useful after adding several schedules).
router.post('/run', requireAdmin, (_req, res) => {
  const created = generateDueTasks();
  res.json({ created, recurring: listAll.all() });
});

module.exports = router;
