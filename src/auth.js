'use strict';

// Authentication helpers: password hashing, JWT issue/verify, and Express
// middleware that loads the current user onto req.user.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-welitnexus';
const COOKIE = 'wln_session';
const TOKEN_TTL = '7d';

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function issueToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
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
}

const getUserById = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');

// Populates req.user (or null). Never blocks — guards do the blocking.
function loadUser(req, _res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = getUserById.get(payload.uid);
      if (user) {
        delete user.password_hash;
        req.user = user;
      }
    } catch (_e) {
      /* invalid/expired token — treat as logged out */
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admins only' });
  next();
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  issueToken,
  setAuthCookie,
  clearAuthCookie,
  loadUser,
  requireAuth,
  requireAdmin,
};
