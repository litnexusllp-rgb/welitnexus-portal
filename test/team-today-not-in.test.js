'use strict';

// /api/attendance/today tells the dashboard who is expected but not in yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-not-in-'));
process.env.DB_PATH = path.join(tmp, 'portal.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'not-in-test-secret';

test('team today marks late arrivals, approved leave and partners correctly', async (t) => {
  const express = require('express');
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  const { COOKIE, issueToken, hashPassword } = require('../src/auth');
  const { now } = require('../src/time');

  // Make today and yesterday workdays whatever day the test runs.
  for (const d of [now(), now().minus({ days: 1 })])
    db.prepare('INSERT OR IGNORE INTO working_days(date, created_ts) VALUES (?, ?)').run(d.toISODate(), Date.now());
  // A shift that started an hour ago (well past the 15-minute grace).
  const anHourAgo = now().minus({ hours: 1 }).toFormat('HH:mm');
  const add = (name, role, shift) =>
    db
      .prepare('INSERT INTO users(name,email,password_hash,role,shift_start,created_ts) VALUES (?,?,?,?,?,?)')
      .run(name, `${name.toLowerCase()}@example.com`, hashPassword('x'), role, shift, Date.now()).lastInsertRowid;
  const late = add('Late', 'EMPLOYEE', anHourAgo);
  const away = add('Away', 'EMPLOYEE', anHourAgo);
  const partner = add('Partner', 'ADMIN', anHourAgo);

  const server = express.application.listen.call(app, 0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const get = async () =>
    (
      await fetch(`http://127.0.0.1:${server.address().port}/api/attendance/today`, {
        headers: { cookie: `${COOKIE}=${issueToken({ id: partner })}` },
      })
    ).json();

  let today = await get();
  const person = (id) => today.people.find((p) => p.id === id);
  // Away's leave covers their own shift day, whatever the clock says.
  db.prepare(
    "INSERT INTO leaves(user_id,start_date,end_date,kind,status,days,created_ts) VALUES (?,?,?,'FULL','APPROVED',1,?)",
  ).run(away, person(away).day, person(away).day, Date.now());
  today = await get();

  assert.equal(today.graceMinutes, 15);
  assert.ok(today.officeZone);
  assert.equal(person(late).state, 'OFF');
  assert.ok(person(late).scheduled > 0);
  assert.equal(person(late).shiftStart, anHourAgo);
  assert.ok(person(late).shiftStartTs < Date.now());
  assert.equal(person(late).late, true);
  assert.equal(person(away).leave, 'FULL');
  assert.equal(person(away).late, false);
  assert.equal(person(partner).role, 'ADMIN');
  assert.equal(person(partner).late, false);
});
