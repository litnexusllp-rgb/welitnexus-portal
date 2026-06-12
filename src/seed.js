'use strict';

// Seeds two admin accounts (the partners), a few sample employees, holidays,
// and demo tasks so the portal is usable the moment it boots.
// Safe to re-run: it skips anything that already exists.

require('dotenv').config();
const { db } = require('./db');
const { hashPassword } = require('./auth');
const { now } = require('./time');

const ts = now().toMillis();
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertUser = db.prepare(
  `INSERT INTO users (name, email, password_hash, role, department, title, phone, leave_balance, active, created_ts)
   VALUES (@name, @email, @password_hash, @role, @department, @title, @phone, @leave_balance, 1, @created_ts)`
);

function ensureUser(u) {
  const existing = findByEmail.get(u.email);
  if (existing) { console.log(`= exists: ${u.email}`); return existing.id; }
  const info = insertUser.run({ leave_balance: 18, department: '', title: '', phone: '', ...u, password_hash: hashPassword(u.password), created_ts: ts });
  console.log(`+ created ${u.role}: ${u.email}  (password: ${u.password})`);
  return info.lastInsertRowid;
}

// --- Admins (the two partners) -------------------------------------------
const admin1 = ensureUser({ name: 'Saurav Garg', email: 'saurav@welitnexus.com', password: 'Welit@2026', role: 'ADMIN', department: 'Leadership', title: 'Partner' });
ensureUser({ name: 'Partner', email: 'partner@welitnexus.com', password: 'Welit@2026', role: 'ADMIN', department: 'Leadership', title: 'Partner' });

// --- Sample employees ----------------------------------------------------
const e1 = ensureUser({ name: 'Aanya Sharma', email: 'aanya@welitnexus.com', password: 'Welcome@123', role: 'EMPLOYEE', department: 'Accounting', title: 'Senior Accountant', phone: '+91 90000 11111' });
ensureUser({ name: 'Rohan Mehta', email: 'rohan@welitnexus.com', password: 'Welcome@123', role: 'EMPLOYEE', department: 'Bookkeeping', title: 'Bookkeeper', phone: '+91 90000 22222' });

// --- Holidays ------------------------------------------------------------
const upsertHoliday = db.prepare(
  `INSERT INTO holidays (date, name, type, created_by, created_ts) VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(date) DO NOTHING`
);
[
  ['2026-01-26', 'Republic Day', 'PUBLIC'],
  ['2026-03-04', 'Holi', 'PUBLIC'],
  ['2026-08-15', 'Independence Day', 'PUBLIC'],
  ['2026-10-20', 'Diwali', 'PUBLIC'],
  ['2026-12-25', 'Christmas', 'PUBLIC'],
].forEach(([date, name, type]) => upsertHoliday.run(date, name, type, admin1, ts));

// --- Demo task -----------------------------------------------------------
const insertTask = db.prepare(
  `INSERT INTO tasks (title, description, assignee_id, assigned_by, priority, status, due_date, created_ts, updated_ts)
   VALUES (?, ?, ?, ?, 'HIGH', 'TODO', ?, ?, ?)`
);
const taskCount = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
if (taskCount === 0) {
  insertTask.run('Reconcile June bank statements', 'Match all transactions for the June close.', e1, admin1, now().plus({ days: 3 }).toFormat('yyyy-LL-dd'), ts, ts);
  console.log('+ created demo task');
}

console.log('\nSeed complete. Log in at http://localhost:3000');
console.log('Admin: saurav@welitnexus.com / Welit@2026');
