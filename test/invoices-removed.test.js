'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('invoice removal preserves clients, backups and legacy records', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-removal-'));
  process.env.DB_PATH = path.join(tmp, 'portal.db');
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'isolated-removal-test-secret';
  delete process.env.ASANA_TOKEN;
  delete process.env.ASANA_PROJECT_GID;

  // Capture the real server application without starting background schedulers.
  const express = require('express');
  const originalListen = express.application.listen;
  let app;
  express.application.listen = function () { app = this; };
  try { require('../src/server'); } finally { express.application.listen = originalListen; }
  const { db } = require('../src/db');
  const server = originalListen.call(app, 0, '127.0.0.1');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { COOKIE, issueToken } = require('../src/auth');
  const admin = db.prepare("SELECT * FROM users WHERE role = 'ADMIN'").get();
  const cookie = `${COOKIE}=${issueToken(admin)}`;

  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('invoices','invoice_items')").all(), []);
  for (const [method, endpoint] of [
    ['GET', '/api/invoices'], ['GET', '/api/invoices/summary/totals'],
    ['POST', '/api/invoices'], ['GET', '/api/invoices/1'],
    ['PUT', '/api/invoices/1'], ['POST', '/api/invoices/1/status'],
    ['DELETE', '/api/invoices/1'],
  ]) {
    const response = await fetch(base + endpoint, { method, headers: { cookie } });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    await response.text();
  }

  const create = await fetch(base + '/api/clients', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Retained client', billing_address: 'Example address' }),
  });
  assert.equal(create.status, 200);
  const created = (await create.json()).client;
  const list = await fetch(base + '/api/clients/all', { headers: { cookie } });
  assert.equal((await list.json()).clients[0].id, created.id);

  const { buildCsvAttachments } = require('../src/backupMailer');
  assert.deepEqual(buildCsvAttachments().map(a => a.filename), [
    'employees.csv', 'attendance.csv', 'leaves.csv', 'tasks.csv', 'clients.csv',
  ]);
  // Representative existing tables: restarting must not drop or modify them.
  db.exec("CREATE TABLE invoices(id INTEGER PRIMARY KEY, amount REAL); CREATE TABLE invoice_items(id INTEGER PRIMARY KEY, invoice_id INTEGER, item TEXT); INSERT INTO invoices VALUES(42,125.50); INSERT INTO invoice_items VALUES(7,42,'Historical service');");
  const restarted = spawnSync(process.execPath, ['-e', "const {db}=require('./src/db'); require('./src/backupMailer').buildCsvAttachments(); db.close();"], {
    cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8',
  });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(db.prepare('SELECT amount FROM invoices WHERE id=42').get().amount, 125.50);
  assert.equal(db.prepare('SELECT item FROM invoice_items WHERE id=7').get().item, 'Historical service');
  const backup = await fetch(base + '/api/backup', { headers: { cookie } });
  assert.equal(backup.status, 200);
  const snapshot = path.join(tmp, 'snapshot.db');
  fs.writeFileSync(snapshot, Buffer.from(await backup.arrayBuffer()));
  const Database = require('better-sqlite3');
  const saved = new Database(snapshot, { readonly: true });
  try {
    assert.equal(saved.prepare('SELECT amount FROM invoices WHERE id=42').get().amount, 125.50);
    assert.equal(saved.prepare('SELECT name FROM clients WHERE id=?').get(created.id).name, 'Retained client');
  } finally { saved.close(); }
});
