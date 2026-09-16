'use strict';

// Admin analytics: attendance over time.

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now, attendanceToday } = require('../time');
const { summarize } = require('../compute');

const router = express.Router();

const eventsSince = db.prepare(`SELECT user_id, type, ts, day FROM events WHERE day >= ? ORDER BY user_id, ts, id`);
router.get('/', requireAdmin, (_req, res) => {
  // --- Attendance trend: last 30 attendance days ---
  const days = Number(30);
  const startDay = now().minus({ days: days - 1 }).toFormat('yyyy-LL-dd');
  const today = attendanceToday();
  const byUserDay = {};
  for (const e of eventsSince.all(startDay)) {
    const k = `${e.user_id}|${e.day}`;
    (byUserDay[k] = byUserDay[k] || []).push(e);
  }
  const perDay = {}; // day -> { present, minutes }
  for (const k of Object.keys(byUserDay)) {
    const [, day] = k.split('|');
    const s = summarize(byUserDay[k], day === today ? now().toMillis() : null);
    const d = (perDay[day] = perDay[day] || { present: 0, minutes: 0 });
    if (s.firstIn != null) d.present += 1;
    d.minutes += s.workedMinutes;
  }
  const attendance = [];
  for (let i = 0; i < days; i++) {
    const day = now().minus({ days: days - 1 - i }).toFormat('yyyy-LL-dd');
    const d = perDay[day] || { present: 0, minutes: 0 };
    attendance.push({ day, present: d.present, hours: Math.round(d.minutes / 6) / 10 });
  }

  res.json({ attendance });
});

module.exports = router;
