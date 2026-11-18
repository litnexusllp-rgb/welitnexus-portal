'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-v2i-'));
process.env.DB_PATH = path.join(tmp, 'portal.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'v2-integrations-test-secret';

test('calendar integration; Slack messages and the AI assistant are gone', async (t) => {
  const express = require('express');
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  const { COOKIE, issueToken, hashPassword } = require('../src/auth');
  const id = db
    .prepare(
      "INSERT INTO users(name,email,password_hash,role,created_ts) VALUES ('Emp One','emp1@example.com',?, 'EMPLOYEE', ?)",
    )
    .run(hashPassword('x'), Date.now()).lastInsertRowid;
  const cookie = `${COOKIE}=${issueToken({ id })}`;
  const server = express.application.listen.call(app, 0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // The removed features no longer answer.
  for (const [method, url] of [
    ['GET', '/api/messages/channels'],
    ['POST', '/api/messages/channels/C0000001'],
    ['POST', '/api/messages/channels/C0000001/files'],
    ['POST', '/api/hooks/slack/events'],
    ['POST', '/api/ai/complete'],
    ['GET', '/api/ai/providers'],
    ['POST', '/api/asana-tasks/from-message'],
  ])
    assert.equal((await req(method, url, method === 'POST' ? {} : undefined)).status, 404, `${method} ${url}`);

  // Calendar: private-network links are refused; portal events appear.
  const ics = await req('POST', '/api/calendar/sources/ics', { url: 'http://127.0.0.1:1/cal.ics', label: 'x' });
  assert.equal(ics.status, 400);
  db.prepare("INSERT INTO holidays(date,name,created_ts) VALUES ('2026-11-14','Company holiday',?)").run(Date.now());
  const ev = await req(
    'GET',
    `/api/calendar/events?from=${encodeURIComponent('2026-11-09T00:00:00Z')}&to=${encodeURIComponent('2026-11-16T00:00:00Z')}`,
  );
  assert.equal(ev.status, 200);
  assert.ok(ev.body.events.some((e) => e.kind === 'holiday' && e.title === 'Company holiday'));
  assert.equal((await req('POST', '/api/calendar/sources/google/connect')).status, 503); // not configured
});

test('ICS parser: time zones, all-day, weekly recurrence, exceptions', () => {
  const { parseIcs } = require('../src/v2/ics');
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:a',
    'SUMMARY:Stand-up',
    'DTSTART;TZID=America/New_York:20261109T093000',
    'DTEND;TZID=America/New_York:20261109T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6',
    'EXDATE;TZID=America/New_York:20261111T093000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:b',
    'SUMMARY:Holiday\\, office closed',
    'DTSTART;VALUE=DATE:20261126',
    'DTEND;VALUE=DATE:20261127',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:c',
    'SUMMARY:Long title that is',
    ' folded',
    'DTSTART:20261110T150000Z',
    'DURATION:PT90M',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const out = parseIcs(text, {
    rangeStart: Date.parse('2026-11-01T00:00:00Z'),
    rangeEnd: Date.parse('2026-12-31T00:00:00Z'),
    defaultZone: 'Asia/Kolkata',
  });
  const standups = out.filter((e) => e.uid === 'a');
  assert.equal(standups.length, 5); // 6 occurrences minus one EXDATE
  assert.equal(new Date(standups[0].start_ts).toISOString(), '2026-11-09T14:30:00.000Z');
  const hol = out.find((e) => e.uid === 'b');
  assert.equal(hol.title, 'Holiday, office closed');
  assert.equal(hol.all_day, true);
  assert.equal(hol.busy, false);
  const folded = out.find((e) => e.uid === 'c');
  assert.equal(folded.title, 'Long title that isfolded');
  assert.equal(folded.end_ts - folded.start_ts, 90 * 60 * 1000);
});
