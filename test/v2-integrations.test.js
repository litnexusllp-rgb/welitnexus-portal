'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wln-v2i-'));
process.env.DB_PATH = path.join(tmp, 'portal.db');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'v2-integrations-test-secret';

// One fake upstream that plays Slack, Asana and Anthropic.
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => {
    body += d;
  });
  req.on('end', () => {
    calls.push({ url: req.url, body, headers: req.headers });
    const send = (o) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (req.url.startsWith('/slack/users.lookupByEmail'))
      return send({ ok: true, user: { id: 'U111', real_name: 'Emp One', profile: { email: 'emp1@example.com' } } });
    if (req.url.startsWith('/slack/conversations.list'))
      return send({
        ok: true,
        channels: [
          { id: 'C0000001', name: 'client-alpha', is_member: true },
          { id: 'C0000002', name: 'secret', is_member: false },
        ],
      });
    if (req.url.startsWith('/slack/users.conversations'))
      return send({
        ok: true,
        channels: [
          { id: 'C0000001', name: 'client-alpha' },
          { id: 'C0000002', name: 'secret' },
        ],
      });
    if (req.url.startsWith('/slack/conversations.history'))
      return send({
        ok: true,
        messages: [
          { ts: '1762750000.000200', user: 'U111', text: 'Second' },
          { ts: '1762750000.000100', user: 'U111', text: 'First' },
        ],
      });
    if (req.url.startsWith('/slack/users.info'))
      return send({ ok: true, user: { id: 'U111', real_name: 'Emp One', profile: { email: 'emp1@example.com' } } });
    if (req.url.startsWith('/slack/chat.postMessage')) return send({ ok: true, ts: '1762750001.000100' });
    if (req.url.startsWith('/slack/chat.getPermalink'))
      return send({ ok: true, permalink: 'https://slack.example/p1' });
    if (req.url.startsWith('/asana/tasks'))
      return send({
        data: {
          gid: '9001',
          name: JSON.parse(body).data.name,
          permalink_url: 'https://app.asana.com/0/1/9001',
          due_on: JSON.parse(body).data.due_on || null,
        },
      });
    if (req.url.startsWith('/anthropic'))
      return send({
        content: [
          {
            type: 'text',
            text: '{"text":"Summary here","suggestions":[{"type":"create_task","name":"Request bank statement","due_on":"2026-11-13"},{"type":"bogus"}]}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    res.statusCode = 404;
    res.end('{}');
  });
});

test('Slack, Asana, AI and calendar integrations', async (t) => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${fake.address().port}`;
  process.env.SLACK_API_BASE = up + '/slack';
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_SIGNING_SECRET = 'signing-secret';
  process.env.ASANA_API_BASE = up + '/asana';
  process.env.ASANA_TOKEN = 'asana-test';
  process.env.ASANA_PROJECT_GID = '1234';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_BASE = up + '/anthropic';

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
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fake.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, {
      method,
      headers: {
        cookie,
        ...(body && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // Channels = person's channels that the portal app was added to.
  const ch = await req('GET', '/api/messages/channels');
  assert.deepEqual(
    ch.body.channels.map((c) => c.id),
    ['C0000001'],
  );
  // Not visible -> refused.
  assert.equal((await req('GET', '/api/messages/channels/C0000002')).status, 403);
  const hist = await req('GET', '/api/messages/channels/C0000001');
  assert.deepEqual(
    hist.body.messages.map((m) => m.text),
    ['First', 'Second'],
  );
  assert.equal(hist.body.messages[0].portal_user_id, id);

  const sent = await req('POST', '/api/messages/channels/C0000001', { text: 'Hello team' });
  assert.equal(sent.status, 200);
  const post = calls.find((c) => c.url.startsWith('/slack/chat.postMessage'));
  assert.equal(JSON.parse(post.body).username, 'Emp One');

  // Signed Slack events are accepted; unsigned ones are rejected.
  const payload = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  assert.equal(
    (await req('POST', '/api/hooks/slack/events', payload, { 'Content-Type': 'application/json' })).status,
    401,
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', 'signing-secret').update(`v0:${ts}:${payload}`).digest('hex');
  const ver = await req('POST', '/api/hooks/slack/events', payload, {
    'Content-Type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': sig,
  });
  assert.equal(ver.body.challenge, 'abc');

  // Asana: create a task from a Slack message; link is posted back to the thread.
  const task = await req('POST', '/api/asana-tasks/from-message', {
    channel: 'C0000001',
    ts: '1762750000.000100',
    due_date: '2026-11-13',
  });
  assert.equal(task.status, 200, JSON.stringify(task.body));
  assert.equal(task.body.task.gid, '9001');
  const asanaCall = calls.find((c) => c.url.startsWith('/asana/tasks'));
  const asanaBody = JSON.parse(asanaCall.body).data;
  assert.equal(asanaBody.assignee, 'emp1@example.com');
  assert.deepEqual(asanaBody.projects, ['1234']);
  assert.match(asanaBody.notes, /slack\.example\/p1/);

  // AI: provider-neutral, suggestions sanitized, usage logged.
  const ai = await req('POST', '/api/ai/complete', { action: 'summarize_thread', context: { channel: 'C0000001' } });
  assert.equal(ai.status, 200, JSON.stringify(ai.body));
  assert.equal(ai.body.text, 'Summary here');
  assert.deepEqual(ai.body.suggestions, [
    { type: 'create_task', name: 'Request bank statement', due_on: '2026-11-13' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM int_ai_usage WHERE user_id=?').get(id).n, 1);
  assert.equal((await req('POST', '/api/ai/complete', { action: 'hack' })).status, 400);

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

test('AI redaction removes identifiers and pay figures', () => {
  const { redact } = require('../src/v2/ai');
  const out = redact('PAN ABCDE1234F, account 123456789012, IFSC HDFC0001234, salary: ₹85,000');
  assert.doesNotMatch(out, /ABCDE1234F|123456789012|HDFC0001234|85,000/);
});
