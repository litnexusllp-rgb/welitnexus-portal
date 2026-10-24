'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('bounded password pool keeps the event loop responsive and verifies existing hashes', async () => {
  const { hashPasswordAsync, verifyPasswordAsync } = require('../src/passwords');
  let beats = 0;
  const timer = setInterval(() => beats++, 1);
  try {
    const hashes = await Promise.all(Array.from({ length: 6 }, () => hashPasswordAsync('isolated-test-password')));
    assert.ok(beats > 0, 'main-thread timers must progress during bcrypt work');
    assert.equal(await verifyPasswordAsync('isolated-test-password', hashes[0]), true);
    assert.equal(await verifyPasswordAsync('wrong', hashes[0]), false);
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => hashPasswordAsync('queue-limit-test')));
    assert.ok(results.some(r => r.status === 'rejected' && r.reason.status === 503));
  } finally { clearInterval(timer); }
});

test('exclusive scheduler lock works across processes and is recoverable after owner death', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-scheduler-lock-'));
  const lockPath = path.join(dir, 'scheduler.sqlite');
  const { acquireSchedulerLock } = require('../src/schedulerLock');
  const child = spawn(process.execPath, ['-e', `const release = require('./src/schedulerLock').acquireSchedulerLock(process.argv[1]); process.send({ owned: !!release }); setInterval(() => {}, 1000);`, lockPath], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await once(child, 'message'))[0].owned, true);
  assert.equal(acquireSchedulerLock(lockPath), null);
  child.kill('SIGKILL'); await once(child, 'exit');
  const release = acquireSchedulerLock(lockPath); assert.equal(typeof release, 'function'); release();
});

test('shutdown waits for HTTP and asynchronous background drainage before closing SQLite', async () => {
  const { EventEmitter } = require('node:events');
  const { installShutdown } = require('../src/shutdown');
  const processRef = new EventEmitter(); const exits = []; processRef.exit = c => exits.push(c);
  let httpDone, backgroundDone, closed = false;
  const background = new Promise(resolve => { backgroundDone = resolve; });
  installShutdown({ server: { close(fn) { httpDone = fn; } }, db: { open: true, close() { closed = true; } }, stopBackground: () => background, processRef, logger: { log() {}, error() {} } });
  processRef.emit('SIGTERM'); httpDone(); await Promise.resolve();
  assert.equal(closed, false); backgroundDone();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true); assert.deepEqual(exits, [0]);
});

test('proxy configuration rejects blanket trust and groups IPv6 privacy addresses', async t => {
  const express = require('express'); const rateLimit = require('express-rate-limit');
  const { trustProxy } = require('../src/proxyConfig'); const { ipKey } = require('../src/rateLimitKey');
  assert.equal(trustProxy({}), false); assert.equal(trustProxy({ RAILWAY_ENVIRONMENT_ID: 'test' }), 1);
  assert.throws(() => trustProxy({ TRUST_PROXY: 'true' }), /unsafe/);
  assert.throws(() => trustProxy({ TRUST_PROXY: 'arbitrary text' }));
  assert.equal(ipKey({ ip: '::ffff:192.0.2.1' }), ipKey({ ip: '192.0.2.1' }));
  assert.equal(ipKey({ ip: '2001:db8:abcd:12ff::1' }), ipKey({ ip: '2001:db8:abcd:1200::2' }));
  const app = express(); app.set('trust proxy', trustProxy({}));
  app.use(rateLimit({ windowMs: 60000, limit: 2, keyGenerator: ipKey }));
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status, 200);
  assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status, 200);
  assert.equal((await fetch(url, { headers: { 'X-Forwarded-For': '198.51.100.3' } })).status, 429);
  app.set('trust proxy', 1);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const response = await fetch(url + '/ip', { headers: { 'X-Forwarded-For': '198.51.100.99, 203.0.113.5' } });
  assert.equal((await response.json()).ip, '203.0.113.5');
});

