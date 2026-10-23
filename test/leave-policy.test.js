'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('October leave year, category credits and unpaid dates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-leave-policy-'));
  process.env.DB_PATH = path.join(dir, 'synthetic.db');
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'synthetic-leave-secret'; process.env.TZ_OFFICE = 'Asia/Kolkata';
  const { Settings } = require('luxon');
  const originalNow = Settings.now;
  Settings.now = () => Date.parse('2026-10-21T10:00:00+05:30');
  const { db } = require('../src/db');
  const auth = require('../src/auth');
  const policy = require('../src/leavePolicy');
  let seq = 0;
  const employee = (role = 'EMPLOYEE', balance = 7) => db.prepare("INSERT INTO users(name,email,password_hash,role,leave_balance,created_ts,join_date) VALUES(?,?,?,?,?,0,'2026-01-01')").run('Synthetic '+(++seq),`leave${seq}@example.test`,auth.hashPassword('synthetic123'),role,balance).lastInsertRowid;
  const getUser = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const cookie = id => `${auth.COOKIE}=${auth.issueToken(getUser(id))}`;
  const admin = employee('ADMIN');
  const express = require('express'), app = express();
  app.use(express.json(), require('cookie-parser')(), auth.loadUser);
  app.use('/api/leaves', require('../src/routes/leaves'));
  app.use('/api/users', require('../src/routes/directory'));
  app.use('/api/auth', require('../src/routes/auth'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve,reject) => { server.once('listening',resolve); server.once('error',reject); });
  t.after(async () => { Settings.now=originalNow; await new Promise(resolve=>server.close(resolve)); db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const request = async (id, url, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, { method, headers:{cookie:cookie(id),'content-type':'application/json'}, ...(body ? { body:JSON.stringify(body) } : {}) });
    return { status:res.status, body:await res.json() };
  };
  const body = (start, category='REGULAR', extra={}) => ({start_date:start,end_date:start,kind:'FULL',category,reason:'Synthetic leave',...extra});
  const rawLeave = (id,start,end,status='APPROVED',category='REGULAR',kind='FULL') => db.prepare('INSERT INTO leaves(user_id,start_date,end_date,kind,category,reason,status,days,created_ts) VALUES(?,?,?,?,?,?,?,?,0)').run(id,start,end,kind,category,'Existing source record',status,kind==='HALF'?0.5:require('../src/time').inclusiveDays(start,end)).lastInsertRowid;

  await t.test('reset retains audit and source history, deducts only approved paid days since October',async()=>{
    const id=employee('EMPLOYEE',3.5);
    rawLeave(id,'2026-09-18','2026-09-19'); rawLeave(id,'2026-10-05','2026-10-05'); rawLeave(id,'2026-10-15','2026-10-15'); rawLeave(id,'2026-10-22','2026-10-22','PENDING');
    const before=db.prepare('SELECT * FROM leaves WHERE user_id=?').all(id);
    let r=await request(id,'leaves/mine'); assert.equal(r.status,200); assert.equal(r.body.balance,19);
    assert.equal(r.body.balances.buckets.regular.remaining,17); assert.equal(r.body.balances.buckets.regular.pending,1); assert.equal(r.body.balances.buckets.regular.available,16);
    assert.equal(r.body.balances.buckets.flexi.remaining,1); assert.equal(r.body.balances.buckets.special.remaining,1);
    assert.equal(r.body.leaves.find(l=>l.start_date==='2026-10-05').pay_status,'UNPAID');
    await request(id,'leaves/mine');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM leave_balance_resets WHERE user_id=?').get(id).n,1);
    assert.equal(db.prepare('SELECT previous_balance FROM leave_balance_resets WHERE user_id=?').get(id).previous_balance,3.5);
    assert.deepEqual(db.prepare('SELECT * FROM leaves WHERE user_id=?').all(id),before);
    assert.equal(getUser(id).leave_balance,19);
  });
  await t.test('October reset is automatic and idempotent; January does not reset',()=>{
    const id=employee();rawLeave(id,'2026-10-20','2026-10-20');policy.syncBalance(id);
    Settings.now=()=>Date.parse('2027-01-01T00:01:00+05:30');assert.equal(policy.syncBalance(id).balance,19);assert.equal(policy.periodFor().start,'2026-10-01');
    Settings.now=()=>Date.parse('2027-10-01T00:01:00+05:30');assert.equal(policy.syncBalance(id).balance,20);assert.equal(policy.syncBalance(id).balance,20);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM leave_balance_resets WHERE user_id=?').get(id).n,2);
    Settings.now=()=>Date.parse('2026-10-21T10:00:00+05:30');
  });
  await t.test('1st and 12th are unpaid, 13th paid; mixed ranges and half days split exactly',()=>{
    for(const date of ['2026-11-01','2026-11-12']) assert.equal(policy.describeLeave(body(date)).unpaid_days,1);
    assert.equal(policy.describeLeave(body('2026-11-13')).paid_days,1);
    const mixed=policy.describeLeave(body('2026-11-11','REGULAR',{end_date:'2026-11-14'}));assert.equal(mixed.paid_days,2);assert.equal(mixed.unpaid_days,2);assert.equal(mixed.pay_status,'MIXED');
    const half=policy.normalizeLeave(body('2026-11-12','REGULAR',{kind:'HALF',end_date:'2026-11-20'}));assert.equal(half.end_date,'2026-11-12');assert.equal(policy.describeLeave(half).unpaid_days,0.5);
    const crossing=policy.describeLeave(body('2027-09-30','REGULAR',{end_date:'2027-10-13'}));assert.deepEqual(crossing.charges,[{period:'2026-10-01',bucket:'regular',days:1},{period:'2027-10-01',bucket:'regular',days:1}]);assert.equal(crossing.unpaid_days,12);
    assert.equal(policy.describeLeave(body('2026-09-01')).unpaid_days,0);
  });
  await t.test('regular requests reserve credit; cancellation/rejection releases it',async()=>{
    const id=employee();let r=await request(id,'leaves','POST',body('2026-10-23'));assert.equal(r.status,200);const rid=r.body.leave.id;
    assert.equal(r.body.balances.balance,20);assert.equal(r.body.balances.available,19);
    assert.equal((await request(id,'leaves','POST',body('2026-10-23'))).status,409);
    r=await request(id,`leaves/${rid}/cancel`,'POST',{});assert.equal(r.status,200);assert.equal(r.body.balances.available,20);
    r=await request(id,'leaves','POST',body('2026-10-24'));const rejected=r.body.leave.id;
    assert.equal((await request(admin,`leaves/${rejected}/decide`,'POST',{decision:'REJECTED'})).status,200);
    assert.equal((await request(id,'leaves/mine')).body.balances.available,20);
  });
  await t.test('approval deducts once; duplicate/concurrent decisions have one notification',async()=>{
    const id=employee();const r=await request(id,'leaves','POST',body('2026-10-25'));const rid=r.body.leave.id;
    const results=await Promise.all([request(admin,`leaves/${rid}/decide`,'POST',{decision:'APPROVED'}),request(admin,`leaves/${rid}/decide`,'POST',{decision:'APPROVED'})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(policy.syncBalance(id).balance,19);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND title='Leave approved'").get(id).n,1);
  });
  await t.test('birthday and anniversary share one credit, including pending and half days',async()=>{
    const id=employee();let r=await request(id,'leaves','POST',body('2026-10-26','BIRTHDAY'));assert.equal(r.status,200);
    assert.equal((await request(id,'leaves','POST',body('2026-10-27','ANNIVERSARY'))).status,409);
    await request(admin,`leaves/${r.body.leave.id}/decide`,'POST',{decision:'APPROVED'});
    assert.equal(policy.syncBalance(id).buckets.special.remaining,0);
    // An unpaid special occasion does not spend the paid entitlement twice.
    assert.equal((await request(id,'leaves','POST',body('2026-11-05','ANNIVERSARY'))).status,200);
    const halfId=employee();r=await request(halfId,'leaves','POST',body('2026-10-26','BIRTHDAY',{kind:'HALF'}));assert.equal(r.status,200);
    r=await request(halfId,'leaves','POST',body('2026-10-27','ANNIVERSARY',{kind:'HALF'}));assert.equal(r.status,200);assert.equal(r.body.balances.buckets.special.available,0);
  });
  await t.test('Flexi has its own credit, needs no reason, and starts strictly after the 15th',async()=>{
    const id=employee();assert.equal((await request(id,'leaves','POST',body('2026-11-15','FLEXI',{reason:''}))).status,400);
    let r=await request(id,'leaves','POST',body('2026-11-16','FLEXI',{reason:''}));assert.equal(r.status,200);assert.equal(r.body.leave.reason,'');
    assert.equal((await request(id,'leaves','POST',body('2026-11-17','FLEXI',{reason:''}))).status,409);
    assert.equal((await request(admin,'leaves/admin','POST',body('2026-11-15','FLEXI',{user_id:id}))).status,400);
  });
  await t.test('unpaid leave works with zero balance and ignores client payment/day claims',async()=>{
    const id=employee();rawLeave(id,'2026-10-13','2026-10-30');rawLeave(id,'2026-11-16','2026-11-16','APPROVED','FLEXI');rawLeave(id,'2026-11-17','2026-11-17','APPROVED','BIRTHDAY');assert.equal(policy.syncBalance(id).balance,0);
    let r=await request(id,'leaves','POST',body('2026-12-12','REGULAR',{paid_days:1,unpaid_days:0,days:99,pay_status:'PAID'}));assert.equal(r.status,200);assert.equal(r.body.leave.days,1);assert.equal(r.body.leave.paid_days,0);assert.equal(r.body.leave.unpaid_days,1);
    r=await request(admin,`leaves/${r.body.leave.id}/decide`,'POST',{decision:'APPROVED'});assert.equal(r.status,200);assert.equal(r.body.balances.balance,0);
    assert.equal((await request(id,'leaves','POST',body('2026-12-13'))).status,409);
  });
  await t.test('admin recording, auto-flagged legacy requests and profile totals use the same rules',async()=>{
    const id=employee();let r=await request(admin,'leaves/admin','POST',body('2026-10-08','REGULAR',{user_id:id}));assert.equal(r.status,200);assert.equal(r.body.balances.balance,20);
    r=await request(admin,'leaves/admin','POST',body('2026-10-19','REGULAR',{user_id:id}));assert.equal(r.status,200);assert.equal(r.body.balances.balance,19);
    const rid=rawLeave(id,'2026-10-09','2026-10-09','PENDING');r=await request(admin,`leaves/${rid}/decide`,'POST',{decision:'APPROVED'});assert.equal(r.status,200);assert.equal(r.body.balances.balance,19);
    r=await request(admin,`users/${id}`,'PUT',{leave_balance:999,phone:'123'});assert.equal(r.status,200);assert.equal(r.body.user.leave_balance,19);
    assert.equal((await request(id,'auth/me')).body.user.leave_balance,19);
    const summary=(await request(admin,'leaves/summary')).body.rows.find(u=>u.id===id);assert.equal(summary.balance,19);assert.equal(summary.balances.buckets.regular.remaining,17);
  });
  await t.test('validation and access controls hold for direct API callers',async()=>{
    const id=employee(),other=employee();
    for(const patch of [{category:'INVALID'},{kind:'INVALID'},{start_date:'2026-02-30'},{start_date:'2026-10-20'},{reason:''},{end_date:'2029-10-21'}]) assert.equal((await request(id,'leaves','POST',body('2026-10-28','REGULAR',patch))).status,400);
    assert.equal((await request(id,'leaves/summary')).status,403);assert.equal((await request(id,'leaves/admin','POST',body('2026-10-28','REGULAR',{user_id:other}))).status,403);
    assert.equal((await request(id,'leaves/preview','POST',body('2026-10-28','REGULAR',{user_id:other}))).status,403);
    const r=await request(id,'leaves','POST',body('2026-10-28','REGULAR',{user_id:other}));assert.equal(r.body.leave.user_id,id);
    assert.equal((await request(other,`leaves/${r.body.leave.id}/cancel`,'POST',{})).status,404);
  });
  await t.test('future leave year uses its own pool without consuming the current year',async()=>{
    const id=employee();let r=await request(id,'leaves','POST',body('2027-10-16','FLEXI'));assert.equal(r.status,200);assert.equal(r.body.balances.available,20);
    assert.equal((await request(id,'leaves','POST',body('2027-10-17','FLEXI'))).status,409);
  });
  await t.test('admins have no personal leave; employee management and existing records remain',async()=>{
    const otherAdmin=employee('ADMIN'),id=employee();
    rawLeave(otherAdmin,'2026-10-16','2026-10-16');
    const before=db.prepare('SELECT * FROM leaves ORDER BY id').all();
    for(const owner of [admin,otherAdmin]){
      assert.equal((await request(owner,'leaves/mine')).status,403);
      assert.equal((await request(owner,'leaves','POST',body('2026-11-05'))).status,403);
      assert.equal((await request(owner,'leaves/preview','POST',body('2026-11-05'))).status,403);
      assert.equal((await request(admin,'leaves/preview','POST',body('2026-11-05','REGULAR',{user_id:owner}))).status,403);
      assert.equal((await request(admin,'leaves/admin','POST',body('2026-11-05','REGULAR',{user_id:owner}))).status,403);
    }
    assert.deepEqual(db.prepare('SELECT * FROM leaves ORDER BY id').all(),before);
    const summary=await request(admin,'leaves/summary');assert.equal(summary.status,200);
    assert.ok(summary.body.rows.some(u=>u.id===id));assert.ok(!summary.body.rows.some(u=>[admin,otherAdmin].includes(u.id)));
    const preview=await request(admin,'leaves/preview','POST',body('2026-11-05','REGULAR',{user_id:id}));assert.equal(preview.status,200);assert.equal(preview.body.leave.unpaid_days,1);
    assert.equal((await request(admin,'leaves/admin','POST',body('2026-11-05','REGULAR',{user_id:id}))).status,200);
    assert.equal((await request(id,'leaves/mine')).body.leaves.length,1);
    assert.equal((await request(admin,`leaves/for/${otherAdmin}`)).body.leaves.length,1);
  });
  await t.test('restart and additive migration preserve original leave records and reset markers',()=>{
    const id=employee();rawLeave(id,'2026-10-13','2026-10-13');policy.syncBalance(id);
    const source=db.prepare('SELECT * FROM leaves WHERE user_id=?').all(id);const count=db.prepare('SELECT COUNT(*) n FROM leave_balance_resets').get().n;
    const result=require('node:child_process').spawnSync(process.execPath,['-e',"const {db}=require('./src/db'); console.log(JSON.stringify({leaves:db.prepare('SELECT * FROM leaves WHERE user_id=?').all(Number(process.argv[1])),resets:db.prepare('SELECT COUNT(*) n FROM leave_balance_resets').get().n}));db.close();",String(id)],{cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const reopened=JSON.parse(result.stdout);assert.deepEqual(reopened.leaves,source);assert.equal(reopened.resets,count);
  });
  await t.test('a pre-category database upgrades without rewriting leave history',()=>{
    const legacyPath=path.join(dir,'legacy.db');
    const Database=require('better-sqlite3'), legacy=new Database(legacyPath);
    // Frozen pre-category tables: independent of the checkout's current HEAD.
    legacy.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      emp_code TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'EMPLOYEE',
      department TEXT DEFAULT '', title TEXT DEFAULT '', phone TEXT DEFAULT '',
      leave_balance REAL NOT NULL DEFAULT 18, active INTEGER NOT NULL DEFAULT 1,
      created_ts INTEGER NOT NULL
    ); CREATE TABLE leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'FULL',
      reason TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', days REAL NOT NULL DEFAULT 1,
      decided_by INTEGER, decided_ts INTEGER, admin_note TEXT DEFAULT '', created_ts INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    INSERT INTO users(name,email,password_hash,leave_balance,created_ts) VALUES('Legacy','legacy@example.test','x',4.5,0);
    INSERT INTO leaves(user_id,start_date,end_date,kind,reason,status,days,created_ts) VALUES(1,'2026-10-15','2026-10-15','FULL','Original reason','APPROVED',1,0);`);
    assert.equal(legacy.pragma('table_info(leaves)').some(c=>c.name==='category'),false);
    legacy.close();
    const child=require('node:child_process').spawnSync(process.execPath,['-e',"const {db}=require('./src/db');console.log(JSON.stringify({user:db.prepare('SELECT leave_balance FROM users WHERE id=1').get(),leave:db.prepare('SELECT * FROM leaves WHERE id=1').get(),resets:db.prepare('SELECT COUNT(*) n FROM leave_balance_resets').get().n}));db.close();"],{cwd:path.join(__dirname,'..'),env:{...process.env,DB_PATH:legacyPath},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
    assert.equal(result.user.leave_balance,4.5);assert.equal(result.leave.reason,'Original reason');assert.equal(result.leave.status,'APPROVED');assert.equal(result.leave.category,'REGULAR');assert.equal(result.resets,0);
  });
});
