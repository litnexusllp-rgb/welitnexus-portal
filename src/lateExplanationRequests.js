'use strict';

const { db } = require('./db');
const { now, attendanceToday } = require('./time');
const { settings, daySettings, shiftInstant } = require('./attendanceSession');
const { calendarFrom, scheduledDays } = require('./leaveCalculation');
const { notify } = require('./notify');

const getUser = db.prepare('SELECT * FROM users WHERE id=?');
const insert = db.prepare(`INSERT INTO late_explanation_requests
  (user_id,day,created_ts,first_in,expected_start,timezone,minutes_late)
  VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,day) DO NOTHING`);

// Resolve the report lazily: its router also uses the decision helpers. This
// keeps eligibility identical to the calendar without a module-loading cycle.
function attendanceRows(user, start, end) {
  return require('./routes/reports').buildAttendanceReport(user, { user, query: { start, end } }).rows;
}

function eligible(user, row, calendar) {
  return Boolean(
    user?.role === 'EMPLOYEE' &&
      user.active &&
      row?.late &&
      !row.leaveKind &&
      !row.approvedShortDay &&
      scheduledDays(row.day, calendar),
  );
}

function eligibleRow(user, day) {
  if (!user || user.role !== 'EMPLOYEE' || !user.active) return null;
  const calendar = calendarFrom(db);
  if (!scheduledDays(day, calendar)) return null;
  const row = attendanceRows(user, day, day)[0];
  return eligible(user, row, calendar) ? row : null;
}

function requestForDay(userId, day) {
  const user = getUser.get(userId);
  const row = eligibleRow(user, day);
  if (!row || row.lateExplanation) return false;
  const result = insert.run(
    userId,
    day,
    now().toMillis(),
    row.firstIn,
    shiftInstant(day, daySettings(user, day)),
    row.timezone,
    row.minutesLate,
  );
  if (!result.changes) return false;
  notify(userId, {
    type: 'PUNCH',
    title: 'Please explain your late clock-in',
    body: `${day}: your clock-in was after your shift's grace period. Add your comments for admin review.`,
    link: 'dashboard',
  });
  return true;
}

function processRequest(userId, day, adminId, resolution, timestamp = now().toMillis()) {
  return db
    .prepare(
      `UPDATE late_explanation_requests SET processed_ts=?,processed_by=?,resolution=?
    WHERE user_id=? AND day=? AND processed_ts IS NULL`,
    )
    .run(timestamp, adminId, resolution, userId, day).changes;
}

function outstanding(userId) {
  const user = getUser.get(userId);
  return db
    .prepare(
      `SELECT day FROM late_explanation_requests
    WHERE user_id=? AND processed_ts IS NULL ORDER BY day DESC`,
    )
    .all(userId)
    .map(({ day }) => eligibleRow(user, day))
    .filter((row) => row && !row.lateExplanation);
}

function requestReport(start, end, userId = null) {
  const rows = db
    .prepare(
      `SELECT r.*,u.name,e.reason,e.created_ts AS submitted_ts,
      p.name AS processed_by_name FROM late_explanation_requests r
    JOIN users u ON u.id=r.user_id
    LEFT JOIN users p ON p.id=r.processed_by
    LEFT JOIN late_explanations e ON e.user_id=r.user_id AND e.day=r.day
    WHERE r.day BETWEEN ? AND ? AND (? IS NULL OR r.user_id=?)
    ORDER BY r.day DESC,u.name,r.user_id`,
    )
    .all(start, end, userId, userId);
  const totals = {
    generated: rows.length,
    submitted: 0,
    processed: 0,
    awaitingEmployee: 0,
    awaitingReview: 0,
    noLongerRequired: 0,
  };
  const calendar = calendarFrom(db);
  const currentRows = new Map();
  const stillRequired = (request) => {
    if (!currentRows.has(request.user_id)) {
      const user = getUser.get(request.user_id);
      currentRows.set(
        request.user_id,
        new Map(
          user?.role === 'EMPLOYEE' && user.active
            ? attendanceRows(user, start, end).map((row) => [row.day, eligible(user, row, calendar)])
            : [],
        ),
      );
    }
    return currentRows.get(request.user_id).get(request.day);
  };
  for (const row of rows) {
    if (row.submitted_ts != null) totals.submitted++;
    if (row.processed_ts != null) {
      totals.processed++;
      row.state = 'Processed';
    } else if (!stillRequired(row)) {
      totals.noLongerRequired++;
      row.state = 'No longer required';
    } else if (row.submitted_ts != null) {
      totals.awaitingReview++;
      row.state = 'Awaiting review';
    } else {
      totals.awaitingEmployee++;
      row.state = 'Awaiting employee';
    }
  }
  return { start, end, totals, rows };
}

// On startup and periodically, cover only each employee's current workday.
// Historical requests are never silently backfilled on deployment.
function requestCurrentDays() {
  for (const user of db.prepare("SELECT * FROM users WHERE active=1 AND role='EMPLOYEE'").all()) {
    db.transaction(() => requestForDay(user.id, attendanceToday(settings(user)))).immediate();
  }
}

function startLateRequestScheduler() {
  const run = () => {
    try {
      requestCurrentDays();
    } catch (error) {
      console.error('Late explanation requests:', error);
    }
  };
  run();
  const timer = setInterval(run, 60000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  requestForDay,
  processRequest,
  outstanding,
  requestReport,
  requestCurrentDays,
  startLateRequestScheduler,
};
