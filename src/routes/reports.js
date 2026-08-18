'use strict';

// Admin attendance reports:
//   GET /api/reports/attendance?user_id=&start=&end=  -> one person, day by day
//   GET /api/reports/register?month=yyyy-mm           -> whole team, grid
// Each day is classified PRESENT / LEAVE / HALF / HOLIDAY / WEEKEND / ABSENT,
// merging clock punches with approved leaves and published holidays.

const express = require('express');
const { db } = require('../db');
const { requireAdmin, requireAuth } = require('../auth');
const { now, attendanceToday, DateTime, ZONE } = require('../time');
const { summarize } = require('../compute');

const router = express.Router();

// Punctuality thresholds (mirror the KPI page): a clock-in counts as late past
// the employee's own shift start + grace; a present day under FULL_DAY_MIN
// worked minutes is flagged "short".
const SHIFT_START_HOUR = Math.min(23, Math.max(0, Number(process.env.SHIFT_START_HOUR ?? 16)));
const SHIFT_GRACE_MIN = Math.max(0, Number(process.env.SHIFT_GRACE_MIN ?? 15));
const FULL_DAY_MIN = Math.max(60, Number(process.env.FULL_DAY_MINUTES ?? 480)); // 8h default
function shiftStartOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : { h: SHIFT_START_HOUR, m: 0 };
}
const fmtShift = (s) => (s.h < 10 ? '0' : '') + s.h + ':' + (s.m < 10 ? '0' : '') + s.m;

const getUser = db.prepare(`SELECT id, name, department, title, shift_start FROM users WHERE id = ?`);
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
const workingDaysBetween = db.prepare(`SELECT id, date FROM working_days WHERE date >= ? AND date <= ?`);

function eachDay(start, end) {
  const out = [];
  let d = DateTime.fromISO(start, { zone: ZONE });
  const last = DateTime.fromISO(end, { zone: ZONE });
  while (d <= last) { out.push(d.toFormat('yyyy-LL-dd')); d = d.plus({ days: 1 }); }
  return out;
}

// Decide a single day's status given precomputed context.
function classify(day, summary, leaveKind, isHoliday, isFuture, isWorkingOverride) {
  const weekday = DateTime.fromISO(day, { zone: ZONE }).weekday; // 1=Mon..7=Sun
  const clockedIn = summary && summary.firstIn != null; // showed up = clocked in at all
  if (isFuture) return 'FUTURE';
  // A half day is worked AND partly off, so it must win over plain PRESENT —
  // otherwise clocking in (which they always do) would hide it.
  if (leaveKind === 'HALF') return 'HALF';
  if (clockedIn) return 'PRESENT';         // presence counts even on a holiday/weekend
  if (leaveKind === 'FULL') return 'LEAVE';
  if (isHoliday) return 'HOLIDAY';
  if (weekday >= 6 && !isWorkingOverride) return 'WEEKEND'; // a marked working weekend (1st Sat) falls through to ABSENT
  return 'ABSENT';
}

// ---- Per-employee, day-by-day ----
// Build one employee's day-by-day attendance for a range. Shared by the admin
// report and the employee's own calendar (which passes their own id).
function buildAttendanceReport(user, req) {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end)) ? String(req.query.end) : attendanceToday();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.start)) ? String(req.query.start)
    : DateTime.fromISO(end, { zone: ZONE }).startOf('month').toFormat('yyyy-LL-dd');
  if (start > end) return { error: 'Start must be before end' };

  const today = attendanceToday();
  const shift = shiftStartOf(user.shift_start); // this employee's own expected clock-in
  const byDay = {};
  for (const e of eventsForUserBetween.all(user.id, start, end)) (byDay[e.day] = byDay[e.day] || []).push(e);
  const holidaySet = {};
  for (const h of holidaysBetween.all(start, end)) holidaySet[h.date] = h.name;
  const workingSet = {};
  for (const w of workingDaysBetween.all(start, end)) workingSet[w.date] = true;
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
    const status = classify(day, s, leaveByDay[day], !!holidaySet[day], day > today, !!workingSet[day]);
    if (status === 'PRESENT') { totals.present += 1; totals.workedMinutes += s.workedMinutes; }
    else if (status === 'LEAVE') totals.leave += 1;
    else if (status === 'HALF') { totals.leave += 0.5; totals.present += 0.5; totals.workedMinutes += s ? s.workedMinutes : 0; }
    else if (status === 'ABSENT') totals.absent += 1;
    else if (status === 'HOLIDAY') totals.holiday += 1;
    else if (status === 'WEEKEND') totals.weekend += 1;
    // Punctuality / short-day flags for the calendar view. An approved half day
    // is exempt — coming in later (or leaving early) is the point of it.
    let late = false; let minutesLate = 0;
    if (s && s.firstIn != null && status !== 'HALF') {
      const cutoff = DateTime.fromISO(day, { zone: ZONE })
        .set({ hour: shift.h, minute: shift.m, second: 0, millisecond: 0 })
        .plus({ minutes: SHIFT_GRACE_MIN }).toMillis();
      if (s.firstIn > cutoff) { late = true; minutesLate = Math.round((s.firstIn - cutoff) / 60000); }
    }
    // Forgot to clock out: a finished day that still ends IN or on BREAK. The
    // recorded hours are incomplete, so flag that rather than calling it short.
    const noClockOut = !!(s && s.firstIn != null && day < today && s.state !== 'OUT');
    const short = !noClockOut && status === 'PRESENT' && s && day < today && s.workedMinutes > 0 && s.workedMinutes < FULL_DAY_MIN;
    return {
      day,
      weekday: DateTime.fromISO(day, { zone: ZONE }).toFormat('ccc'),
      status,
      holidayName: holidaySet[day] || '',
      firstIn: s ? s.firstIn : null,
      lastOut: s ? s.lastOut : null,
      workedMinutes: s ? s.workedMinutes : 0,
      breakMinutes: s ? s.breakMinutes : 0,
      late,
      minutesLate,
      short,
      noClockOut,
    };
  });
  return { user, start, end, rows, totals, shiftStart: fmtShift(shift), graceMin: SHIFT_GRACE_MIN, fullDayMinutes: FULL_DAY_MIN };
}

