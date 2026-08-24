'use strict';

// Birthdays. Admins get a heads-up a few days before (and again on the morning
// of), and the person themselves gets a congratulations popup on the day.
// Only the day and month are ever shown — the birth year stays private.
//
// Config: BIRTHDAY_LEAD_DAYS (default 3), BIRTHDAY_CHECK_HOUR (office zone,
// default 9), BIRTHDAYS=off to disable.

const { db } = require('./db');
const { now, DateTime, ZONE } = require('./time');
const { notifyAdmins } = require('./notify');

const LEAD_DAYS = Math.min(30, Math.max(1, Number(process.env.BIRTHDAY_LEAD_DAYS ?? 3)));
const enabled = () => String(process.env.BIRTHDAYS || 'on').toLowerCase() !== 'off';

const activeWithBirthday = db.prepare(
  `SELECT id, name, birthday FROM users WHERE active = 1 AND birthday != ''`
);
// Dedupe the admin heads-up: one row per admin, per birthday person, per date.
const markSent = db.prepare(
  `INSERT OR IGNORE INTO reminder_acks (user_id, kind, day, item, acked_ts) VALUES (?, 'BDAY_SENT', ?, ?, ?)`
);

// This year's occurrence of a birthday, as a Luxon DateTime in the office zone.
// A 29 Feb birthday falls back to 28 Feb in non-leap years.
function occurrenceIn(year, birthday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthday || ''));
  if (!m) return null;
  const month = Number(m[2]); let day = Number(m[3]);
  if (month === 2 && day === 29 && !DateTime.fromObject({ year, month: 1, day: 1 }, { zone: ZONE }).isInLeapYear) day = 28;
  const dt = DateTime.fromObject({ year, month, day }, { zone: ZONE });
  return dt.isValid ? dt.startOf('day') : null;
}

// Everyone whose birthday falls within the next `days` days (0 = today only).
// Each row: { id, name, date (this occurrence), daysUntil, label "12 Mar" }.
function upcoming(days = LEAD_DAYS) {
  const today = now().startOf('day');
  const out = [];
  for (const u of activeWithBirthday.all()) {
    let occ = occurrenceIn(today.year, u.birthday);
    if (!occ) continue;
    if (occ < today) occ = occurrenceIn(today.year + 1, u.birthday); // already passed this year
    if (!occ) continue;
    const daysUntil = Math.round(occ.diff(today, 'days').days);
    if (daysUntil <= days) out.push({ id: u.id, name: u.name, date: occ.toFormat('yyyy-LL-dd'), daysUntil, label: occ.toFormat('d LLL') });
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil);
}

// Is it this user's birthday today?
function isBirthdayToday(birthday) {
  const occ = occurrenceIn(now().year, birthday);
  return !!occ && occ.toFormat('yyyy-LL-dd') === now().toFormat('yyyy-LL-dd');
}

// Daily run: tell admins about birthdays exactly LEAD_DAYS away, and again on
// the day itself. Returns how many notifications were sent.
function notifyAdminsOfBirthdays() {
  if (!enabled()) return 0;
  const ts = now().toMillis();
  let sent = 0;
  for (const b of upcoming(LEAD_DAYS)) {
    if (b.daysUntil !== LEAD_DAYS && b.daysUntil !== 0) continue; // only the heads-up and the day itself
    // Skip if we already told them about this person's birthday today.
    const already = db.prepare(
      `SELECT 1 FROM reminder_acks WHERE kind = 'BDAY_SENT' AND day = ? AND item = ? LIMIT 1`
    ).get(now().toFormat('yyyy-LL-dd'), String(b.id));
    if (already) continue;
    notifyAdmins({
      type: 'GENERAL',
      title: b.daysUntil === 0 ? `🎂 ${b.name}'s birthday is today` : `🎂 ${b.name}'s birthday in ${b.daysUntil} days`,
      body: b.daysUntil === 0 ? `Wish ${b.name} a happy birthday!` : `${b.name} turns another year older on ${b.label}. Time to plan something.`,
      link: 'directory',
    }, b.id); // don't notify the birthday person if they're an admin — keep the surprise
    markSent.run(b.id, now().toFormat('yyyy-LL-dd'), String(b.id), ts);
    sent += 1;
  }
  if (sent) console.log(`Birthdays: sent ${sent} admin heads-up notification(s).`);
  return sent;
}

// Run once a day at BIRTHDAY_CHECK_HOUR (office zone).
function startBirthdayScheduler() {
  if (!enabled()) { console.log('Birthdays: disabled (BIRTHDAYS=off).'); return; }
  const hour = Math.min(23, Math.max(0, Number(process.env.BIRTHDAY_CHECK_HOUR ?? 9)));
  const scheduleNext = () => {
    const n = now();
    let next = n.set({ hour, minute: 0, second: 0, millisecond: 0 });
    if (next <= n) next = next.plus({ days: 1 });
    setTimeout(() => {
      try { notifyAdminsOfBirthdays(); } catch (e) { console.error('Birthday check failed:', e.message); }
      scheduleNext();
    }, next.toMillis() - n.toMillis()).unref();
    console.log(`Birthday check scheduled for ${next.toFormat('yyyy-LL-dd HH:mm')} (${ZONE}); ${LEAD_DAYS}-day heads-up.`);
  };
  scheduleNext();
}

module.exports = { upcoming, isBirthdayToday, notifyAdminsOfBirthdays, startBirthdayScheduler, LEAD_DAYS };
