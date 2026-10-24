'use strict';

const { DateTime, ZONE, now, todayStr } = require('./time');
const { EFFECTIVE } = require('./leavePolicy');
const { employmentError, overlapsEmployment } = require('./employment');

const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value, { zone: ZONE }).isValid;
function monthRange(month) {
  const first = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? DateTime.fromISO(month + '-01', { zone: ZONE }) : null;
  if (!first?.isValid) throw Object.assign(new Error('Choose a valid salary month.'), { status: 400 });
  return { month, start: first.toISODate(), end: first.endOf('month').toISODate() };
}

// Read-only salary worksheet. Recalculate approved leave at the salary rate
// effective on each leave date, never by adding stale request-time quotes.
function buildSalaries(db, month = todayStr().slice(0, 7)) {
  const period = monthRange(month);
  return db.transaction(() => {
    const users = db.prepare(`SELECT id,name,emp_code,department,active,join_date,exit_date
      FROM users WHERE role='EMPLOYEE' ORDER BY name COLLATE NOCASE`).all()
      .filter(user => overlapsEmployment(user, period.start, period.end));
    const salaries = db.prepare('SELECT user_id,effective_from,monthly_gross_paise FROM employee_salary_rates WHERE effective_from<=? ORDER BY effective_from DESC').all(period.end);
    const leaves = db.prepare(`SELECT id,user_id,start_date,end_date,kind,category,status FROM leaves
      WHERE status IN ('APPROVED','PENDING') AND start_date<=? AND end_date>=? ORDER BY start_date,id`).all(period.end, period.start);
    const rows = users.map(user => employeeSalary(user, period, salaries.filter(s => s.user_id === user.id), leaves.filter(l => l.user_id === user.id)));
    const calculated = rows.filter(row => row.status === 'CALCULATED');
    return { ...period, currency: 'INR', divisor: 30, basis: 'MONTHLY_GROSS', calculated_ts: now().toMillis(),
      period_state: month < todayStr().slice(0, 7) ? 'ENDED' : month === todayStr().slice(0, 7) ? 'IN_PROGRESS' : 'UPCOMING',
      scope: 'Monthly gross less approved unpaid leave only. Tax, bonuses, attendance penalties and other adjustments are not included.',
      totals: { employees: rows.length, calculated: calculated.length, review: rows.length - calculated.length,
        pending_requests: rows.reduce((sum, row) => sum + row.pending_requests, 0),
        gross_paise: calculated.reduce((sum, row) => sum + row.monthly_gross_paise, 0),
        deduction_paise: calculated.reduce((sum, row) => sum + row.deduction_paise, 0),
        salary_to_pay_paise: calculated.reduce((sum, row) => sum + row.salary_to_pay_paise, 0) }, rows };
  }).deferred();
}

