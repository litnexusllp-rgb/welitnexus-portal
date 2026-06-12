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

module.exports = { ZONE, now, todayStr, dayFromTs, inclusiveDays, DateTime };
