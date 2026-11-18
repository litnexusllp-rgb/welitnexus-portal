'use strict';

// Limits that protect the server and staff privacy: capped downloads,
// birthday year hidden from colleagues, password minimum.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-limits-'));
process.env.DB_PATH = path.join(tmp, 'portal.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'limits-test-secret';

const express = require('express');
const { app } = require('../src/server');
const { db } = require('../src/db');
const { COOKIE, issueToken, hashPassword } = require('../src/auth');
const { readCapped } = require('../src/v2/crypto');

const addUser = (name, email, role, birthday) =>
  db
    .prepare('INSERT INTO users(name,email,password_hash,role,birthday,created_ts) VALUES (?,?,?,?,?,?)')
    .run(name, email, hashPassword('existing-pass'), role, birthday, Date.now()).lastInsertRowid;

async function boot(t) {
  const server = express.application.listen.call(app, 0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('downloads stop at the size limit instead of loading everything', async () => {
  const tooLarge = () => Object.assign(new Error('too large'), { status: 413 });
  assert.equal((await readCapped(new Response('hello'), 10, tooLarge)).toString(), 'hello');
  await assert.rejects(readCapped(new Response('x'.repeat(11)), 10, tooLarge), /too large/);
  const declared = new Response('small', { headers: { 'content-length': String(1e9) } });
  await assert.rejects(readCapped(declared, 10, tooLarge), /too large/);
});

test('colleagues see a birthday as day and month only; admins see the full date', async (t) => {
  const base = await boot(t);
  const viewer = addUser('Viewer', 'viewer@example.com', 'EMPLOYEE', '');
  addUser('Birthday Person', 'bday@example.com', 'EMPLOYEE', '1990-05-17');
  const admin = addUser('Partner', 'partner@example.com', 'ADMIN', '');
  const get = async (id, url) =>
    (await fetch(base + url, { headers: { cookie: `${COOKIE}=${issueToken({ id })}` } })).json();
  const inDirectory = (await get(viewer, '/api/users')).users.find((u) => u.email === 'bday@example.com');
  assert.equal(inDirectory.birthday, '05-17');
  assert.doesNotMatch(JSON.stringify(await get(viewer, '/api/users')), /1990/);
  const managed = (await get(admin, '/api/users/manage')).users.find((u) => u.email === 'bday@example.com');
  assert.equal(managed.birthday, '1990-05-17');
});

test('new passwords must be at least 10 characters', async (t) => {
  const base = await boot(t);
  const id = addUser('Changer', 'changer@example.com', 'EMPLOYEE', '');
  const change = (next) =>
    fetch(base + '/api/auth/change-password', {
      method: 'POST',
      headers: { cookie: `${COOKIE}=${issueToken({ id })}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'existing-pass', new_password: next }),
    });
  const short = await change('nine-char');
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /at least 10 characters/);
  assert.equal((await change('ten-chars!')).status, 200);
});
