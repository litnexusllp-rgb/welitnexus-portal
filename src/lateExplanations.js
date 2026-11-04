'use strict';

const { db } = require('./db');
const { now } = require('./time');

const setLateNormalOverride = db.prepare(`
  INSERT INTO attendance_day_overrides (user_id, day, ignore_late, updated_by, updated_ts)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, day) DO UPDATE SET
    ignore_late = excluded.ignore_late,
    full_day = CASE WHEN excluded.ignore_late = 0 THEN 0 ELSE attendance_day_overrides.full_day END,
    updated_by = excluded.updated_by,
    updated_ts = excluded.updated_ts
`);

const decide = db.prepare(`
  UPDATE late_explanations SET status=?, resolution=?, decided_by=?, decided_ts=?
  WHERE user_id=? AND day=? AND status='PENDING'
`);

function resolveLateExplanation(userId, day, adminId, resolution, timestamp = now().toMillis()) {
  decide.run('RESOLVED', resolution, adminId, timestamp, userId, day);
}

function markFullDay(userId, day, adminId) {
  const timestamp = now().toMillis();
  setLateNormalOverride.run(userId, day, 1, adminId, timestamp);
  db.prepare('UPDATE attendance_day_overrides SET full_day=1 WHERE user_id=? AND day=?').run(userId, day);
  resolveLateExplanation(userId, day, adminId, 'FULL_DAY', timestamp);
}

function approveLateExplanation(userId, day, adminId) {
  const timestamp = now().toMillis();
  const result = decide.run('APPROVED', 'EXCUSED', adminId, timestamp, userId, day);
  if (result.changes) setLateNormalOverride.run(userId, day, 1, adminId, timestamp);
  return result.changes === 1;
}

module.exports = { setLateNormalOverride, resolveLateExplanation, approveLateExplanation, markFullDay };
