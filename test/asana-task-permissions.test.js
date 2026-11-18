'use strict';

// The portal uses one shared Asana token, so the portal must enforce who may
// change which task. Employees: only tasks assigned to them. Admins: any task.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-asana-perm-'));
process.env.DB_PATH = path.join(tmp, 'portal.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'asana-permissions-test-secret';
delete process.env.ADMIN_CONSOLE_REQUIRED;

const writes = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    const send = (o) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (req.method === 'GET' && req.url.startsWith('/tasks?project=1234'))
      return send({
        data: [
          {
            gid: '501',
            name: 'Mine',
            completed: false,
            assignee: { gid: '1', name: 'Emp One', email: 'emp1@example.com' },
          },
          {
            gid: '502',
            name: 'Theirs',
            completed: false,
            assignee: { gid: '2', name: 'Emp Two', email: 'emp2@example.com' },
          },
        ],
      });
    writes.push({ method: req.method, url: req.url, data: body ? JSON.parse(body).data : null });
    const gid = (req.url.match(/^\/tasks\/(\d+)/) || [])[1] || '9001';
    send({
      data: {
        gid,
        name: 'Task ' + gid,
        completed: true,
        due_on: null,
        permalink_url: 'https://app.asana.com/0/1/' + gid,
      },
    });
  });
});

test('employees can only change Asana tasks assigned to them', async (t) => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.ASANA_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.ASANA_TOKEN = 'asana-test';
  process.env.ASANA_PROJECT_GID = '1234';

  const express = require('express');
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  const { COOKIE, issueToken, hashPassword } = require('../src/auth');
  const addUser = (name, email, role) =>
    db
      .prepare('INSERT INTO users(name,email,password_hash,role,created_ts) VALUES (?,?,?,?,?)')
      .run(name, email, hashPassword('x'), role, Date.now()).lastInsertRowid;
  const emp = addUser('Emp One', 'emp1@example.com', 'EMPLOYEE');
  addUser('Emp Two', 'emp2@example.com', 'EMPLOYEE');
  const admin = addUser('Partner', 'partner@example.com', 'ADMIN');

  const server = express.application.listen.call(app, 0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fake.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (id) => async (url, body) => {
    const r = await fetch(base + url, {
      method: 'POST',
      headers: { cookie: `${COOKIE}=${issueToken({ id })}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const employee = as(emp);
  const partner = as(admin);

  // Someone else's task, and a task the portal has never seen: refused, nothing sent to Asana.
  for (const gid of ['502', '777777']) {
    assert.equal((await employee(`/api/asana-tasks/${gid}/update`, { completed: true })).status, 403);
    assert.equal((await employee(`/api/asana-tasks/${gid}/comments`, { text: 'hi' })).status, 403);
  }
  assert.equal((await employee('/api/asana-tasks/not-a-number/update', { completed: true })).status, 400);
  assert.equal(writes.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM int_audit_log WHERE action='asana.task_change_refused'").get().n, 4);

  // Their own task: allowed, but they cannot hand it to someone else.
  const own = await employee('/api/asana-tasks/501/update', { completed: true, assignee_id: admin });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(writes.at(-1).data, { completed: true });
  assert.equal((await employee('/api/asana-tasks/501/comments', { text: 'Done' })).status, 200);

  // New tasks from employees always go to the portal's own project.
  assert.equal((await employee('/api/asana-tasks', { name: 'New', project_gid: '999' })).status, 200);
  assert.deepEqual(writes.at(-1).data.projects, ['1234']);

  // Admins can act on any task and reassign.
  const any = await partner('/api/asana-tasks/502/update', { completed: true, assignee_id: emp });
  assert.equal(any.status, 200, JSON.stringify(any.body));
  assert.deepEqual(writes.at(-1).data, { completed: true, assignee: 'emp1@example.com' });

  // With console enforcement on, a password-only admin is treated like any employee here.
  process.env.ADMIN_CONSOLE_REQUIRED = 'on';
  try {
    assert.equal((await partner('/api/asana-tasks/502/update', { completed: false })).status, 403);
  } finally {
    delete process.env.ADMIN_CONSOLE_REQUIRED;
  }
});
