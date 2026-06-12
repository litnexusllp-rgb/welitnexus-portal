'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const listHolidays = db.prepare(`SELECT * FROM holidays ORDER BY date ASC`);
const upsertHoliday = db.prepare(
  `INSERT INTO holidays (date, name, type, created_by, created_ts)
   VALUES (@date, @name, @type, @created_by, @created_ts)
   ON CONFLICT(date) DO UPDATE SET name = excluded.name, type = excluded.type`
);
const deleteHoliday = db.prepare(`DELETE FROM holidays WHERE id = ?`);

// Everyone can view the calendar.
router.get('/', requireAuth, (_req, res) => res.json({ holidays: listHolidays.all() }));

// ADMIN: publish / update a holiday.
router.post('/', requireAdmin, (req, res) => {
  const date = String(req.body.date || '');
  const name = String(req.body.name || '').slice(0, 120);
  const type = ['PUBLIC', 'OPTIONAL', 'COMPANY'].includes(String(req.body.type || '').toUpperCase())
    ? String(req.body.type).toUpperCase() : 'PUBLIC';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) {
    return res.status(400).json({ error: 'Valid date (yyyy-mm-dd) and name required' });
  }
  upsertHoliday.run({ date, name, type, created_by: req.user.id, created_ts: now().toMillis() });
  res.json({ holidays: listHolidays.all() });
});

router.delete('/:id', requireAdmin, (req, res) => {
  deleteHoliday.run(Number(req.params.id));
  res.json({ holidays: listHolidays.all() });
});

module.exports = router;
