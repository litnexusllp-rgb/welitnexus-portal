'use strict';
const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../auth');
const { db } = require('../db');
const { buildSalaries } = require('../salaries');
const { now } = require('../time');
const { employeeSalaryReport, withSalarySlips, slipEligibility } = require('../employeeSalary');
const { renderSalarySlip } = require('../salarySlip');
const slipLimiter = require('express-rate-limit')({ windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false, keyGenerator: req => String(req.user.id),
  message: { error: 'Too many salary-slip downloads. Please try again later.' } });
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const requireEmployee = (req, res, next) => {
  if (req.user.role !== 'EMPLOYEE') return res.status(403).json({ error: 'Use an employee account to view personal salary records.' });
  if (Object.keys(req.query).some(key => key !== 'month')) return res.status(400).json({ error: 'Only the salary month can be selected.' });
  next();
};

router.get('/mine', requireAuth, requireEmployee, (req, res) => {
  try { res.json(employeeSalaryReport(db, req.user.id, req.query.month)); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not load your salary calculation. Please try again.' }); }
});

async function sendSlip(req, res, userId) {
  try {
    if (typeof req.query.month !== 'string') fail('Choose a salary month.');
    const report = employeeSalaryReport(db, userId, req.query.month), row = report.rows[0];
    if (!row) fail('No employment records for this salary month.', 404);
    const reason = slipEligibility(report, row); if (reason) fail(reason, 409);
    const pdf = await renderSalarySlip(report, row);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="salary-slip-${report.month}-${userId}.pdf"`);
    res.send(pdf);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not create the salary slip. Please try again.' }); }
}

router.get('/mine/slip', requireAuth, requireEmployee, slipLimiter, require('../asyncRoute')((req, res) => sendSlip(req, res, req.user.id)));

router.use(requireAdmin);
router.get('/', (req, res) => {
  try { res.json(withSalarySlips(buildSalaries(db, req.query.month))); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not calculate salaries. Please try again.' }); }
});
router.get('/:id/slip', require('../requestValidation').validateParams, slipLimiter, require('../asyncRoute')((req, res) => sendSlip(req, res, Number(req.params.id))));

function fail(message, status=400) { throw Object.assign(new Error(message), { status }); }
function target(req) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) fail('Choose a valid employee.');
  if (typeof req.body.month !== 'string') fail('Choose a salary month.');
  const row = buildSalaries(db, req.body.month).rows.find(row => row.id === id);
  if (!row) fail('Employee not found in this salary month.',404);
  if (!Number.isSafeInteger(req.body.expected_revision) || req.body.expected_revision < 0) fail('Reload this salary review and try again.');
  return row;
}
function audit(id, month, action, before, admin) {
  const after = db.prepare('SELECT * FROM salary_month_reviews WHERE user_id=? AND month=?').get(id,month);
  db.prepare('INSERT INTO salary_month_review_events(user_id,month,action,before_json,after_json,changed_by,changed_ts) VALUES(?,?,?,?,?,?,?)')
    .run(id,month,action,before ? JSON.stringify(before) : null,JSON.stringify(after),admin,now().toMillis());
}
const reportError = (res,error) => res.status(error.status || 500).json({ error:error.status ? error.message : 'Could not save the salary review. Please try again.' });

router.post('/:id/review', require('../requestValidation').validateParams, (req,res) => {
  try {
    const amount = String(req.body.amount ?? '').trim(), note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(amount)) fail('Enter a non-negative salary-to-pay amount with up to 2 decimal places.');
    if (!note || note.length > 1000) fail('Add a calculation or reason, up to 1,000 characters.');
    const [rupees,decimals=''] = amount.split('.'), paise = Number(rupees)*100 + Number(decimals.padEnd(2,'0'));
    db.transaction(() => {
      const row = target(req), month = req.body.month;
      if (row.source_fingerprint !== req.body.source_fingerprint) fail('Salary, leave or employment records changed. Reload and review the current calculation.',409);
      if (row.status === 'CALCULATED') fail('This amount is calculated automatically. Update the source salary or leave records instead.',409);
      const before = db.prepare('SELECT * FROM salary_month_reviews WHERE user_id=? AND month=?').get(row.id,month);
      if (before && before.reopened_ts === null && before.source_fingerprint === row.source_fingerprint && before.amount_paise === paise && before.note === note) return;
      if ((before?.revision || 0) !== req.body.expected_revision) fail('Another admin changed this review. Reload before saving.',409);
      db.prepare(`INSERT INTO salary_month_reviews(user_id,month,amount_paise,note,source_fingerprint,input_snapshot_json,revision,reviewed_by,reviewed_ts)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET amount_paise=excluded.amount_paise,note=excluded.note,
        source_fingerprint=excluded.source_fingerprint,input_snapshot_json=excluded.input_snapshot_json,revision=excluded.revision,
        reviewed_by=excluded.reviewed_by,reviewed_ts=excluded.reviewed_ts,reopened_by=NULL,reopened_ts=NULL`)
        .run(row.id,month,paise,note,row.source_fingerprint,JSON.stringify(row),(before?.revision || 0)+1,req.user.id,now().toMillis());
      audit(row.id,month,'CONFIRM',before,req.user.id);
    }).immediate();
    res.json({ ok:true });
  } catch (error) { reportError(res,error); }
});

router.post('/:id/review/reopen', require('../requestValidation').validateParams, (req,res) => {
  try {
    db.transaction(() => {
      const row = target(req), month = req.body.month;
      const before = db.prepare('SELECT * FROM salary_month_reviews WHERE user_id=? AND month=?').get(row.id,month);
      if (!before) fail('There is no confirmation to reopen.',404);
      if (before.revision !== req.body.expected_revision) fail('Another admin changed this review. Reload before reopening it.',409);
      if (before.reopened_ts !== null) return;
      db.prepare('UPDATE salary_month_reviews SET reopened_by=?,reopened_ts=?,revision=revision+1 WHERE user_id=? AND month=?')
        .run(req.user.id,now().toMillis(),row.id,month);
      audit(row.id,month,'REOPEN',before,req.user.id);
    }).immediate();
    res.json({ ok:true });
  } catch (error) { reportError(res,error); }
});
module.exports = router;
