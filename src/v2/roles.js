'use strict';

// Admin console access levels and the audit log.
//
//   OWNER   — the partners. Everything, including people, payroll, billing,
//             settings, integrations and granting admin access.
//   BILLING — delegated admins. Clients, invoices and billing reports only.
//
// Existing users with users.role = 'ADMIN' are treated as OWNER unless a row
// in int_user_roles says otherwise, so current partner accounts keep working
// with no data change. BILLING admins keep users.role = 'EMPLOYEE', which is
// why none of the existing admin-only routes become reachable for them.

const { db } = require('../db');

const getRole = db.prepare('SELECT level FROM int_user_roles WHERE user_id = ?');
const insertAudit = db.prepare(
  'INSERT INTO int_audit_log(actor_id, action, target, detail, ip, ts) VALUES (?,?,?,?,?,?)',
);

function adminLevel(user) {
  if (!user) return null;
  const row = getRole.get(user.id);
  if (user.role === 'ADMIN') return 'OWNER';
  return row && row.level === 'BILLING' ? 'BILLING' : null;
}

function audit(req, action, target = '', detail = {}) {
  insertAudit.run(
    req && req.user ? req.user.id : null,
    action,
    String(target),
    JSON.stringify(detail || {}),
    (req && req.ip) || '',
    Date.now(),
  );
}

// The admin console requires its own cookie (from signing in at /admin) in
// addition to the normal session. See src/auth.js loadUser.
function consoleGuard(levels) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const level = adminLevel(req.user);
    if (!level || !levels.includes(level))
      return res.status(403).json({ error: 'You do not have access to this part of the admin console' });
    if (!req.adminConsole)
      return res.status(403).json({ error: 'Sign in to the admin console to continue', code: 'ADMIN_CONSOLE' });
    req.adminLevel = level;
    next();
  };
}

const requireOwner = consoleGuard(['OWNER']);
const requireBilling = consoleGuard(['OWNER', 'BILLING']);

module.exports = { adminLevel, audit, requireOwner, requireBilling };
