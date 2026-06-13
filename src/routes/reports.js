'use strict';

// Admin attendance reports:
//   GET /api/reports/attendance?user_id=&start=&end=  -> one person, day by day
//   GET /api/reports/register?month=yyyy-mm           -> whole team, grid
// Each day is classified PRESENT / LEAVE / HALF / HOLIDAY / WEEKEND / ABSENT,
// merging clock punches with approved leaves and published holidays.

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now, todayStr, DateTime, ZONE } = require('../time');
const { summarize } = require('../compute');

const router = express.Router();

const getUser = db.prepare(`SELECT id, name, department, title FROM users WHERE id = ?`);
const activeUsers = db.prepare(`SELECT id, name, department, title FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE`);
const eventsForUserBetween = db.prepare(
  `SELECT type, ts, day FROM events WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY ts, id`
);
const allEventsBetween = db.prepare(
  `SELECT user_id, type, ts, day FROM events WHERE day >= ? AND day <= ? ORDER BY user_id, ts, id`
);
const approvedLeavesOverlapping = db.prepare(
  `SELECT user_id, start_date, end_date, kind FROM leaves
   WHERE status = 'APPROVED' AND start_date <= ? AND end_date >= ?`
);
const holidaysBetween = db.prepare(`SELECT date, name FROM holidays WHERE date >= ? AND date <= ?`);

function eachDay(start, end) {
  const out = [];
  let d = DateTime.fromISO(start, { zone: ZONE });
  const last = DateTime.fromISO(end, { zone: ZONE });
  while (d <= last) { out.push(d.toFormat('yyyy-LL-dd')); d = d.plus({ days: 1 }); }
  return out;
}

// Decide a single day's status given precomputed context.
function classify(day, summary, leaveKind, isHoliday, isFuture) {
  const weekday = DateTime.fromISO(day, { zone: ZONE }).weekday; // 1=Mon..7=Sun
  const clockedIn = summary && summary.firstIn != null; // showed up = clocked in at all
  if (isFuture) return 'FUTURE';
  if (clockedIn) return 'PRESENT';         // presence counts even on a holiday/weekend
  if (leaveKind === 'HALF') return 'HALF';
  if (leaveKind === 'FULL') return 'LEAVE';
  if (isHoliday) return 'HOLIDAY';
  if (weekday >= 6) return 'WEEKEND';
  return 'ABSENT';
}

// ---- Per-employee, day-by-day ----
router.get('/attendance', requireAdmin, (req, res) => {
  const user = getUser.get(Number(req.query.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end)) ? String(req.query.end) : todayStr();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start)) ? String(req.query.start)
    : DateTime.fromISO(end, { zone: ZONE }).startOf('month').toFormat('yyyy-LL-dd');
  if (start > end) return res.status(400).json({ error: 'Start must be before end' });

  const today = todayStr();
  const byDay = {};
  for (const e of eventsForUserBetween.all(user.id, start, end)) (byDay[e.day] = byDay[e.day] || []).push(e);
  const holidaySet = {};
  for (const h of holidaysBetween.all(start, end)) holidaySet[h.date] = h.name;
  const leaveByDay = {};
  for (const l of approvedLeavesOverlapping.all(end, start)) {
    if (l.user_id !== user.id) continue;
    for (const d of eachDay(l.start_date < start ? start : l.start_date, l.end_date > end ? end : l.end_date)) {
      leaveByDay[d] = l.kind;
    }
  }

  const totals = { present: 0, leave: 0, absent: 0, holiday: 0, weekend: 0, workedMinutes: 0 };
  const rows = eachDay(start, end).map((day) => {
    const s = byDay[day] ? summarize(byDay[day], day === today ? now().toMillis() : null) : null;
    const status = classify(day, s, leaveByDay[day], !!holidaySet[day], day > today);
    if (status === 'PRESENT') { totals.present += 1; totals.workedMinutes += s.workedMinutes; }
    else if (status === 'LEAVE') totals.leave += 1;
    else if (status === 'HALF') { totals.leave += 0.5; totals.present += 0.5; totals.workedMinutes += s ? s.workedMinutes : 0; }
    else if (status === 'ABSENT') totals.absent += 1;
    else if (status === 'HOLIDAY') totals.holiday += 1;
    else if (status === 'WEEKEND') totals.weekend += 1;
    return {
      day,
      weekday: DateTime.fromISO(day, { zone: ZONE }).toFormat('ccc'),
      status,
      holidayName: holidaySet[day] || '',
      firstIn: s ? s.firstIn : null,
      lastOut: s ? s.lastOut : null,
      workedMinutes: s ? s.workedMinutes : 0,
      breakMinutes: s ? s.breakMinutes : 0,
    };
  });
  res.json({ user, start, end, rows, totals });
});

// ---- Whole-team monthly register grid ----
router.get('/register', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : now().toFormat('yyyy-LL');
  const start = `${month}-01`;
  const end = DateTime.fromISO(start, { zone: ZONE }).endOf('month').toFormat('yyyy-LL-dd');
  const today = todayStr();
  const days = eachDay(start, end);

  const holidaySet = {};
  for (const h of holidaysBetween.all(start, end)) holidaySet[h.date] = h.name;

  const eventsByUserDay = {};
  for (const e of allEventsBetween.all(start, end)) {
    const k = `${e.user_id}|${e.day}`;
    (eventsByUserDay[k] = eventsByUserDay[k] || []).push(e);
  }
  const leaveByUserDay = {};
  for (const l of approvedLeavesOverlapping.all(end, start)) {
    for (const d of eachDay(l.start_date < start ? start : l.start_date, l.end_date > end ? end : l.end_date)) {
      leaveByUserDay[`${l.user_id}|${d}`] = l.kind;
    }
  }

  const users = activeUsers.all().map((u) => {
    const cells = {};
    const totals = { present: 0, leave: 0, absent: 0 };
    for (const day of days) {
      const ev = eventsByUserDay[`${u.id}|${day}`];
      const s = ev ? summarize(ev, day === today ? now().toMillis() : null) : null;
      const status = classify(day, s, leaveByUserDay[`${u.id}|${day}`], !!holidaySet[day], day > today);
      cells[day] = status;
      if (status === 'PRESENT') totals.present += 1;
      else if (status === 'HALF') { totals.present += 0.5; totals.leave += 0.5; }
      else if (status === 'LEAVE') totals.leave += 1;
      else if (status === 'ABSENT') totals.absent += 1;
    }
    return { id: u.id, name: u.name, department: u.department, cells, totals };
  });

  res.json({ month, days, holidays: holidaySet, users });
});

module.exports = router;
