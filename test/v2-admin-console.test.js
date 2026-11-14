'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-v2-'));
process.env.DB_PATH = path.join(tmp, 'portal.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'v2-admin-console-test-secret';
process.env.ADMIN_EMAIL = 'partner@example.com';
process.env.ADMIN_PASSWORD = 'partner-pass-123';
delete process.env.ADMIN_2FA;
delete process.env.SMTP_HOST;

const express = require('express');
const { app } = require('../src/server');
const { db } = require('../src/db');
const c = require('../src/v2/crypto');

async function boot(t) {
  await require('../src/bootstrap').bootstrapAdmin();
  const server = express.application.listen.call(app, 0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function jar() {
  const cookies = {};
  return {
    header: () =>
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    take(res) {
      for (const sc of res.headers.getSetCookie()) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i),
          v = pair.slice(i + 1);
        if (!v || /Expires=Thu, 01 Jan 1970/.test(sc)) delete cookies[k];
        else cookies[k] = v;
      }
    },
  };
}

async function call(base, j, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { cookie: j.header(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  j.take(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_e) {
    /* pdf etc */
  }
  return { status: res.status, body: json, text };
}

async function adminSignIn(base, email = 'partner@example.com', password = 'partner-pass-123') {
  const j = jar();
  const step1 = await call(base, j, 'POST', '/api/admin/auth/login', { email, password });
  assert.equal(step1.status, 200, JSON.stringify(step1.body));
  let code;
  if (step1.body.step === 'enroll') code = c.hotp(step1.body.secret, c.currentStep());
  else {
    const row = db.prepare('SELECT * FROM int_admin_totp t JOIN users u ON u.id=t.user_id WHERE u.email=?').get(email);
    // Use the next time step so replay protection does not reject the code.
    code = c.hotp(c.decrypt(row.secret_enc), c.currentStep() + 1);
  }
  const step2 = await call(base, j, 'POST', '/api/admin/auth/verify', { challengeId: step1.body.challengeId, code });
  assert.equal(step2.status, 200, JSON.stringify(step2.body));
  return { j, step1, step2 };
}

test('TOTP helpers follow RFC 6238', () => {
  // RFC 6238 test secret "12345678901234567890" (ASCII) at T=59s -> 94287082 (8 digits); 6-digit = 287082
  const secret = c.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(c.hotp(secret, 1), '287082');
  assert.equal(c.verifyTotp(secret, '287082', { ms: 59000, window: 0 }), 1);
  assert.equal(c.verifyTotp(secret, '287082', { ms: 59000, window: 0, afterStep: 1 }), null);
  assert.equal(c.decrypt(c.encrypt('hello')), 'hello');
});

test('admin console: two-step sign-in, roles, people and billing', async (t) => {
  const base = await boot(t);

  // Employee portal login still works exactly as before for the partner.
  const plain = jar();
  assert.equal(
    (await call(base, plain, 'POST', '/api/auth/login', { email: 'partner@example.com', password: 'partner-pass-123' }))
      .status,
    200,
  );
  const me = await call(base, plain, 'GET', '/api/auth/me');
  assert.equal(me.body.access.adminLevel, 'OWNER');
  assert.equal(me.body.access.console, false);
  // Without the admin console cookie, console APIs are refused.
  assert.equal((await call(base, plain, 'GET', '/api/admin/people')).status, 403);

  // Wrong password and wrong code are refused.
  assert.equal(
    (await call(base, jar(), 'POST', '/api/admin/auth/login', { email: 'partner@example.com', password: 'nope' }))
      .status,
    401,
  );
  const bad = jar();
  const s1 = await call(base, bad, 'POST', '/api/admin/auth/login', {
    email: 'partner@example.com',
    password: 'partner-pass-123',
  });
  assert.equal(s1.body.step, 'enroll');
  assert.equal(
    (await call(base, bad, 'POST', '/api/admin/auth/verify', { challengeId: s1.body.challengeId, code: '000000' }))
      .status,
    401,
  );

  // First real sign-in enrols the authenticator and returns backup codes.
  const { j: owner, step2 } = await adminSignIn(base);
  assert.equal(step2.body.backupCodes.length, 10);
  assert.equal((await call(base, owner, 'GET', '/api/admin/auth/status')).body.twoStepEnabled, true);

  // Second sign-in asks for the code (no re-enrolment); backup code also works once.
  const again = jar();
  const v1 = await call(base, again, 'POST', '/api/admin/auth/login', {
    email: 'partner@example.com',
    password: 'partner-pass-123',
  });
  assert.equal(v1.body.step, 'verify');
  const ok = await call(base, again, 'POST', '/api/admin/auth/verify', {
    challengeId: v1.body.challengeId,
    backupCode: step2.body.backupCodes[0],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.backupCodesLeft, 9);

  // Add an employee with the existing endpoint, then make them a billing admin.
  const created = await call(base, owner, 'POST', '/api/users', {
    name: 'Billing Person',
    email: 'billing@example.com',
    password: 'billing-pass-1',
    role: 'EMPLOYEE',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const billingId = created.body.user.id;
  assert.equal(
    (await call(base, owner, 'PUT', `/api/admin/people/${billingId}/access`, { level: 'BILLING' })).status,
    200,
  );
  const people = await call(base, owner, 'GET', '/api/admin/people');
  assert.equal(people.body.people.find((p) => p.id === billingId).access, 'BILLING');

  // Employees cannot open the admin console at all.
  const emp = await call(base, owner, 'POST', '/api/users', {
    name: 'Plain Employee',
    email: 'emp@example.com',
    password: 'emp-pass-123',
    role: 'EMPLOYEE',
  });
  const refused = await call(base, jar(), 'POST', '/api/admin/auth/login', {
    email: 'emp@example.com',
    password: 'emp-pass-123',
  });
  assert.equal(refused.status, 403);

  // Billing admin: billing yes, people management no, existing admin APIs no.
  const { j: biller } = await adminSignIn(base, 'billing@example.com', 'billing-pass-1');
  assert.equal((await call(base, biller, 'GET', '/api/admin/people')).status, 403);
  assert.equal((await call(base, biller, 'GET', '/api/users/manage')).status, 403);
  assert.equal((await call(base, biller, 'GET', '/api/admin/billing/summary')).status, 200);

  // Billing flow.
  const client = await call(base, owner, 'POST', '/api/clients', {
    name: 'Client Alpha LLC',
    billing_address: '1 Main St',
    email: 'ap@alpha.example',
  });
  const clientId = client.body.client.id;
  const draft = await call(base, biller, 'POST', '/api/admin/billing/invoices', {
    client_id: clientId,
    issue_date: '2026-11-10',
    terms: 'NET_30',
    currency: 'USD',
    tax_rate: 0,
    lines: [
      { description: 'Monthly bookkeeping', quantity: 1, unit_price: 1800 },
      { description: 'Advisory hours', quantity: 8, unit_price: 100 },
    ],
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const inv = draft.body.invoice;
  assert.equal(inv.total, 2600);
  assert.equal(inv.due_date, '2026-12-10');
  assert.equal(inv.status, 'DRAFT');
  assert.equal(inv.number, null);

  const edited = await call(base, biller, 'PUT', `/api/admin/billing/invoices/${inv.id}`, {
    lines: [{ description: 'Monthly bookkeeping', quantity: 1, unit_price: 1800.5 }],
    tax_rate: 10,
  });
  assert.equal(edited.body.invoice.subtotal, 1800.5);
  assert.equal(edited.body.invoice.tax, 180.05);
  assert.equal(edited.body.invoice.total, 1980.55);

  const pdf = await fetch(`${base}/api/admin/billing/invoices/${inv.id}/pdf`, { headers: { cookie: biller.header() } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
    '%PDF',
  );

  const sent = await call(base, biller, 'POST', `/api/admin/billing/invoices/${inv.id}/send`, {});
  assert.equal(sent.status, 200);
  assert.match(sent.body.invoice.number, /^INV-\d{4}-001$/);
  assert.equal(sent.body.delivery.emailed, false); // no SMTP in tests
  assert.equal((await call(base, biller, 'PUT', `/api/admin/billing/invoices/${inv.id}`, { notes: 'x' })).status, 409);
  assert.equal((await call(base, biller, 'DELETE', `/api/admin/billing/invoices/${inv.id}`)).status, 409);

  assert.equal(
    (await call(base, biller, 'POST', `/api/admin/billing/invoices/${inv.id}/payments`, { amount: 5000 })).status,
    400,
  );
  const part = await call(base, biller, 'POST', `/api/admin/billing/invoices/${inv.id}/payments`, {
    amount: 1000,
    paid_on: '2026-11-15',
    method: 'ACH',
  });
  assert.equal(part.body.invoice.balance, 980.55);
  const full = await call(base, biller, 'POST', `/api/admin/billing/invoices/${inv.id}/payments`, {
    amount: 980.55,
    paid_on: '2026-11-20',
  });
  assert.equal(full.body.invoice.status, 'PAID');

  const summary = await call(base, biller, 'GET', '/api/admin/billing/summary?fy=2026&currency=USD');
  assert.equal(summary.body.billed, 1980.55);
  assert.equal(summary.body.collected, 1980.55);
  assert.equal(summary.body.outstanding, 0);

  // Permanent delete: typed name required, backup written first, history removed.
  const victim = emp.body.user.id;
  db.prepare('INSERT INTO events(user_id, type, ts, day, note, device) VALUES (?,?,?,?,?,?)').run(
    victim,
    'IN',
    Date.now(),
    '2026-11-10',
    '',
    'web',
  );
  assert.equal(
    (await call(base, owner, 'DELETE', `/api/admin/people/${victim}`, { confirmName: 'wrong' })).status,
    400,
  );
  const preview = await call(base, owner, 'GET', `/api/admin/people/${victim}/delete-preview`);
  assert.equal(preview.body.records.punches, 1);
  const del = await call(base, owner, 'DELETE', `/api/admin/people/${victim}`, { confirmName: 'Plain Employee' });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(fs.existsSync(path.join(tmp, 'backups', del.body.backupFile)));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE user_id=?').get(victim).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get(victim).n, 0);

  // Owners cannot be deleted, and the last owner cannot be demoted.
  const ownerId = db.prepare("SELECT id FROM users WHERE email='partner@example.com'").get().id;
  assert.equal(
    (await call(base, owner, 'PUT', `/api/admin/people/${ownerId}/access`, { level: 'EMPLOYEE' })).status,
    409,
  );

  // Audit log captured the sensitive actions.
  const log = await call(base, owner, 'GET', '/api/admin/people/audit-log');
  const actions = log.body.entries.map((e) => e.action);
  for (const a of [
    'admin.sign_in',
    'admin.2fa_enrolled',
    'people.access_changed',
    'invoice.sent',
    'invoice.payment',
    'people.deleted',
  ])
    assert.ok(actions.includes(a), a);

  // Strict mode: existing admin APIs then also require the console cookie.
  process.env.ADMIN_CONSOLE_REQUIRED = 'on';
  try {
    assert.equal((await call(base, plain, 'GET', '/api/users/manage')).status, 403);
    assert.equal((await call(base, owner, 'GET', '/api/users/manage')).status, 200);
    // The full database backup follows the same rule: password alone is not enough.
    const refused = await call(base, plain, 'GET', '/api/backup');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'ADMIN_CONSOLE');
    assert.equal((await call(base, plain, 'POST', '/api/backup/email')).status, 403);
    assert.equal((await call(base, owner, 'GET', '/api/backup')).status, 200);
  } finally {
    delete process.env.ADMIN_CONSOLE_REQUIRED;
  }
});

test('existing tables are untouched by the v2 schema', () => {
  const v2 = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'int_%'")
    .all()
    .map((r) => r.name);
  assert.ok(v2.length >= 15);
  const { TABLES } = require('../src/v2/schema');
  assert.doesNotMatch(TABLES, /\b(ALTER|DROP)\b/i);
  for (const m of TABLES.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS ([a-z_]+)/g))
    assert.match(m[1], /^(int_|idx_int_)/);
});
