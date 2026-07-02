'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin, hashPassword } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const PUBLIC_COLS = `id, name, email, emp_code, role, department, title, phone, active`;
const listAll = db.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE active = 1 ORDER BY name`);
const listAllIncInactive = db.prepare(`SELECT ${PUBLIC_COLS}, leave_balance FROM users ORDER BY active DESC, name`);
const getOne = db.prepare(`SELECT ${PUBLIC_COLS}, leave_balance FROM users WHERE id = ?`);
const findByEmail = db.prepare(`SELECT id FROM users WHERE email = ?`);
const findByCode = db.prepare(`SELECT id FROM users WHERE emp_code = ? AND emp_code != ''`);
const insertUser = db.prepare(
  `INSERT INTO users (name, email, password_hash, emp_code, role, department, title, phone, leave_balance, active, created_ts)
   VALUES (@name, @email, @password_hash, @emp_code, @role, @department, @title, @phone, @leave_balance, 1, @created_ts)`
);
const updateUser = db.prepare(
  `UPDATE users SET name=@name, email=@email, emp_code=@emp_code, role=@role, department=@department,
   title=@title, phone=@phone, leave_balance=@leave_balance WHERE id=@id`
);
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
router.get('/manage', requireAdmin, (_req, res) => res.json({ users: listAllIncInactive.all() }));

// ADMIN: create employee.
router.post('/', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email || password.length < 6) {
    return res.status(400).json({ error: 'Name, email, and a 6+ char password are required' });
  }
  if (findByEmail.get(email)) return res.status(409).json({ error: 'Email already in use' });
  const empCode = String(req.body.emp_code || '').trim();
  if (empCode && findByCode.get(empCode)) return res.status(409).json({ error: 'Employee code already in use' });
  const info = insertUser.run({
    name, email,
    password_hash: hashPassword(password),
    emp_code: empCode,
    role: String(req.body.role || 'EMPLOYEE').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
    department: String(req.body.department || ''),
    title: String(req.body.title || ''),
    phone: String(req.body.phone || ''),
    leave_balance: Number(req.body.leave_balance) >= 0 ? Number(req.body.leave_balance) : 18,
    created_ts: now().toMillis(),
  });
  res.json({ user: getOne.get(info.lastInsertRowid) });
});

// ADMIN: update employee profile.
router.put('/:id', requireAdmin, (req, res) => {
  const existing = getOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
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
  updateUser.run({
    id: existing.id,
    name: String(req.body.name ?? existing.name),
    email: String(req.body.email ?? existing.email).toLowerCase(),
    emp_code: empCode,
    role: String(req.body.role ?? existing.role).toUpperCase() === 'ADMIN' ? 'ADMIN' : 'EMPLOYEE',
    department: String(req.body.department ?? existing.department),
    title: String(req.body.title ?? existing.title),
    phone: String(req.body.phone ?? existing.phone),
    leave_balance: Number(req.body.leave_balance ?? existing.leave_balance),
  });
  res.json({ user: getOne.get(existing.id) });
});

// ADMIN: reset a password.
router.post('/:id/password', requireAdmin, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
  setPassword.run(hashPassword(pw), Number(req.params.id));
  res.json({ ok: true });
});

// ADMIN: deactivate / reactivate.
router.post('/:id/active', requireAdmin, (req, res) => {
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
