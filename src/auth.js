'use strict';

// Authentication helpers: password hashing, JWT issue/verify, and Express
// middleware that loads the current user onto req.user.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

// In production a real secret is mandatory — never fall back to a known
// default, or anyone could forge an admin session. In dev we allow a
// placeholder so the app runs without setup.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production. Refusing to start with a default secret.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const COOKIE = 'wln_session';
const TOKEN_TTL = '7d';

// Synchronous helpers are reserved for offline seed/test fixtures; HTTP uses passwords.js.
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function issueToken(user) {
  const current = db.prepare('SELECT session_version FROM users WHERE id = ?').get(user.id);
  if (!current) throw new Error('Cannot issue a session for a missing user');
  return jwt.sign({ uid: user.id, role: user.role, sv: current.session_version }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE);
  res.clearCookie(ADMIN_COOKIE);
}

// ---------- Admin console (second login) ----------
// A separate, short-lived cookie issued after signing in at /admin (password,
// plus a 6-digit code when ADMIN_2FA=required). It is checked IN ADDITION to the normal session cookie.
const ADMIN_COOKIE = 'wln_admin';
const ADMIN_TTL_SECONDS = 8 * 60 * 60;

function issueAdminToken(user, mfa) {
  const current = db.prepare('SELECT session_version FROM users WHERE id = ?').get(user.id);
  if (!current) throw new Error('Cannot issue a session for a missing user');
  return jwt.sign({ uid: user.id, sv: current.session_version, kind: 'admin-console', mfa: Boolean(mfa) }, JWT_SECRET, {
    expiresIn: ADMIN_TTL_SECONDS,
  });
}

function setAdminCookie(res, token) {
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ADMIN_TTL_SECONDS * 1000,
  });
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE);
}

// When ADMIN_CONSOLE_REQUIRED=on, the existing admin-only API routes also
// require the admin console cookie. Off by default so current admin sessions
// keep working until both partners have enrolled their 2-step codes.
// Admin console sign-in asks for a 6-digit authenticator code only when
// ADMIN_2FA=required (or on). Off by default: the admin password is enough.
const twoStepRequired = () => ['required', 'on'].includes(String(process.env.ADMIN_2FA || 'off').toLowerCase());

const consoleRequired = () => String(process.env.ADMIN_CONSOLE_REQUIRED || 'off').toLowerCase() === 'on';

const getUserById = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');

// Populates req.user (or null). Never blocks — guards do the blocking.
function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = getUserById.get(payload.uid);
      // Existing pre-migration cookies are version zero, valid only until the
      // first password, identity, role or activation change.
      const version = payload.sv === undefined ? 0 : payload.sv;
      if (user && Number.isInteger(version) && version === user.session_version) {
        delete user.password_hash;
        req.user = user;
      }
    } catch (_e) {
      /* invalid/expired token — treat as logged out */
    }
  }
  req.adminConsole = null;
  const consoleToken = req.user && req.cookies && req.cookies[ADMIN_COOKIE];
  if (consoleToken) {
    try {
      const payload = jwt.verify(consoleToken, JWT_SECRET);
      if (payload.kind === 'admin-console' && payload.uid === req.user.id && payload.sv === req.user.session_version) {
        req.adminConsole = { mfa: Boolean(payload.mfa), exp: payload.exp };
      }
    } catch (_e) {
      /* expired admin console session */
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// True only for a session allowed to use admin-only features: an ADMIN user
// who, when ADMIN_CONSOLE_REQUIRED=on, has also passed the admin console
// sign-in. Every admin check must go through this so a password-only session
// can never reach admin data once enforcement is on.
function hasAdminAccess(req) {
  return Boolean(req.user && req.user.role === 'ADMIN' && (!consoleRequired() || req.adminConsole));
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admins only' });
  if (!hasAdminAccess(req))
    return res.status(403).json({ error: 'Sign in to the admin console to continue', code: 'ADMIN_CONSOLE' });
  next();
}

module.exports = {
  COOKIE,
  ADMIN_COOKIE,
  issueAdminToken,
  setAdminCookie,
  clearAdminCookie,
  consoleRequired,
  twoStepRequired,
  hasAdminAccess,
  hashPassword,
  verifyPassword,
  issueToken,
  setAuthCookie,
  clearAuthCookie,
  loadUser,
  requireAuth,
  requireAdmin,
};
