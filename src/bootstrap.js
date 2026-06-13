'use strict';

// First-boot bootstrap: if the database has no users yet (fresh deploy),
// create one admin account from environment variables so you can log in
// immediately — no seeding step required on Railway.

const { db } = require('./db');
const { hashPassword } = require('./auth');
const { now } = require('./time');

function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return; // already set up — do nothing

  // Don't auto-create an admin with a publicly-known default password in
  // production — require the deployer to choose one.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    console.warn('Bootstrap: ADMIN_PASSWORD not set in production — skipping admin creation. Set it and redeploy.');
    return;
  }
  const name = process.env.ADMIN_NAME || 'Admin';
  const email = (process.env.ADMIN_EMAIL || 'admin@welitnexus.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe@2026';

  db.prepare(
    `INSERT INTO users (name, email, password_hash, role, department, title, leave_balance, active, created_ts)
     VALUES (?, ?, ?, 'ADMIN', 'Leadership', 'Partner', 18, 1, ?)`
  ).run(name, email, hashPassword(password), now().toMillis());

  console.log(`Bootstrap: created first admin ${email}. Log in and change the password.`);
}

module.exports = { bootstrapAdmin };
