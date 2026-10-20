'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('attendance sessions survive local midnight, office cutover and timezone differences', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-timezones-'));
  process.env.DB_PATH = path.join(dir, 'synthetic.db');
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'timezone-test-only';
  process.env.TZ = 'Pacific/Honolulu'; // deliberately different server process timezone
  process.env.TZ_OFFICE = 'Asia/Kolkata'; process.env.ATTENDANCE_CUTOVER_HOUR = '8';
  const { db } = require('../src/db');
  const { DateTime, Settings } = require('luxon');
  const { attendanceDayFromTs } = require('../src/time');
  const { summarize } = require('../src/compute');
  const { settings, daySettings } = require('../src/attendanceSession');
  const auth = require('../src/auth');
  const express = require('express');
  const app = express(); app.use(express.json(), require('cookie-parser')(), auth.loadUser);
  for (const [url, file] of [['attendance','attendance'],['punch-requests','punchRequests'],['reports','reports'],['kpi','kpi'],['users','directory']]) app.use('/api/' + url, require('../src/routes/' + file));
  const add = (name, zone = '', cutover = null, shift = '16:00', role = 'EMPLOYEE') => Number(db.prepare(`INSERT INTO users(name,email,password_hash,role,created_ts,join_date,attendance_timezone,attendance_cutover,shift_start)
    VALUES(?,?,'unused',?,0,'2026-01-01',?,?,?)`).run(name, name + '@example.test', role, zone, cutover, shift).lastInsertRowid);
  const admin = add('admin','',null, '16:00','ADMIN');
  const user = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const cookie = id => auth.COOKIE + '=' + auth.issueToken(user(id));
  const server = app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(async()=>{Settings.now = ()=>Date.now(); await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const at = (iso, zone = 'Asia/Kolkata') => { const ms = DateTime.fromISO(iso,{zone}).toMillis(); assert.ok(Number.isSafeInteger(ms)); Settings.now = ()=>ms; return ms; };
  const req = async (id, url, method='GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, {method,headers:{cookie:cookie(id),'content-type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    const result = {status:res.status,body:await res.json()};
    return result;
  };
  const punch = (id,type) => req(id,'attendance/punch','POST',{type,ts:0,day:'1900-01-01'});
  const events = id => db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY ts,id').all(id);
  let overnight;
  await t.test('reproduces the old current-day query failure and closes the original session after office cutover', async()=>{
    const id = add('office'); overnight = id;
    const first = at('2026-10-19T23:30');
    assert.equal((await punch(id,'IN')).status,200);
    at('2026-10-20T09:30');
    const legacyDay = attendanceDayFromTs(Settings.now());
    const legacyRows = db.prepare('SELECT * FROM events WHERE user_id=? AND day=?').all(id,legacyDay);
    assert.equal(summarize(legacyRows,Settings.now()).state,'OUT'); // old endpoint offers IN and rejects OUT
    const s = await req(id,'attendance/status');
    assert.equal(s.body.state,'IN'); assert.equal(s.body.day,'2026-10-19'); assert.equal(s.body.currentDay,'2026-10-20');
    assert.ok(s.body.allowed.includes('OUT')); assert.ok(!s.body.allowed.includes('IN'));
    assert.equal(s.body.workedMinutes,600); assert.equal(events(id)[0].ts,first);
    assert.equal((await punch(id,'IN')).status,409);
    const team = (await req(admin,'attendance/today')).body.people.find(p=>p.id===id);
    assert.equal(team.state,'IN'); assert.equal(team.day,'2026-10-19');
    assert.equal((await punch(id,'OUT')).status,200);
    assert.deepEqual(events(id).map(e=>e.day),['2026-10-19','2026-10-19']);
    const report = (await req(admin,`reports/attendance?user_id=${id}&start=2026-10-19&end=2026-10-20`)).body;
    assert.equal(report.rows[0].workedMinutes,600);assert.equal(report.rows[0].noClockOut,false);
    assert.equal(report.rows[0].timezone,'Asia/Kolkata');assert.equal(report.totals.workedMinutes,600);
    assert.equal((await req(admin,'kpi?month=2026-10')).body.rows.find(r=>r.id===id).hoursWorked,10);
  });
  await t.test('unconfigured same-day IN/break/OUT, repeated OUT, and multiple daily sessions retain behavior',async()=>{
    const id=add('same');at('2026-10-19T16:00');assert.equal((await punch(id,'IN')).status,200);
    at('2026-10-19T18:00');assert.equal((await punch(id,'BREAK_START')).status,200);
    at('2026-10-19T18:30');assert.equal((await punch(id,'BREAK_END')).status,200);
    at('2026-10-19T20:30');assert.equal((await punch(id,'OUT')).status,200);
    let s=(await req(id,'attendance/status')).body;assert.equal(s.workedMinutes,240);assert.equal(s.breakMinutes,30);
    assert.equal((await punch(id,'OUT')).status,409);
    at('2026-10-19T21:00');assert.equal((await punch(id,'IN')).status,200);
    at('2026-10-19T22:00');await punch(id,'OUT');s=(await req(id,'attendance/status')).body;assert.equal(s.workedMinutes,300);
  });
  await t.test('explicit employee timezone keeps a month-end overnight break and OUT on the IN workday',async()=>{
    const id=add('remote','America/New_York',0,'22:00');
    at('2026-10-31T22:00','America/New_York');await punch(id,'IN');
    at('2026-10-31T23:50','America/New_York');await punch(id,'BREAK_START');
    at('2026-11-01T00:20','America/New_York');
    let s=(await req(id,'attendance/status')).body;assert.equal(s.state,'BREAK');assert.equal(s.day,'2026-10-31');assert.deepEqual(s.allowed,['BREAK_END','OUT']);
    assert.equal((await punch(id,'BREAK_START')).status,409);await punch(id,'BREAK_END');
    at('2026-11-01T07:00','America/New_York');await punch(id,'OUT'); // DST adds an actual hour
    assert.ok(events(id).every(e=>e.day==='2026-10-31'));
    const r=(await req(admin,`reports/attendance?user_id=${id}&start=2026-10-31&end=2026-11-01`)).body;
    assert.equal(r.rows[0].workedMinutes,570);assert.equal(r.rows[0].breakMinutes,30);assert.equal(r.rows[0].late,false);
    assert.equal((await req(admin,'kpi?month=2026-10')).body.rows.find(r=>r.id===id).hoursWorked,9.5);
    assert.equal((await req(admin,'kpi?month=2026-11')).body.rows.find(r=>r.id===id).hoursWorked,0);
  });
  await t.test('spring DST uses wall-clock day boundaries and elapsed UTC durations',async()=>{
    const c={timezone:'America/New_York',cutover:8};
    assert.equal(attendanceDayFromTs(DateTime.fromISO('2026-03-08T08:30',{zone:c.timezone}).toMillis(),c),'2026-03-08');
    assert.equal(attendanceDayFromTs(DateTime.fromISO('2026-11-01T07:30',{zone:c.timezone}).toMillis(),c),'2026-10-31');
    const id=add('spring','America/New_York',0,'22:00');at('2026-03-07T22:00','America/New_York');await punch(id,'IN');
    at('2026-03-08T07:00','America/New_York');await punch(id,'OUT');
    const r=(await req(admin,`reports/attendance?user_id=${id}&start=2026-03-07&end=2026-03-07`)).body;
    assert.equal(r.rows[0].workedMinutes,480);
  });
  await t.test('a remote local workday ahead of the office is present in reports and register',async()=>{
    const id=add('ahead','Pacific/Auckland',4,'06:00');at('2026-10-20T06:00','Pacific/Auckland');
    assert.equal((await punch(id,'IN')).body.day,'2026-10-20');
    const report=(await req(id,'reports/my-attendance')).body;assert.equal(report.end,'2026-10-20');assert.equal(report.rows.at(-1).status,'PRESENT');
    const register=(await req(admin,'reports/register?month=2026-10')).body;assert.equal(register.users.find(u=>u.id===id).cells['2026-10-20'],'PRESENT');
    at('2026-10-20T07:00','Pacific/Auckland');await punch(id,'BREAK_START');
    at('2026-10-21T05:00','Pacific/Auckland');assert.equal((await punch(id,'OUT')).status,200);assert.equal(events(id).at(-1).day,'2026-10-20');
    at('2026-10-21T06:00','Pacific/Auckland');assert.equal((await punch(id,'IN')).body.day,'2026-10-21');
    assert.equal((await req(id,'attendance/status')).body.day,'2026-10-21');
  });
  await t.test('auto-absence never flags a remote day that has not closed locally',async()=>{
    const id=add('absence','Pacific/Honolulu',8,'16:00');
    const ms=DateTime.fromISO('2026-10-19T16:00',{zone:'Pacific/Honolulu'}).toMillis();
    db.prepare("INSERT INTO events(user_id,type,ts,day) VALUES(?,'IN',?,'2026-10-19'),(?,'OUT',?,'2026-10-19')").run(id,ms,id,ms+3600000);
    at('2026-10-21T10:00'); // Honolulu is still on the Oct 19 attendance day
    const {flagAbsences}=require('../src/autoAbsence');flagAbsences('2026-10-20');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM leaves WHERE user_id=? AND start_date='2026-10-20'").get(id).n,0);
  });
  await t.test('parallel duplicate IN and OUT clicks commit exactly once',async()=>{
    const id=add('parallel');at('2026-10-19T16:00');
    assert.deepEqual((await Promise.all([punch(id,'IN'),punch(id,'IN')])).map(r=>r.status).sort(),[200,409]);
    at('2026-10-20T10:00');assert.deepEqual((await Promise.all([punch(id,'OUT'),punch(id,'OUT')])).map(r=>r.status).sort(),[200,409]);
    assert.equal(events(id).length,2);
  });
  await t.test('stale sessions remain closable without fabricating a new clock-in',async()=>{
    const id=add('stale');at('2026-10-01T16:00');await punch(id,'IN');at('2026-10-20T17:00');
    const s=(await req(id,'attendance/status')).body;assert.equal(s.needsReview,true);assert.ok(s.allowed.includes('OUT'));assert.ok(!s.allowed.includes('IN'));
    assert.equal((await punch(id,'IN')).status,409);
    const missing=(await req(admin,'reports/missing-clockouts?days=30')).body.rows;assert.ok(missing.some(r=>r.user_id===id));
    assert.equal((await punch(id,'OUT')).status,200);
  });
  await t.test('admin config is validated, employee-protected and blocked during an open shift',async()=>{
    const id=add('config');at('2026-10-19T16:00');await punch(id,'IN');
    assert.equal((await req(admin,`users/${id}`,'PUT',{attendance_timezone:'Europe/London'})).status,409);
    at('2026-10-19T17:00');await punch(id,'OUT');
    for(const body of [{attendance_timezone:'Made/Up'},{attendance_cutover:24},{attendance_cutover:'8'},{attendance_cutover:1.5}]) assert.equal((await req(admin,`users/${id}`,'PUT',body)).status,400);
    assert.equal((await req(id,`users/${id}`,'PUT',{attendance_timezone:'Europe/London'})).status,403);
    assert.equal((await req(id,'users/me','PUT',{attendance_timezone:'Europe/London'})).status,200);assert.equal(user(id).attendance_timezone,'');
    assert.equal((await req(admin,`users/${id}`,'PUT',{attendance_timezone:'Europe/London',attendance_cutover:0,shift_start:'09:00'})).status,200);
    assert.equal(daySettings(user(id),'2026-10-19').timezone,'Asia/Kolkata');assert.equal(daySettings(user(id),'2026-10-19').shift_start,'16:00');
    at('2026-10-20T09:00','Europe/London');await punch(id,'IN');at('2026-10-20T10:00','Europe/London');await punch(id,'OUT');
    assert.equal(daySettings(user(id),'2026-10-20').timezone,'Europe/London');
    const r=(await req(admin,`reports/attendance?user_id=${id}&start=2026-10-19&end=2026-10-20`)).body;assert.ok(r.rows.every(r=>r.late===false));
  });
  await t.test('overnight OUT corrections and admin edits preserve the actual calendar date and audited ID',async()=>{
    const id=overnight, ev=events(id)[1];
    const r=await req(id,'punch-requests','POST',{day:ev.day,type:'OUT',time:'09:00',event_date:'2026-10-20',operation:'EDIT',target_event_id:ev.id});assert.equal(r.status,200);
    assert.equal(r.body.request.requested_ts,DateTime.fromISO('2026-10-20T09:00',{zone:'Asia/Kolkata'}).toMillis());
    const approve=await req(admin,`punch-requests/${r.body.request.id}/decide`,'POST',{decision:'APPROVED'});assert.equal(approve.status,200,JSON.stringify(approve.body));
    assert.equal(events(id)[1].id,ev.id);assert.equal(events(id)[1].day,ev.day);
    const edit=await req(admin,`attendance/admin/event/${ev.id}`,'PUT',{time:'09:10',event_date:'2026-10-20'});assert.equal(edit.status,200);
    assert.equal(events(id)[1].ts,DateTime.fromISO('2026-10-20T09:10',{zone:'Asia/Kolkata'}).toMillis());
    const display=(await req(id,`punch-requests/events?day=${ev.day}`)).body;assert.equal(display.events[1].event_date,'2026-10-20');assert.equal(display.timezone,'Asia/Kolkata');
  });
  await t.test('corrections reject nonexistent and ambiguous DST times; live punches retain distinct instants',async()=>{
    const id=add('dst','America/New_York',0,'00:00');
    for(const [day,time] of [['2026-03-08','02:30'],['2026-11-01','01:30']]) {
      const r=await req(id,'punch-requests','POST',{day,type:'IN',time,operation:'ADD',event_date:day});assert.equal(r.status,400);
    }
    at('2026-11-01T01:15-04:00');await punch(id,'IN');at('2026-11-01T01:45-05:00');await punch(id,'OUT');
    assert.equal(events(id)[1].ts-events(id)[0].ts,90*60000);
  });
  await t.test('late-normal override and HALF classification continue applying in configured zones',async()=>{
    const id=add('late','America/Los_Angeles',0,'09:00');at('2026-10-19T10:00','America/Los_Angeles');await punch(id,'IN');at('2026-10-19T18:00','America/Los_Angeles');await punch(id,'OUT');
    const report=()=>req(admin,`reports/attendance?user_id=${id}&start=2026-10-19&end=2026-10-19`);
    assert.equal((await report()).body.rows[0].late,true);
    assert.equal((await req(admin,'attendance/admin/late-normal','POST',{user_id:id,day:'2026-10-19',normal:true})).status,200);
    assert.equal((await report()).body.rows[0].late,false);
    db.prepare("INSERT INTO leaves(user_id,start_date,end_date,kind,reason,status,days,created_ts) VALUES(?,'2026-10-19','2026-10-19','HALF','','APPROVED',0.5,0)").run(id);
    assert.equal((await report()).body.rows[0].status,'HALF');
  });
  await t.test('admin add/edit/delete validates and rolls back overlaps across workdays', async()=>{
    const id=add('admined');
    const create=async(day,time,type,event_date)=>req(admin,'attendance/admin/event','POST',{user_id:id,day,time,type,event_date});
    assert.equal((await create('2026-10-18','16:00','IN')).status,200);
    assert.equal((await create('2026-10-18','17:00','OUT')).status,200);
    assert.equal((await create('2026-10-19','16:00','IN')).status,200);
    assert.equal((await create('2026-10-19','17:00','OUT')).status,200);
    const ev=events(id);
    const edit=await req(admin,`attendance/admin/event/${ev[1].id}`,'PUT',{time:'18:00',event_date:'2026-10-19'});
    assert.equal(edit.status,409);assert.deepEqual(events(id),ev);
    const del=await req(admin,`attendance/admin/event/${ev[3].id}`,'DELETE');assert.equal(del.status,200);assert.equal(del.body.state,'IN');
  });
  await t.test('profile changes snapshot legacy workdays before changing their expected shift', async()=>{
    const id=add('legacy');
    db.prepare("INSERT INTO events(user_id,type,ts,day) VALUES(?,'IN',?,'2026-10-05'),(?,'OUT',?,'2026-10-05')").run(id,DateTime.fromISO('2026-10-05T16:00',{zone:'Asia/Kolkata'}).toMillis(),id,DateTime.fromISO('2026-10-05T17:00',{zone:'Asia/Kolkata'}).toMillis());
    assert.equal((await req(admin,`users/${id}`,'PUT',{attendance_timezone:'Europe/London',attendance_cutover:0,shift_start:'09:00'})).status,200);
    assert.equal(daySettings(user(id),'2026-10-05').timezone,'Asia/Kolkata');assert.equal(daySettings(user(id),'2026-10-05').shift_start,'16:00');
  });
  await t.test('restart never re-buckets overnight UTC punches or rewrites stored workdays',()=>{
    const before=db.prepare('SELECT * FROM events ORDER BY id').all();
    const result=require('node:child_process').spawnSync(process.execPath,['-e',"const {db}=require('./src/db'); console.log(JSON.stringify(db.prepare('SELECT * FROM events ORDER BY id').all())); db.close();"],{cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),before);
  });
});
