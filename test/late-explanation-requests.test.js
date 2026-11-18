'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('automatic late requests retain generation, comments and admin decisions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'late-requests-'));
  process.env.DB_PATH = path.join(dir, 'synthetic.db');
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'synthetic-late-requests';
  process.env.TZ_OFFICE = 'Asia/Kolkata';
  process.env.SHIFT_GRACE_MIN = '15';
  const { Settings } = require('luxon');
  const originalNow = Settings.now;
  let clock = Date.parse('2026-11-18T16:30:00+05:30');
  Settings.now = () => clock;
  const { db } = require('../src/db');
  const auth = require('../src/auth');
  const requests = require('../src/lateExplanationRequests');
  const { changeAttendance } = require('../src/attendanceValidation');
  const express = require('express');
  const app = express();
  app.use(express.json(), require('cookie-parser')(), auth.loadUser);
  app.use('/api/attendance', require('../src/routes/attendance'));
  app.use('/api/reports', require('../src/routes/reports'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const call = async (id, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        ...(id ? { cookie: auth.COOKIE + '=' + auth.issueToken(user(id)) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  let seq = 0;
  const add = (role = 'EMPLOYEE') =>
    Number(
      db
        .prepare(
          `INSERT INTO users
    (name,email,password_hash,role,shift_start,join_date,created_ts) VALUES(?,?,'synthetic',?,'16:00','2026-01-01',0)`,
        )
        .run('Synthetic ' + ++seq, `late${seq}@example.test`, role).lastInsertRowid,
    );
  const user = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const admin = add('ADMIN');
  const history = (id) => requests.requestReport('2026-11-01', '2026-11-30', id);
  const punch = (id, type = 'IN') => call(id, 'attendance/punch', { type });
  t.after(async () => {
    await new Promise((r) => server.close(r));
    Settings.now = originalNow;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test(
    'late punch generates one employee request; repeated punches and reconciliation do not duplicate it',
    async () => {
      const id = add();
      assert.equal((await punch(id)).status, 200);
      assert.equal(history(id).totals.generated, 1);
      assert.equal(history(id).totals.awaitingEmployee, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM late_explanations WHERE user_id=?').get(id).n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get(id).n, 1);
      clock += 60000;
      assert.equal((await punch(id, 'BREAK_START')).status, 200);
      requests.requestCurrentDays();
      requests.requestCurrentDays();
      assert.equal(history(id).totals.generated, 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id=?').get(id).n, 1);
      const own = await call(id, 'reports/late-explanations/requests?user_id=' + admin);
      assert.equal(own.body.requests.length, 1);
      assert.equal(own.body.requests[0].minutesLate, 15);
      assert.equal((await call(add(), 'reports/late-explanations/requests?user_id=' + id)).body.requests.length, 0);
    },
  );

  await t.test(
    'employee comments enter the admin queue and marking normal preserves the complete history',
    async () => {
      const id = add();
      assert.equal((await punch(id)).status, 200);
      const before = db.prepare('SELECT * FROM events WHERE user_id=?').all(id);
      const other = add();
      assert.equal(
        (await call(other, 'reports/late-explanations', { day: '2026-11-18', reason: 'Other user', user_id: id }))
          .status,
        409,
      );
      assert.equal(
        (await call(id, 'reports/late-explanations', { day: '2026-11-18', reason: 'Train delayed' })).status,
        201,
      );
      assert.equal(
        (await call(id, 'reports/late-explanations', { day: '2026-11-18', reason: 'Duplicate' })).status,
        409,
      );
      const pending = await call(admin, 'reports/late-explanations/pending');
      const submitted = pending.body.requests.find((r) => r.user_id === id);
      assert.ok(submitted);
      assert.equal(history(id).totals.submitted, 1);
      assert.equal(history(id).totals.awaitingReview, 1);
      assert.equal((await call(id, 'reports/late-explanations/requests')).body.requests.length, 0);
      assert.ok(
        db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Late explanation to review'").get(admin),
      );
      assert.equal((await call(other, `reports/late-explanations/${submitted.id}/approve`, {})).status, 403);
      assert.equal((await call(admin, `reports/late-explanations/${submitted.id}/approve`, {})).status, 200);
      assert.equal((await call(admin, `reports/late-explanations/${submitted.id}/approve`, {})).status, 409);
      const report = history(id);
      assert.equal(report.totals.generated, 1);
      assert.equal(report.totals.submitted, 1);
      assert.equal(report.totals.processed, 1);
      assert.equal(report.rows[0].reason, 'Train delayed');
      assert.equal(report.rows[0].processed_by, admin);
      assert.equal(report.rows[0].resolution, 'EXCUSED');
      const day = await call(id, 'reports/my-attendance?start=2026-11-18&end=2026-11-18');
      assert.equal(day.body.rows[0].late, false);
      assert.deepEqual(db.prepare('SELECT * FROM events WHERE user_id=?').all(id), before);
      assert.equal((await call(id, 'reports/late-explanations/history')).status, 403);
      assert.equal((await call(null, 'reports/late-explanations/requests')).status, 401);
      assert.equal(
        (await call(admin, 'reports/late-explanations/history?start=2026-12-01&end=2026-11-01')).status,
        400,
      );
    },
  );

  await t.test('manual normal and full-day decisions process requests once even without comments', async () => {
    for (const action of ['late-normal', 'full-day']) {
      const id = add();
      await punch(id);
      const body = { user_id: id, day: '2026-11-18', ...(action === 'late-normal' ? { normal: true } : {}) };
      assert.equal((await call(admin, 'attendance/admin/' + action, body)).status, 200);
      assert.equal(history(id).totals.processed, 1);
      assert.equal(history(id).totals.submitted, 0);
      assert.equal(requests.outstanding(id).length, 0);
      const processed = history(id).rows[0].processed_ts;
      clock += 60000;
      if (action === 'late-normal') await call(admin, 'attendance/admin/late-normal', body);
      assert.equal(history(id).rows[0].processed_ts, processed);
    }
  });

  await t.test(
    'grace boundary, admins, approved leave, Short Days, holidays and weekends do not create prompts',
    async () => {
      const original = clock;
      clock = Date.parse('2026-11-18T16:15:00+05:30');
      const boundary = add();
      await punch(boundary);
      assert.equal(history(boundary).totals.generated, 0);
      clock += 60000;
      await punch(boundary, 'OUT');
      clock += 60000;
      await punch(boundary);
      assert.equal(history(boundary).totals.generated, 0); // first clock-in was on time
      await punch(admin);
      assert.equal(history(admin).totals.generated, 0);
      for (const kind of ['FULL', 'HALF']) {
        const id = add();
        db.prepare(
          `INSERT INTO leaves(user_id,start_date,end_date,kind,status,reason,days,created_ts)
        VALUES(?,'2026-11-18','2026-11-18',?,'APPROVED','Synthetic',1,0)`,
        ).run(id, kind);
        await punch(id);
        assert.equal(history(id).totals.generated, 0);
      }
      const short = add();
      db.prepare(
        `INSERT INTO short_day_requests(user_id,date,status,created_ts,timezone,decided_by) VALUES(?,'2026-11-18','APPROVED',0,'Asia/Kolkata',?)`,
      ).run(short, admin);
      await punch(short);
      assert.equal(history(short).totals.generated, 0);
      db.prepare("INSERT INTO holidays(date,name,duration,created_ts) VALUES('2026-11-18','Synthetic','HALF',0)").run();
      const holiday = add();
      await punch(holiday);
      assert.equal(history(holiday).totals.generated, 0);
      db.prepare("DELETE FROM holidays WHERE date='2026-11-18'").run();
      clock = Date.parse('2026-11-22T16:30:00+05:30');
      const weekend = add();
      await punch(weekend);
      assert.equal(history(weekend).totals.generated, 0);
      clock = original;
    },
  );

  await t.test('corrected on-time punches remove outstanding prompts but retain generated counts', async () => {
    const id = add();
    await punch(id);
    changeAttendance(id, ['2026-11-18'], () =>
      db.prepare('UPDATE events SET ts=? WHERE user_id=?').run(Date.parse('2026-11-18T16:10:00+05:30'), id),
    );
    assert.equal(requests.outstanding(id).length, 0);
    assert.equal(history(id).totals.generated, 1);
    assert.equal(history(id).totals.noLongerRequired, 1);
    assert.equal(history(id).totals.processed, 0);
  });

  await t.test('startup covers current workdays only and respects individual timezone snapshots', async () => {
    const id = add();
    const oldDay = '2026-11-17';
    db.prepare('INSERT INTO events(user_id,type,ts,day) VALUES(?,?,?,?)').run(
      id,
      'IN',
      Date.parse(oldDay + 'T16:30:00+05:30'),
      oldDay,
    );
    requests.requestCurrentDays();
    assert.equal(history(id).totals.generated, 0);
    const remote = add();
    db.prepare(
      "UPDATE users SET shift_start='23:00',attendance_timezone='America/New_York',attendance_cutover=8 WHERE id=?",
    ).run(remote);
    clock = Date.parse('2026-11-19T04:40:00Z'); // Nov 18 23:40 New York
    assert.equal((await punch(remote)).status, 200);
    const record = history(remote).rows[0];
    assert.equal(record.day, '2026-11-18');
    assert.equal(record.timezone, 'America/New_York');
    assert.equal(record.minutes_late, 25);
    clock += 60000;
    requests.requestCurrentDays();
    assert.equal(history(remote).totals.generated, 1);
  });
});
