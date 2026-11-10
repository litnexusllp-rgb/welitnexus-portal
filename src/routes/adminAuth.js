'use strict';

// Admin console sign-in: a second login for partners and billing admins.
// Step 1: email + password. Step 2: a 6-digit code from an authenticator app
// (Google Authenticator, Microsoft Authenticator, 1Password, Authy...). The
// first time, step 2 enrols the app and returns one-time backup codes.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { verifyPasswordAsync } = require('../passwords');
const { issueToken, setAuthCookie, issueAdminToken, setAdminCookie, clearAdminCookie, requireAuth } = require('../auth');
const { adminLevel, audit, requireOwner } = require('../v2/roles');
const c = require('../v2/crypto');

const router = express.Router();
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, skipSuccessfulRequests: true,
  keyGenerator: require('../rateLimitKey').ipKey, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

const CHALLENGE_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const mfaMode = () => (String(process.env.ADMIN_2FA || 'required').toLowerCase() === 'off' ? 'off' : 'required');

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1');
const getUser = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');
const getTotp = db.prepare('SELECT * FROM int_admin_totp WHERE user_id = ?');
const saveTotp = db.prepare(`INSERT INTO int_admin_totp(user_id, secret_enc, enabled, created_ts) VALUES (?,?,0,?)
  ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc, enabled=0, backup_codes='[]', last_step=0, created_ts=excluded.created_ts, enabled_ts=NULL`);
const newChallenge = db.prepare('INSERT INTO int_admin_challenges(id, user_id, expires_ts) VALUES (?,?,?)');
const getChallenge = db.prepare('SELECT * FROM int_admin_challenges WHERE id = ?');
const bumpChallenge = db.prepare('UPDATE int_admin_challenges SET attempts = attempts + 1 WHERE id = ?');
const dropChallenge = db.prepare('DELETE FROM int_admin_challenges WHERE id = ?');
const purgeChallenges = db.prepare('DELETE FROM int_admin_challenges WHERE expires_ts < ?');

function publicUser(user) {
  const { password_hash: _ignored, ...rest } = user;
  return rest;
}

function finish(req, res, user, mfa, extra = {}) {
  setAuthCookie(res, issueToken(user));
  setAdminCookie(res, issueAdminToken(user, mfa));
  req.user = user;
  audit(req, 'admin.sign_in', `user:${user.id}`, { mfa });
  res.json({ ok: true, user: publicUser(user), access: { adminLevel: adminLevel(user), console: true }, ...extra });
}

router.post('/login', limiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = findByEmail.get(email);
  const hash = user?.password_hash || '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  const ok = await verifyPasswordAsync(password, hash);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });
  if (!adminLevel(user)) {
    req.user = user; audit(req, 'admin.sign_in_refused', `user:${user.id}`, { reason: 'not an admin' });
    return res.status(403).json({ error: 'This account does not have admin console access. Use the employee portal instead.' });
  }
  if (mfaMode() === 'off') return finish(req, res, user, false);

  purgeChallenges.run(Date.now());
  const challengeId = c.randomId();
  newChallenge.run(challengeId, user.id, Date.now() + CHALLENGE_TTL);
  const totp = getTotp.get(user.id);
  if (totp && totp.enabled) return res.json({ step: 'verify', challengeId });

  const secret = c.newTotpSecret();
  saveTotp.run(user.id, c.encrypt(secret), Date.now());
  res.json({ step: 'enroll', challengeId, secret, otpauth: c.otpauthUri(secret, user.email) });
}));

router.post('/verify', limiter, asyncRoute(async (req, res) => {
  const challenge = getChallenge.get(String(req.body.challengeId || ''));
  if (!challenge || challenge.expires_ts < Date.now()) return res.status(401).json({ error: 'Sign-in expired. Please start again.' });
  if (challenge.attempts >= MAX_ATTEMPTS) { dropChallenge.run(challenge.id); return res.status(429).json({ error: 'Too many wrong codes. Please start again.' }); }
  const user = getUser.get(challenge.user_id);
  const totp = user && getTotp.get(user.id);
  if (!user || !totp || !adminLevel(user)) { dropChallenge.run(challenge.id); return res.status(401).json({ error: 'Sign-in expired. Please start again.' }); }

  const secret = c.decrypt(totp.secret_enc);
  const backupCode = String(req.body.backupCode || '').trim().toUpperCase();
  if (backupCode && totp.enabled) {
    const codes = JSON.parse(totp.backup_codes || '[]');
    const hashed = c.sha256(backupCode.replace(/[^A-Z0-9]/g, ''));
    const idx = codes.indexOf(hashed);
    if (idx === -1) { bumpChallenge.run(challenge.id); return res.status(401).json({ error: 'That backup code is not valid.' }); }
    codes.splice(idx, 1);
    db.prepare('UPDATE int_admin_totp SET backup_codes=? WHERE user_id=?').run(JSON.stringify(codes), user.id);
    dropChallenge.run(challenge.id);
    return finish(req, res, user, true, { backupCodesLeft: codes.length });
  }

  const step = c.verifyTotp(secret, req.body.code, { afterStep: totp.last_step });
  if (step === null) { bumpChallenge.run(challenge.id); return res.status(401).json({ error: 'That code is not right. Check the time on your phone and try again.' }); }
  dropChallenge.run(challenge.id);

  let extra = {};
  if (!totp.enabled) {
    const plain = Array.from({ length: 10 }, () => c.randomId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8));
    db.prepare('UPDATE int_admin_totp SET enabled=1, enabled_ts=?, last_step=?, backup_codes=? WHERE user_id=?')
      .run(Date.now(), step, JSON.stringify(plain.map(c.sha256)), user.id);
    req.user = user; audit(req, 'admin.2fa_enrolled', `user:${user.id}`);
    extra = { backupCodes: plain };
  } else {
    db.prepare('UPDATE int_admin_totp SET last_step=? WHERE user_id=?').run(step, user.id);
  }
  finish(req, res, user, true, extra);
}));

router.get('/status', requireAuth, (req, res) => {
  const totp = getTotp.get(req.user.id);
  res.json({
    adminLevel: adminLevel(req.user),
    console: Boolean(req.adminConsole),
    expiresAt: req.adminConsole ? req.adminConsole.exp * 1000 : null,
    twoStepEnabled: Boolean(totp && totp.enabled),
    mode: mfaMode(),
  });
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'admin.sign_out', `user:${req.user.id}`);
  clearAdminCookie(res);
  res.json({ ok: true });
});

// OWNER: reset another admin's 2-step setup (lost phone). They re-enrol at next sign-in.
router.post('/reset-2fa/:id', requireOwner, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user' });
  db.prepare('DELETE FROM int_admin_totp WHERE user_id=?').run(id);
  audit(req, 'admin.2fa_reset', `user:${id}`);
  res.json({ ok: true });
});

module.exports = router;
