'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, DateTime, attendanceToday } = require('../time');
const { summarize } = require('../compute');
const { changeAttendance, attendanceError } = require('../attendanceValidation');

const { settings, daySettings, snapshot, currentSession, liveForDay, wallTime, withTimes } = require('../attendanceSession');
const router = express.Router();

const insertEvent = db.prepare(
  `INSERT INTO events (user_id, type, ts, day, note, device) VALUES (?, ?, ?, ?, ?, ?)`
);

// Classify the punching device from the browser's User-Agent header.
// Phones/tablets send "Mobi"/"Android"/"iPhone"/"iPad"; everything else is a PC.
function deviceFrom(req) {
  const ua = String(req.get('user-agent') || '');
  if (!ua) return '';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? 'MOBILE' : 'PC';
}
const eventsForUserDay = db.prepare(
  `SELECT * FROM events WHERE user_id = ? AND day = ? ORDER BY ts ASC, id ASC`
);
const eventsForUserBetween = db.prepare(
  `SELECT * FROM events WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY ts ASC, id ASC`
);
const getLateNormalOverride = db.prepare(
  `SELECT ignore_late FROM attendance_day_overrides WHERE user_id = ? AND day = ?`
);
const setLateNormalOverride = db.prepare(`
  INSERT INTO attendance_day_overrides (user_id, day, ignore_late, updated_by, updated_ts)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, day) DO UPDATE SET
    ignore_late = excluded.ignore_late,
    updated_by = excluded.updated_by,
    updated_ts = excluded.updated_ts
`);

// GET the current attendance-day status for the signed-in user. "day" here is
// the shift day (cutover-adjusted), so an overnight shift stays one day.
router.get('/status', requireAuth, (req, res) => {
  res.json(currentSession(req.user));
});

// POST a punch action: { type: IN | OUT | BREAK_START | BREAK_END }
router.post('/punch', requireAuth, (req, res) => {
  const type = String(req.body.type || '').toUpperCase();
  const note = String(req.body.note || '').slice(0, 200);
  if (!['IN', 'OUT', 'BREAK_START', 'BREAK_END'].includes(type)) {
    return res.status(400).json({ error: 'Invalid punch type' });
  }
  try {
    const result = db.transaction(() => {
      const ts = now().toMillis(); // server UTC instant; never trust a browser clock
      const session = currentSession(req.user, ts);
      if (!session.allowed.includes(type)) throw Object.assign(new Error(`Cannot ${type} while ${session.state}`), { status: 409, attendanceValidation: true });
      if (session.lastPunchTs != null && ts <= session.lastPunchTs) throw Object.assign(new Error('Punch time must follow the last recorded punch.'), { status: 409, attendanceValidation: true });
      const day = type === 'IN' ? attendanceToday(settings(req.user)) : session.day;
      snapshot(req.user, day);
      changeAttendance(req.user.id, [day], () => insertEvent.run(req.user.id, type, ts, day, note, deviceFrom(req)));
      return currentSession(req.user, ts);
    }).immediate();
    res.json(result);
  } catch (e) { return attendanceError(e, res); }
});

// GET my timesheet for a range of attendance days (defaults to last 14).
router.get('/timesheet', requireAuth, (req, res) => {
  const end = String(req.query.end || attendanceToday(settings(req.user)));
  const start = String(req.query.start || DateTime.fromISO(end).minus({ days: 13 }).toISODate());
  const rows = eventsForUserBetween.all(req.user.id, start, end);
  const byDay = {};
  for (const e of rows) (byDay[e.day] = byDay[e.day] || []).push(e);
  // The in-progress day gets a live tail; finished days stop at their last punch.
  const days = Object.keys(byDay).sort().map((day) => ({
    day, ...daySettings(req.user, day), ...summarize(byDay[day], liveForDay(req.user, day)),
  }));
  res.json({ start, end, days });
});

// ADMIN: who is in today, with live state.
const activeUsers = db.prepare(`SELECT * FROM users WHERE active = 1 ORDER BY name`);

router.get('/today', requireAdmin, (req, res) => {
  const day = attendanceToday(); // current shift day, not calendar day
  const people = activeUsers.all().map((u) => {
    const session = currentSession(u);
    const events = session.events;
    const s = session;
    // Device of the most recent punch that recorded one (their latest session).
    const lastWithDevice = [...events].reverse().find((e) => e.device);
    return {
      id: u.id, name: u.name, department: u.department, title: u.title,
      day: session.day, timezone: session.timezone, needsReview: session.needsReview,
      state: events.length ? s.state : 'OFF',
      attendanceError: s.error || null,
      workedMinutes: s.workedMinutes, breakMinutes: s.breakMinutes,
      firstIn: s.firstIn, lastOut: s.lastOut,
      device: lastWithDevice ? lastWithDevice.device : '',
    };
  });
  res.json({ day, people });
});

