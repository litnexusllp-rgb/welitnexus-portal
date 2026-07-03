'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const {
  verifyPassword, hashPassword, issueToken, setAuthCookie, clearAuthCookie, requireAuth,
} = require('../auth');

const router = express.Router();
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1');
const getUserFull = db.prepare('SELECT * FROM users WHERE id = ?');
const setPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

// Throttle login attempts to blunt brute-force / credential-stuffing.
// Only FAILED attempts count (skipSuccessfulRequests), and the cap is high
// enough that a whole team behind one shared mobile-carrier IP (CGNAT) can all
// sign in — a successful login never consumes the budget, so only repeated
// wrong-password attempts from one IP are throttled.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15 minutes
  max: 50,                         // failed attempts per IP per window
  skipSuccessfulRequests: true,    // don't count successful logins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts. Please wait a few minutes and try again.' },
});

router.post('/login', loginLimiter, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = findByEmail.get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = issueToken(user);
  setAuthCookie(res, token);
  delete user.password_hash;
  res.json({ user });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Self-service: change your own password (must confirm the current one).
router.post('/change-password', requireAuth, (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = getUserFull.get(req.user.id);
  if (!user || !verifyPassword(current, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  setPassword.run(hashPassword(next), user.id);
  res.json({ ok: true });
});

module.exports = router;
