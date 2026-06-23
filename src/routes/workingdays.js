'use strict';

// Admin-managed weekend dates the firm treats as working (e.g. the 1st
// Saturday). These override the default Sat/Sun = weekend rule in reports.

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const listBetween = db.prepare(`SELECT * FROM working_days WHERE date >= ? AND date <= ? ORDER BY date`);
const listAll = db.prepare(`SELECT * FROM working_days ORDER BY date`);
const upsert = db.prepare(
  `INSERT INTO working_days (date, note, created_by, created_ts) VALUES (@date, @note, @created_by, @created_ts)
   ON CONFLICT(date) DO UPDATE SET note = excluded.note`
);
const remove = db.prepare(`DELETE FROM working_days WHERE id = ?`);

router.get('/', requireAdmin, (req, res) => {
  const { start, end } = req.query;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(start)) && /^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
    return res.json({ workingDays: listBetween.all(String(start), String(end)) });
  }
  res.json({ workingDays: listAll.all() });
});

router.post('/', requireAdmin, (req, res) => {
  const date = String(req.body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Valid date (yyyy-mm-dd) required' });
  upsert.run({ date, note: String(req.body.note || '').slice(0, 120), created_by: req.user.id, created_ts: now().toMillis() });
  res.json({ ok: true });
});

router.delete('/:id', requireAdmin, (req, res) => {
  remove.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
