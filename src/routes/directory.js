'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { now } = require('../time');
const { IANAZone } = require('luxon');
const { currentSession, snapshot } = require('../attendanceSession');
const { employmentError } = require('../employment');
const { syncBalance, syncAllBalancesAsync } = require('../leavePolicy');
const { validateSalary, saveSalary, salaryHistory } = require('../salaryDeduction');

const { hashPasswordAsync } = require('../passwords');
const asyncRoute = require('../asyncRoute');
function adminStillAuthorized(req, res) {
  const actor = db.prepare('SELECT role,active,session_version FROM users WHERE id=?').get(req.user.id);
  if (actor?.active && actor.role === 'ADMIN' && actor.session_version === req.user.session_version) return true;
  res.status(401).json({ error: 'Account changed. Please sign in again.' }); return false;
}
const router = express.Router();

const PUBLIC_COLS = `id, name, email, emp_code, role, department, title, phone, shift_start, attendance_timezone, attendance_cutover, join_date, exit_date, birthday, asana_email, created_ts, active`;
const listAll = db.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE active = 1 ORDER BY name`);
const listAllIncInactive = db.prepare(`SELECT ${PUBLIC_COLS}, leave_balance FROM users ORDER BY active DESC, name`);
const getOne = db.prepare(`SELECT ${PUBLIC_COLS}, leave_balance FROM users WHERE id = ?`);
const findByEmail = db.prepare(`SELECT id FROM users WHERE email = ?`);
const findByCode = db.prepare(`SELECT id FROM users WHERE emp_code = ? AND emp_code != ''`);
const insertUser = db.prepare(
  `INSERT INTO users (name, email, password_hash, emp_code, role, department, title, phone, shift_start, attendance_timezone, attendance_cutover, join_date, exit_date, birthday, asana_email, leave_balance, active, created_ts)
   VALUES (@name, @email, @password_hash, @emp_code, @role, @department, @title, @phone, @shift_start, @attendance_timezone, @attendance_cutover, @join_date, @exit_date, @birthday, @asana_email, @leave_balance, 1, @created_ts)`
);
const updateUser = db.prepare(
  `UPDATE users SET name=@name, email=@email, emp_code=@emp_code, role=@role, department=@department,
   title=@title, phone=@phone, shift_start=@shift_start, attendance_timezone=@attendance_timezone, attendance_cutover=@attendance_cutover, join_date=@join_date, exit_date=@exit_date, birthday=@birthday, asana_email=@asana_email WHERE id=@id`
);
// Accept "HH:mm" (24h) or empty; anything else is stored as blank (firm default).
const cleanShift = (v) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v).padStart(5, '0') : '');
// Accept "yyyy-mm-dd" or empty.
const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const setActive = db.prepare(`UPDATE users SET active = ? WHERE id = ?`);
const setPassword = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);
// Count active admins OTHER than the given user — used to prevent locking the
// firm out by demoting/deactivating the last administrator.
const otherActiveAdmins = db.prepare(
  `SELECT COUNT(*) AS c FROM users WHERE role = 'ADMIN' AND active = 1 AND id != ?`
);

// Everyone sees the directory of active employees.
router.get('/', requireAuth, (_req, res) => res.json({ users: listAll.all() }));

// ADMIN: full list (used for assigning tasks, managing people).
router.get('/manage', requireAdmin, require('../asyncRoute')(async (_req, res) => { await syncAllBalancesAsync(); res.json({ users: listAllIncInactive.all() }); }));

// Compensation is never included in the shared employee directory or auth
// payloads. Only admins can read or edit another employee's salary history.
router.get('/:id/salary', require('../requestValidation').validateParams, requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = getOne.get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  res.json(salaryHistory(user.id));
});

function salaryError(body) {
  if (body.salary === undefined) return null;
  try { validateSalary(body.salary); return null; } catch (e) { return e.message; }
}

function configError(body) {
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return 'Name cannot be empty';
  if (body.email !== undefined && (typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()))) return 'Use a valid email address';
  if (body.attendance_timezone != null && body.attendance_timezone !== '' && (typeof body.attendance_timezone !== 'string' || !IANAZone.isValidZone(body.attendance_timezone))) return 'Use a valid IANA attendance timezone.';
  if (body.attendance_cutover != null && (!Number.isInteger(body.attendance_cutover) || body.attendance_cutover < 0 || body.attendance_cutover > 23)) return 'Attendance cutover must be an integer hour from 0 to 23, or null for the office default.';
  return null;
}

// ADMIN: create employee.
router.post('/', requireAdmin, asyncRoute(async (req, res) => {
  const se = salaryError(req.body); if (se) return res.status(400).json({ error: se });
  const ce = configError(req.body); if (ce) return res.status(400).json({ error: ce });
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email || password.length < 6) {
    return res.status(400).json({ error: 'Name, email, and a 6+ char password are required' });
  }
  if (findByEmail.get(email)) return res.status(409).json({ error: 'Email already in use' });
  const datesError = employmentError(req.body.join_date, req.body.exit_date);
  if (datesError) return res.status(400).json({ error: datesError });
  const empCode = String(req.body.emp_code || '').trim();
  if (empCode && findByCode.get(empCode)) return res.status(409).json({ error: 'Employee code already in use' });
  const passwordHash = await hashPasswordAsync(password);
  if (!adminStillAuthorized(req, res)) return;
  // Recheck identity after asynchronous hashing before inserting atomically.
  if (findByEmail.get(email) || (empCode && findByCode.get(empCode))) return res.status(409).json({ error: 'Email or employee code already in use' });
  const info = db.transaction(() => {
    const created = insertUser.run({
      name, email,
      password_hash: passwordHash,
      emp_code: empCode,
      role: String(req.body.role || 'EMPLOYEE').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
      department: String(req.body.department || ''),
      title: String(req.body.title || ''),
      phone: String(req.body.phone || ''),
      shift_start: cleanShift(req.body.shift_start),
      attendance_timezone: req.body.attendance_timezone || '',
      attendance_cutover: req.body.attendance_cutover ?? null,
      join_date: cleanDate(req.body.join_date),
      exit_date: cleanDate(req.body.exit_date),
      birthday: cleanDate(req.body.birthday),
      asana_email: String(req.body.asana_email || '').trim().toLowerCase().slice(0,160),
      leave_balance: 20,
      created_ts: now().toMillis(),
    });
    if (req.body.salary !== undefined) saveSalary(created.lastInsertRowid, req.body.salary, req.user.id);
    syncBalance(created.lastInsertRowid);
    return created;
  }).immediate();
  res.json({ user: getOne.get(info.lastInsertRowid) });
}));

// Self-service: update your OWN basic personal details.
// Deliberately narrow — only name, phone and birthday. Everything else
// (email/login, role, employee code, department, title, shift start, joining
// and last working day, leave balance, active) stays admin-controlled, because
// it affects identity, pay, permissions or the punctuality KPI.
const updateOwnProfile = db.prepare(
  `UPDATE users SET name = @name, phone = @phone, birthday = @birthday WHERE id = @id`
);
router.put('/me', requireAuth, (req, res) => {
  const me = getOne.get(req.user.id);
  if (!me) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name ?? me.name).trim();
  if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
  updateOwnProfile.run({
    id: me.id,
    name: name.slice(0, 120),
    phone: String(req.body.phone ?? me.phone).slice(0, 40),
    birthday: cleanDate(req.body.birthday ?? me.birthday),
  });
  res.json({ user: getOne.get(me.id) });
});

// ADMIN: update employee profile.
router.put('/:id', require('../requestValidation').validateParams, requireAdmin, (req, res) => {
  const se = salaryError(req.body); if (se) return res.status(400).json({ error: se });
  const existing = getOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const ce = configError(req.body); if (ce) return res.status(400).json({ error: ce });
  const nextZone = req.body.attendance_timezone ?? existing.attendance_timezone;
  const nextCutover = req.body.attendance_cutover === undefined ? existing.attendance_cutover : req.body.attendance_cutover;
  const changedConfig = nextZone !== existing.attendance_timezone || nextCutover !== existing.attendance_cutover || cleanShift(req.body.shift_start ?? existing.shift_start) !== existing.shift_start;
  if (changedConfig && currentSession(existing).ongoing) return res.status(409).json({ error: 'Close or correct the open session before changing attendance settings.' });
  const datesError = employmentError(req.body.join_date ?? existing.join_date, req.body.exit_date ?? existing.exit_date);
  if (datesError) return res.status(400).json({ error: datesError });
  const newEmail = String(req.body.email ?? existing.email).toLowerCase();
  const emailOwner = findByEmail.get(newEmail);
  if (emailOwner && emailOwner.id !== existing.id) {
    return res.status(409).json({ error: 'Email already in use by another employee' });
  }
  const empCode = String(req.body.emp_code ?? existing.emp_code).trim();
  if (empCode) {
    const codeOwner = findByCode.get(empCode);
    if (codeOwner && codeOwner.id !== existing.id) {
      return res.status(409).json({ error: 'Employee code already in use by another employee' });
    }
  }
  // Don't let the last active admin be demoted — it would lock everyone out.
  const newRole = String(req.body.role ?? existing.role).toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE';
  if (existing.role === 'ADMIN' && newRole !== 'ADMIN' && otherActiveAdmins.get(existing.id).c === 0) {
    return res.status(409).json({ error: 'This is the last admin — promote another admin before removing admin rights.' });
  }
  db.transaction(() => {
    if (changedConfig) {
      for (const row of db.prepare('SELECT DISTINCT day FROM events WHERE user_id=?').all(existing.id)) snapshot(existing, row.day);
    }
    updateUser.run({
      id: existing.id,
      name: String(req.body.name ?? existing.name),
      email: String(req.body.email ?? existing.email).toLowerCase(),
      emp_code: empCode,
      role: String(req.body.role ?? existing.role).toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
      department: String(req.body.department ?? existing.department),
      title: String(req.body.title ?? existing.title),
      phone: String(req.body.phone ?? existing.phone),
      shift_start: cleanShift(req.body.shift_start ?? existing.shift_start),
      attendance_timezone: nextZone,
      attendance_cutover: nextCutover,
      join_date: cleanDate(req.body.join_date ?? existing.join_date),
      exit_date: cleanDate(req.body.exit_date ?? existing.exit_date),
      birthday: cleanDate(req.body.birthday ?? existing.birthday),
      asana_email: String(req.body.asana_email ?? existing.asana_email ?? '').trim().toLowerCase().slice(0,160),
    });
    if (req.body.salary !== undefined) saveSalary(existing.id, req.body.salary, req.user.id);
  }).immediate();
  syncBalance(existing.id);
  res.json({ user: getOne.get(existing.id) });
});

// ADMIN: reset a password.
router.post('/:id/password', require('../requestValidation').validateParams, requireAdmin, asyncRoute(async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
  const hashed = await hashPasswordAsync(pw);
  if (!adminStillAuthorized(req, res)) return;
  if (!setPassword.run(hashed, Number(req.params.id)).changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

// ADMIN: deactivate / reactivate.
router.post('/:id/active', require('../requestValidation').validateParams, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const target = getOne.get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  // Don't let the last active admin be deactivated — it would lock everyone out.
  if (!req.body.active && target.role === 'ADMIN' && otherActiveAdmins.get(id).c === 0) {
    return res.status(409).json({ error: 'This is the last admin — promote another admin before deactivating this account.' });
  }
  setActive.run(req.body.active ? 1 : 0, id);
  res.json({ user: getOne.get(id) });
});

module.exports = router;
