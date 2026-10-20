'use strict';

// "Fix my punch" — employees submit an attendance correction (a missed or
// wrong clock punch). Approval adds a missed punch or updates an existing one.
// Everything is filed under the shift/attendance day, consistent with the rest
// of attendance.

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now, DateTime } = require('../time');
const { notify, notifyAdmins } = require('../notify');
const { validateDay, attendanceError } = require('../attendanceValidation');

const { daySettings, snapshot, wallTime, withTimes } = require('../attendanceSession');
const userFor = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const router = express.Router();

const EVENT_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
const TYPE_LABEL = { IN: 'Clock in', OUT: 'Clock out', BREAK_START: 'Break start', BREAK_END: 'Break end' };

const insertReq = db.prepare(
  `INSERT INTO punch_requests (user_id, day, type, time, reason, status, created_ts, operation, target_event_id, original_event)
   VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`
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
const decideReq = db.prepare(`UPDATE punch_requests SET status = ?, decided_by = ?, decided_ts = ?, admin_note = ? WHERE id = ? AND status = 'PENDING'`);
const getUserName = db.prepare(`SELECT id, name FROM users WHERE id = ?`);
const insertEvent = db.prepare(`INSERT INTO events (user_id, type, ts, day, note, device) VALUES (?, ?, ?, ?, ?, '')`);
const getEvent = db.prepare('SELECT * FROM events WHERE id = ?');
const dayEvents = db.prepare('SELECT * FROM events WHERE user_id = ? AND day = ? ORDER BY ts, id');
const editEvent = db.prepare('UPDATE events SET ts = ? WHERE id = ?');
const auditChange = db.prepare(`INSERT INTO punch_request_changes
  (request_id, event_id, before_json, after_json, changed_by, changed_ts) VALUES (?, ?, ?, ?, ?, ?)`);

function fail(message, status = 409) {
  throw Object.assign(new Error(message), { status, attendanceValidation: true });
}

// Older clients/requests had no operation or target. Only infer a replacement
// when there is exactly one matching punch; never guess among multiple breaks.
function legacyTarget(userId, day, type) {
  const matches = dayEvents.all(userId, day).filter(e => e.type === type);
  if (matches.length > 1) fail('Multiple matching punches. Cancel this request and submit a new correction selecting the original punch.');
  return matches[0] || null;
}

function withOriginalTime(r) {
  const original = r.original_event ? JSON.parse(r.original_event) : null;
  const c = daySettings(userFor(r.user_id), r.day);
  return { ...r, timezone: c.timezone, event_date: r.requested_ts ? DateTime.fromMillis(r.requested_ts, { zone: c.timezone }).toISODate() : null, original_time: original ? DateTime.fromMillis(original.ts, { zone: c.timezone }).toFormat('HH:mm') : null };
}

// Combine an attendance day (yyyy-LL-dd) + HH:mm into epoch ms. A time before
// the cutover is the post-midnight tail of that shift → next calendar day.
function toTs(day, time, userId, eventDate) {
  return wallTime(day, time, daySettings(userFor(userId), day), eventDate);
}

// Employee: submit a correction request.
router.post('/', requireAuth, (req, res) => {
  const day = String(req.body.day || '');
  const type = String(req.body.type || '').toUpperCase();
  const time = String(req.body.time || '');
  const reason = String(req.body.reason || '').slice(0, 300);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Valid day (yyyy-mm-dd) required' });
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid punch type' });
  if (!/^\d{2}:\d{2}$/.test(time) || toTs(day, time, req.user.id, req.body.event_date) === null) return res.status(400).json({ error: 'Valid time (HH:mm) required' });
  const operation = req.body.operation == null ? null : String(req.body.operation).toUpperCase();
  if (operation !== null && !['ADD', 'EDIT'].includes(operation)) return res.status(400).json({ error: 'operation must be ADD or EDIT' });
  if (operation !== 'EDIT' && req.body.target_event_id != null) return res.status(400).json({ error: 'Only EDIT may select an original punch' });
  try {
    const result = db.transaction(() => {
      let target = null;
      if (operation === 'EDIT') {
        if (!Number.isSafeInteger(req.body.target_event_id)) fail('Select the original punch to correct.', 400);
        target = getEvent.get(req.body.target_event_id);
        if (!target || target.user_id !== req.user.id || target.day !== day || target.type !== type) fail('Original punch not found for your selected day and type.', 404);
      } else if (operation === null) target = legacyTarget(req.user.id, day, type);
      const actualOperation = target ? 'EDIT' : 'ADD';
      const info = insertReq.run(req.user.id, day, type, time, reason, now().toMillis(), actualOperation, target?.id ?? null, target ? JSON.stringify(target) : null);
      notifyAdmins({ type: 'PUNCH', title: 'Attendance correction request', body: `${req.user.name} asked to ${target ? 'correct' : 'add'} ${TYPE_LABEL[type]} at ${time} on ${day}.`, link: 'clock' }, req.user.id);
      const originalDate = target && DateTime.fromMillis(target.ts, { zone: daySettings(req.user, day).timezone }).toISODate();
      const requestedTs = toTs(day, time, req.user.id, req.body.event_date || (originalDate > day ? originalDate : undefined));
      if (requestedTs === null) fail('Invalid or ambiguous local date/time.', 400);
      snapshot(req.user, day);
      db.prepare('UPDATE punch_requests SET requested_ts=? WHERE id=?').run(requestedTs, info.lastInsertRowid);
      return getReq.get(info.lastInsertRowid);
    }).immediate();
    res.json({ request: withOriginalTime(result) });
  } catch (e) { return attendanceError(e, res); }
});

// Read only the signed-in employee's punches, in the recorded workday timezone.
router.get('/events', requireAuth, (req, res) => {
  const day = String(req.query.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || toTs(day, '12:00', req.user.id) === null) return res.status(400).json({ error: 'Valid day required' });
  const c = daySettings(req.user, day);
  res.json({ day, ...c, events: withTimes(dayEvents.all(req.user.id, day), c) });
});

// Employee: my requests.
router.get('/mine', requireAuth, (req, res) => res.json({ requests: mineReqs.all(req.user.id).map(withOriginalTime) }));

// Employee: cancel my own pending request.
router.post('/:id/cancel', requireAuth, (req, res) => {
  const r = getReq.get(Number(req.params.id));
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'PENDING') return res.status(409).json({ error: 'Only pending requests can be cancelled' });
  if (!decideReq.run('REJECTED', req.user.id, now().toMillis(), 'Cancelled by employee', r.id).changes) return res.status(409).json({ error: 'Already decided' });
  res.json({ requests: mineReqs.all(req.user.id).map(withOriginalTime) });
});

