'use strict';
const { db } = require('./db');
const { validateEvents } = require('./compute');
const events = db.prepare('SELECT type, ts FROM events WHERE user_id=? AND day=? ORDER BY ts,id');

function validateDay(userId, day) {
  const error = validateEvents(events.all(userId, day));
  if (error) throw Object.assign(new Error(error), { status: 409, attendanceValidation: true });
}

// Validate after the proposed mutation inside the same transaction. Throwing
// rolls back inserts, edits, deletions and approval decisions together.
function changeAttendance(userId, days, change) {
  return db.transaction(() => {
    const result = change();
    for (const day of new Set(days)) validateDay(userId, day);
    return result;
  })();
}
function attendanceError(e, res) {
  if (!e.attendanceValidation) throw e;
  return res.status(e.status).json({ error: e.message });
}
module.exports = { changeAttendance, attendanceError, validateDay };
