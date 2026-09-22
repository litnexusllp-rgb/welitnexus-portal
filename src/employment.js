'use strict';
const { DateTime, ZONE } = require('./time');
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: ZONE }).isValid;
function employmentError(join, exit) {
  if (join && !validDate(join)) return 'Enter a valid joining date.';
  if (exit && !validDate(exit)) return 'Enter a valid last working day.';
  if (join && exit && exit < join) return 'Last working day cannot be before joining date.';
  return null;
}
function employmentStatus(user, day) {
  if (employmentError(user.join_date, user.exit_date)) return 'EMPLOYMENT_UNKNOWN';
  if ((user.join_date && day < user.join_date) || (user.exit_date && day > user.exit_date)) return 'NOT_EMPLOYED';
  if (!user.join_date || (!user.active && !user.exit_date)) return 'EMPLOYMENT_UNKNOWN';
  return null;
}
function overlapsEmployment(user, start, end) {
  return (!validDate(user.join_date) || user.join_date <= end) && (!validDate(user.exit_date) || user.exit_date >= start);
}
module.exports = { employmentError, employmentStatus, overlapsEmployment };
