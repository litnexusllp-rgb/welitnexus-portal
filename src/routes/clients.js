'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

// Order clients so a parent is followed by its sub-clients (same "family").
const FAMILY_ORDER = `ORDER BY COALESCE(p.name, c.name) COLLATE NOCASE, (c.parent_id IS NOT NULL), c.name COLLATE NOCASE`;
// Dropdown source: only approved + active clients are usable for tasks.
const listActive = db.prepare(
  `SELECT c.*, p.name AS parent_name FROM clients c LEFT JOIN clients p ON p.id = c.parent_id
   WHERE c.active = 1 AND c.approval = 'APPROVED' ${FAMILY_ORDER}`
);
const listAll = db.prepare(
  `SELECT c.*, u.name AS created_by_name, p.name AS parent_name
   FROM clients c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN clients p ON p.id = c.parent_id
   ORDER BY (c.approval = 'PENDING') DESC, c.active DESC, COALESCE(p.name, c.name) COLLATE NOCASE, (c.parent_id IS NOT NULL), c.name COLLATE NOCASE`
);
const listPending = db.prepare(
  `SELECT c.*, u.name AS created_by_name, p.name AS parent_name
   FROM clients c LEFT JOIN users u ON u.id = c.created_by LEFT JOIN clients p ON p.id = c.parent_id
   WHERE c.approval = 'PENDING' ORDER BY c.created_ts ASC`
);
const getOne = db.prepare(`SELECT * FROM clients WHERE id = ?`);
const insertClient = db.prepare(
  `INSERT INTO clients (name, code, business_type, stage, notes, approval, created_by, parent_id, active, created_ts)
   VALUES (@name, @code, @business_type, @stage, @notes, @approval, @created_by, @parent_id, 1, @created_ts)`
);
const updateClient = db.prepare(
  `UPDATE clients SET name=@name, code=@code, business_type=@business_type, stage=@stage, notes=@notes, parent_id=@parent_id WHERE id=@id`
);
const setActive = db.prepare(`UPDATE clients SET active = ? WHERE id = ?`);
const setApproval = db.prepare(`UPDATE clients SET approval = ? WHERE id = ?`);

const STAGES = ['PROSPECT', 'INTERVIEWED', 'SIGNED'];
const cleanStage = (v, fallback) => (STAGES.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : fallback);

// Resolve a parent_id from the request. Must be an existing top-level client
// (no grandparents — keep the hierarchy two levels) and not the client itself.
function resolveParent(rawParent, selfId) {
  if (!rawParent) return null;
  const pid = Number(rawParent);
  if (!pid || pid === selfId) return null;
  const parent = getOne.get(pid);
  if (!parent || parent.parent_id) return null; // missing, or itself a sub-client
  return pid;
}

// Everyone can read the usable (approved) client list — needed to label/assign tasks.
router.get('/', requireAuth, (_req, res) => res.json({ clients: listActive.all() }));

// ADMIN: full list incl. archived + pending.
router.get('/all', requireAdmin, (_req, res) => res.json({ clients: listAll.all() }));

// ADMIN: clients awaiting approval (proposed by employees).
router.get('/pending', requireAdmin, (_req, res) => res.json({ clients: listPending.all() }));

// Create a client. Admins create it approved; employees propose it (pending).
router.post('/', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const admin = req.user.role === 'ADMIN';
  const info = insertClient.run({
    name,
    code: String(req.body.code || '').slice(0, 20),
    business_type: String(req.body.business_type || '').slice(0, 100),
    stage: cleanStage(req.body.stage, 'PROSPECT'),
    notes: String(req.body.notes || '').slice(0, 500),
    approval: admin ? 'APPROVED' : 'PENDING',
    created_by: req.user.id,
    parent_id: resolveParent(req.body.parent_id, null),
    created_ts: now().toMillis(),
  });
  res.json({ client: getOne.get(info.lastInsertRowid), pending: !admin });
});

// ADMIN: approve or reject a proposed client.
router.post('/:id/approval', requireAdmin, (req, res) => {
  const decision = String(req.body.decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: 'decision must be APPROVED or REJECTED' });
  const c = getOne.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  setApproval.run(decision, c.id);
  res.json({ client: getOne.get(c.id) });
});

router.put('/:id', requireAdmin, (req, res) => {
  const c = getOne.get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  updateClient.run({
    id: c.id,
    name: String(req.body.name ?? c.name),
    code: String(req.body.code ?? c.code),
    business_type: String(req.body.business_type ?? c.business_type ?? '').slice(0, 100),
    stage: cleanStage(req.body.stage, c.stage || 'PROSPECT'),
    notes: String(req.body.notes ?? c.notes),
    parent_id: req.body.parent_id === undefined ? c.parent_id : resolveParent(req.body.parent_id, c.id),
  });
  res.json({ client: getOne.get(c.id) });
});

router.post('/:id/active', requireAdmin, (req, res) => {
  setActive.run(req.body.active ? 1 : 0, Number(req.params.id));
  res.json({ client: getOne.get(Number(req.params.id)) });
});

module.exports = router;