// ADMIN: any employee's day-by-day report.
router.get('/attendance', requireAdmin, (req, res) => {
  const user = getUser.get(Number(req.query.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const data = buildAttendanceReport(user, req);
  if (data.error) return res.status(400).json(data);
  res.json(data);
});

// Day-by-day attendance for the personal calendar. Employees always get their
// own; admins may pass ?user_id= to review any employee.
router.get('/my-attendance', requireAuth, (req, res) => {
  const asked = Number(req.query.user_id);
  const targetId = (req.user.role === 'ADMIN' && asked) ? asked : req.user.id;
  const user = getUser.get(targetId);
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const data = buildAttendanceReport(user, req);
  if (data.error) return res.status(400).json(data);
  res.json(data);
});

// ---- ADMIN: who forgot to clock out recently (team-wide) ----
// A finished attendance day that still ends IN or on BREAK means the clock-out
// is missing, so that day's hours are understated until it's corrected.
router.get('/missing-clockouts', requireAdmin, (req, res) => {
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
  const today = attendanceToday();
  const start = DateTime.fromISO(today, { zone: ZONE }).minus({ days }).toFormat('yyyy-LL-dd');
  const byUserDay = {};
  for (const e of allEventsBetween.all(start, today)) {
    const k = `${e.user_id}|${e.day}`;
    (byUserDay[k] = byUserDay[k] || []).push(e);
  }
  const names = {};
  for (const u of activeUsers.all()) names[u.id] = u.name;
  const rows = [];
  for (const k of Object.keys(byUserDay)) {
    const [uid, day] = k.split('|');
    if (day >= today) continue;              // today is still in progress
    if (!names[uid]) continue;               // inactive employee
    const s = summarize(byUserDay[k], null); // no live tail: past day
    if (s.firstIn == null || s.state === 'OUT') continue;
    rows.push({
      user_id: Number(uid), name: names[uid], day,
      firstIn: s.firstIn, state: s.state, workedMinutes: s.workedMinutes,
    });
  }
  rows.sort((a, b) => (b.day.localeCompare(a.day)) || a.name.localeCompare(b.name));
  res.json({ start, end: today, days, rows });
});

// ---- Whole-team monthly register grid ----
router.get('/register', requireAdmin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : now().toFormat('yyyy-LL');
  const start = `${month}-01`;
  const end = DateTime.fromISO(start, { zone: ZONE }).endOf('month').toFormat('yyyy-LL-dd');
  const today = attendanceToday();
  const days = eachDay(start, end);

  const holidaySet = {};
  for (const h of holidaysBetween.all(start, end)) holidaySet[h.date] = h.name;
  const workingSet = {};
  const workingDays = workingDaysBetween.all(start, end);
  for (const w of workingDays) workingSet[w.date] = true;

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
      const status = classify(day, s, leaveByUserDay[`${u.id}|${day}`], !!holidaySet[day], day > today, !!workingSet[day]);
      cells[day] = status;
      if (status === 'PRESENT') totals.present += 1;
      else if (status === 'HALF') { totals.present += 0.5; totals.leave += 0.5; }
      else if (status === 'LEAVE') totals.leave += 1;
      else if (status === 'ABSENT') totals.absent += 1;
    }
    return { id: u.id, name: u.name, department: u.department, cells, totals };
  });

  res.json({ month, days, holidays: holidaySet, workingDays, users });
});

module.exports = router;
