'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const listActive = db.prepare(`SELECT * FROM clients WHERE active = 1 ORDER BY name COLLATE NOCASE`);
const listAll = db.prepare(`SELECT * FROM clients ORDER BY active DESC, name COLLATE NOCASE`);
const getOne = db.prepare(`SELECT * FROM clients WHERE id = ?`);
const insertClient = db.prepare(
  `INSERT INTO clients (name, code, business_type, stage, notes, active, created_ts)
   VALUES (@name, @code, @business_type, @stage, @notes, 1, @created_ts)`
);
const updateClient = db.prepare(
  `UPDATE clients SET name=@name, code=@code, business_type=@business_type, stage=@stage, notes=@notes WHERE id=@id`
);
const setActive = db.prepare(`UPDATE clients SET active = ? WHERE id = ?`);

const STAGES = ['PROSPECT', 'INTERVIEWED', 'SIGNED'];
const cleanStage = (v, fallback) => (STAGES.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : fallback);

// Everyone can read the active client list (needed to label/assign tasks).
router.get('/', requireAuth, (_req, res) => res.json({ clients: listActive.all() }));

// ADMIN: full list incl. archived.
router.get('/all', requireAdmin, (_req, res) => res.json({ clients: listAll.all() }));

router.post('/', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const info = insertClient.run({
    name,
    code: String(req.body.code || '').slice(0, 20),
    business_type: String(req.body.business_type || '').slice(0, 100),
    stage: cleanStage(req.body.stage, 'PROSPECT'),
    notes: String(req.body.notes || '').slice(0, 500),
    created_ts: now().toMillis(),
  });
  res.json({ client: getOne.get(info.lastInsertRowid) });
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
  });
  res.json({ client: getOne.get(c.id) });
});

router.post('/:id/active', requireAdmin, (req, res) => {
  setActive.run(req.body.active ? 1 : 0, Number(req.params.id));
  res.json({ client: getOne.get(Number(req.params.id)) });
});

module.exports = router;
