'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, todayStr, inclusiveDays } = require('../time');
const { notify } = require('../notify');

const router = express.Router();

const insertLeave = db.prepare(
  `INSERT INTO leaves (user_id, start_date, end_date, kind, reason, status, days, created_ts)
   VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
);
const leavesForUser = db.prepare(`SELECT * FROM leaves WHERE user_id = ? ORDER BY start_date DESC`);
const getLeave = db.prepare(`SELECT * FROM leaves WHERE id = ?`);
const allPending = db.prepare(
  `SELECT l.*, u.name, u.leave_balance FROM leaves l JOIN users u ON u.id = l.user_id
   WHERE l.status = 'PENDING' ORDER BY l.created_ts ASC`
);
const allLeaves = db.prepare(
  `SELECT l.*, u.name, u.leave_balance FROM leaves l JOIN users u ON u.id = l.user_id ORDER BY l.start_date DESC LIMIT 200`
);
// Existing pending/approved leaves for a user that overlap a [start,end] range.
const overlappingLeaves = db.prepare(
  `SELECT id FROM leaves WHERE user_id = ? AND status IN ('PENDING','APPROVED')
   AND start_date <= ? AND end_date >= ? LIMIT 1`
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
  // Can't apply for leave that has already started (before today).
  if (start < todayStr()) return res.status(400).json({ error: 'Leave cannot start in the past' });
  // Block overlapping requests so the same days aren't double-booked.
  if (overlappingLeaves.get(req.user.id, end, start)) {
    return res.status(409).json({ error: 'You already have a leave request covering some of these dates' });
  }
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

// ADMIN: who is on leave now or upcoming (approved leaves ending today or later).
const upcomingApproved = db.prepare(
  `SELECT l.*, u.name FROM leaves l JOIN users u ON u.id = l.user_id
   WHERE l.status = 'APPROVED' AND l.end_date >= ? ORDER BY l.start_date ASC`
);
router.get('/upcoming', requireAdmin, (_req, res) => res.json({ leaves: upcomingApproved.all(todayStr()) }));

// ADMIN: per-employee leave balance + days taken (last 30 days and this year).
const activeUsersForLeave = db.prepare(
  `SELECT id, name, department, leave_balance FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE`
);
const approvedOverlap = db.prepare(
  `SELECT user_id, start_date, end_date, kind FROM leaves
   WHERE status = 'APPROVED' AND start_date <= ? AND end_date >= ?`
);
// Sum approved leave days that fall within [winStart, winEnd], clipped to it.
function takenInWindow(winStart, winEnd) {
  const m = {};
  for (const l of approvedOverlap.all(winEnd, winStart)) {
    const s = l.start_date < winStart ? winStart : l.start_date;
    const e = l.end_date > winEnd ? winEnd : l.end_date;
    const d = l.kind === 'HALF' ? 0.5 : inclusiveDays(s, e);
    m[l.user_id] = (m[l.user_id] || 0) + d;
  }
  return m;
}
router.get('/summary', requireAdmin, (_req, res) => {
  const today = todayStr();
  const win0 = now().minus({ days: 29 }).toFormat('yyyy-LL-dd');
  const yearStart = now().startOf('year').toFormat('yyyy-LL-dd');
  const yearEnd = now().endOf('year').toFormat('yyyy-LL-dd');
  const taken30 = takenInWindow(win0, today);
  const takenYear = takenInWindow(yearStart, yearEnd);
  const rows = activeUsersForLeave.all().map((u) => ({
    id: u.id, name: u.name, department: u.department,
    balance: u.leave_balance, taken30: taken30[u.id] || 0, takenYear: takenYear[u.id] || 0,
  }));
  res.json({ rows });
});

// ADMIN: one employee's full leave history (for the balance breakdown).
const leavesForEmployee = db.prepare(
  `SELECT l.*, u.name FROM leaves l JOIN users u ON u.id = l.user_id
   WHERE l.user_id = ? ORDER BY l.start_date DESC LIMIT 100`
);
router.get('/for/:userId', requireAdmin, (req, res) => res.json({ leaves: leavesForEmployee.all(Number(req.params.userId)) }));

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
  // Let the employee know their request was decided.
  notify(leave.user_id, {
    type: 'LEAVE',
    title: decision === 'APPROVED' ? 'Leave approved' : 'Leave rejected',
    body: `Your leave from ${leave.start_date}${leave.end_date !== leave.start_date ? ' to ' + leave.end_date : ''} was ${decision.toLowerCase()}${note ? ` — ${note}` : ''}.`,
    link: 'leaves',
  });
  res.json({ leave: getLeave.get(leave.id) });
});

module.exports = router;
