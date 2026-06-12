'use strict';

const express = require('express');
const { db } = require('../db');
const {
  verifyPassword, issueToken, setAuthCookie, clearAuthCookie, requireAuth,
} = require('../auth');

const router = express.Router();
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1');

router.post('/login', (req, res) => {
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
