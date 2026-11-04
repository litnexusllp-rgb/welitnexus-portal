'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Settings } = require('luxon');

test('successful clock actions queue one Slack alert each for the Attendance channel', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-slack-'));
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 'portal.db'),
    JWT_SECRET: 'synthetic-only',
    TZ_OFFICE: 'Asia/Kolkata',
    SLACK_BOT_TOKEN: 'mock-bot-token',
    SLACK_ATTENDANCE_CHANNEL: 'CTESTATTENDANCE',
    SLACK_EOD_CHANNEL: 'CTESTEOD',
  });
  const { db } = require('../src/db');
  const auth = require('../src/auth');
  const { app } = require('../src/server');
  const { createApi } = require('../src/eodApi');
  const { config, createDelivery, queueAttendanceAlert } = require('../src/attendanceSlack');
  const id = Number(db.prepare("INSERT INTO users(name,email,password_hash,created_ts,join_date) VALUES (?,?,?,0,'2026-01-01')")
    .run('Synthetic <@staff>', 'attendance@example.test', 'synthetic').lastInsertRowid);
  const cookie = auth.COOKIE + '=' + auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  const server = app.listen(0, '127.0.0.1');
  const originalNow = Settings.now;
  t.after(async () => {
    Settings.now = originalNow;
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  let timestamp = Date.parse('2026-10-19T16:00:00+05:30');
  Settings.now = () => timestamp;
  const punch = type => fetch('http://127.0.0.1:' + server.address().port + '/api/attendance/punch', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ type, note: 'private note' }),
  });
  for (const type of ['IN', 'BREAK_START', 'BREAK_END', 'OUT']) {
    assert.equal((await punch(type)).status, 200, type);
    timestamp += 60_000;
  }
  assert.equal((await punch('BREAK_END')).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance_slack_alerts').get().n, 4);
  assert.equal(config({ SLACK_BOT_TOKEN: 'test', SLACK_EOD_CHANNEL: 'CTESTEOD' }), null);
  assert.equal(config({ ...process.env, SLACK_ATTENDANCE_ALERTS: 'off' }), null);

  const posts = [];
  const fakeFetch = async (url, options) => {
    if (new URL(url).pathname.endsWith('/auth.test')) {
      return new Response(JSON.stringify({ ok: true, bot_id: 'BTEST', user_id: 'UTEST' }), { headers: { 'x-oauth-scopes': 'chat:write' } });
    }
    assert.equal(new URL(url).pathname, '/api/chat.postMessage');
    const message = JSON.parse(options.body);
    assert.equal(message.channel, 'CTESTATTENDANCE');
    assert.equal(message.parse, 'none');
    assert.match(message.text, /Synthetic &lt;@staff&gt;/);
    assert.doesNotMatch(message.text, /private note|attendance@example/);
    posts.push(message.text);
    return new Response(JSON.stringify({ ok: true, ts: '100.' + posts.length }));
  };
  const log = { info() {}, warn() {} };
  const deliver = createDelivery(db, createApi(config(), fakeFetch), { clock: () => timestamp, log });
  for (let i = 0; i < 5; i++) await deliver();
  assert.deepEqual(posts.map(text => text.split(' · ')[0].replace('Synthetic &lt;@staff&gt; ', '')),
    ['clocked in', 'started a break', 'resumed work', 'clocked out']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attendance_slack_alerts WHERE status='SENT'").get().n, 4);

  queueAttendanceAlert(db, 100, 'Synthetic', 'IN', timestamp);
  const flaky = createDelivery(db, {
    checkBot: async () => ({ botUserId: 'UTEST' }),
    post: async () => { throw Object.assign(new Error('unconfirmed outcome'), { ambiguous: true }); },
  }, { clock: () => timestamp, log });
  await flaky();
  await deliver();
  assert.equal(db.prepare('SELECT status FROM attendance_slack_alerts WHERE event_id=100').get().status, 'REVIEW');
  assert.equal(posts.length, 4);
});
