'use strict';

const { db } = require('./db');
const { DateTime, ZONE, now, todayStr } = require('./time');
const { calculationFor } = require('./leavePolicy');
const { VERSION } = require('./leaveCalculation');

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
  return { rates, current: rates.find(rate => rate.effective_from <= todayStr()) || null, latest: rates[0] || null, currency: 'INR', basis: 'MONTHLY_GROSS', day_basis: 'CALENDAR_MONTH' };
}

// Use the actual calendar length of each leave month and its effective salary.
// A common denominator for 28/29/30/31-day months and half days keeps even
// cross-month requests exact. Round the complete request once to paise.
function estimateDeduction(userId, leave) {
  const rates = salaryRows.all(userId), groups = new Map(), missing = [];
  const calculated = calculationFor(userId, leave).result;
  if (calculated.pay_status === 'REVIEW') fail('Invalid date range for deduction estimate.');
  const denominator = 2n * 28n * 29n * 30n * 31n;
  let numerator = 0n, units = 0;
  for (const line of calculated.date_lines) {
    const iso = line.date, date = DateTime.fromISO(iso, { zone: ZONE });
    if (line.unpaid_days) {
      const dayUnits = line.unpaid_days * 2;
      units += dayUnits;
      const rate = rates.find(rate => rate.effective_from <= iso);
      if (!rate) missing.push(iso);
      else {
        const month = iso.slice(0, 7), key = `${month}:${rate.id}`;
        if (!groups.has(key)) groups.set(key, { month, divisor: date.daysInMonth, effective_from: rate.effective_from, monthly_gross_paise: rate.monthly_gross_paise, unpaid_half_day_units: 0, dates: [] });
        const group = groups.get(key); group.unpaid_half_day_units += dayUnits; group.dates.push(iso);
        numerator += BigInt(rate.monthly_gross_paise) * BigInt(dayUnits) * (denominator / BigInt(2 * date.daysInMonth));
      }
    }
  }
  return { version: VERSION, basis: 'MONTHLY_GROSS', day_basis: 'CALENDAR_MONTH', currency: 'INR', estimated_ts: now().toMillis(),
    status: missing.length ? 'MISSING_SALARY' : 'AVAILABLE', unpaid_days: units / 2,
    total_paise: missing.length ? null : Number((numerator + denominator / 2n) / denominator),
    items: [...groups.values()].map(group => ({ ...group, unpaid_days: group.unpaid_half_day_units / 2 })), missing_salary_dates: missing };
}

function savedDeduction(leave) {
  if (!leave.deduction_quote_json) return null;
  try { return JSON.parse(leave.deduction_quote_json); } catch (_e) { return null; }
}

module.exports = { validateSalary, saveSalary, salaryHistory, estimateDeduction, savedDeduction };
