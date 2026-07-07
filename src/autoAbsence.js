'use strict';

// Auto-absence flagging. After a shift day closes, any employee who normally
// clocks in but didn't gets a PENDING leave request auto-created, which lands
// in the admin approval queue. Nothing is deducted until an admin approves.
//
// Guards (so it never spams):
//  - only ACTIVE, role=EMPLOYEE users who clocked in at least once in the last
//    HABIT_DAYS days (an established clock-in habit — excludes partners/admins
//    who never clock, and brand-new hires),
//  - skips weekends (unless a working_days override), holidays, and any day the
//    person already has a pending/approved leave for,
//  - idempotent: won't create a second request for a day already covered.
//
// Disable entirely by setting AUTO_ABSENCE=off.

const { db } = require('./db');
const { now, attendanceToday, DateTime, ZONE } = require('./time');
const { notifyAdmins } = require('./notify');

const HABIT_DAYS = 14;

const activeEmployees = db.prepare(`SELECT id, name FROM users WHERE active = 1 AND role = 'EMPLOYEE'`);
const inOnDay = db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND type = 'IN' AND day = ? LIMIT 1`);
const inWithinWindow = db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND type = 'IN' AND day >= ? AND day <= ? LIMIT 1`);
const isHolidayOn = db.prepare(`SELECT 1 FROM holidays WHERE date = ? LIMIT 1`);
const isWorkingOverride = db.prepare(`SELECT 1 FROM working_days WHERE date = ? LIMIT 1`);
const leaveCoveringDay = db.prepare(
  `SELECT 1 FROM leaves WHERE user_id = ? AND status IN ('PENDING','APPROVED') AND start_date <= ? AND end_date >= ? LIMIT 1`
);
const insertPendingLeave = db.prepare(
  `INSERT INTO leaves (user_id, start_date, end_date, kind, reason, status, days, created_ts)
   VALUES (?, ?, ?, 'FULL', ?, 'PENDING', 1, ?)`
);

// The most recently completed attendance day (yesterday's shift), when run
// after the cutover. Callers may pass an explicit day for manual runs/tests.
function lastCompletedAttendanceDay() {
  return DateTime.fromISO(attendanceToday(), { zone: ZONE }).minus({ days: 1 }).toFormat('yyyy-LL-dd');
}

// Flag no-shows for one attendance day. Returns the number of requests created.
function flagAbsences(dayStr) {
  const day = dayStr || lastCompletedAttendanceDay();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;

  // Weekend / holiday days are never working days (unless overridden).
  const weekday = DateTime.fromISO(day, { zone: ZONE }).weekday; // 1=Mon .. 7=Sun
  const override = !!isWorkingOverride.get(day);
  if (isHolidayOn.get(day)) return 0;
  if (weekday >= 6 && !override) return 0;

  const windowStart = DateTime.fromISO(day, { zone: ZONE }).minus({ days: HABIT_DAYS }).toFormat('yyyy-LL-dd');
  const reason = `Auto-flagged: no clock-in on ${day}`;
  const created = [];

  const run = db.transaction(() => {
    for (const u of activeEmployees.all()) {
      if (inOnDay.get(u.id, day)) continue;                                   // they were present
      if (!inWithinWindow.get(u.id, windowStart, day)) continue;             // no clock-in habit
      if (leaveCoveringDay.get(u.id, day, day)) continue;                    // already on/awaiting leave
      insertPendingLeave.run(u.id, day, day, reason, now().toMillis());
      created.push(u.name);
    }
  });
  run();

  if (created.length) {
    notifyAdmins({
      type: 'LEAVE',
      title: `${created.length} auto-flagged absence${created.length > 1 ? 's' : ''}`,
      body: `${created.join(', ')} didn't clock in on ${day}. Review in the leave approvals.`,
      link: 'leaves',
    });
    console.log(`Auto-absence: created ${created.length} pending leave(s) for ${day} — ${created.join(', ')}.`);
  }
  return created.length;
}

// Run once a day at ABSENCE_CHECK_HOUR (office zone; default 10 AM, safely after
// the 8 AM shift cutover), checking the shift that just completed.
function startAbsenceScheduler() {
  if (String(process.env.AUTO_ABSENCE || 'on').toLowerCase() === 'off') {
    console.log('Auto-absence flagging: disabled (AUTO_ABSENCE=off).');
    return;
  }
  const hour = Math.min(23, Math.max(0, Number(process.env.ABSENCE_CHECK_HOUR ?? 10)));
  const scheduleNext = () => {
    const n = now();
    let next = n.set({ hour, minute: 0, second: 0, millisecond: 0 });
    if (next <= n) next = next.plus({ days: 1 });
    setTimeout(() => {
      try { flagAbsences(); } catch (e) { console.error('Auto-absence run failed:', e.message); }
      scheduleNext();
    }, next.toMillis() - n.toMillis()).unref();
    console.log(`Auto-absence flagging scheduled for ${next.toFormat('yyyy-LL-dd HH:mm')} (${ZONE}).`);
  };
  scheduleNext();
}

module.exports = { flagAbsences, startAbsenceScheduler, lastCompletedAttendanceDay };
