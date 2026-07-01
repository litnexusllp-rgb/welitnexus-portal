'use strict';

// Time helpers anchored to the office timezone so "today" is consistent
// for everyone regardless of where the server runs.

const { DateTime } = require('luxon');

const ZONE = process.env.TZ_OFFICE || 'Asia/Kolkata';

function now() {
  return DateTime.now().setZone(ZONE);
}

function todayStr() {
  return now().toFormat('yyyy-LL-dd');
}

// yyyy-LL-dd for a given epoch ms, in the office zone.
function dayFromTs(ts) {
  return DateTime.fromMillis(ts).setZone(ZONE).toFormat('yyyy-LL-dd');
}

// Inclusive count of weekday-aware days between two yyyy-LL-dd strings.
// Counts every calendar day (weekends included) — kept simple and predictable.
function inclusiveDays(startStr, endStr) {
  const start = DateTime.fromISO(startStr, { zone: ZONE });
  const end = DateTime.fromISO(endStr, { zone: ZONE });
  if (!start.isValid || !end.isValid || end < start) return 0;
  return Math.round(end.diff(start, 'days').days) + 1;
}

// ---- Attendance "shift day" helpers ----------------------------------------
// A shift can run past midnight (e.g. 4 PM–2 AM), so an attendance day is not a
// calendar day. It runs from the cutover hour (default 8 AM — a quiet point
// between shifts) to the same hour next day. Everything before the cutover
// belongs to the PREVIOUS attendance day (the tail of the overnight shift).
const ATT_CUTOVER = () => Math.min(23, Math.max(0, Number(process.env.ATTENDANCE_CUTOVER_HOUR ?? 8)));

// The attendance date (yyyy-LL-dd) that an epoch-ms timestamp belongs to.
function attendanceDayFromTs(ts) {
  return DateTime.fromMillis(ts).setZone(ZONE).minus({ hours: ATT_CUTOVER() }).toFormat('yyyy-LL-dd');
}
// The attendance date that "now" is in.
function attendanceToday() {
  return now().minus({ hours: ATT_CUTOVER() }).toFormat('yyyy-LL-dd');
}
// [startMs, endMs) window for a given attendance date string.
function attendanceWindow(dateStr) {
  const s = DateTime.fromISO(dateStr, { zone: ZONE }).set({ hour: ATT_CUTOVER(), minute: 0, second: 0, millisecond: 0 });
  return { startMs: s.toMillis(), endMs: s.plus({ days: 1 }).toMillis() };
}

module.exports = {
  ZONE, now, todayStr, dayFromTs, inclusiveDays, DateTime,
  ATT_CUTOVER, attendanceDayFromTs, attendanceToday, attendanceWindow,
};