test('application imports without listening and validates full API requests', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-api-validation-'));
  process.env.DB_PATH = path.join(dir, 'portal.db'); process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'isolated-hardening-tests';
  const { app } = require('../src/server'); const { db } = require('../src/db');
  await require('../src/bootstrap').bootstrapAdmin();
  const { COOKIE, issueToken } = require('../src/auth');
  const admin = db.prepare("SELECT * FROM users WHERE role='ADMIN'").get();
  const cookie = `${COOKIE}=${issueToken(admin)}`;
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, method = 'POST') => fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const [route, body] of [
    ['/api/clients', []], ['/api/clients', { name: {} }], ['/api/clients', { name: ['bad'] }],
    ['/api/auth/login', { email: ['admin@example.test'], password: 'password' }],
    ['/api/auth/change-password', { current_password: 'old', new_password: 'é'.repeat(37) }],
    ['/api/users/1/active', { active: 'false' }], ['/api/holidays', { name: 'Invalid', date: '2026-02-30' }],
    ['/api/recurring', { title: 'Bad recurrence', next_due: '2026-10-01', step: 1.5, assignee_id: admin.id }],
    ['/api/tasks', { title: 'Unknown assignee', assignee_id: 999999 }],
    ['/api/tasks/reorder', { ids: [1, 'NaN'] }],
  ]) assert.equal((await request(route, body)).status, 400, route + JSON.stringify(body));
  assert.equal((await fetch(base + '/api/reports/attendance?user_id=' + admin.id + '&start=2000-01-01&end=2026-10-01', { headers: { cookie } })).status, 400);
  assert.equal((await fetch(base + '/api/users/not-a-number/salary', { headers: { cookie } })).status, 400);
  assert.equal((await fetch(base + '/api/achievements/month/2026-13', { headers: { cookie } })).status, 400);
  assert.equal((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' })).status, 400);
  const clientsBefore = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  assert.equal((await request('/api/tasks/bulk', { client_name: 'Must not be created', default_assignee_id: admin.id, items: [null] })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, clientsBefore);
  assert.equal((await request('/api/tasks/reorder', { ids: [1] })).status, 200);
  assert.equal((await request('/api/auth/login', { email: admin.email, password: 'ChangeMe@2026' })).status, 200);
  assert.equal((await request('/api/clients', { name: 'Valid synthetic client', email: '' })).status, 200);
  assert.equal((await request('/api/asana/test', {})).status, 200);
  process.env.BACKUP_TOKEN = 'synthetic-backup-token';
  const backup = await fetch(base + '/api/backup', { headers: { Authorization: 'Bearer synthetic-backup-token' } });
  assert.equal(backup.status, 200); assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await fetch(base + '/api/backup', { headers: { Authorization: 'Bearer wrong-token' } })).status, 403);
  await t.test('backup mail streams a valid database snapshot and cleans up on success or failure', async () => {
    const nodemailer = require('nodemailer'); const original = nodemailer.createTransport;
    const keys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'BACKUP_EMAIL_TO']; const previous = keys.map(k => process.env[k]);
    Object.assign(process.env, { SMTP_HOST: 'synthetic.invalid', SMTP_USER: 'test@example.test', SMTP_PASS: 'synthetic', BACKUP_EMAIL_TO: 'backup@example.test' });
    try {
      for (const fail of [false, true]) {
        let snapshot;
        nodemailer.createTransport = () => ({
          async sendMail(message) {
            snapshot = message.attachments.find(a => a.path)?.path;
            assert.ok(snapshot); assert.ok(fs.existsSync(snapshot));
            assert.equal(fs.readFileSync(snapshot).subarray(0, 15).toString(), 'SQLite format 3');
            if (fail) throw new Error('Synthetic SMTP failure');
            const transport = original({ streamTransport: true, buffer: true });
            const result = await transport.sendMail(message); assert.ok(result.message.length > 0); transport.close();
            return result;
          }, close() {},
        });
        const result = await require('../src/backupMailer').sendBackup('Synthetic');
        assert.equal(result.ok, !fail); assert.equal(fs.existsSync(path.dirname(snapshot)), false);
      }
    } finally { nodemailer.createTransport = original; keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); }
  });
});

test('real background workers elect one owner and standby takes over after graceful stop', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-background-takeover-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const script = `const stop = require('./src/backgroundWorker').startBackgroundWorker(); process.on('message', async () => { await stop(); process.exit(0); });`;
  function start() {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, DB_PATH: path.join(dir, 'portal.db'), NODE_ENV: 'test', AUTO_ABSENCE: 'off', BIRTHDAYS: 'off', EOD_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    children.push(child);
    child.output = ''; child.owners = 0;
    child.stdout.on('data', data => { child.output += data; child.owners = (child.output.match(/Background scheduler ownership acquired/g) || []).length; });
    child.stderr.on('data', data => { child.output += data; });
    return child;
  }
  async function until(predicate, child) {
    const deadline = Date.now() + 6000;
    while (!predicate()) { assert.ok(Date.now() < deadline && child.exitCode === null, child.output); await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  const first = start(); await until(() => first.owners === 1, first);
  const second = start();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(second.owners, 0, second.output);
  const firstExit = once(first, 'exit'); first.send('stop');
  assert.equal((await firstExit)[0], 0, first.output);
  await until(() => second.owners === 1, second);
  const secondExit = once(second, 'exit'); second.send('stop');
  assert.equal((await secondExit)[0], 0, second.output);
  const Database = require('better-sqlite3'); const db = new Database(path.join(dir, 'portal.db'));
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); db.close();
});
