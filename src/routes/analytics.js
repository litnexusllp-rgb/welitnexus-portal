'use strict';

// Admin analytics feeding the Trends dashboard: attendance over time, revenue
// per month, and invoiced-vs-paid by client. (Profit-per-client is intentionally
// omitted until per-client hours/time-tracking exists.)

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now, attendanceToday, DateTime, ZONE } = require('../time');
const { summarize } = require('../compute');

const router = express.Router();

const eventsSince = db.prepare(`SELECT user_id, type, ts, day FROM events WHERE day >= ? ORDER BY user_id, ts, id`);
const invoicesWithDate = db.prepare(`SELECT invoice_date, amount, status FROM invoices WHERE invoice_date != ''`);
const clientTotals = db.prepare(
  `SELECT c.name, COALESCE(pc.name, c.name) AS family,
          SUM(i.amount) AS invoiced,
          SUM(CASE WHEN i.status = 'PAID' THEN i.amount ELSE 0 END) AS paid
   FROM invoices i JOIN clients c ON c.id = i.client_id
   LEFT JOIN clients pc ON pc.id = c.parent_id
   GROUP BY c.id ORDER BY invoiced DESC LIMIT 8`
);

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

  // --- Revenue per month: last 12 months ---
  const monthMap = {};
  for (const inv of invoicesWithDate.all()) {
    const mo = String(inv.invoice_date).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mo)) continue;
    const m = (monthMap[mo] = monthMap[mo] || { invoiced: 0, paid: 0 });
    m.invoiced += inv.amount || 0;
    if (inv.status === 'PAID') m.paid += inv.amount || 0;
  }
  const revenue = [];
  for (let i = 11; i >= 0; i--) {
    const mo = now().minus({ months: i }).toFormat('yyyy-LL');
    const m = monthMap[mo] || { invoiced: 0, paid: 0 };
    revenue.push({ month: mo, label: DateTime.fromISO(`${mo}-01`, { zone: ZONE }).toFormat('LLL yy'), invoiced: Math.round(m.invoiced), paid: Math.round(m.paid) });
  }

  const clients = clientTotals.all().map((c) => ({
    name: c.family === c.name ? c.name : `${c.family} › ${c.name}`,
    invoiced: Math.round(c.invoiced || 0),
    paid: Math.round(c.paid || 0),
  }));

  res.json({ attendance, revenue, clients });
});

module.exports = router;
