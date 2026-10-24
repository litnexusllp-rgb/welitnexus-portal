'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { syncBalance } = require('../leavePolicy');
const {
  issueToken, setAuthCookie, clearAuthCookie, requireAuth,
} = require('../auth');

const { hashPasswordAsync, verifyPasswordAsync } = require('../passwords');
const asyncRoute = require('../asyncRoute');
const router = express.Router();
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1');
const getUserFull = db.prepare('SELECT * FROM users WHERE id = ?');

// Throttle login attempts to blunt brute-force / credential-stuffing.
// Only FAILED attempts count (skipSuccessfulRequests), and the cap is high
// enough that a whole team behind one shared mobile-carrier IP (CGNAT) can all
// sign in — a successful login never consumes the budget, so only repeated
// wrong-password attempts from one IP are throttled.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15 minutes
  max: 50,                         // failed attempts per IP per window
  keyGenerator: require('../rateLimitKey').ipKey,
  skipSuccessfulRequests: true,    // don't count successful logins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts. Please wait a few minutes and try again.' },
});

router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = findByEmail.get(email);
  const hash = user?.password_hash || '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  const verified = await verifyPasswordAsync(password, hash);
  if (!user || !verified) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const currentUser = getUserFull.get(user.id);
  if (!currentUser?.active || currentUser.session_version !== user.session_version) return res.status(401).json({ error: 'Account changed. Please sign in again.' });
  const token = issueToken(currentUser);
  user.leave_balance = syncBalance(user.id).balance;
  setAuthCookie(res, token);
  delete user.password_hash;
  res.json({ user });
}));

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { ...req.user, leave_balance: syncBalance(req.user.id).balance } });
});

// Self-service: change your own password (must confirm the current one).
router.post('/change-password', requireAuth, asyncRoute(async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = getUserFull.get(req.user.id);
  if (!user || !await verifyPasswordAsync(current, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hashed = await hashPasswordAsync(next);
  const changed = db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND active=1 AND session_version=?').run(hashed, user.id, user.password_hash, user.session_version);
  if (!changed.changes) return res.status(409).json({ error: 'Account changed. Please sign in again.' });
  // Keep this browser signed in using the new version; all old cookies fail.
  setAuthCookie(res, issueToken(user));
  res.json({ ok: true });
}));

module.exports = router;
