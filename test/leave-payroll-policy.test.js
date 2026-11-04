'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('complete leave treatment agrees across payroll, balances, previews and Short Day approvals', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ems-policy-payroll-'));
  process.env.DB_PATH = path.join(dir,'synthetic.db'); process.env.NODE_ENV='test'; process.env.JWT_SECRET='synthetic-policy-payroll'; process.env.TZ_OFFICE='Asia/Kolkata';
  const {Settings} = require('luxon'), originalNow=Settings.now;
  Settings.now=()=>Date.parse('2026-11-02T09:00:00+05:30');
  const {db}=require('../src/db'), auth=require('../src/auth');
  const policy=require('../src/leavePolicy'), {buildSalaries}=require('../src/salaries'), {saveSalary,estimateDeduction}=require('../src/salaryDeduction');
  let seq=0;
  const add=(role='EMPLOYEE')=>Number(db.prepare("INSERT INTO users(name,email,password_hash,role,join_date,created_ts) VALUES(?,?,'synthetic',?,'2026-01-01',0)").run('Policy '+(++seq),`policy${seq}@example.test`,role).lastInsertRowid);
  const admin=add('ADMIN');
  const salary=id=>saveSalary(id,{monthly_gross:'31000',effective_from:'2026-01-01'},admin);
  const leave=(id,date,kind='FULL',status='APPROVED',category='REGULAR',end=date)=>Number(db.prepare("INSERT INTO leaves(user_id,start_date,end_date,kind,status,category,reason,days,created_ts) VALUES(?,?,?,?,?,?,'Synthetic',?,0)").run(id,date,end,kind,status,category,kind==='HALF'?0.5:1).lastInsertRowid);
  const row=(id,month='2026-10')=>buildSalaries(db,month,id).rows[0];
  const express=require('express'), app=express(); app.use(express.json(),require('cookie-parser')(),auth.loadUser);
  app.use('/api/leaves',require('../src/routes/leaves')); app.use('/api/short-days',require('../src/routes/shortDays')); app.use('/api/salaries',require('../src/routes/salaries'));
  const server=app.listen(0,'127.0.0.1'); await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});
  const req=async(id,url,method='GET',body)=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`,{method,headers:{'content-type':'application/json',...(id?{cookie:auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id))}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json()};
  };
  t.after(async()=>{Settings.now=originalNow;await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});

  await t.test('calendar records approved leave and Short Day with admin permissions and existing limits', async () => {
    const id = add();
    salary(id);
    const flagged = leave(id, '2026-10-13', 'FULL', 'PENDING');
    db.prepare('UPDATE leaves SET reason=? WHERE id=?').run('Auto-flagged: no clock-in on 2026-10-13', flagged);
    const halfDay = { user_id: id, start_date: '2026-10-13', kind: 'HALF', replace_auto_absence: true };
    assert.equal((await req(id, 'leaves/admin', 'POST', halfDay)).status, 403);
    const half = await req(admin, 'leaves/admin', 'POST', halfDay);
    assert.equal(half.status, 200);
    assert.equal(half.body.leave.paid_days, 0.5);
    assert.equal(db.prepare('SELECT status FROM leaves WHERE id=?').get(flagged).status, 'CANCELLED');
    assert.equal((await req(admin, 'leaves/admin', 'POST', halfDay)).status, 409);

    const shortDay = { user_id: id, date: '2026-10-14', start_time: '17:00', minutes: 60 };
    assert.equal((await req(id, 'short-days/admin', 'POST', shortDay)).status, 403);
    const short = await req(admin, 'short-days/admin', 'POST', shortDay);
    assert.equal(short.status, 200);
    assert.equal(short.body.request.status, 'APPROVED');
    assert.equal(short.body.request.decided_by, admin);
    assert.ok(short.body.request.decided_ts > short.body.request.start_ts);
    assert.equal((await req(admin, 'short-days/admin', 'POST', shortDay)).status, 409);
    assert.equal((await req(admin, 'short-days/admin', 'POST', { ...shortDay, date: '2026-10-15', minutes: 61 })).status, 409);
    assert.equal((await req(admin, 'short-days/admin', 'POST', { ...shortDay, date: '2026-10-13' })).status, 409);
    assert.equal(row(id).approved_short_day_minutes, 60);
  });

  await t.test('regular cap spans split requests; special categories stay separate; first twelve always unpaid',()=>{
    const id=add();salary(id);
    leave(id,'2026-10-05');leave(id,'2026-10-13');leave(id,'2026-10-14');leave(id,'2026-10-15','HALF');
    leave(id,'2026-10-16','FULL','APPROVED','FLEXI');leave(id,'2026-10-19','FULL','APPROVED','BIRTHDAY');
    const r=row(id); assert.equal(r.paid_leave_days,3.5);assert.equal(r.unpaid_leave_days,2);assert.equal(r.deduction_paise,200000);assert.equal(r.salary_to_pay_paise,2900000);
    const split=r.approved_leaves.find(l=>l.start_date==='2026-10-14'); assert.equal(split.paid_days,0.5);assert.equal(split.unpaid_days,0.5);
    assert.deepEqual(r.deduction_lines[0].reasons,['FIRST_TWELVE','MONTHLY_LIMIT']);
    const b=policy.balances(id,'2026-10-31');assert.equal(b.monthly_regular.used,1.5);assert.equal(b.monthly_regular.available,0);assert.equal(b.buckets.regular.used,1.5);assert.equal(b.buckets.flexi.used,1);assert.equal(b.buckets.special.used,1);
    const special=add();salary(special);leave(special,'2026-11-05','FULL','APPROVED','ANNIVERSARY');
    assert.equal(row(special,'2026-11').unpaid_leave_days,1);assert.equal(policy.balances(special,'2026-11-30').buckets.special.used,0);
  });
  await t.test('three consecutive days use 1.5 paid and 1.5 unpaid; prior unused months add no credit',()=>{
    const id=add();salary(id);leave(id,'2026-11-16','FULL','APPROVED','REGULAR','2026-11-18');
    const r=row(id,'2026-11');assert.equal(r.paid_leave_days,1.5);assert.equal(r.unpaid_leave_days,1.5);assert.equal(r.deduction_paise,155000);
    assert.equal(policy.balances(id,'2026-10-31').monthly_regular.available,1.5);
    assert.equal(policy.balances(id,'2026-12-31').monthly_regular.available,1.5);
  });
  await t.test('weekends, working weekends and both holiday durations affect every calculation consistently',()=>{
    db.prepare("INSERT INTO holidays(date,name,duration,created_ts) VALUES(?,'Synthetic',?,0)").run('2026-10-20','FULL');
    db.prepare("INSERT INTO holidays(date,name,duration,created_ts) VALUES(?,'Synthetic',?,0)").run('2026-10-21','HALF');
    db.prepare("INSERT INTO working_days(date,created_ts) VALUES('2026-10-25',0)").run();
    const id=add();salary(id);leave(id,'2026-10-13');leave(id,'2026-10-14','HALF');
    for(const day of ['2026-10-20','2026-10-21','2026-10-24','2026-10-25'])leave(id,day);
    const r=row(id);assert.equal(r.paid_leave_days,1.5);assert.equal(r.unpaid_leave_days,1.5);assert.equal(r.non_working_leave_days,2.5);assert.equal(r.deduction_paise,150000);
    const quote=estimateDeduction(id,{start_date:'2026-10-21',end_date:'2026-10-21',kind:'HALF',category:'REGULAR'});
    assert.equal(quote.unpaid_days,0.5);assert.equal(quote.total_paise,50000);
    const free=estimateDeduction(id,{start_date:'2026-10-24',end_date:'2026-10-24',kind:'FULL'});assert.equal(free.total_paise,0);
    const descriptions=policy.describeLeaves(db.prepare('SELECT * FROM leaves WHERE user_id=?').all(id));assert.equal(descriptions.reduce((n,l)=>n+l.unpaid_days,0),r.unpaid_leave_days);
  });
  await t.test('pending credit is reserved after approved leave and released on rejection; quote matches resulting payroll',async()=>{
    const id=add();salary(id);leave(id,'2026-11-13');
    const first=leave(id,'2026-11-16','FULL','PENDING');
    let b=policy.balances(id,'2026-11-30');assert.equal(b.monthly_regular.pending,0.5);assert.equal(b.monthly_regular.available,0);
    const draft={start_date:'2026-11-17',end_date:'2026-11-17',kind:'FULL',category:'REGULAR',reason:'Synthetic'};
    let q=estimateDeduction(id,draft);assert.equal(q.unpaid_days,1);
    assert.equal((await req(admin,`leaves/${first}/decide`,'POST',{decision:'REJECTED'})).status,200);
    q=estimateDeduction(id,draft);assert.equal(q.unpaid_days,0.5);assert.equal(q.total_paise,51667);
    leave(id,'2026-11-17');const r=row(id,'2026-11');assert.equal(r.deduction_paise,q.total_paise);assert.equal(r.paid_leave_days,1.5);
  });
  await t.test('cross-month requests each receive their own monthly allowance and actual divisor',()=>{
    const id=add();salary(id);leave(id,'2026-10-29','FULL','APPROVED','REGULAR','2026-11-16');
    const oct=row(id),nov=row(id,'2026-11');assert.equal(oct.paid_leave_days,1.5);assert.equal(oct.unpaid_leave_days,0.5);
    // Nov 2-6 and 9-12 = 9 mandatory unpaid days; Nov 13+16 = 1.5 paid + 0.5 excess.
    assert.equal(nov.paid_leave_days,1.5);assert.equal(nov.unpaid_leave_days,9.5);
    assert.equal(oct.deduction_paise,50000);assert.equal(nov.deduction_paise,981667);
    assert.equal(estimateDeduction(id,{start_date:'2026-10-29',end_date:'2026-11-16',kind:'FULL',category:'REGULAR',id:db.prepare('SELECT id FROM leaves WHERE user_id=?').get(id).id,status:'APPROVED'}).total_paise,1031667);
  });
  await t.test('admin direct-record preview uses approval priority and matches the saved estimate and payroll',async()=>{
    const id=add();salary(id);leave(id,'2026-11-13');leave(id,'2026-11-16','FULL','PENDING');
    const draft={start_date:'2026-11-17',end_date:'2026-11-17',kind:'FULL',category:'REGULAR',reason:'Synthetic'};
    const employeePreview=await req(id,'leaves/preview','POST',draft);
    assert.equal(employeePreview.status,200);assert.equal(employeePreview.body.leave.unpaid_days,1);
    const preview=await req(admin,'leaves/preview','POST',{...draft,user_id:id,status:'PENDING'});
    assert.equal(preview.status,200);assert.equal(preview.body.leave.paid_days,0.5);assert.equal(preview.body.leave.unpaid_days,0.5);
    const saved=await req(admin,'leaves/admin','POST',{...draft,user_id:id});
    assert.equal(saved.status,200);assert.equal(saved.body.leave.deduction_estimate.total_paise,preview.body.leave.deduction_estimate.total_paise);
    assert.equal(row(id,'2026-11').deduction_paise,preview.body.leave.deduction_estimate.total_paise);
  });
  await t.test('calendar changes invalidate salary confirmations and do not rewrite source leaves or saved estimates',()=>{
    const id=add();salary(id);leave(id,'2026-10-06');
    const before=row(id),sources=db.prepare('SELECT * FROM leaves WHERE user_id=?').all(id);
    db.prepare('INSERT INTO salary_month_reviews(user_id,month,amount_paise,note,source_fingerprint,input_snapshot_json,revision,reviewed_by,reviewed_ts) VALUES(?,?,?,?,?,?,?,?,0)').run(id,'2026-10',before.salary_to_pay_paise,'Synthetic review',before.source_fingerprint,'{}',1,admin);
    assert.equal(row(id).status,'REVIEWED');
    db.prepare("INSERT INTO holidays(date,name,duration,created_ts) VALUES('2026-10-06','Synthetic change','FULL',0)").run();
    const after=row(id);assert.equal(after.review.state,'STALE');assert.equal(after.status,'REVIEW');assert.equal(after.deduction_paise,0);assert.equal(after.salary_to_pay_paise,null);
    assert.deepEqual(db.prepare('SELECT * FROM leaves WHERE user_id=?').all(id),sources);
  });
  await t.test('notice requirements and emergency exceptions are enforced by the server',()=>{
    const l=(date,end=date,emergency_type='NONE')=>({start_date:date,end_date:end,kind:'FULL',category:'REGULAR',reason:'Synthetic',emergency_type});
    assert.throws(()=>policy.normalizeLeave(l('2026-11-04')),/three days/);
    assert.doesNotThrow(()=>policy.normalizeLeave(l('2026-11-05')));
    assert.doesNotThrow(()=>policy.normalizeLeave(l('2026-11-02','2026-11-02','OTHER')));
    assert.throws(()=>policy.normalizeLeave(l('2026-11-09','2026-11-11')),/20 days/);
    assert.throws(()=>policy.normalizeLeave(l('2026-11-09','2026-11-11','OTHER')),/20 days/);
    assert.doesNotThrow(()=>policy.normalizeLeave(l('2026-11-09','2026-11-11','HEALTH')));
    assert.doesNotThrow(()=>policy.normalizeLeave(l('2026-11-23','2026-11-25')));
    assert.doesNotThrow(()=>policy.normalizeLeave(l('2026-10-01'),{allowPast:true}));
  });
  await t.test('Short Day requires advance approval, reserves only 120 minutes, and stays separate from paid leave',async()=>{
    const id=add(),other=add();salary(id);
    const draft=(date,minutes,start_time='16:00')=>({date,start_time,minutes,reason:'Synthetic'});
    assert.equal((await req(null,'short-days')).status,401);assert.equal((await req(id,'short-days/pending')).status,403);
    assert.equal((await req(id,'short-days?user_id='+other)).status,403);assert.equal((await req(admin,'short-days','POST',draft('2026-11-03',60))).status,403);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-01',60))).status,400);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-07',60))).status,400);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-03',121))).status,400);
    const first=await req(id,'short-days','POST',draft('2026-11-03',80));assert.equal(first.status,200);
    const second=await req(id,'short-days','POST',draft('2026-11-04',40));assert.equal(second.status,200);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-05',1))).status,409);
    assert.equal((await req(other,`short-days/${first.body.request.id}/cancel`,'POST',{})).status,404);
    const before=row(id,'2026-11');
    assert.equal((await req(admin,`short-days/${first.body.request.id}/decide`,'POST',{decision:'APPROVED'})).status,200);
    assert.equal((await req(admin,`short-days/${first.body.request.id}/decide`,'POST',{decision:'APPROVED'})).status,409);
    assert.equal((await req(id,`short-days/${second.body.request.id}/cancel`,'POST',{})).status,200);
    assert.equal((await req(id,'short-days')).body.available_minutes,40);
    const after=row(id,'2026-11');assert.equal(after.approved_short_day_minutes,80);assert.equal(after.deduction_paise,0);assert.equal(after.salary_to_pay_paise,before.salary_to_pay_paise);
    assert.equal(policy.balances(id,'2026-11-30').balance,20);
    assert.equal((await req(admin,'leaves/admin','POST',{user_id:id,start_date:'2026-11-03',end_date:'2026-11-03',kind:'FULL',category:'REGULAR'})).status,409);
    const expired=await req(id,'short-days','POST',draft('2026-11-05',40));assert.equal(expired.status,200);
    Settings.now=()=>Date.parse('2026-11-05T16:01:00+05:30');
    assert.equal((await req(admin,`short-days/${expired.body.request.id}/decide`,'POST',{decision:'APPROVED'})).status,409);
    assert.equal((await req(admin,`short-days/${expired.body.request.id}/decide`,'POST',{decision:'REJECTED'})).status,200);
    Settings.now=()=>Date.parse('2026-11-02T09:00:00+05:30');
    const otherRequests=await req(other,'short-days');assert.equal(otherRequests.body.requests.length,0);
    const races=await Promise.all([req(other,'short-days','POST',draft('2026-11-03',80)),req(other,'short-days','POST',draft('2026-11-04',80))]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  });
});
