'use strict';

// Monthly KPI report per employee — the raw numbers the partners use to
// decide bonuses: attendance, hours, task throughput & punctuality, leave
// taken, and acknowledged achievement points.

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now, attendanceToday, dayFromTs, DateTime, ZONE } = require('../time');
const { summarize } = require('../compute');

const router = express.Router();

// Punctuality = clocked in by the shift start (+ a grace window). The team runs
// an evening/overnight shift, so the default expected clock-in is 16:00 (4 PM);
// both are configurable per firm.
const SHIFT_START_HOUR = Math.min(23, Math.max(0, Number(process.env.SHIFT_START_HOUR ?? 16)));
const SHIFT_GRACE_MIN = Math.max(0, Number(process.env.SHIFT_GRACE_MIN ?? 15));

const activeUsers = db.prepare(
  `SELECT id, name, department, title, leave_balance FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE`
);
const eventsBetween = db.prepare(
  `SELECT user_id, type, ts, day FROM events WHERE day >= ? AND day <= ? ORDER BY user_id, ts, id`
);
const doneTasksBetween = db.prepare(
  `SELECT assignee_id, due_date, updated_ts FROM tasks WHERE status = 'DONE' AND updated_ts >= ? AND updated_ts <= ?`
);
const openTasksNow = db.prepare(
  `SELECT assignee_id, COUNT(*) AS c FROM tasks WHERE status != 'DONE' GROUP BY assignee_id`
);
const approvedLeaves = db.prepare(
  `SELECT user_id, start_date, end_date, kind FROM leaves
   WHERE status = 'APPROVED' AND start_date <= ? AND end_date >= ?`
);
const achievementsBetween = db.prepare(
  `SELECT user_id, status, points FROM achievements WHERE date >= ? AND date <= ?`
);

// Inclusive day overlap between [aStart,aEnd] and [bStart,bEnd] (ISO strings).
function overlapDays(aStart, aEnd, bStart, bEnd) {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  if (e < s) return 0;
  return Math.round(DateTime.fromISO(e, { zone: ZONE }).diff(DateTime.fromISO(s, { zone: ZONE }), 'days').days) + 1;
}

router.get('/', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : now().toFormat('yyyy-LL');
  const start = `${month}-01`;
  const end = DateTime.fromISO(start, { zone: ZONE }).endOf('month').toFormat('yyyy-LL-dd');
  const today = attendanceToday();
  const startMs = DateTime.fromISO(start, { zone: ZONE }).startOf('day').toMillis();
  const endMs = DateTime.fromISO(end, { zone: ZONE }).endOf('day').toMillis();

  // --- attendance: group events by user+day, summarize each day ---
  const byUserDay = {};
  for (const e of eventsBetween.all(start, end)) {
    const k = `${e.user_id}|${e.day}`;
    (byUserDay[k] = byUserDay[k] || []).push(e);
  }
  const attendance = {}; // user_id -> { days, minutes, present, onTime }
  for (const k of Object.keys(byUserDay)) {
    const [uid, day] = k.split('|');
    const s = summarize(byUserDay[k], day === today ? now().toMillis() : null);
    const a = (attendance[uid] = attendance[uid] || { days: 0, minutes: 0, present: 0, onTime: 0 });
    a.days += 1;
    a.minutes += s.workedMinutes;
    // Punctuality: was the first clock-in by the shift start (+ grace)?
    if (s.firstIn != null) {
      a.present += 1;
      const cutoff = DateTime.fromISO(day, { zone: ZONE })
        .set({ hour: SHIFT_START_HOUR, minute: 0, second: 0, millisecond: 0 })
        .plus({ minutes: SHIFT_GRACE_MIN }).toMillis();
      if (s.firstIn <= cutoff) a.onTime += 1;
    }
  }

  // --- tasks completed in the month ---
  const tasks = {}; // user_id -> { done, onTime }
  for (const t of doneTasksBetween.all(startMs, endMs)) {
    const r = (tasks[t.assignee_id] = tasks[t.assignee_id] || { done: 0, onTime: 0 });
    r.done += 1;
    if (!t.due_date || dayFromTs(t.updated_ts) <= t.due_date) r.onTime += 1;
  }
  const openNow = {};
  for (const r of openTasksNow.all()) openNow[r.assignee_id] = r.c;

  // --- approved leave days falling inside the month ---
  const leaveDays = {}; // user_id -> days
  for (const l of approvedLeaves.all(end, start)) {
    const d = overlapDays(l.start_date, l.end_date, start, end);
    if (!d) continue;
    leaveDays[l.user_id] = (leaveDays[l.user_id] || 0) + (l.kind === 'HALF' ? 0.5 : d);
  }

  // --- achievements in the month ---
  const ach = {}; // user_id -> { logged, acknowledged, points, pending }
  for (const a of achievementsBetween.all(start, end)) {
    const r = (ach[a.user_id] = ach[a.user_id] || { logged: 0, acknowledged: 0, points: 0, pending: 0 });
    r.logged += 1;
    if (a.status === 'ACKNOWLEDGED') { r.acknowledged += 1; r.points += a.points; }
    if (a.status === 'PENDING') r.pending += 1;
  }

  const rows = activeUsers.all().map((u) => {
    const a = attendance[u.id] || { days: 0, minutes: 0, present: 0, onTime: 0 };
    const t = tasks[u.id] || { done: 0, onTime: 0 };
    const x = ach[u.id] || { logged: 0, acknowledged: 0, points: 0, pending: 0 };
    return {
      id: u.id,
      name: u.name,
      department: u.department,
      title: u.title,
      daysPresent: a.days,
      hoursWorked: Math.round((a.minutes / 60) * 10) / 10,
      punctualPct: a.present ? Math.round((a.onTime / a.present) * 100) : null,
      lateDays: a.present - a.onTime,
      tasksDone: t.done,
      tasksOnTime: t.onTime,
      onTimePct: t.done ? Math.round((t.onTime / t.done) * 100) : null,
      openTasks: openNow[u.id] || 0,
      leaveDays: leaveDays[u.id] || 0,
      leaveBalance: u.leave_balance,
      achievementsLogged: x.logged,
      achievementsAcknowledged: x.acknowledged,
      achievementsPending: x.pending,
      points: x.points,
    };
  });

  res.json({ month, start, end, rows, shiftStart: SHIFT_START_HOUR, graceMin: SHIFT_GRACE_MIN });
});

module.exports = router;
