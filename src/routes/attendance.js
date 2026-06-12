'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, todayStr } = require('../time');

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

// Derive the user's current state and worked/break minutes for a day's events.
function summarize(events) {
  let state = 'OUT';            // OUT | IN | BREAK
  let workedMs = 0;
  let breakMs = 0;
  let lastIn = null;
  let lastBreak = null;
  let firstIn = null;
  let lastOut = null;

  for (const e of events) {
    if (e.type === 'IN') {
      if (state === 'OUT') { lastIn = e.ts; if (firstIn === null) firstIn = e.ts; }
      state = 'IN';
    } else if (e.type === 'OUT') {
      if (state === 'IN' && lastIn !== null) workedMs += e.ts - lastIn;
      if (state === 'BREAK' && lastBreak !== null) breakMs += e.ts - lastBreak;
      lastOut = e.ts;
      state = 'OUT';
    } else if (e.type === 'BREAK_START') {
      if (state === 'IN' && lastIn !== null) workedMs += e.ts - lastIn;
      lastBreak = e.ts;
      state = 'BREAK';
    } else if (e.type === 'BREAK_END') {
      if (state === 'BREAK' && lastBreak !== null) breakMs += e.ts - lastBreak;
      lastIn = e.ts;
      state = 'IN';
    }
  }
  // Add open running interval up to "now" if still clocked in / on break.
  const t = now().toMillis();
  if (state === 'IN' && lastIn !== null) workedMs += t - lastIn;
  if (state === 'BREAK' && lastBreak !== null) breakMs += t - lastBreak;

  return {
    state,
    workedMinutes: Math.round(workedMs / 60000),
    breakMinutes: Math.round(breakMs / 60000),
    firstIn,
    lastOut,
  };
}

const VALID = {
  OUT:   ['IN'],
  IN:    ['OUT', 'BREAK_START'],
  BREAK: ['BREAK_END', 'OUT'],
};

// GET today's status for the current user.
router.get('/status', requireAuth, (req, res) => {
  const day = todayStr();
  const events = eventsForUserDay.all(req.user.id, day);
  const summary = summarize(events);
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
  const { state } = summarize(events);
  if (!VALID[state].includes(type)) {
    return res.status(409).json({ error: `Cannot ${type} while ${state}` });
  }
  insertEvent.run(req.user.id, type, now().toMillis(), day, note);
  const updated = eventsForUserDay.all(req.user.id, day);
  const summary = summarize(updated);
  res.json({ day, ...summary, allowed: VALID[summary.state], events: updated });
});

// GET my timesheet for a date range (defaults to last 14 days).
router.get('/timesheet', requireAuth, (req, res) => {
  const end = String(req.query.end || todayStr());
  const start = String(req.query.start || now().minus({ days: 13 }).toFormat('yyyy-LL-dd'));
  const rows = eventsForUserBetween.all(req.user.id, start, end);
  const byDay = {};
  for (const e of rows) (byDay[e.day] = byDay[e.day] || []).push(e);
  const days = Object.keys(byDay).sort().map((day) => ({ day, ...summarize(byDay[day]) }));
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
    const s = summarize(events);
    return { id: u.id, name: u.name, department: u.department, title: u.title, state: events.length ? s.state : 'OFF', workedMinutes: s.workedMinutes, firstIn: s.firstIn };
  });
  res.json({ day, people });
});

module.exports = router;
