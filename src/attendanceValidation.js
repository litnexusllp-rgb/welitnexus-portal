'use strict';
const { db } = require('./db');
const { validateEvents } = require('./compute');
const events = db.prepare('SELECT type, ts FROM events WHERE user_id=? AND day=? ORDER BY ts,id');
const overlapping = db.prepare('SELECT 1 FROM events WHERE user_id=? AND day<>? GROUP BY day HAVING MIN(ts)<=? AND MAX(ts)>=? LIMIT 1');

function validateDay(userId, day) {
  const rows = events.all(userId, day);
  let error = validateEvents(rows);
  if (!error && rows.length && overlapping.get(userId, day, rows[rows.length - 1].ts, rows[0].ts)) error = 'Punches overlap another attendance workday. Correct the complete session.';
  if (!error) {
    const { attendanceDayFromTs } = require('./time');
    const { daySettings } = require('./attendanceSession');
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const config = daySettings(user, day);
    if (rows.some(e => e.type === 'IN' && attendanceDayFromTs(e.ts, config) !== day)) error = 'Clock-in must belong to the selected local attendance workday.';
  }
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
