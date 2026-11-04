'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { DateTime, ZONE, now, todayStr, inclusiveDays } = require('../time');
const { employmentStatus } = require('../employment');
const { notify } = require('../notify');
const { flagAbsences, lastCompletedAttendanceDay } = require('../autoAbsence');
const { CATEGORIES, describeLeave, describeLeaves, syncBalance, syncAllBalancesAsync, normalizeLeave, assertAvailable } = require('../leavePolicy');
const { estimateDeduction, savedDeduction } = require('../salaryDeduction');

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const insertLeave = db.prepare(
  `INSERT INTO leaves (user_id, start_date, end_date, kind, category, reason, status, days, created_ts, emergency_type, deduction_quote_json)
   VALUES (@user_id, @start_date, @end_date, @kind, @category, @reason, 'PENDING', @days, @created_ts, @emergency_type, @deduction_quote_json)`
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
const getUser = db.prepare(`SELECT * FROM users WHERE id = ?`);
const presentLeave = leave => {
  const { deduction_quote_json, ...fields } = describeLeave(leave);
  return { ...fields, deduction_estimate: savedDeduction(leave) };
};
const present = leaves => describeLeaves(leaves).map(leave => { const { deduction_quote_json, ...fields } = leave; return { ...fields, deduction_estimate:savedDeduction(leave) }; });
const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not update leave. Please try again.' });
const personalLeaveUnavailable = res => res.status(403).json({ error: 'Personal leave is not available for admin accounts.' });
function checkShortDays(userId, leave) {
  if (db.prepare("SELECT 1 FROM short_day_requests WHERE user_id=? AND status IN ('PENDING','APPROVED') AND date BETWEEN ? AND ? LIMIT 1").get(userId,leave.start_date,leave.end_date)) {
    throw Object.assign(new Error('Short Day time already covers a date in this request. Resolve the overlapping time with management before recording full/half-day leave.'), {status:409});
  }
}

function employeeLeaveHistory(userId) {
  const balances = syncBalance(userId), leaves = leavesForUser.all(userId), today = todayStr();
  const activity = { taken_days: 0, upcoming_days: 0, pending_days: 0, pending_requests: 0 };
  for (const leave of leaves) {
    const start = leave.start_date > balances.period.start ? leave.start_date : balances.period.start;
    const last = leave.kind === 'HALF' ? leave.start_date : leave.end_date;
    const end = last < balances.period.end ? last : balances.period.end;
    if (start > end) continue;
    const count = (from, to) => from > to ? 0 : leave.kind === 'HALF' ? 0.5 : inclusiveDays(from, to);
    if (leave.status === 'PENDING') {
      activity.pending_days += count(start, end); activity.pending_requests++;
    } else if (leave.status === 'APPROVED') {
      activity.taken_days += count(start, end < today ? end : today);
      // Exclude today from future days without assuming a browser timezone.
      activity.upcoming_days += count(start, end) - count(start, end < today ? end : today);
    }
  }
  return { balance: balances.balance, balances, activity, leaves: present(leaves) };
}

// Server-authoritative payment preview; employees can preview only themselves.
router.post('/preview', requireAuth, (req, res) => {
  const userId = Number(req.body.user_id || req.user.id);
  if (userId !== req.user.id && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admins only' });
  const user = getUser.get(userId);
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  if (user.role === 'ADMIN') return personalLeaveUnavailable(res);
  try {
    const leave = { ...normalizeLeave(req.body, { allowPast: req.user.role === 'ADMIN', requireReason: false }), user_id:userId, status:req.user.role === 'ADMIN' ? 'APPROVED' : 'PENDING' };
    assertAvailable(userId, leave);
    res.json({ leave: { ...describeLeave(leave), deduction_estimate: estimateDeduction(userId, leave) }, balances: syncBalance(userId), categories: CATEGORIES });
  } catch (e) { return fail(res, e); }
});

// Apply for leave.
router.post('/', requireAuth, (req, res) => {
  if (req.user.role === 'ADMIN') return personalLeaveUnavailable(res);
  try {
    const leave = { ...normalizeLeave(req.body), user_id:req.user.id, status:'PENDING' };
    const created = db.transaction(() => {
      checkShortDays(req.user.id,leave);
      if (overlappingLeaves.get(req.user.id, leave.end_date, leave.start_date)) throw Object.assign(new Error('You already have a leave request covering some of these dates.'), { status: 409 });
      assertAvailable(req.user.id, leave);
      const info = insertLeave.run({ ...leave, user_id: req.user.id, created_ts: now().toMillis(), deduction_quote_json: JSON.stringify(estimateDeduction(req.user.id, leave)) });
      return getLeave.get(info.lastInsertRowid);
    }).immediate();
    res.json({ leave: presentLeave(created), balances: syncBalance(req.user.id) });
  } catch (e) { return fail(res, e); }
});

// My leave history + balance.
router.get('/mine', requireAuth, (req, res) => {
  if (req.user.role === 'ADMIN') return personalLeaveUnavailable(res);
  res.json(employeeLeaveHistory(req.user.id));
});

// Employee cancels their own pending request.
router.post('/:id/cancel', require('../requestValidation').validateParams, requireAuth, (req, res) => {
  try {
    const leave = db.transaction(() => {
      const existing = getLeave.get(Number(req.params.id));
      if (!existing || existing.user_id !== req.user.id) throw Object.assign(new Error('Not found'), { status: 404 });
      if (existing.status !== 'PENDING') throw Object.assign(new Error('Only pending leaves can be cancelled'), { status: 409 });
      setStatus.run('CANCELLED', req.user.id, now().toMillis(), '', existing.id);
      return getLeave.get(existing.id);
    }).immediate();
    res.json({ leave: presentLeave(leave), balances: syncBalance(req.user.id) });
  } catch (e) { return fail(res, e); }
});

// ADMIN: mark leave for an employee directly (phone-in sick days, etc.).
// Recorded as already APPROVED — balance is deducted and the employee is told.
// Past dates are allowed here on purpose (recording what already happened).
const insertApprovedLeave = db.prepare(
  `INSERT INTO leaves (user_id, start_date, end_date, kind, category, reason, status, days, decided_by, decided_ts, created_ts, emergency_type, deduction_quote_json)
   VALUES (@user_id, @start_date, @end_date, @kind, @category, @reason, 'APPROVED', @days, @decided_by, @decided_ts, @created_ts, @emergency_type, @deduction_quote_json)`
);
router.post('/admin', requireAdmin, (req, res) => {
  const user = getUser.get(Number(req.body.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  if (user.role === 'ADMIN') return personalLeaveUnavailable(res);
  let leaveId;
  let leave;
  try {
    leave = { ...normalizeLeave(req.body, { allowPast: true, requireReason: false }), user_id:user.id, status:'APPROVED' };
    db.transaction(() => {
      const endpoints = [leave.start_date, leave.end_date].map(date => employmentStatus(user, date));
      if (endpoints.includes('NOT_EMPLOYED') || (!user.active && endpoints.some(Boolean))) {
        throw Object.assign(new Error('Choose dates within the employee’s employment period.'), { status: 400 });
      }
      checkShortDays(user.id,leave);
      const overlap = overlappingLeaves.get(user.id, leave.end_date, leave.start_date);
      if (overlap && req.body.replace_auto_absence === true && leave.start_date === leave.end_date) {
        const existing = getLeave.get(overlap.id);
        if (existing.status === 'PENDING' && existing.start_date === leave.start_date && existing.end_date === leave.end_date
          && existing.reason === `Auto-flagged: no clock-in on ${leave.start_date}`) {
          setStatus.run('CANCELLED', req.user.id, now().toMillis(), 'Replaced by admin-recorded leave.', existing.id);
        }
      }
      if (overlappingLeaves.get(user.id, leave.end_date, leave.start_date)) {
        throw Object.assign(new Error(`${user.name} already has a pending or approved leave covering these dates.`), { status: 409 });
      }
      assertAvailable(user.id, leave);
      leaveId = insertApprovedLeave.run({ ...leave, user_id: user.id, decided_by: req.user.id, decided_ts: now().toMillis(), created_ts: now().toMillis(), deduction_quote_json: JSON.stringify(estimateDeduction(user.id, leave)) }).lastInsertRowid;
      syncBalance(user.id);
    }).immediate();
  } catch (e) { return fail(res, e); }
  const recordedLeave = presentLeave(getLeave.get(leaveId));
  notify(user.id, {
    type: 'LEAVE',
    title: 'Leave recorded for you',
    body: `${req.user.name} recorded ${CATEGORIES[leave.category]}: ${leave.start_date}${leave.end_date !== leave.start_date ? ' to ' + leave.end_date : ''}. ${recordedLeave.paid_days} paid, ${recordedLeave.unpaid_days} unpaid day(s).`,
    link: 'leaves',
  });
  res.json({ leave: recordedLeave, balances: syncBalance(user.id) });
});

// Split an approved full-day request without rewriting the original decision.
router.post('/:id/half-day', requireAdmin, require('../requestValidation').validateParams, (req, res) => {
  const { day } = req.body;
  if (!require('../requestValidation').day(day)) return res.status(400).json({ error: 'Choose a valid date.' });
  try {
    const result = db.transaction(() => {
      const original = getLeave.get(Number(req.params.id));
      if (!original) throw Object.assign(new Error('Leave request not found.'), { status: 404 });
      if (original.status !== 'APPROVED' || original.kind !== 'FULL' || day < original.start_date || day > original.end_date) {
        throw Object.assign(new Error('This date is no longer covered by this approved full-day request. Refresh the calendar.'), { status: 409 });
      }
      const date = DateTime.fromISO(day, { zone: ZONE });
      const segments = [];
      if (original.start_date < day) {
        segments.push({ start_date: original.start_date, end_date: date.minus({ days: 1 }).toISODate(), kind: 'FULL' });
      }
      segments.push({ start_date: day, end_date: day, kind: 'HALF' });
      if (day < original.end_date) {
        segments.push({ start_date: date.plus({ days: 1 }).toISODate(), end_date: original.end_date, kind: 'FULL' });
      }

      const adjustedAt = now().toMillis();
      const auditNote = `Adjusted ${day} to half-day leave.`;
      const updateNote = db.prepare('UPDATE leaves SET admin_note=? WHERE id=?');
      db.prepare("UPDATE leaves SET status='CANCELLED' WHERE id=?").run(original.id);
      if (overlappingLeaves.get(original.user_id, original.end_date, original.start_date)) {
        throw Object.assign(new Error('Another leave request overlaps these dates. Resolve it before adjusting this request.'), { status: 409 });
      }
      checkShortDays(original.user_id, original);
      const ids = segments.map(segment => {
        const id = insertApprovedLeave.run({
          ...original,
          ...segment,
          days: segment.kind === 'HALF' ? 0.5 : inclusiveDays(segment.start_date, segment.end_date),
          decided_by: req.user.id,
          decided_ts: adjustedAt,
          deduction_quote_json: null,
        }).lastInsertRowid;
        updateNote.run(`Replaces request #${original.id}. ${auditNote}`, id);
        return id;
      });
      updateNote.run([original.admin_note, `${auditNote} Replaced by ${ids.map(id => '#' + id).join(', ')}.`].filter(Boolean).join(' '), original.id);
      return { leaves: present(ids.map(id => getLeave.get(id))), balances: syncBalance(original.user_id) };
    }).immediate();
    res.json(result);
  } catch (e) { return fail(res, e); }
});

// ADMIN: run the no-show check now (normally runs daily on a schedule).
// Optional ?day=yyyy-mm-dd, else the most recently completed shift day.
router.post('/flag-absences', requireAdmin, require('../asyncRoute')(async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day)) ? String(req.query.day) : lastCompletedAttendanceDay();
  const created = flagAbsences(day);
  await syncAllBalancesAsync();
  res.json({ day, created, leaves: present(allPending.all()) });
}));

// ADMIN: list pending + recent.
router.get('/pending', requireAdmin, require('../asyncRoute')(async (_req, res) => { await syncAllBalancesAsync(); res.json({ leaves: present(allPending.all()) }); }));
router.get('/all', requireAdmin, require('../asyncRoute')(async (_req, res) => { await syncAllBalancesAsync(); res.json({ leaves: present(allLeaves.all()) }); }));

// ADMIN: who is on leave now or upcoming (approved leaves ending today or later).
const upcomingApproved = db.prepare(
  `SELECT l.*, u.name FROM leaves l JOIN users u ON u.id = l.user_id
   WHERE l.status = 'APPROVED' AND l.end_date >= ? ORDER BY l.start_date ASC`
);
router.get('/upcoming', requireAdmin, (_req, res) => res.json({ leaves: present(upcomingApproved.all(todayStr())) }));

// ADMIN: per-employee leave balance + days taken (last 30 days and this year).
const activeUsersForLeave = db.prepare(
  `SELECT id, name, department, leave_balance FROM users WHERE active = 1 AND role = 'EMPLOYEE' ORDER BY name COLLATE NOCASE`
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
router.get('/summary', requireAdmin, require('../asyncRoute')(async (_req, res) => {
  await syncAllBalancesAsync();
  const today = todayStr();
  const win0 = now().minus({ days: 29 }).toFormat('yyyy-LL-dd');
  const yearStart = now().startOf('year').toFormat('yyyy-LL-dd');
  const yearEnd = now().endOf('year').toFormat('yyyy-LL-dd');
  const taken30 = takenInWindow(win0, today);
  const takenYear = takenInWindow(yearStart, yearEnd);
  const rows = activeUsersForLeave.all().map((u) => ({
    id: u.id, name: u.name, department: u.department,
    balance: u.leave_balance, balances: syncBalance(u.id), taken30: taken30[u.id] || 0, takenYear: takenYear[u.id] || 0,
  }));
  res.json({ rows });
}));

// ADMIN: one employee's full leave history (for the balance breakdown).
router.get('/for/:userId', require('../requestValidation').validateParams, requireAdmin, (req, res) => {
  const user = getUser.get(Number(req.params.userId));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  res.json(employeeLeaveHistory(user.id));
});

// ADMIN: approve / reject. Deducts balance on approval.
router.post('/:id/decide', require('../requestValidation').validateParams, requireAdmin, (req, res) => {
  const decision = String(req.body.decision || '').toUpperCase();
  const note = String(req.body.note || '').slice(0, 300);
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be APPROVED or REJECTED' });
  }
  let leave;
  try {
    db.transaction(() => {
      leave = getLeave.get(Number(req.params.id));
      if (!leave) throw Object.assign(new Error('Not found'), { status: 404 });
      if (leave.status !== 'PENDING') throw Object.assign(new Error('Already decided'), { status: 409 });
      if (decision === 'APPROVED') {
        checkShortDays(leave.user_id,leave);
        // Revalidate legacy/auto-flagged requests and available category credit.
        normalizeLeave(leave, { allowPast: true, requireReason: false });
        assertAvailable(leave.user_id, leave, leave.id);
      }
      setStatus.run(decision, req.user.id, now().toMillis(), note, leave.id);
      syncBalance(leave.user_id);
    }).immediate();
  } catch (e) { return fail(res, e); }
  // Let the employee know their request was decided.
  notify(leave.user_id, {
    type: 'LEAVE',
    title: decision === 'APPROVED' ? 'Leave approved' : 'Leave rejected',
    body: `Your ${CATEGORIES[leave.category]} from ${leave.start_date}${leave.end_date !== leave.start_date ? ' to ' + leave.end_date : ''} was ${decision.toLowerCase()}. ${describeLeave(leave).paid_days} paid, ${describeLeave(leave).unpaid_days} unpaid day(s)${note ? ` — ${note}` : ''}.`,
    link: 'leaves',
  });
  res.json({ leave: presentLeave(getLeave.get(leave.id)), balances: syncBalance(leave.user_id) });
});

module.exports = router;
