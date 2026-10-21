'use strict';

const { db } = require('./db');
const { DateTime, ZONE, now, todayStr, inclusiveDays } = require('./time');

const EFFECTIVE = '2026-10-01';
const ENTITLEMENT = Object.freeze({ regular: 18, flexi: 1, special: 1 });
const CATEGORIES = Object.freeze({ REGULAR: 'Regular paid leave', FLEXI: 'Flexi leave', BIRTHDAY: 'Birthday leave', ANNIVERSARY: 'Anniversary leave' });
const bucketFor = category => category === 'FLEXI' ? 'flexi' : ['BIRTHDAY', 'ANNIVERSARY'].includes(category) ? 'special' : 'regular';
const getUser = db.prepare('SELECT id, leave_balance FROM users WHERE id=?');
const getLeaves = db.prepare("SELECT * FROM leaves WHERE user_id=? AND status IN ('PENDING','APPROVED') AND start_date<=? AND end_date>=?");

function periodFor(date = todayStr()) {
  const d = DateTime.fromISO(date, { zone: ZONE });
  const year = d.month >= 10 ? d.year : d.year - 1;
  return { start: `${year}-10-01`, end: `${year + 1}-09-30`, nextReset: `${year + 1}-10-01` };
}

// Payment treatment is calculated per actual leave date, including ranges that
// cross a month or leave-year boundary. Existing calendar-day counting remains.
function describeLeave(leave) {
  const category = leave.category || 'REGULAR';
  const charges = {};
  let paid = 0, unpaid = 0;
  let date = DateTime.fromISO(leave.start_date, { zone: ZONE });
  const end = DateTime.fromISO(leave.end_date, { zone: ZONE });
  if (!date.isValid || !end.isValid || end < date) return { ...leave, category, paid_days: 0, unpaid_days: 0, pay_status: 'REVIEW', charges: [] };
  while (date <= end) {
    const iso = date.toISODate(), amount = leave.kind === 'HALF' ? 0.5 : 1;
    if (iso >= EFFECTIVE && date.day <= 12) unpaid += amount;
    else {
      paid += amount;
      const period = periodFor(iso).start, bucket = bucketFor(category), key = `${period}:${bucket}`;
      charges[key] ||= { period, bucket, days: 0 };
      charges[key].days += amount;
    }
    if (leave.kind === 'HALF') break;
    date = date.plus({ days: 1 });
  }
  return { ...leave, category, paid_days: paid, unpaid_days: unpaid, pay_status: unpaid ? (paid ? 'MIXED' : 'UNPAID') : 'PAID', charges: Object.values(charges) };
}

function balances(userId, date = todayStr(), excludeRequestId = null) {
  const period = periodFor(date), user = getUser.get(userId);
  if (!user) throw Object.assign(new Error('Employee not found'), { status: 404 });
  const buckets = Object.fromEntries(Object.entries(ENTITLEMENT).map(([key, entitlement]) => [key, { entitlement, used: 0, pending: 0, remaining: entitlement, available: entitlement }]));
  for (const leave of getLeaves.all(userId, period.end, period.start)) {
    if (leave.id === excludeRequestId) continue;
    for (const c of describeLeave(leave).charges) {
      if (c.period !== period.start) continue;
      buckets[c.bucket][leave.status === 'APPROVED' ? 'used' : 'pending'] += c.days;
    }
  }
  for (const b of Object.values(buckets)) { b.remaining = b.entitlement - b.used; b.available = b.remaining - b.pending; }
  const total = key => Object.values(buckets).reduce((n, b) => n + b[key], 0);
  return { period, buckets, balance: total('remaining'), pending: total('pending'), available: total('available'), entitlement: 20, effective: EFFECTIVE };
}

// Rebuild the compatibility total from approved records, never from repeated
// deductions. A unique reset marker retains the pre-reset amount for audit.
function syncBalance(userId) {
  let result;
  if (todayStr() >= EFFECTIVE) {
    const sync = db.transaction(() => {
      result = balances(userId);
      const previous = getUser.get(userId).leave_balance;
      db.prepare('INSERT OR IGNORE INTO leave_balance_resets(user_id,period_start,previous_balance,entitlement_json,recorded_ts) VALUES(?,?,?,?,?)')
        .run(userId, result.period.start, previous, JSON.stringify(ENTITLEMENT), now().toMillis());
      db.prepare('UPDATE users SET leave_balance=? WHERE id=? AND leave_balance<>?').run(result.balance, userId, result.balance);
    });
    sync.immediate();
  } else result = balances(userId);
  return result;
}
function syncAllBalances() {
  for (const u of db.prepare('SELECT id FROM users').all()) syncBalance(u.id);
}

function normalizeLeave(body, { allowPast = false, requireReason = true } = {}) {
  const start_date = String(body.start_date || ''), kind = String(body.kind || 'FULL').toUpperCase();
  const end_date = kind === 'HALF' ? start_date : String(body.end_date || start_date);
  const category = String(body.category || 'REGULAR').toUpperCase();
  const reason = String(body.reason || '').trim().slice(0, 500);
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!['FULL', 'HALF'].includes(kind)) fail('Choose full day or half day.');
  if (!Object.hasOwn(CATEGORIES, category)) fail('Choose a valid leave category.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) fail('Invalid date range.');
  const span = inclusiveDays(start_date, end_date);
  if (!span || span > 366) fail('Choose a valid date range of up to one year.');
  if (!allowPast && start_date < todayStr()) fail('Leave cannot start in the past.');
  if (requireReason && category !== 'FLEXI' && !reason) fail('Please give a reason for your leave.');
  if (category === 'FLEXI') {
    let date = DateTime.fromISO(start_date, { zone: ZONE });
    const end = DateTime.fromISO(end_date, { zone: ZONE });
    while (date <= end) {
      if (date.day <= 15) fail('Flexi leave is available only after the 15th of a month.');
      date = date.plus({ days: 1 });
    }
  }
  return { start_date, end_date, kind, category, reason, days: kind === 'HALF' ? 0.5 : span };
}

function assertAvailable(userId, leave, excludeRequestId = null) {
  for (const charge of describeLeave(leave).charges) {
    if (charge.period < EFFECTIVE) continue;
    const b = balances(userId, charge.period, excludeRequestId).buckets[charge.bucket];
    if (charge.days > b.available) throw Object.assign(new Error(`Not enough ${charge.bucket === 'special' ? 'birthday / anniversary' : charge.bucket} leave for the year starting ${charge.period}. Available: ${b.available} day(s); requested: ${charge.days}.`), { status: 409 });
  }
}

module.exports = { EFFECTIVE, ENTITLEMENT, CATEGORIES, periodFor, describeLeave, balances, syncBalance, syncAllBalances, normalizeLeave, assertAvailable };
