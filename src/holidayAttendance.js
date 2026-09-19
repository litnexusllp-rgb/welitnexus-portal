'use strict';

function halfHolidayStatus({ clockedIn, leaveKind, weekend }) {
  if (leaveKind) return 'HALF_HOLIDAY_LEAVE';
  if (clockedIn) return 'HALF_HOLIDAY_PRESENT';
  return weekend ? 'HALF_HOLIDAY_WEEKEND' : 'HALF_HOLIDAY_ABSENT';
}

function addAttendanceTotals(totals, status, workedMinutes = 0) {
  if (status.startsWith('HALF_HOLIDAY_')) {
    totals.holiday = (totals.holiday || 0) + 0.5;
    const key = status.slice('HALF_HOLIDAY_'.length).toLowerCase();
    totals[key] = (totals[key] || 0) + 0.5;
  } else if (status === 'HALF') { totals.present += 0.5; totals.leave += 0.5; }
  else {
    const key = status.toLowerCase();
    if (['present', 'leave', 'absent', 'holiday', 'weekend'].includes(key)) totals[key] = (totals[key] || 0) + 1;
  }
  if ('workedMinutes' in totals) totals.workedMinutes += workedMinutes;
}

module.exports = { halfHolidayStatus, addAttendanceTotals };
