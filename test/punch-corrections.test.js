'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('attendance correction approvals replace the selected punch atomically', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-punch-corrections-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-only-secret';
  process.env.TZ_OFFICE = 'Asia/Kolkata'; process.env.ATTENDANCE_CUTOVER_HOUR = '8';
  // Start with the pre-change request schema to exercise the additive migration.
  const old = new (require('better-sqlite3'))(process.env.DB_PATH);
  old.exec(`CREATE TABLE punch_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    day TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, reason TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'PENDING', decided_by INTEGER, decided_ts INTEGER,
    admin_note TEXT DEFAULT '', created_ts INTEGER NOT NULL)`);
  old.close();
  const { db } = require('../src/db');
  const auth = require('../src/auth');
  const express = require('express');
  const app = express(); app.use(express.json(), require('cookie-parser')(), auth.loadUser);
  for (const [url, file] of [['attendance', 'attendance'], ['punch-requests', 'punchRequests'], ['reports', 'reports'], ['kpi', 'kpi']]) {
    app.use('/api/' + url, require('../src/routes/' + file));
  }
  const add = role => Number(db.prepare(`INSERT INTO users(name,email,password_hash,role,created_ts,join_date)
    VALUES(?,?,?,?,0,'2026-01-01')`).run(role, role + '@example.test', 'unused', role).lastInsertRowid);
  const admin = add('ADMIN'), employee = add('EMPLOYEE'), other = add('OTHER');
  const cookie = id => auth.COOKIE + '=' + auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  const adminCookie = cookie(admin), empCookie = cookie(employee);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body, session = adminCookie) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/` + url, {
      method, headers: { cookie: session, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  let dayNumber = 1;
  const ts = (day, time) => Date.parse(`${day}T${time}:00+05:30`);
  const seed = (pairs = [['IN', '09:00'], ['BREAK_START', '12:00'], ['BREAK_END', '12:30'], ['OUT', '15:10']], uid = employee) => {
    const day = `2026-06-${String(dayNumber++).padStart(2, '0')}`;
    const insert = db.prepare('INSERT INTO events(user_id,type,ts,day,note,device) VALUES(?,?,?,?,?,?)');
    for (const [type, time] of pairs) insert.run(uid, type, ts(day, time), day, 'original note', 'PC');
    return { day, events: db.prepare('SELECT * FROM events WHERE user_id=? AND day=? ORDER BY ts,id').all(uid, day) };
  };
  const submit = (data, session = empCookie) => request('punch-requests', 'POST', { reason: 'wrong punch time', ...data }, session);
  const decide = (id, decision = 'APPROVED', session = adminCookie) => request(`punch-requests/${id}/decide`, 'POST', { decision, note: 'Reviewed' }, session);
  const edit = (fixture, type, time, target = fixture.events.find(e => e.type === type)) => submit({ day: fixture.day, type, time, operation: 'EDIT', target_event_id: target.id });
  const stored = id => db.prepare('SELECT * FROM punch_requests WHERE id=?').get(id);
  const event = id => db.prepare('SELECT * FROM events WHERE id=?').get(id);
  const audit = id => db.prepare('SELECT * FROM punch_request_changes WHERE request_id=?').get(id);
  const employeeNotifications = () => db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id').all(employee);

  await t.test('3:10 PM clock-out corrects to 2:10 PM with the same event ID and accurate reports', async () => {
    const f = seed([['IN', '09:00'], ['OUT', '15:10']]); const original = f.events[1];
    const r = await edit(f, 'OUT', '14:10'); assert.equal(r.status, 200);
    assert.equal(r.body.request.original_time, '15:10');
    assert.deepEqual(JSON.parse(r.body.request.original_event), original);
    const result = await decide(r.body.request.id); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(event(original.id), { ...original, ts: ts(f.day, '14:10') });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE user_id=? AND day=?').get(employee, f.day).n, 2);
    const summary = (await request(`attendance/admin/day?user_id=${employee}&day=${f.day}`)).body;
    assert.equal(summary.workedMinutes, 310); assert.equal(summary.lastOut, ts(f.day, '14:10'));
    const report = (await request(`reports/attendance?user_id=${employee}&start=${f.day}&end=${f.day}`)).body;
    assert.equal(report.rows[0].workedMinutes, 310); assert.equal(report.totals.workedMinutes, 310);
    const kpi = (await request('kpi?month=2026-06')).body.rows.find(r => r.id === employee);
    assert.equal(kpi.hoursWorked, 5.2); // KPI's existing one-decimal display rounding.
    const a = audit(r.body.request.id);
    assert.deepEqual(JSON.parse(a.before_json), original); assert.deepEqual(JSON.parse(a.after_json), event(original.id));
    assert.equal(a.changed_by, admin); assert.equal(a.changed_ts, stored(a.request_id).decided_ts);
    assert.equal(stored(a.request_id).admin_note, 'Reviewed');
  });
  for (const [type, time, worked, breaks] of [['IN', '09:10', 330, 30], ['BREAK_START', '11:50', 330, 40], ['BREAK_END', '12:40', 330, 40]]) {
    await t.test(`existing ${type} correction preserves identity and recalculates worked/break time`, async () => {
      const f = seed(); const original = f.events.find(e => e.type === type);
      const r = await edit(f, type, time); assert.equal(r.status, 200);
      assert.equal((await decide(r.body.request.id)).status, 200);
      assert.equal(event(original.id).ts, ts(f.day, time));
      const summary = (await request(`attendance/admin/day?user_id=${employee}&day=${f.day}`)).body;
      assert.equal(summary.workedMinutes, worked); assert.equal(summary.breakMinutes, breaks);
    });
  }
  await t.test('explicit target selects the second of multiple break pairs', async () => {
    const f = seed([['IN','09:00'],['BREAK_START','10:00'],['BREAK_END','10:15'],['BREAK_START','12:00'],['BREAK_END','12:30'],['OUT','15:10']]);
    const r = await edit(f, 'BREAK_START', '11:50', f.events[3]);
    assert.equal((await decide(r.body.request.id)).status, 200);
    assert.deepEqual(event(f.events[1].id), f.events[1]); assert.equal(event(f.events[3].id).ts, ts(f.day, '11:50'));
  });
  for (const [type, time] of [['OUT','08:59'],['OUT','12:30'],['BREAK_START','12:40'],['BREAK_END','11:50']]) {
    await t.test(`invalid ${type} time ${time} rolls back event, decision, audit and notification`, async () => {
      const f = seed(), before = employeeNotifications(); const original = f.events.find(e => e.type === type);
      const r = await edit(f, type, time); assert.equal(r.status, 200);
      assert.equal((await decide(r.body.request.id)).status, 409);
      assert.deepEqual(event(original.id), original); assert.equal(stored(r.body.request.id).status, 'PENDING');
      assert.equal(stored(r.body.request.id).decided_by, null); assert.equal(audit(r.body.request.id), undefined);
      assert.deepEqual(employeeNotifications(), before);
    });
  }
  await t.test('a valid-looking swap across complete sessions is rejected', async () => {
    const f = seed([['IN','09:00'],['OUT','10:00'],['IN','11:00'],['OUT','12:00'],['IN','13:00'],['OUT','15:00']]);
    const r = await edit(f, 'OUT', '14:00', f.events[1]);
    assert.equal((await decide(r.body.request.id)).status, 409); assert.deepEqual(event(f.events[1].id), f.events[1]);
  });
  await t.test('complete-day validation rejects an already-corrupt sequence after an otherwise valid edit', async () => {
    const f = seed(); db.prepare("UPDATE events SET type='IN' WHERE id=?").run(f.events[2].id);
    const r = await edit(f,'OUT','14:10'); const result = await decide(r.body.request.id);
    assert.equal(result.status,409); assert.match(result.body.error,/Cannot IN while BREAK/);
    assert.deepEqual(event(f.events[3].id),f.events[3]); assert.equal(stored(r.body.request.id).status,'PENDING');
    assert.equal(audit(r.body.request.id),undefined);
  });
  await t.test('ADD still adds a genuinely missed punch and cannot insert duplicate clock-outs', async () => {
    const f = seed([['IN','09:00']]);
    const r = await submit({ day:f.day, type:'OUT', time:'15:10', operation:'ADD' });
    assert.equal((await decide(r.body.request.id)).status, 200); assert.equal(audit(r.body.request.id).before_json, null);
    const dup = await submit({ day:f.day, type:'OUT', time:'14:10', operation:'ADD' });
    assert.equal((await decide(dup.body.request.id)).status, 409); assert.equal(stored(dup.body.request.id).status, 'PENDING');
  });
  for (const type of ['BREAK_START','BREAK_END']) {
    await t.test(`ADD can repair a missing ${type} in a legacy sequence`, async () => {
      const f = seed([['IN','09:00'],['BREAK_START','12:00'],['BREAK_END','12:30'],['OUT','15:10']]);
      const missing = f.events.find(e => e.type === type); db.prepare('DELETE FROM events WHERE id=?').run(missing.id);
      const r = await submit({ day:f.day, type, time: type === 'BREAK_START' ? '12:00' : '12:30', operation:'ADD' });
      assert.equal((await decide(r.body.request.id)).status, 200);
    });
  }
  await t.test('post-midnight edit remains in its original attendance day', async () => {
    const f = seed([['IN','16:00'],['OUT','23:00']]);
    const nextDay = require('../src/time').DateTime.fromISO(f.day).plus({days:1}).toISODate();
    db.prepare('UPDATE events SET ts=? WHERE id=?').run(ts(nextDay,'03:10'),f.events[1].id);
    const r = await edit(f,'OUT','02:10'); assert.equal((await decide(r.body.request.id)).status,200);
    assert.equal(event(f.events[1].id).day,f.day); assert.equal(event(f.events[1].id).ts,ts(nextDay,'02:10'));
    assert.equal((await request(`attendance/admin/day?user_id=${employee}&day=${f.day}`)).body.workedMinutes,610);
  });
  for (const mutation of ['changed', 'deleted']) {
    await t.test(`${mutation} original punch is not silently overwritten or reinserted`, async () => {
      const f = seed(), original = f.events[3]; const r = await edit(f,'OUT','14:10');
      if (mutation === 'changed') db.prepare('UPDATE events SET ts=ts+60000 WHERE id=?').run(original.id);
      else db.prepare('DELETE FROM events WHERE id=?').run(original.id);
      const before = event(original.id);
      const result = await decide(r.body.request.id); assert.equal(result.status,409); assert.match(result.body.error,/changed or was deleted/);
      assert.deepEqual(event(original.id),before); assert.equal(stored(r.body.request.id).status,'PENDING'); assert.equal(audit(r.body.request.id),undefined);
    });
  }
  await t.test('concurrent duplicate approvals apply and notify once; competing edits become stale', async () => {
    const f = seed(), r = await edit(f,'OUT','14:10'), competing = await edit(f,'OUT','14:20');
    const before = employeeNotifications().length;
    const responses = await Promise.all([decide(r.body.request.id), decide(r.body.request.id)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    assert.equal(employeeNotifications().length,before+1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM punch_request_changes WHERE request_id=?').get(r.body.request.id).n,1);
    assert.equal((await decide(competing.body.request.id)).status,409);
    assert.equal((await decide(r.body.request.id,'REJECTED')).status,409);
  });
  await t.test('rejection and employee cancellation never change attendance', async () => {
    const f = seed();
    for (const cancel of [false,true]) {
      const r = await edit(f,'OUT','14:10');
      const result = cancel ? await request(`punch-requests/${r.body.request.id}/cancel`,'POST',{},empCookie) : await decide(r.body.request.id,'REJECTED');
      assert.equal(result.status,200); assert.deepEqual(event(f.events[3].id),f.events[3]); assert.equal(audit(r.body.request.id),undefined);
      assert.equal((await decide(r.body.request.id)).status,409);
    }
  });
  await t.test('ownership, event day/type and admin authorization are enforced', async () => {
    const f = seed(), foreign = seed(undefined,other);
    const data = { day:f.day, type:'OUT', time:'14:10', operation:'EDIT', target_event_id:f.events[3].id };
    assert.equal((await submit(data,'')).status,401);
    for (const bad of [{target_event_id:foreign.events[3].id},{day:'2026-05-01'},{type:'BREAK_START'},{target_event_id:999999}]) {
      assert.equal((await submit({...data,...bad})).status,404);
    }
    for (const bad of [{target_event_id:'1'},{operation:'INVALID'},{operation:'ADD'},{time:'25:00'},{day:'2026-02-30'}]) {
      assert.equal((await submit({...data,...bad})).status,400);
    }
    const r = await submit(data);
    assert.equal((await decide(r.body.request.id,'APPROVED',empCookie)).status,403);
    assert.equal((await decide(r.body.request.id,'APPROVED','')).status,401);
    assert.equal((await request(`punch-requests/${r.body.request.id}/cancel`,'POST',{},cookie(other))).status,404);
    assert.equal((await request('punch-requests/pending','GET',undefined,empCookie)).status,403);
    const own = await request(`punch-requests/events?day=${foreign.day}&user_id=${other}`,'GET',undefined,empCookie);
    assert.deepEqual(own.body.events,[]);
    assert.equal((await request('punch-requests/events?day=2026-02-30','GET',undefined,empCookie)).status,400);
    assert.deepEqual(event(f.events[3].id),f.events[3]);
  });
  await t.test('legacy pending OUT and break edits match only a unique existing event', async () => {
    const insert = db.prepare("INSERT INTO punch_requests(user_id,day,type,time,reason,created_ts) VALUES(?,?,?,?,?,?)");
    for (const [type,time] of [['OUT','14:10'],['BREAK_START','11:50'],['BREAK_END','12:40']]) {
      const f = seed(), original = f.events.find(e=>e.type===type);
      const id = Number(insert.run(employee,f.day,type,time,'old pending request',Date.now()).lastInsertRowid);
      assert.equal(stored(id).operation,null); assert.equal((await decide(id)).status,200);
      assert.equal(event(original.id).ts,ts(f.day,time)); assert.deepEqual(JSON.parse(audit(id).before_json),original);
    }
    const f = seed([['IN','09:00'],['BREAK_START','10:00'],['BREAK_END','10:15'],['BREAK_START','12:00'],['BREAK_END','12:30'],['OUT','15:10']]);
    const id = Number(insert.run(employee,f.day,'BREAK_START','11:50','ambiguous',Date.now()).lastInsertRowid);
    const result = await decide(id); assert.equal(result.status,409); assert.match(result.body.error,/Multiple matching punches/);
    assert.equal(stored(id).status,'PENDING');
    assert.equal((await submit({day:f.day,type:'BREAK_START',time:'11:50'})).status,409);
    const missing = seed([['IN','09:00']]);
    const addId = Number(insert.run(employee,missing.day,'OUT','15:00','legacy missed punch',Date.now()).lastInsertRowid);
    assert.equal((await decide(addId)).status,200); assert.equal(audit(addId).before_json,null);
  });
  await t.test('older clients capture a unique target on submission; missing-punch requests still insert', async () => {
    const f = seed([['IN','09:00'],['OUT','15:10']]);
    const r = await submit({day:f.day,type:'OUT',time:'14:10'});
    assert.equal(r.body.request.operation,'EDIT'); assert.equal(r.body.request.target_event_id,f.events[1].id);
    assert.equal((await decide(r.body.request.id)).status,200);
    const missing = seed([['IN','09:00']]);
    const m = await submit({day:missing.day,type:'OUT',time:'15:00'});
    assert.equal(m.body.request.operation,'ADD'); assert.equal((await decide(m.body.request.id)).status,200);
  });
  await t.test('migration and before/after audit survive restart without changing attendance', () => {
    const before = db.prepare('SELECT COUNT(*) n FROM events').get().n;
    const r = require('node:child_process').spawnSync(process.execPath,['-e',`const {db}=require('./src/db');
      console.log(JSON.stringify({events:db.prepare('SELECT COUNT(*) n FROM events').get().n,audits:db.prepare('SELECT COUNT(*) n FROM punch_request_changes').get().n})); db.close();`],
    {cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); const saved = JSON.parse(r.stdout.trim());
    assert.equal(saved.events,before); assert.ok(saved.audits>0);
  });
});
