'use strict';

const { db } = require('./db');
const { DateTime, ZONE, now, todayStr, inclusiveDays } = require('./time');

const { EFFECTIVE, ENTITLEMENT, MONTHLY_REGULAR, periodFor: leavePeriod, calendarFrom, scheduledDays, shortDayCharges, calculateLeaves } = require('./leaveCalculation');
const CATEGORIES = Object.freeze({ REGULAR: 'Regular leave', FLEXI: 'Flexi leave', BIRTHDAY: 'Birthday leave', ANNIVERSARY: 'Anniversary leave' });
const getUser = db.prepare('SELECT id, leave_balance FROM users WHERE id=?');
const getLeaves = db.prepare("SELECT * FROM leaves WHERE user_id=? AND status IN ('PENDING','APPROVED') ORDER BY start_date,id");
const getShortDays = db.prepare("SELECT id,user_id,date,status FROM short_day_requests WHERE user_id=? AND status='APPROVED' AND date>=?");
const periodFor = (date = todayStr()) => leavePeriod(date);

function calculationFor(userId, candidate = null, excludeRequestId = null) {
  const leaves = getLeaves.all(userId).filter(l => l.id !== excludeRequestId && (!candidate?.id || l.id !== candidate.id));
  const proposed = candidate ? { ...candidate, user_id:userId, status:candidate.status || 'PENDING' } : null;
  if (proposed) leaves.push(proposed);
  const calendar = calendarFrom(db);
  leaves.push(...shortDayCharges(getShortDays.all(userId, EFFECTIVE), calendar));
  const ledger = calculateLeaves(leaves, calendar);
  return { leaves, ledger, proposed, result: proposed ? ledger.get(proposed) : null };
}

function policyNotes(leave, calendar = calendarFrom(db)) {
  const notes = [];
  const first = DateTime.fromISO(leave.start_date, { zone:ZONE }), last = DateTime.fromISO(leave.end_date, { zone:ZONE });
  if (first.isValid && last.isValid && (!scheduledDays(first.minus({days:1}).toISODate(), calendar) || !scheduledDays(last.plus({days:1}).toISODate(), calendar))) notes.push('Leave adjoining a weekend or holiday needs specific management approval and may be refused.');
  if (leave.emergency_type && leave.emergency_type !== 'NONE') notes.push(leave.emergency_type === 'HEALTH' ? 'Health emergency: advance-notice exception requested.' : 'Emergency: three-day advance-notice exception requested.');
  if (leave.status === 'PENDING' && leave.created_ts > 0) {
    let due = DateTime.fromMillis(leave.created_ts, { zone:ZONE }).plus({days:1});
    while (!scheduledDays(due.toISODate(), calendar)) due = due.plus({days:1});
    notes.push(`Management response due by ${due.toISODate()} (one business day).${todayStr() > due.toISODate() ? ' Response overdue.' : ''}`);
  }
  return notes;
}

function describeLeave(leave) {
  if (leave.user_id) return { ...calculationFor(leave.user_id, leave).result, policy_notes:policyNotes(leave) };
  const proposed = { ...leave, status:leave.status || 'PENDING' };
  return { ...calculateLeaves([proposed], calendarFrom(db)).get(proposed), policy_notes:policyNotes(leave) };
}

function describeLeaves(leaves) {
  const calendar = calendarFrom(db), groups = new Map();
  for (const userId of new Set(leaves.map(l => l.user_id))) {
    const active = getLeaves.all(userId), ids = new Set(active.map(l => l.id));
    const all = [...active, ...leaves.filter(l => l.user_id === userId && !ids.has(l.id))];
    const ledger = calculateLeaves([...all, ...shortDayCharges(getShortDays.all(userId, EFFECTIVE), calendar)], calendar);
    groups.set(userId, new Map([...ledger].map(([l,result]) => [l.id,result])));
  }
  return leaves.map(l => ({ ...l, ...groups.get(l.user_id).get(l.id), policy_notes:policyNotes(l, calendar) }));
}

