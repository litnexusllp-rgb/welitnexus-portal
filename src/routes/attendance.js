'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, todayStr, DateTime, ZONE } = require('../time');
const { summarize, VALID } = require('../compute');

const router = express.Router();

const insertEvent = db.prepare(
  `INSERT INTO events (user_id, type, ts, day, note) VALUES (?, ?, ?, ?, ?)`
);
const eventsForUserDay = db.prepare(
  `SELECT * FROM events WHERE user_id = ? AND day = ? ORDER BY ts ASC, id ASC`
);
const eventsForUserBetween = db.prepare(
  `SELECT * FROM events WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY ts ASC, id ASC`
);

// GET today's status for the current user.
router.get('/status', requireAuth, (req, res) => {
  const day = todayStr();
  const events = eventsForUserDay.all(req.user.id, day);
  const summary = summarize(events, now().toMillis());
  res.json({ day, ...summary, allowed: VALID[summary.state], events });
});

// POST a punch action: { type: IN | OUT | BREAK_START | BREAK_END }
router.post('/punch', requireAuth, (req, res) => {
  const type = String(req.body.type || '').toUpperCase();
  const note = String(req.body.note || '').slice(0, 200);
  if (!['IN', 'OUT', 'BREAK_START', 'BREAK_END'].includes(type)) {
    return res.status(400).json({ error: 'Invalid punch type' });
  }
  const day = todayStr();
  const events = eventsForUserDay.all(req.user.id, day);
  const { state } = summarize(events, now().toMillis());
  if (!VALID[state].includes(type)) {
    return res.status(409).json({ error: `Cannot ${type} while ${state}` });
  }
  insertEvent.run(req.user.id, type, now().toMillis(), day, note);
  const updated = eventsForUserDay.all(req.user.id, day);
  const summary = summarize(updated, now().toMillis());
  res.json({ day, ...summary, allowed: VALID[summary.state], events: updated });
});

// GET my timesheet for a date range (defaults to last 14 days).
router.get('/timesheet', requireAuth, (req, res) => {
  const end = String(req.query.end || todayStr());
  const start = String(req.query.start || now().minus({ days: 13 }).toFormat('yyyy-LL-dd'));
  const rows = eventsForUserBetween.all(req.user.id, start, end);
  const byDay = {};
  for (const e of rows) (byDay[e.day] = byDay[e.day] || []).push(e);
  const today = todayStr();
  // Past days don't get a live tail — a forgotten clock-out just stops counting.
  const days = Object.keys(byDay).sort().map((day) => ({
    day, ...summarize(byDay[day], day === today ? now().toMillis() : null),
  }));
  res.json({ start, end, days });
});

// ADMIN: who is in today, with live state.
const allEventsForDay = db.prepare(
  `SELECT e.*, u.name FROM events e JOIN users u ON u.id = e.user_id
   WHERE e.day = ? ORDER BY e.user_id, e.ts ASC, e.id ASC`
);
const activeUsers = db.prepare(`SELECT id, name, department, title FROM users WHERE active = 1 ORDER BY name`);

router.get('/today', requireAdmin, (req, res) => {
  const day = todayStr();
  const rows = allEventsForDay.all(day);
  const byUser = {};
  for (const e of rows) (byUser[e.user_id] = byUser[e.user_id] || []).push(e);
  const people = activeUsers.all().map((u) => {
    const events = byUser[u.id] || [];
    const s = summarize(events, now().toMillis());
    return {
      id: u.id, name: u.name, department: u.department, title: u.title,
      state: events.length ? s.state : 'OFF',
      workedMinutes: s.workedMinutes, breakMinutes: s.breakMinutes,
      firstIn: s.firstIn, lastOut: s.lastOut,
    };
  });
  res.json({ day, people });
});

// ===================================================================
//  ADMIN attendance correction — fix mistakes in an employee's punches
// ===================================================================
const EVENT_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
const getEvent = db.prepare(`SELECT * FROM events WHERE id = ?`);
const updateEvent = db.prepare(`UPDATE events SET type = ?, ts = ?, note = ? WHERE id = ?`);
const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ?`);
const getUserName = db.prepare(`SELECT id, name FROM users WHERE id = ?`);

// Combine a yyyy-LL-dd day and HH:mm time into an epoch ms in the office zone.
function toTs(day, time) {
  const dt = DateTime.fromFormat(`${day} ${time}`, 'yyyy-LL-dd HH:mm', { zone: ZONE });
  return dt.isValid ? dt.toMillis() : null;
}

// Attach a HH:mm office-zone time string to each event (so the admin UI shows
// and edits times in office time, not the admin's browser timezone).
function withTimes(events) {
  return events.map((e) => ({ ...e, time: DateTime.fromMillis(e.ts).setZone(ZONE).toFormat('HH:mm') }));
}

// GET one employee's punches for a day (admin view for editing).
router.get('/admin/day', requireAdmin, (req, res) => {
  const user = getUserName.get(Number(req.query.user_id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  const day = String(req.query.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Valid day (yyyy-mm-dd) required' });
  const events = eventsForUserDay.all(user.id, day);
  const summary = summarize(events, day === todayStr() ? now().toMillis() : null);
  res.json({ user, day, events: withTimes(events), ...summary });
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
  const ts = toTs(day, time);
  if (ts === null) return res.status(400).json({ error: 'Valid time (HH:mm) required' });
  insertEvent.run(user.id, type, ts, day, `edited by ${req.user.name}`);
  const events = eventsForUserDay.all(user.id, day);
  res.json({ user, day, events: withTimes(events), ...summarize(events, day === todayStr() ? now().toMillis() : null) });
});

// ADMIN: edit a punch's type/time.
router.put('/admin/event/:id', requireAdmin, (req, res) => {
  const ev = getEvent.get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'Punch not found' });
  const type = req.body.type ? String(req.body.type).toUpperCase() : ev.type;
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid punch type' });
  const ts = req.body.time ? toTs(ev.day, String(req.body.time)) : ev.ts;
  if (ts === null) return res.status(400).json({ error: 'Valid time (HH:mm) required' });
  updateEvent.run(type, ts, `edited by ${req.user.name}`, ev.id);
  const events = eventsForUserDay.all(ev.user_id, ev.day);
  res.json({ day: ev.day, events: withTimes(events), ...summarize(events, ev.day === todayStr() ? now().toMillis() : null) });
});

// ADMIN: delete a punch.
router.delete('/admin/event/:id', requireAdmin, (req, res) => {
  const ev = getEvent.get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: 'Punch not found' });
  deleteEvent.run(ev.id);
  const events = eventsForUserDay.all(ev.user_id, ev.day);
  res.json({ day: ev.day, events: withTimes(events), ...summarize(events, ev.day === todayStr() ? now().toMillis() : null) });
});

module.exports = router;
