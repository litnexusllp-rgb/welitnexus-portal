'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, inclusiveDays } = require('../time');

const router = express.Router();

const insertLeave = db.prepare(
  `INSERT INTO leaves (user_id, start_date, end_date, kind, reason, status, days, created_ts)
   VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
);
const leavesForUser = db.prepare(`SELECT * FROM leaves WHERE user_id = ? ORDER BY start_date DESC`);
const getLeave = db.prepare(`SELECT * FROM leaves WHERE id = ?`);
const allPending = db.prepare(
  `SELECT l.*, u.name FROM leaves l JOIN users u ON u.id = l.user_id
   WHERE l.status = 'PENDING' ORDER BY l.created_ts ASC`
);
const allLeaves = db.prepare(
  `SELECT l.*, u.name FROM leaves l JOIN users u ON u.id = l.user_id ORDER BY l.start_date DESC LIMIT 200`
);
const setStatus = db.prepare(
  `UPDATE leaves SET status = ?, decided_by = ?, decided_ts = ?, admin_note = ? WHERE id = ?`
);
const adjustBalance = db.prepare(`UPDATE users SET leave_balance = leave_balance - ? WHERE id = ?`);
const getUser = db.prepare(`SELECT * FROM users WHERE id = ?`);

// Apply for leave.
router.post('/', requireAuth, (req, res) => {
  const start = String(req.body.start_date || '');
  const kind = String(req.body.kind || 'FULL').toUpperCase() === 'HALF' ? 'HALF' : 'FULL';
  // A half day is by definition a single date — ignore any range for HALF.
  const end = kind === 'HALF' ? start : String(req.body.end_date || start);
  const reason = String(req.body.reason || '').slice(0, 500);
  const span = inclusiveDays(start, end);
  if (!span) return res.status(400).json({ error: 'Invalid date range' });
  const days = kind === 'HALF' ? 0.5 : span;
  const info = insertLeave.run(req.user.id, start, end, kind, reason, days, now().toMillis());
  res.json({ leave: getLeave.get(info.lastInsertRowid) });
});

// My leave history + balance.
router.get('/mine', requireAuth, (req, res) => {
  const u = getUser.get(req.user.id);
  res.json({ balance: u.leave_balance, leaves: leavesForUser.all(req.user.id) });
});

// Employee cancels their own pending request.
router.post('/:id/cancel', requireAuth, (req, res) => {
  const leave = getLeave.get(Number(req.params.id));
  if (!leave || leave.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (leave.status !== 'PENDING') return res.status(409).json({ error: 'Only pending leaves can be cancelled' });
  setStatus.run('CANCELLED', req.user.id, now().toMillis(), '', leave.id);
  res.json({ leave: getLeave.get(leave.id) });
});

// ADMIN: list pending + recent.
router.get('/pending', requireAdmin, (_req, res) => res.json({ leaves: allPending.all() }));
router.get('/all', requireAdmin, (_req, res) => res.json({ leaves: allLeaves.all() }));

// ADMIN: approve / reject. Deducts balance on approval.
router.post('/:id/decide', requireAdmin, (req, res) => {
  const decision = String(req.body.decision || '').toUpperCase();
  const note = String(req.body.note || '').slice(0, 300);
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be APPROVED or REJECTED' });
  }
  const leave = getLeave.get(Number(req.params.id));
  if (!leave) return res.status(404).json({ error: 'Not found' });
  if (leave.status !== 'PENDING') return res.status(409).json({ error: 'Already decided' });

  const decide = db.transaction(() => {
    setStatus.run(decision, req.user.id, now().toMillis(), note, leave.id);
    if (decision === 'APPROVED') adjustBalance.run(leave.days, leave.user_id);
  });
  decide();
  res.json({ leave: getLeave.get(leave.id) });
});

module.exports = router;