// ===================================================================
//  ADMIN attendance correction — fix mistakes in an employee's punches
// ===================================================================
const EVENT_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
const getEvent = db.prepare(`SELECT * FROM events WHERE id = ?`);
const updateEvent = db.prepare(`UPDATE events SET type = ?, ts = ?, day = ?, note = ? WHERE id = ?`);
const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ?`);
const getUserName = db.prepare(`SELECT id, name, shift_start, attendance_timezone, attendance_cutover FROM users WHERE id = ?`);

// GET one employee's punches for a day (admin view for editing).
router.get('/admin/day', requireAdmin, (req, res) => {
  const user = getUserName.get(Number(req.query.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const day = String(req.query.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Valid day (yyyy-mm-dd) required' });
  const events = eventsForUserDay.all(user.id, day);
  const summary = summarize(events, liveForDay(user, day));
  const lateNormal = getLateNormalOverride.get(user.id, day)?.ignore_late === 1;
  res.json({ user, day, ...daySettings(user, day), events: withTimes(events, daySettings(user, day)), lateNormal, ...summary });
});

// ADMIN: mark a day's late clock-in as normal for punctuality, or restore the
// automatic late calculation. This never changes the recorded punch times.
router.post('/admin/late-normal', requireAdmin, (req, res) => {
  const user = getUserName.get(Number(req.body.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const day = String(req.body.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Valid day required' });
  if (typeof req.body.normal !== 'boolean') return res.status(400).json({ error: 'normal must be true or false' });
  setLateNormalOverride.run(user.id, day, req.body.normal ? 1 : 0, req.user.id, now().toMillis());
  res.json({ user_id: user.id, day, lateNormal: req.body.normal });
});

// ADMIN: add a punch for an employee.
router.post('/admin/event', requireAdmin, (req, res) => {
  const user = getUserName.get(Number(req.body.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const day = String(req.body.day || '');
  const type = String(req.body.type || '').toUpperCase();
  const time = String(req.body.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Valid day required' });
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid punch type' });
  const ts = wallTime(day, time, daySettings(user, day), req.body.event_date);
  if (ts === null) return res.status(400).json({ error: 'Valid time (HH:mm) required' });
  try { changeAttendance(user.id, [day], () => {
    snapshot(user, day);
    return insertEvent.run(user.id, type, ts, day, `edited by ${req.user.name}`, ''); }); }
  catch (e) { return attendanceError(e, res); }
  const events = eventsForUserDay.all(user.id, day);
  res.json({ user, day, ...daySettings(user, day), events: withTimes(events, daySettings(user, day)), ...summarize(events, liveForDay(user, day)) });
});

// ADMIN: edit a punch's type/time.
router.put('/admin/event/:id', requireAdmin, (req, res) => {
  const ev = getEvent.get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'Punch not found' });
  const type = req.body.type ? String(req.body.type).toUpperCase() : ev.type;
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid punch type' });
  const user = getUserName.get(ev.user_id);
  const ts = req.body.time ? wallTime(ev.day, String(req.body.time), daySettings(user, ev.day), req.body.event_date || DateTime.fromMillis(ev.ts, { zone: daySettings(user, ev.day).timezone }).toISODate()) : ev.ts;
  if (ts === null) return res.status(400).json({ error: 'Valid time (HH:mm) required' });
  const day = ev.day;
  try { changeAttendance(ev.user_id, [ev.day, day], () => { snapshot(user, day); return updateEvent.run(type, ts, day, `edited by ${req.user.name}`, ev.id); }); }
  catch (e) { return attendanceError(e, res); }
  const events = eventsForUserDay.all(ev.user_id, day);
  res.json({ day, events: withTimes(events, daySettings(user, day)), ...summarize(events, liveForDay(user, day)) });
});

// ADMIN: delete a punch.
router.delete('/admin/event/:id', requireAdmin, (req, res) => {
  const ev = getEvent.get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'Punch not found' });
  try { changeAttendance(ev.user_id, [ev.day], () => { snapshot(getUserName.get(ev.user_id), ev.day); return deleteEvent.run(ev.id); }); }
  catch (e) { return attendanceError(e, res); }
  const user = getUserName.get(ev.user_id);
  const day = ev.day;
  const events = eventsForUserDay.all(ev.user_id, ev.day);
  res.json({ day: ev.day, events: withTimes(events, daySettings(user, day)), ...summarize(events, liveForDay(user, day)) });
});

module.exports = router;
