'use strict';

const { buildSalaries } = require('./salaries');

function slipEligibility(report, row) {
  if (!row) return 'No employment records for this month.';
  if (report.period_state !== 'ENDED') return 'Salary slips are available after the month has ended.';
  if (!['CALCULATED', 'REVIEWED'].includes(row.status) || !Number.isSafeInteger(row.salary_to_pay_paise)) return 'An admin needs to complete the salary review for this month.';
  if (row.pending_requests) return 'Pending leave requests must be resolved before downloading this salary slip.';
  return null;
}

function withSalarySlips(report, own = false) {
  return { ...report, rows: report.rows.map(row => {
    const reason = slipEligibility(report, row);
    return { ...row, salary_slip: { available: reason === null, reason,
      url: reason ? null : `/api/salaries/${own ? 'mine' : row.id}/slip?month=${report.month}` } };
  }) };
}

// Query only the authenticated employee's sources, then explicitly remove
// administrative confirmation notes, actor identities and write tokens.
function employeeSalaryReport(db, userId, month) {
  const report = buildSalaries(db, month, userId);
  const rows = report.rows.map(row => {
    const { source_fingerprint, review, ...fields } = row;
    return { ...fields, review: row.status === 'REVIEWED' && review?.state === 'CONFIRMED'
      ? { amount_paise: review.amount_paise, reviewed_ts: review.reviewed_ts, state: review.state } : null };
  });
  return withSalarySlips({ ...report, rows, employee_view: true }, true);
}

module.exports = { slipEligibility, withSalarySlips, employeeSalaryReport };