// ADMIN: pending + recent.
router.get('/pending', requireAdmin, (_req, res) => res.json({ requests: pendingReqs.all().map(withOriginalTime) }));
router.get('/all', requireAdmin, (_req, res) => res.json({ requests: recentReqs.all().map(withOriginalTime) }));

// ADMIN: decide and apply exactly once, with validation and audit in one write lock.
router.post('/:id/decide', requireAdmin, (req, res) => {
  const decision = String(req.body.decision || '').toUpperCase();
  const note = String(req.body.note || '').slice(0, 300);
  if (!['APPROVED', 'REJECTED'].includes(decision)) return res.status(400).json({ error: 'decision must be APPROVED or REJECTED' });
  const apply = db.transaction(() => {
    const r = getReq.get(Number(req.params.id));
    if (!r) fail('Not found', 404);
    if (r.status !== 'PENDING') fail('Already decided');
    const decidedTs = now().toMillis();
    let target = null;
    if (decision === 'APPROVED') {
      const ts = r.requested_ts ?? toTs(r.day, r.time, r.user_id);
      if (ts === null) fail('Invalid correction date or time.', 400);
      if (r.operation === 'EDIT') {
        target = getEvent.get(r.target_event_id);
        if (!target || target.user_id !== r.user_id || target.day !== r.day || target.type !== r.type || JSON.stringify(target) !== r.original_event) {
          fail('The original punch changed or was deleted. Cancel this request and submit a new correction.');
        }
      } else if (r.operation === null) target = legacyTarget(r.user_id, r.day, r.type);
      else if (r.operation !== 'ADD') fail('Invalid correction operation.', 400);
      let eventId;
      if (target) {
        const events = dayEvents.all(r.user_id, r.day);
        const i = events.findIndex(e => e.id === target.id);
        if ((i > 0 && ts <= events[i - 1].ts) || (i + 1 < events.length && ts >= events[i + 1].ts)) {
          fail('The corrected time must stay between the preceding and following punches.');
        }
        editEvent.run(ts, target.id);
        eventId = target.id;
      } else {
        eventId = insertEvent.run(r.user_id, r.type, ts, r.day, `correction approved by ${req.user.name}`).lastInsertRowid;
      }
      validateDay(r.user_id, r.day);
      auditChange.run(r.id, eventId, target ? JSON.stringify(target) : null, JSON.stringify(getEvent.get(eventId)), req.user.id, decidedTs);
    }
    if (!decideReq.run(decision, req.user.id, decidedTs, note, r.id).changes) fail('Already decided');
    const action = (r.operation === 'EDIT' || target) ? 'correct' : r.operation === 'ADD' ? 'add' : 'change';
    notify(r.user_id, {
      type: 'PUNCH', title: decision === 'APPROVED' ? 'Punch correction approved' : 'Punch correction rejected',
      body: `Your request to ${action} ${TYPE_LABEL[r.type]} at ${r.time} on ${r.day} was ${decision.toLowerCase()}${note ? ` — ${note}` : ''}.`, link: 'clock',
    });
    return { request: withOriginalTime(getReq.get(r.id)), user: getUserName.get(r.user_id) };
  });
  try { res.json(apply.immediate()); } catch (e) { return attendanceError(e, res); }
});

module.exports = router;
