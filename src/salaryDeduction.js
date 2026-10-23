'use strict';

const { db } = require('./db');
const { DateTime, ZONE, now, todayStr } = require('./time');
const { EFFECTIVE } = require('./leavePolicy');

const salaryRows = db.prepare('SELECT id, effective_from, monthly_gross_paise, currency FROM employee_salary_rates WHERE user_id=? ORDER BY effective_from DESC');
const salaryOnDate = db.prepare('SELECT * FROM employee_salary_rates WHERE user_id=? AND effective_from=?');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };

// Parse decimal rupees without a floating-point multiplication. Missing salary
// means unknown, never an invented zero. Zero can be entered deliberately.
function validateSalary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Enter a valid salary and effective date.');
  const amount = String(input.monthly_gross ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount)) fail('Monthly gross salary must be a non-negative rupee amount with up to 2 decimal places.');
  const [rupees, decimals = ''] = amount.split('.');
  const monthly_gross_paise = Number(rupees) * 100 + Number(decimals.padEnd(2, '0'));
  const effective_from = String(input.effective_from || '');
  const date = DateTime.fromISO(effective_from, { zone: ZONE });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_from) || !date.isValid || date.toISODate() !== effective_from) fail('Choose a valid salary effective date.');
  if (input.currency != null && input.currency !== 'INR') fail('Salary amounts must be entered in INR.');
  return { effective_from, monthly_gross_paise, currency: 'INR' };
}

function saveSalary(userId, input, adminId) {
  const salary = validateSalary(input);
  return db.transaction(() => {
    const before = salaryOnDate.get(userId, salary.effective_from);
    if (before && before.monthly_gross_paise === salary.monthly_gross_paise && before.currency === salary.currency) return;
    db.prepare(`INSERT INTO employee_salary_rates(user_id,effective_from,monthly_gross_paise,currency,updated_by,updated_ts) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,effective_from) DO UPDATE SET monthly_gross_paise=excluded.monthly_gross_paise,currency=excluded.currency,updated_by=excluded.updated_by,updated_ts=excluded.updated_ts`)
      .run(userId, salary.effective_from, salary.monthly_gross_paise, salary.currency, adminId, now().toMillis());
    db.prepare('INSERT INTO salary_rate_changes(user_id,effective_from,before_json,after_json,changed_by,changed_ts) VALUES(?,?,?,?,?,?)')
      .run(userId, salary.effective_from, before ? JSON.stringify(before) : null, JSON.stringify(salaryOnDate.get(userId, salary.effective_from)), adminId, now().toMillis());
  }).immediate();
}

function salaryHistory(userId) {
  const rates = salaryRows.all(userId);
  return { rates, current: rates.find(rate => rate.effective_from <= todayStr()) || null, latest: rates[0] || null, currency: 'INR', basis: 'MONTHLY_GROSS', divisor: 30 };
}

// Company-confirmed rule: monthly gross / 30 * unpaid days. Use the gross rate
// effective on each leave date. Half-day units keep the numerator exact; round
// the complete request once to paise, rather than rounding a daily rate first.
function estimateDeduction(userId, leave) {
  const rates = salaryRows.all(userId), groups = new Map(), missing = [];
  let date = DateTime.fromISO(leave.start_date, { zone: ZONE });
  const end = DateTime.fromISO(leave.end_date, { zone: ZONE });
  if (!date.isValid || !end.isValid || end < date) fail('Invalid date range for deduction estimate.');
  let numerator = 0, units = 0;
  while (date <= end) {
    const iso = date.toISODate();
    if (iso >= EFFECTIVE && date.day <= 12) {
      const dayUnits = leave.kind === 'HALF' ? 1 : 2;
      units += dayUnits;
      const rate = rates.find(rate => rate.effective_from <= iso);
      if (!rate) missing.push(iso);
      else {
        const month = iso.slice(0, 7), key = `${month}:${rate.id}`;
        if (!groups.has(key)) groups.set(key, { month, effective_from: rate.effective_from, monthly_gross_paise: rate.monthly_gross_paise, unpaid_half_day_units: 0, dates: [] });
        const group = groups.get(key); group.unpaid_half_day_units += dayUnits; group.dates.push(iso);
        numerator += rate.monthly_gross_paise * dayUnits;
      }
    }
    if (leave.kind === 'HALF') break;
    date = date.plus({ days: 1 });
  }
  return { version: 1, basis: 'MONTHLY_GROSS', divisor: 30, currency: 'INR', estimated_ts: now().toMillis(),
    status: missing.length ? 'MISSING_SALARY' : 'AVAILABLE', unpaid_days: units / 2,
    total_paise: missing.length ? null : Math.round(numerator / 60),
    items: [...groups.values()].map(group => ({ ...group, unpaid_days: group.unpaid_half_day_units / 2 })), missing_salary_dates: missing };
}

function savedDeduction(leave) {
  if (!leave.deduction_quote_json) return null;
  try { return JSON.parse(leave.deduction_quote_json); } catch (_e) { return null; }
}

module.exports = { validateSalary, saveSalary, salaryHistory, estimateDeduction, savedDeduction };
