'use strict';

// "Fix my punch" — employees submit an attendance correction (a missed or
// wrong clock punch). Admins approve (which inserts the real punch) or reject.
// Everything is filed under the shift/attendance day, consistent with the rest
// of attendance.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, DateTime, ZONE, ATT_CUTOVER, attendanceDayFromTs } = require('../time');
const { notify, notifyAdmins } = require('../notify');

const router = express.Router();

const EVENT_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
const TYPE_LABEL = { IN: 'Clock in', OUT: 'Clock out', BREAK_START: 'Break start', BREAK_END: 'Break end' };

const insertReq = db.prepare(
  `INSERT INTO punch_requests (user_id, day, type, time, reason, status, created_ts)
   VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`
);
const getReq = db.prepare(`SELECT * FROM punch_requests WHERE id = ?`);
const mineReqs = db.prepare(`SELECT * FROM punch_requests WHERE user_id = ? ORDER BY created_ts DESC LIMIT 100`);
const pendingReqs = db.prepare(
  `SELECT p.*, u.name FROM punch_requests p JOIN users u ON u.id = p.user_id
   WHERE p.status = 'PENDING' ORDER BY p.created_ts ASC`
);
const recentReqs = db.prepare(
  `SELECT p.*, u.name FROM punch_requests p JOIN users u ON u.id = p.user_id
   ORDER BY (p.status = 'PENDING') DESC, p.created_ts DESC LIMIT 100`
);
const decideReq = db.prepare(`UPDATE punch_requests SET status = ?, decided_by = ?, decided_ts = ?, admin_note = ? WHERE id = ?`);
const getUserName = db.prepare(`SELECT id, name FROM users WHERE id = ?`);
const insertEvent = db.prepare(`INSERT INTO events (user_id, type, ts, day, note, device) VALUES (?, ?, ?, ?, ?, '')`);

// Combine an attendance day (yyyy-LL-dd) + HH:mm into epoch ms. A time before
// the cutover is the post-midnight tail of that shift → next calendar day.
function toTs(day, time) {
  let dt = DateTime.fromFormat(`${day} ${time}`, 'yyyy-LL-dd HH:mm', { zone: ZONE });
  if (!dt.isValid) return null;
  if (Number(String(time).split(':')[0]) < ATT_CUTOVER()) dt = dt.plus({ days: 1 });
  return dt.toMillis();
}

// Employee: submit a correction request.
router.post('/', requireAuth, (req, res) => {
  const day = String(req.body.day || '');
  const type = String(req.body.type || '').toUpperCase();
  const time = String(req.body.time || '');
  const reason = String(req.body.reason || '').slice(0, 300);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Valid day (yyyy-mm-dd) required' });
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid punch type' });
  if (!/^\d{2}:\d{2}$/.test(time) || toTs(day, time) === null) return res.status(400).json({ error: 'Valid time (HH:mm) required' });
  const info = insertReq.run(req.user.id, day, type, time, reason, now().toMillis());
  notifyAdmins({ type: 'PUNCH', title: 'Attendance correction request', body: `${req.user.name} asked to add ${TYPE_LABEL[type]} at ${time} on ${day}.`, link: 'clock' }, req.user.id);
  res.json({ request: getReq.get(info.lastInsertRowid) });
});

// Employee: my requests.
router.get('/mine', requireAuth, (req, res) => res.json({ requests: mineReqs.all(req.user.id) }));

// Employee: cancel my own pending request.
router.post('/:id/cancel', requireAuth, (req, res) => {
  const r = getReq.get(Number(req.params.id));
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'PENDING') return res.status(409).json({ error: 'Only pending requests can be cancelled' });
  decideReq.run('REJECTED', req.user.id, now().toMillis(), 'Cancelled by employee', r.id);
  res.json({ requests: mineReqs.all(req.user.id) });
});

// ADMIN: pending + recent.
router.get('/pending', requireAdmin, (_req, res) => res.json({ requests: pendingReqs.all() }));
router.get('/all', requireAdmin, (_req, res) => res.json({ requests: recentReqs.all() }));

// ADMIN: approve (inserts the real punch) or reject.
router.post('/:id/decide', requireAdmin, (req, res) => {
  const decision = String(req.body.decision || '').toUpperCase();
  const note = String(req.body.note || '').slice(0, 300);
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: 'decision must be APPROVED or REJECTED' });
  const r = getReq.get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'PENDING') return res.status(409).json({ error: 'Already decided' });

  const apply = db.transaction(() => {
    decideReq.run(decision, req.user.id, now().toMillis(), note, r.id);
    if (decision === 'APPROVED') {
      const ts = toTs(r.day, r.time);
      insertEvent.run(r.user_id, r.type, ts, attendanceDayFromTs(ts), `correction approved by ${req.user.name}`);
    }
  });
  apply();
  const who = getUserName.get(r.user_id);
  notify(r.user_id, {
    type: 'PUNCH',
    title: decision === 'APPROVED' ? 'Punch correction approved' : 'Punch correction rejected',
    body: `Your request to add ${TYPE_LABEL[r.type]} at ${r.time} on ${r.day} was ${decision.toLowerCase()}${note ? ` — ${note}` : ''}.`,
    link: 'clock',
  });
  res.json({ request: getReq.get(r.id), user: who });
});

module.exports = router;
