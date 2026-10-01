'use strict';
const router = require('express').Router();
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now, DateTime } = require('../time');

router.use(requireAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const validMonth = value => typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) && DateTime.fromISO(value + '-01').isValid;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;

router.get('/', (req, res) => {
  const month = req.query.month || now().toFormat('yyyy-LL');
  if (!validMonth(month)) return res.status(400).json({ error: 'Choose a valid month' });
  const employees = db.prepare(`SELECT u.id, u.name, u.emp_code, u.active,
    MAX(b.month) AS last_bonus_month, COUNT(b.id) AS bonus_count
    FROM users u LEFT JOIN bonuses b ON b.user_id=u.id AND b.voided_ts IS NULL AND b.month<=?
    GROUP BY u.id ORDER BY u.active DESC, last_bonus_month IS NOT NULL, last_bonus_month, u.name`).all(month);
  const history = db.prepare(`SELECT b.*, u.name, u.active, a.name AS recorded_by, v.name AS voided_by_name
    FROM bonuses b JOIN users u ON u.id=b.user_id JOIN users a ON a.id=b.created_by
    LEFT JOIN users v ON v.id=b.voided_by ORDER BY b.month DESC, b.paid_on DESC, b.id DESC`).all();
  res.json({ month, today: now().toISODate(), employees, history });
});

router.post('/', (req, res) => {
  const { month, paid_on, user_ids } = req.body;
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (!validMonth(month) || month > now().toFormat('yyyy-LL')) return res.status(400).json({ error: 'Choose a valid current or past bonus month' });
  if (!validDay(paid_on) || paid_on > now().toISODate()) return res.status(400).json({ error: 'Enter the actual payment date, today or earlier' });
  if (!Array.isArray(user_ids) || user_ids.length < 1 || user_ids.length > 3 || user_ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(user_ids).size !== user_ids.length) return res.status(400).json({ error: 'Choose one to three different employees' });
  if (note.length > 1000) return res.status(400).json({ error: 'Notes must be 1,000 characters or fewer' });
  if (user_ids.some(id => !db.prepare('SELECT id FROM users WHERE id=?').get(id))) return res.status(400).json({ error: 'Employee not found' });
  try {
    const ids = db.transaction(() => user_ids.map(id => db.prepare(`INSERT INTO bonuses(user_id,month,paid_on,note,created_by,created_ts) VALUES(?,?,?,?,?,?)`).run(id,month,paid_on,note,req.user.id,Date.now()).lastInsertRowid))();
    res.status(201).json({ ids });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'One of these employees already has a bonus recorded for this month. Nothing was added.' });
    throw e;
  }
});

router.post('/:id/void', (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 1000) return res.status(400).json({ error: 'Give a correction reason (up to 1,000 characters)' });
  const result = db.prepare('UPDATE bonuses SET voided_by=?,voided_ts=?,void_reason=? WHERE id=? AND voided_ts IS NULL').run(req.user.id,Date.now(),reason,req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Record not found or already voided' });
  res.json({ ok: true });
});
module.exports = router;
