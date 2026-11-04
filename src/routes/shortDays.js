'use strict';

const router = require('express').Router();
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { DateTime, ZONE, now, todayStr } = require('../time');
const { calendarFrom, scheduledDays } = require('../leaveCalculation');
const { settings, daySettings } = require('../attendanceSession');
const { employmentStatus } = require('../employment');
const { notify } = require('../notify');
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
const error = (res,e) => res.status(e.status || 500).json({error:e.status ? e.message : 'Could not update the Short Day request.'});
const get = id => db.prepare('SELECT * FROM short_day_requests WHERE id=?').get(id);
const user = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const allowance = (id,month,exclude=null) => db.prepare(`SELECT COALESCE(SUM(CASE WHEN status='APPROVED' THEN minutes ELSE 0 END),0) AS used,
  COALESCE(SUM(CASE WHEN status='PENDING' THEN minutes ELSE 0 END),0) AS pending FROM short_day_requests
  WHERE user_id=? AND substr(date,1,7)=? AND status IN ('APPROVED','PENDING') AND id<>?`).get(id,month,exclude || 0);
function checkCredit(id,month,minutes,exclude=null) {
  const a = allowance(id,month,exclude);
  if (a.used+a.pending+minutes > 120) fail(`Short Day allowance is two hours per month. ${Math.max(0,120-a.used-a.pending)} minute(s) available.`,409);
}
function checkLeave(id,date) {
  if (db.prepare("SELECT 1 FROM leaves WHERE user_id=? AND status IN ('APPROVED','PENDING') AND start_date<=? AND end_date>=? LIMIT 1").get(id,date,date)) fail('A full/half-day leave request already covers this date. Resolve it before requesting Short Day time.',409);
}
router.use(requireAuth, (_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
router.get('/pending', requireAdmin, (_req,res) => res.json({requests:db.prepare("SELECT s.*,u.name FROM short_day_requests s JOIN users u ON u.id=s.user_id WHERE s.status='PENDING' ORDER BY s.created_ts,s.id").all()}));
router.get('/', (req,res) => {
  try {
    const id = req.query.user_id === undefined ? req.user.id : Number(req.query.user_id);
    if (!Number.isSafeInteger(id) || id < 1) fail('Choose a valid employee.');
    if (id !== req.user.id && req.user.role !== 'ADMIN') fail('Admins only',403);
    if (!user(id) || user(id).role !== 'EMPLOYEE') fail('Choose an employee account.',404);
    const month = req.query.month || todayStr().slice(0,7);
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Choose a valid month.');
    const a = allowance(id,month);
    res.json({month,timezone:settings(user(id)).timezone,limit_minutes:120,used_minutes:a.used,pending_minutes:a.pending,available_minutes:Math.max(0,120-a.used-a.pending),
      requests:db.prepare('SELECT * FROM short_day_requests WHERE user_id=? ORDER BY date DESC,id DESC').all(id)});
  } catch(e) { error(res,e); }
});
function recordShortDay(req, res, admin) {
  try {
    if (!admin && req.user.role !== 'EMPLOYEE') fail('Use an employee account to request Short Day time.',403);
    const id = admin ? Number(req.body.user_id) : req.user.id;
    const employee = user(id);
    if (!employee || employee.role !== 'EMPLOYEE') fail('Employee not found.',404);
    const date = String(req.body.date || ''), time = String(req.body.start_time || ''), minutes = Number(req.body.minutes);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('Enter a valid date and start time.');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) fail('Choose between one and 120 minutes.');
    const timezone = admin ? daySettings(employee, date).timezone : settings(employee).timezone;
    const start = DateTime.fromISO(`${date}T${time}`,{zone:timezone});
    if (!start.isValid || start.toFormat('yyyy-MM-dd HH:mm') !== `${date} ${time}` || start.getPossibleOffsets().length !== 1) fail('Choose an unambiguous local date/time outside a daylight-saving transition.');
    if (start.plus({minutes}).minus({milliseconds:1}).toISODate() !== date) fail('Split Short Day time crossing midnight into separate requests for each date.');
    const recordedAt = now().toMillis();
    const past = start.toMillis() <= recordedAt;
    if (!admin && past) fail('Request Short Day time in advance so management can approve it before it starts.');
    if (employmentStatus(employee,date)) fail('Confirm employment dates before requesting Short Day time.');
    if (!scheduledDays(date,calendarFrom(db))) fail('This date has no scheduled working time.');
    const reason = String(req.body.reason || '').trim().slice(0,500);
    const record = db.transaction(() => {
      checkCredit(id,date.slice(0,7),minutes); checkLeave(id,date);
      const overlapping = db.prepare("SELECT 1 FROM short_day_requests WHERE user_id=? AND status IN ('APPROVED','PENDING') AND start_ts<? AND start_ts+minutes*60000>? LIMIT 1")
        .get(id,start.toMillis()+minutes*60000,start.toMillis());
      if (overlapping) fail('An existing Short Day request overlaps this time.',409);
      const status = admin ? 'APPROVED' : 'PENDING';
      const note = admin ? (past ? 'Recorded by admin after the start time.' : 'Recorded and approved by admin.') : '';
      const result = db.prepare(`INSERT INTO short_day_requests
        (user_id,date,start_time,timezone,start_ts,minutes,reason,created_ts,status,decided_by,decided_ts,admin_note)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, date, time, timezone, start.toMillis(), minutes, reason, recordedAt,
        status, admin ? req.user.id : null, admin ? recordedAt : null, note,
      );
      return get(result.lastInsertRowid);
    }).immediate();
    res.json({request:record});
  } catch(e) { error(res,e); }
}
router.post('/', (req,res) => recordShortDay(req,res,false));
router.post('/admin', requireAdmin, (req,res) => recordShortDay(req,res,true));
router.post('/:id/cancel', require('../requestValidation').validateParams, (req,res) => {
  try {
    const result = db.transaction(() => {
      const r = get(Number(req.params.id));
      if (!r || r.user_id !== req.user.id) fail('Not found',404);
      if (r.status !== 'PENDING') fail('Only pending requests can be cancelled.',409);
      db.prepare("UPDATE short_day_requests SET status='CANCELLED',decided_by=?,decided_ts=? WHERE id=?").run(req.user.id,now().toMillis(),r.id);
      return get(r.id);
    }).immediate();
    res.json({request:result});
  } catch(e) { error(res,e); }
});
router.post('/:id/decide', requireAdmin, require('../requestValidation').validateParams, (req,res) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    if (!['APPROVED','REJECTED'].includes(decision)) fail('Choose approve or reject.');
    const result = db.transaction(() => {
      const r = get(Number(req.params.id));
      if (!r) fail('Not found',404);
      if (r.status !== 'PENDING') fail('Already decided.',409);
      if (decision === 'APPROVED') {
        if (r.start_ts <= now().toMillis()) fail('Short Day time must be approved before it starts. Reject this expired request and review any attendance discrepancy.',409);
        if (employmentStatus(user(r.user_id),r.date) || !scheduledDays(r.date,calendarFrom(db))) fail('The employment dates or working calendar changed. Review this request.',409);
        checkCredit(r.user_id,r.date.slice(0,7),r.minutes,r.id); checkLeave(r.user_id,r.date);
      }
      db.prepare('UPDATE short_day_requests SET status=?,decided_by=?,decided_ts=?,admin_note=? WHERE id=?')
        .run(decision,req.user.id,now().toMillis(),String(req.body.note || '').trim().slice(0,300),r.id);
      return get(r.id);
    }).immediate();
    notify(result.user_id,{type:'LEAVE',title:'Short Day '+decision.toLowerCase(),body:`${result.date}, ${result.minutes} minutes: ${decision.toLowerCase()}.`,link:'employees'});
    res.json({request:result});
  } catch(e) { error(res,e); }
});
module.exports = router;
