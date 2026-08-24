'use strict';

// Recurring day-of-week reminders. Currently the Friday checklist: send the
// weekly status update to clients, and log your achievements. The popup keeps
// showing all day until the person ticks it off, then stops for that day.
//
// Config: REMINDER_WEEKDAY (1=Mon..7=Sun, default 5=Friday), FRIDAY_REMINDER=off
// to disable.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, attendanceToday, DateTime, ZONE } = require('../time');
const { upcoming, isBirthdayToday } = require('../birthdays');

const router = express.Router();

const WEEKDAY = Math.min(7, Math.max(1, Number(process.env.REMINDER_WEEKDAY ?? 5))); // Friday
const enabled = () => String(process.env.FRIDAY_REMINDER || 'on').toLowerCase() !== 'off';

const getAck = db.prepare(`SELECT acked_ts FROM reminder_acks WHERE user_id = ? AND kind = ? AND day = ? AND item = ''`);
const insertAck = db.prepare(
  `INSERT OR IGNORE INTO reminder_acks (user_id, kind, day, item, acked_ts) VALUES (?, ?, ?, '', ?)`
);
// Did they log an achievement in the last 7 days? (so we can pre-tick that item)
const recentAchievement = db.prepare(
  `SELECT COUNT(*) AS c FROM achievements WHERE user_id = ? AND date >= ?`
);

// Is today (by attendance day, so an overnight Friday shift still counts) the
// reminder weekday?
function reminderDay() {
  const day = attendanceToday();
  const wd = DateTime.fromISO(day, { zone: ZONE }).weekday;
  return { day, isDue: wd === WEEKDAY };
}

// GET status: should the popup show, and what's already done?
router.get('/friday', requireAuth, (req, res) => {
  if (!enabled()) return res.json({ due: false, disabled: true });
  const { day, isDue } = reminderDay();
  const acked = getAck.get(req.user.id, 'FRIDAY', day);
  const weekAgo = DateTime.fromISO(day, { zone: ZONE }).minus({ days: 6 }).toFormat('yyyy-LL-dd');
  res.json({
    due: isDue && !acked,
    day,
    weekday: WEEKDAY,
    ackedAt: acked ? acked.acked_ts : null,
    achievementLoggedThisWeek: recentAchievement.get(req.user.id, weekAgo).c > 0,
  });
});

// POST ack: mark the checklist done for today — stops the popup until tomorrow.
router.post('/friday/ack', requireAuth, (req, res) => {
  const { day } = reminderDay();
  insertAck.run(req.user.id, 'FRIDAY', day, now().toMillis());
  res.json({ ok: true, day });
});

// ---- Birthdays ----
const getUserBirthday = db.prepare(`SELECT name, birthday FROM users WHERE id = ?`);
const getBdayAck = db.prepare(`SELECT 1 FROM reminder_acks WHERE user_id = ? AND kind = 'BIRTHDAY' AND day = ? AND item = ''`);
const insertBdayAck = db.prepare(
  `INSERT OR IGNORE INTO reminder_acks (user_id, kind, day, item, acked_ts) VALUES (?, 'BIRTHDAY', ?, '', ?)`
);

// Is it my birthday today, and have I already seen the popup?
router.get('/birthday', requireAuth, (req, res) => {
  const u = getUserBirthday.get(req.user.id);
  const today = now().toFormat('yyyy-LL-dd');
  const mine = !!u && isBirthdayToday(u.birthday);
  res.json({
    isBirthday: mine && !getBdayAck.get(req.user.id, today),
    name: u ? u.name : '',
    day: today,
  });
});

// Dismiss the birthday popup for today.
router.post('/birthday/ack', requireAuth, (req, res) => {
  insertBdayAck.run(req.user.id, now().toFormat('yyyy-LL-dd'), now().toMillis());
  res.json({ ok: true });
});

// ADMIN: birthdays coming up (default next 30 days) — day and month only.
router.get('/birthdays/upcoming', requireAdmin, (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json({ days, rows: upcoming(days) });
});

module.exports = router;
