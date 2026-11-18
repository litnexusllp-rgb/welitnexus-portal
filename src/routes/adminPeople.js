'use strict';

// Admin console: people and access. Adding and editing employees reuses the
// existing /api/users endpoints (same validation, salary handling, invites).
// This router adds what was missing: access levels, restore, permanent delete
// and the audit log.

const express = require('express');
const { db, DB_PATH } = require('../db');
const asyncRoute = require('../asyncRoute');
const { requireOwner, audit, adminLevel } = require('../v2/roles');
const { eraseUser, blockers, backupBeforeDelete } = require('../v2/erase');

const router = express.Router();
const getUser = db.prepare(
  'SELECT id, name, email, role, active, title, department, emp_code, join_date, exit_date FROM users WHERE id = ?',
);
const ownersLeft = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='ADMIN' AND active=1 AND id <> ?");

const idParam = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return id;
};

router.get('/', requireOwner, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.title, u.department, u.emp_code, u.join_date, u.exit_date,
      r.level AS role_level, t.enabled AS two_step
    FROM users u LEFT JOIN int_user_roles r ON r.user_id = u.id LEFT JOIN int_admin_totp t ON t.user_id = u.id
    ORDER BY u.active DESC, u.name COLLATE NOCASE`,
    )
    .all();
  res.json({
    twoStepRequired: require('../auth').twoStepRequired(),
    people: rows.map((u) => ({ ...u, access: adminLevel(u) || 'EMPLOYEE', two_step: Boolean(u.two_step) })),
  });
});

// Set portal access: OWNER (full admin), BILLING (billing admin) or EMPLOYEE.
router.put('/:id/access', requireOwner, (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const level = String(req.body.level || '').toUpperCase();
  if (!['OWNER', 'BILLING', 'EMPLOYEE'].includes(level))
    return res.status(400).json({ error: 'Access must be OWNER, BILLING or EMPLOYEE' });
  const target = getUser.get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id && level !== 'OWNER')
    return res.status(409).json({ error: 'You cannot remove your own owner access.' });
  if (target.role === 'ADMIN' && level !== 'OWNER' && ownersLeft.get(id).n === 0)
    return res.status(409).json({ error: 'At least one owner must remain.' });
  const before = adminLevel(target) || 'EMPLOYEE';
  db.transaction(() => {
    const role = level === 'OWNER' ? 'ADMIN' : 'EMPLOYEE';
    if (role !== target.role)
      db.prepare('UPDATE users SET role=?, session_version=session_version+1 WHERE id=?').run(role, id);
    db.prepare('DELETE FROM int_user_roles WHERE user_id=?').run(id);
    if (level === 'BILLING')
      db.prepare('INSERT INTO int_user_roles(user_id, level, granted_by, granted_ts) VALUES (?,?,?,?)').run(
        id,
        'BILLING',
        req.user.id,
        Date.now(),
      );
  }).immediate();
  audit(req, 'people.access_changed', `user:${id}`, { from: before, to: level });
  res.json({ ok: true, access: level });
});

router.post('/:id/deactivate', requireOwner, (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const target = getUser.get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (id === req.user.id) return res.status(409).json({ error: 'You cannot deactivate yourself.' });
  if (target.role === 'ADMIN' && ownersLeft.get(id).n === 0)
    return res.status(409).json({ error: 'At least one owner must remain.' });
  db.prepare('UPDATE users SET active=0, session_version=session_version+1 WHERE id=?').run(id);
  audit(req, 'people.deactivated', `user:${id}`, { name: target.name });
  res.json({ ok: true, user: getUser.get(id) });
});

router.post('/:id/restore', requireOwner, (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  if (!getUser.get(id)) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET active=1 WHERE id=?').run(id);
  audit(req, 'people.restored', `user:${id}`);
  res.json({ ok: true, user: getUser.get(id) });
});

// What a permanent delete would remove, shown before confirming.
router.get('/:id/delete-preview', requireOwner, (req, res) => {
  const id = idParam(req, res);
  if (!id) return;
  const target = getUser.get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const count = (sql) => db.prepare(sql).get(id).n;
  res.json({
    user: target,
    blockers: blockers(db, id),
    records: {
      punches: count('SELECT COUNT(*) n FROM events WHERE user_id=?'),
      leaves: count('SELECT COUNT(*) n FROM leaves WHERE user_id=?'),
      tasks: count('SELECT COUNT(*) n FROM tasks WHERE assignee_id=?'),
      salaryRates: count('SELECT COUNT(*) n FROM employee_salary_rates WHERE user_id=?'),
    },
  });
});

// Permanent delete: OWNER only, typed-name confirmation, never yourself or an
// owner, automatic backup first.
router.delete(
  '/:id',
  requireOwner,
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const target = getUser.get(id);
    if (!target) return res.status(404).json({ error: 'Not found' });
    if (id === req.user.id) return res.status(409).json({ error: 'You cannot delete yourself.' });
    if (target.role === 'ADMIN')
      return res.status(409).json({ error: 'Remove owner access before deleting this person.' });
    if (String(req.body.confirmName || '').trim() !== target.name.trim())
      return res.status(400).json({ error: 'Type the person’s full name exactly to confirm.' });
    const found = blockers(db, id);
    if (found.length)
      return res.status(409).json({
        error: 'This person is recorded as the author of other people’s records. Deactivate them instead.',
        blockers: found,
      });
    const backupFile = await backupBeforeDelete(db, DB_PATH, id);
    const removed = eraseUser(db, id);
    audit(req, 'people.deleted', `user:${id}`, { name: target.name, email: target.email, backupFile, removed });
    res.json({ ok: true, removed, backupFile: require('node:path').basename(backupFile) });
  }),
);

router.get('/audit-log', requireOwner, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS actor_name FROM int_audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`,
    )
    .all(limit);
  res.json({ entries: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') })) });
});

module.exports = router;
