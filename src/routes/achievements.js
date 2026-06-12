'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const insertAch = db.prepare(
  `INSERT INTO achievements (user_id, date, title, description, created_ts)
   VALUES (?, ?, ?, ?, ?)`
);
const getAch = db.prepare(
  `SELECT a.*, u.name FROM achievements a JOIN users u ON u.id = a.user_id WHERE a.id = ?`
);
const mine = db.prepare(
  `SELECT * FROM achievements WHERE user_id = ? ORDER BY date DESC, id DESC LIMIT 200`
);
const forMonth = db.prepare(
  `SELECT a.*, u.name FROM achievements a JOIN users u ON u.id = a.user_id
   WHERE a.date >= ? AND a.date <= ? ORDER BY a.status = 'PENDING' DESC, a.date DESC`
);
const review = db.prepare(
  `UPDATE achievements SET status = ?, points = ?, reviewed_by = ?, reviewed_ts = ? WHERE id = ?`
);
const deleteAch = db.prepare(`DELETE FROM achievements WHERE id = ?`);

// Log an achievement (any signed-in user, for themselves).
router.post('/', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const date = String(req.body.date || '');
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Title and a valid date are required' });
  }
  const info = insertAch.run(
    req.user.id, date, title,
    String(req.body.description || '').slice(0, 1000),
    now().toMillis()
  );
  res.json({ achievement: getAch.get(info.lastInsertRowid) });
});

// My achievements.
router.get('/mine', requireAuth, (req, res) => res.json({ achievements: mine.all(req.user.id) }));

// Employee deletes their own pending entry.
router.delete('/:id', requireAuth, (req, res) => {
  const a = getAch.get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  const ownPending = a.user_id === req.user.id && a.status === 'PENDING';
  if (!ownPending && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Only your own pending achievements can be deleted' });
  }
  deleteAch.run(a.id);
  res.json({ ok: true });
});

// ADMIN: all achievements in a month (yyyy-mm), pending first.
router.get('/month/:month', requireAdmin, (req, res) => {
  const m = String(req.params.month);
  if (!/^\d{4}-\d{2}$/.test(m)) return res.status(400).json({ error: 'Month must be yyyy-mm' });
  res.json({ achievements: forMonth.all(`${m}-01`, `${m}-31`) });
});

// ADMIN: review — acknowledge with points, or decline.
router.post('/:id/review', requireAdmin, (req, res) => {
  const a = getAch.get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  const status = String(req.body.status || '').toUpperCase();
  if (!['ACKNOWLEDGED', 'DECLINED'].includes(status)) {
    return res.status(400).json({ error: 'status must be ACKNOWLEDGED or DECLINED' });
  }
  const points = status === 'ACKNOWLEDGED' ? Math.max(0, Math.min(100, Number(req.body.points) || 0)) : 0;
  review.run(status, points, req.user.id, now().toMillis(), a.id);
  res.json({ achievement: getAch.get(a.id) });
});

module.exports = router;