function employeeSalary(user, period, rates, leaves) {
  const reasons = new Set(), days = new Map(), rateLines = new Map(), deductionLines = new Map();
  const invalidEmployment = employmentError(user.join_date, user.exit_date);
  if (invalidEmployment || !user.join_date || (!user.active && !user.exit_date)) reasons.add('Confirm the joining and last working dates.');
  const from = validDay(user.join_date) && user.join_date > period.start ? user.join_date : period.start;
  const to = validDay(user.exit_date) && user.exit_date < period.end ? user.exit_date : period.end;
  if (from !== period.start || to !== period.end) reasons.add('Part-month employment: review the salary adjustment.');
  let date = DateTime.fromISO(from, { zone: ZONE }), missingSalaryDays = 0, employedDays = 0;
  while (date.toISODate() <= to) {
    const iso = date.toISODate(), rate = rates.find(rate => rate.effective_from <= iso);
    employedDays++;
    days.set(iso, { rate, units: 0 });
    if (!rate) missingSalaryDays++;
    else {
      const key = rate.effective_from;
      if (!rateLines.has(key)) rateLines.set(key, { effective_from: key, monthly_gross_paise: rate.monthly_gross_paise, from: iso, to: iso, calendar_days: 0 });
      const line = rateLines.get(key); line.to = iso; line.calendar_days++;
    }
    date = date.plus({ days: 1 });
  }
  if (missingSalaryDays) reasons.add(`Salary is missing for ${missingSalaryDays} employed calendar day(s).`);
  const amounts = new Set([...rateLines.values()].map(line => line.monthly_gross_paise));
  if (amounts.size > 1) reasons.add('Salary changed during this month: review the monthly gross calculation.');
  let invalidLeave = false;
  const approved = leaves.filter(leave => leave.status === 'APPROVED');
  const leaveLines = [];
  for (const leave of approved) {
    if (!validDay(leave.start_date) || !validDay(leave.end_date) || leave.end_date < leave.start_date || !['FULL','HALF'].includes(leave.kind)) {
      invalidLeave = true; reasons.add(`Review invalid approved leave #${leave.id}.`); continue;
    }
    if (leave.kind === 'HALF' && leave.start_date < period.start) continue;
    const line = { ...leave, paid_days: 0, unpaid_days: 0 };
    const start = leave.start_date > period.start ? leave.start_date : period.start;
    const end = leave.kind === 'HALF' ? leave.start_date : leave.end_date < period.end ? leave.end_date : period.end;
    let day = DateTime.fromISO(start, { zone: ZONE });
    while (day.toISODate() <= end && day.toISODate() <= period.end) {
      const iso = day.toISODate(), record = days.get(iso), units = leave.kind === 'HALF' ? 1 : 2;
      if (!record) reasons.add(`Approved leave #${leave.id} falls outside employment dates.`);
      else {
        if (record.units) reasons.add('Approved leave overlaps: confirm the records before payment.');
        record.units = Math.min(2, record.units + units);
        if (iso >= EFFECTIVE && day.day <= 12) line.unpaid_days += units / 2;
        else line.paid_days += units / 2;
      }
      day = day.plus({ days: 1 });
    }
    leaveLines.push(line);
  }
  let numerator = 0, unpaid = 0, paid = 0, missingDeductionSalary = false;
  for (const [iso, day] of days) {
    if (!day.units) continue;
    if (iso < EFFECTIVE || Number(iso.slice(8, 10)) > 12) { paid += day.units / 2; continue; }
    unpaid += day.units / 2;
    if (!day.rate) { missingDeductionSalary = true; continue; }
    numerator += day.rate.monthly_gross_paise * day.units;
    const key = day.rate.effective_from;
    if (!deductionLines.has(key)) deductionLines.set(key, { effective_from: key, monthly_gross_paise: day.rate.monthly_gross_paise, unpaid_days: 0, dates: [] });
    const line = deductionLines.get(key); line.unpaid_days += day.units / 2; line.dates.push(iso);
  }
  const deduction = missingDeductionSalary || invalidLeave ? null : Math.round(numerator / 60);
  const gross = !missingSalaryDays && amounts.size === 1 ? [...amounts][0] : null;
  const reference = gross !== null && deduction !== null ? gross - deduction : null;
  const status = reasons.size || reference === null ? 'REVIEW' : 'CALCULATED';
  return { id: user.id, name: user.name, emp_code: user.emp_code, department: user.department,
    active: user.active, join_date: user.join_date, exit_date: user.exit_date,
    employed_from: from, employed_to: to, employed_calendar_days: employedDays,
    monthly_gross_paise: gross, paid_leave_days: paid, unpaid_leave_days: unpaid, deduction_paise: deduction,
    salary_to_pay_paise: status === 'CALCULATED' ? reference : null,
    full_month_reference_after_leave_paise: status === 'REVIEW' ? reference : null,
    status, review_reasons: [...reasons], pending_requests: leaves.filter(leave => leave.status === 'PENDING').length,
    rate_lines: [...rateLines.values()], deduction_lines: [...deductionLines.values()], approved_leaves: leaveLines };
}

module.exports = { buildSalaries, monthRange };
