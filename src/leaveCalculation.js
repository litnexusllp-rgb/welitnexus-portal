'use strict';

const { DateTime, ZONE } = require('./time');
const EFFECTIVE = '2026-10-01';
const VERSION = 3;
const ENTITLEMENT = Object.freeze({ regular: 18, flexi: 1, special: 1 });
const MONTHLY_REGULAR = 1.5;
const bucketFor = category => category === 'FLEXI' ? 'flexi' : ['BIRTHDAY', 'ANNIVERSARY'].includes(category) ? 'special' : 'regular';

function periodFor(iso) {
  const d = DateTime.fromISO(iso, { zone: ZONE }), year = d.month >= 10 ? d.year : d.year - 1;
  return { start: `${year}-10-01`, end: `${year + 1}-09-30`, nextReset: `${year + 1}-10-01` };
}

function calendarFrom(db) {
  return {
    holidays: new Map(db.prepare('SELECT date,duration FROM holidays ORDER BY date').all().map(h => [h.date, h.duration || 'FULL'])),
    working: new Set(db.prepare('SELECT date FROM working_days ORDER BY date').all().map(w => w.date)),
  };
}

function scheduledDays(iso, calendar) {
  const day = DateTime.fromISO(iso, { zone: ZONE });
  if (calendar.holidays.get(iso) === 'FULL') return 0;
  if (day.weekday >= 6 && !calendar.working.has(iso)) return 0;
  return calendar.holidays.get(iso) === 'HALF' ? 0.5 : 1;
}

// Allocate approved records first, then reserve pending credit. Within each
// status use leave date and id, so split requests cannot bypass a monthly cap.
// Every consumer (balances, request previews and payroll) uses this ledger.
function calculateLeaves(leaves, calendar) {
  const annual = new Map(), monthly = new Map(), results = new Map();
  const priority = l => l.status === 'APPROVED' ? 0 : l.status === 'PENDING' ? 1 : 2;
  const ordered = [...leaves].sort((a,b) => priority(a) - priority(b) || a.start_date.localeCompare(b.start_date) || (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
  for (const leave of ordered) {
    const category = leave.category || 'REGULAR', bucket = bucketFor(category), charges = new Map(), date_lines = [];
    let paid = 0, unpaid = 0, nonWorking = 0;
    let date = DateTime.fromISO(leave.start_date, { zone: ZONE });
    const end = DateTime.fromISO(leave.end_date, { zone: ZONE });
    const valid = date.isValid && end.isValid && end >= date && end.diff(date, 'days').days < 366 && ['FULL','HALF'].includes(leave.kind);
    if (!valid) { results.set(leave, { ...leave, category, paid_days:0, unpaid_days:0, non_working_days:0, pay_status:'REVIEW', charges:[], date_lines:[] }); continue; }
    const counted = ['APPROVED','PENDING'].includes(leave.status);
    while (date <= end) {
      const iso = date.toISODate(), requested = leave.kind === 'HALF' ? 0.5 : 1, period = periodFor(iso).start;
      const scheduled = iso < EFFECTIVE ? requested : Math.min(requested, scheduledDays(iso, calendar));
      const month = iso.slice(0,7), annualKey = `${leave.user_id}:${period}:${bucket}`, monthlyKey = `${leave.user_id}:${month}`;
      let paidDays = scheduled, reason = null;
      if (iso >= EFFECTIVE && date.day <= 12) { paidDays = 0; reason = 'FIRST_TWELVE'; }
      else if (iso >= EFFECTIVE) {
        const yearlyAvailable = Math.max(0, ENTITLEMENT[bucket] - (annual.get(annualKey) || 0));
        const monthlyAvailable = bucket === 'regular' ? Math.max(0, MONTHLY_REGULAR - (monthly.get(monthlyKey) || 0)) : scheduled;
        paidDays = Math.min(scheduled, yearlyAvailable, monthlyAvailable);
        if (paidDays < scheduled) reason = monthlyAvailable < scheduled ? 'MONTHLY_LIMIT' : 'ANNUAL_LIMIT';
      }
      const unpaidDays = scheduled - paidDays;
      if (paidDays) {
        const key = `${period}:${bucket}`;
        if (!charges.has(key)) charges.set(key, { period, bucket, days:0 });
        charges.get(key).days += paidDays;
        if (counted) {
          annual.set(annualKey, (annual.get(annualKey) || 0) + paidDays);
          if (bucket === 'regular') monthly.set(monthlyKey, (monthly.get(monthlyKey) || 0) + paidDays);
        }
      }
      paid += paidDays; unpaid += unpaidDays; nonWorking += requested - scheduled;
      date_lines.push({ date:iso, scheduled_days:scheduled, paid_days:paidDays, unpaid_days:unpaidDays, non_working_days:requested-scheduled, unpaid_reason:unpaidDays ? reason : null });
      if (leave.kind === 'HALF') break;
      date = date.plus({ days:1 });
    }
    results.set(leave, { ...leave, category, paid_days:paid, unpaid_days:unpaid, non_working_days:nonWorking,
      pay_status:unpaid ? (paid ? 'MIXED' : 'UNPAID') : paid ? 'PAID' : 'NON_WORKING', charges:[...charges.values()], date_lines });
  }
  return results;
}

module.exports = { EFFECTIVE, VERSION, ENTITLEMENT, MONTHLY_REGULAR, bucketFor, periodFor, calendarFrom, scheduledDays, calculateLeaves };
