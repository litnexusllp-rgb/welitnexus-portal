'use strict';
const { db } = require('./db');
const { DateTime, ZONE, ATT_CUTOVER, now, attendanceToday, attendanceDayFromTs } = require('./time');
const { summarize, VALID } = require('./compute');
const latest = db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY ts DESC,id DESC LIMIT 1');
const dayEvents = db.prepare('SELECT * FROM events WHERE user_id=? AND day=? ORDER BY ts,id');
const saved = db.prepare('SELECT timezone,cutover,shift_start FROM attendance_day_settings WHERE user_id=? AND day=?');
const save = db.prepare('INSERT OR IGNORE INTO attendance_day_settings(user_id,day,timezone,cutover,shift_start) VALUES(?,?,?,?,?)');
const defaultShift = () => `${String(process.env.SHIFT_START_HOUR ?? 16).padStart(2, '0')}:00`;
function settings(user = {}) {
  return { timezone: user.attendance_timezone || ZONE, cutover: user.attendance_cutover ?? ATT_CUTOVER(), shift_start: user.shift_start || defaultShift() };
}
function daySettings(user, day) {
  // Unsnapshotted historical days were recorded using office time. A profile
  // change must never reinterpret those UTC instants or their punctuality.
  return saved.get(user.id, day) || (dayEvents.get(user.id, day)
    ? { timezone: ZONE, cutover: ATT_CUTOVER(), shift_start: user.shift_start || defaultShift() }
    : settings(user));
}
function snapshot(user, day) {
  const c = daySettings(user, day);
  save.run(user.id, day, c.timezone, c.cutover, c.shift_start);
  return c;
}
function currentSession(user, ts = now().toMillis()) {
  const last = latest.get(user.id);
  // The latest unmatched IN or BREAK belongs to its original workday, however
  // many dates have passed. Do not silently expire it or offer a duplicate IN.
  const open = last && last.type !== 'OUT';
  const currentDay = attendanceToday(settings(user));
  const closedToday = last?.type === 'OUT' && attendanceDayFromTs(last.ts, settings(user)) === currentDay;
  const day = open || closedToday ? last.day : currentDay;
  const events = dayEvents.all(user.id, day);
  const base = summarize(events, null);
  const needsReview = !!open && ts - (base.firstIn ?? last.ts) > 24 * 3600000;
  const summary = needsReview ? base : summarize(events, ts);
  const c = daySettings(user, day);
  return { day, ...summary, allowed: VALID[summary.state], events, ...c,
    currentDay, ongoing: !!open,
    needsReview, lastPunchTs: last?.ts ?? null };
}
function liveForDay(user, day, ts = now().toMillis()) {
  // Preserve the existing no-live-tail rule for forgotten historical punches.
  const s = currentSession(user, ts);
  return day === attendanceToday(daySettings(user, day)) || (s.day === day && s.ongoing && !s.needsReview) ? ts : null;
}
function wallTime(day, time, config, eventDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  let date = eventDate || day;
  if (!eventDate && Number(time.slice(0, 2)) < config.cutover) date = DateTime.fromISO(day, { zone: config.timezone }).plus({ days: 1 }).toISODate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: config.timezone });
  // Reject nonexistent DST wall times and ambiguous fall-back times rather
  // than choosing an unintended UTC instant for a correction.
  if (!dt.isValid || dt.toISODate() !== date || dt.toFormat('HH:mm') !== time || dt.getPossibleOffsets().length !== 1) return null;
  return dt.toMillis();
}
function withTimes(events, config) {
  return events.map(e => { const dt = DateTime.fromMillis(e.ts, { zone: config.timezone });
    return { ...e, time: dt.toFormat('HH:mm'), event_date: dt.toISODate(), timezone: config.timezone, offset: dt.toFormat('ZZ') }; });
}
function shiftInstant(day, c) { return wallTime(day, c.shift_start, c); }
module.exports = { settings, daySettings, snapshot, currentSession, liveForDay, wallTime, withTimes, shiftInstant };