function balances(userId, date = todayStr(), excludeRequestId = null) {
  const period = periodFor(date), user = getUser.get(userId);
  if (!user) throw Object.assign(new Error('Employee not found'), { status: 404 });
  const buckets = Object.fromEntries(Object.entries(ENTITLEMENT).map(([key, entitlement]) => [key, { entitlement, used: 0, pending: 0, remaining: entitlement, available: entitlement }]));
  const { leaves, ledger } = calculationFor(userId, null, excludeRequestId);
  let monthUsed = 0, monthPending = 0;
  const short_day = { paid_days: 0, unpaid_days: 0 };
  for (const leave of leaves) {
    if (leave.id === excludeRequestId) continue;
    const calculated = ledger.get(leave);
    for (const line of calculated.date_lines) {
      if (line.date.slice(0,7) === date.slice(0,7) && calculated.category === 'REGULAR') {
        if (leave.status === 'APPROVED') monthUsed += line.paid_days; else monthPending += line.paid_days;
        if (leave.source === 'SHORT_DAY') {
          short_day.paid_days += line.paid_days;
          short_day.unpaid_days += line.unpaid_days;
        }
      }
    }
    for (const c of calculated.charges) {
      if (c.period !== period.start) continue;
      buckets[c.bucket][leave.status === 'APPROVED' ? 'used' : 'pending'] += c.days;
    }
  }
  for (const b of Object.values(buckets)) { b.remaining = b.entitlement - b.used; b.available = b.remaining - b.pending; }
  const total = key => Object.values(buckets).reduce((n, b) => n + b[key], 0);
  return { short_day, monthly_regular: { month:date.slice(0,7), limit:MONTHLY_REGULAR, used:monthUsed, pending:monthPending, remaining:Math.max(0,MONTHLY_REGULAR-monthUsed), available:Math.max(0,MONTHLY_REGULAR-monthUsed-monthPending) }, period, buckets, balance: total('remaining'), pending: total('pending'), available: total('available'), entitlement: 20, effective: EFFECTIVE };
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

async function syncAllBalancesAsync() {
  for (const u of db.prepare('SELECT id FROM users').all()) {
    syncBalance(u.id);
    await new Promise(resolve => setImmediate(resolve));
  }
}

function normalizeLeave(body, { allowPast = false, requireReason = true } = {}) {
  const start_date = String(body.start_date || ''), kind = String(body.kind || 'FULL').toUpperCase();
  const end_date = kind === 'HALF' ? start_date : String(body.end_date || start_date);
  const category = String(body.category || 'REGULAR').toUpperCase();
  const reason = String(body.reason || '').trim().slice(0, 500);
  const emergency_type = String(body.emergency_type || 'NONE').toUpperCase();
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!['FULL', 'HALF'].includes(kind)) fail('Choose full day or half day.');
  if (!Object.hasOwn(CATEGORIES, category)) fail('Choose a valid leave category.');
  if (!['NONE','HEALTH','OTHER'].includes(emergency_type)) fail('Choose a valid emergency option.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) fail('Invalid date range.');
  const span = inclusiveDays(start_date, end_date);
  if (!span || span > 366) fail('Choose a valid date range of up to one year.');
  if (!allowPast && start_date < todayStr()) fail('Leave cannot start in the past.');
  if (!allowPast) {
    const candidate = { start_date, end_date, kind, category, status:'PENDING' };
    const calculated = calculateLeaves([candidate], calendarFrom(db)).get(candidate);
    const scheduled = calculated.date_lines.reduce((sum,line) => sum+line.scheduled_days,0);
    const notice = DateTime.fromISO(start_date, { zone:ZONE }).diff(DateTime.fromISO(todayStr(), { zone:ZONE }), 'days').days;
    if (scheduled >= 3 && emergency_type !== 'HEALTH' && notice < 20) fail('For three or more planned leave days, inform management at least 20 days in advance. Only health emergencies are exempt.');
    if (emergency_type === 'NONE' && notice < 3) fail('Apply at least three days in advance, or select the applicable emergency exception.');
  }
  if (requireReason && category !== 'FLEXI' && !reason) fail('Please give a reason for your leave.');
  if (category === 'FLEXI') {
    let date = DateTime.fromISO(start_date, { zone: ZONE });
    const end = DateTime.fromISO(end_date, { zone: ZONE });
    while (date <= end) {
      if (date.day <= 15) fail('Flexi leave is available only after the 15th of a month.');
      date = date.plus({ days: 1 });
    }
  }
  return { start_date, end_date, kind, category, reason, emergency_type, days: kind === 'HALF' ? 0.5 : span };
}

function assertAvailable(userId, leave, excludeRequestId = null) {
  // Regular leave exceeding the monthly allowance is accepted as unpaid.
  // Flexi/special categories retain their separate annual paid entitlement.
  const result = calculationFor(userId, leave, excludeRequestId).result;
  if (leave.category !== 'REGULAR' && result.date_lines.some(line => line.unpaid_reason === 'ANNUAL_LIMIT')) {
    throw Object.assign(new Error('The paid entitlement for this leave category is exhausted. Apply as regular leave to use its monthly allowance or take unpaid leave.'), { status:409 });
  }
}

module.exports = { EFFECTIVE, ENTITLEMENT, CATEGORIES, periodFor, describeLeave, describeLeaves, calculationFor, balances, syncBalance, syncAllBalances, syncAllBalancesAsync, normalizeLeave, assertAvailable };
