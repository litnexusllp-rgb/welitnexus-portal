'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const {
  verifyPassword, issueToken, setAuthCookie, clearAuthCookie, requireAuth,
} = require('../auth');

const router = express.Router();
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1');

// Throttle login attempts to blunt brute-force / credential-stuffing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15 minutes
  max: 10,                         // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' },
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

module.exports = router;
