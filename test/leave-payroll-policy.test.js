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
  app.use('/api/reports',require('../src/routes/reports')); app.use('/api/attendance',require('../src/routes/attendance'));
  const server=app.listen(0,'127.0.0.1'); await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});
  const req=async(id,url,method='GET',body)=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`,{method,headers:{'content-type':'application/json',...(id?{cookie:auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id))}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json()};
  };
  t.after(async()=>{Settings.now=originalNow;await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});

  await t.test('calendar gives staff and admins the payroll breakdown for each approved leave date', async () => {
    const id = add(), other = add();
    leave(id, '2026-10-09', 'FULL', 'APPROVED', 'REGULAR', '2026-10-10');
    leave(id, '2026-10-13', 'FULL', 'APPROVED', 'REGULAR', '2026-10-15');
    leave(id, '2026-10-16', 'HALF', 'PENDING');
    const range = 'start=2026-10-09&end=2026-10-16';
    const own = await req(id, 'reports/my-attendance?' + range);
    const staffReport = await req(admin, 'reports/attendance?user_id=' + id + '&' + range);
    assert.equal(own.status, 200);
    assert.equal(staffReport.status, 200);
    const expected = [
      ['2026-10-09', 0, 1, 0],
      ['2026-10-10', 0, 0, 1],
      ['2026-10-13', 1, 0, 0],
      ['2026-10-14', 0.5, 0.5, 0],
      ['2026-10-15', 0, 1, 0],
    ];
    for (const report of [own, staffReport]) {
      assert.deepEqual(report.body.rows.filter(r => r.leavePay).map(({ day, leavePay }) =>
        [day, leavePay.paid_days, leavePay.unpaid_days, leavePay.non_working_days]), expected);
    }
    assert.equal((await req(other, 'reports/attendance?user_id=' + id + '&' + range)).status, 403);
    assert.equal(own.body.rows.find(r => r.day === '2026-10-13').approvedLeave, undefined);
  });

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
    assert.equal((await req(admin, 'short-days/admin', 'POST', { ...shortDay, start_time: '19:00', minutes: 61 })).status, 409);
    assert.equal((await req(admin, 'short-days/admin', 'POST', { ...shortDay, date: '2026-10-13' })).status, 409);
    assert.equal(row(id).approved_short_day_minutes, 60);
  });

  await t.test('admin can mark a date as Short Day without saving a time or changing punches', async () => {
    const id = add();
    salary(id);
    const day = '2026-10-06';
    const mark = (date, actor = admin) => req(actor, 'short-days/admin', 'POST', { user_id: id, date });
    assert.equal((await mark(day,id)).status, 403);
    assert.equal((await req(id, 'short-days', 'POST', { date: day })).status, 400);
    assert.equal((await mark('2026-10-04')).status, 400); // Sunday.
    assert.equal((await mark('2026-10-05')).status, 200);
    const [first, second] = await Promise.all([mark(day), mark(day)]);
    for (const result of [first, second]) {
      assert.equal(result.status, 200);
      assert.equal(result.body.request.status, 'APPROVED');
      assert.equal(result.body.request.decided_by, admin);
      for (const field of ['start_time', 'start_ts', 'minutes']) assert.equal(result.body.request[field], null);
    }
    assert.equal(first.body.request.id, second.body.request.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events WHERE user_id=?').get(id).count, 0);
    const calendar = await req(id, 'reports/my-attendance?start=2026-10-06&end=2026-10-06');
    assert.equal(calendar.body.rows[0].approvedShortDay, true);
    assert.equal(calendar.body.rows[0].approvedShortMinutes, 0);
    assert.equal(row(id).approved_short_day_count, 2);
    assert.equal(row(id).approved_short_day_minutes, 0);
    assert.equal(row(id).short_day_unpaid_days, 0.25);
    assert.equal(row(id).deduction_paise, 25000);
    assert.equal((await req(admin, 'short-days/admin', 'POST', { user_id:id, date:day, start_time:'17:00', minutes:30 })).status, 409);
    assert.equal((await req(id, 'short-days', 'POST', { date:'2026-11-03', start_time:'17:00', minutes:30 })).status, 200);
    assert.equal((await mark('2026-11-03')).status, 409);
  });

  await t.test('adjusting one date splits approved leave and recalculates payroll without duplicating it', async () => {
    const id = add();
    salary(id);
    const original = leave(id, '2026-10-12', 'FULL', 'APPROVED', 'REGULAR', '2026-10-15');
    const adjust = actor => req(actor, `leaves/${original}/half-day`, 'POST', { day: '2026-10-15' });
    assert.equal(row(id).unpaid_leave_days, 2.5);
    assert.equal((await adjust(id)).status, 403);
    assert.equal((await req(admin, `leaves/${original}/half-day`, 'POST', { day: '2026-10-16' })).status, 409);

    const outcomes = await Promise.all([adjust(admin), adjust(admin)]);
    assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
    const saved = outcomes.find(result => result.status === 200).body.leaves;
    assert.deepEqual(saved.map(l => [l.start_date, l.end_date, l.kind, l.days]), [
      ['2026-10-12', '2026-10-14', 'FULL', 3],
      ['2026-10-15', '2026-10-15', 'HALF', 0.5],
    ]);
    assert.equal(db.prepare('SELECT status FROM leaves WHERE id=?').get(original).status, 'CANCELLED');
    assert.equal(row(id).paid_leave_days, 1.5);
    assert.equal(row(id).unpaid_leave_days, 2);
    assert.equal(row(id).deduction_paise, 200000);

    const middle = leave(id, '2026-11-16', 'FULL', 'APPROVED', 'REGULAR', '2026-11-18');
    const split = await req(admin, `leaves/${middle}/half-day`, 'POST', { day: '2026-11-17' });
    assert.equal(split.status, 200);
    assert.deepEqual(split.body.leaves.map(l => [l.start_date, l.end_date, l.kind]), [
      ['2026-11-16', '2026-11-16', 'FULL'],
      ['2026-11-17', '2026-11-17', 'HALF'],
      ['2026-11-18', '2026-11-18', 'FULL'],
    ]);
  });

  await t.test('additional approved Short Days use quarter-day leave, including split paid and unpaid time', async () => {
    const id = add();
    salary(id);
    const draft = (date, start_time = '16:00') => ({ user_id: id, date, start_time, minutes: 60 });
    const record = async (date, time) => {
      assert.equal((await req(admin, 'short-days/admin', 'POST', draft(date, time))).status, 200);
    };
    await record('2026-10-05');
    await record('2026-10-06'); // First-twelve charge is unpaid.
    await record('2026-10-06', '18:00'); // Second time slot is the same Short Day.
    await record('2026-10-13'); // 0.25 paid.
    leave(id, '2026-10-14'); // 1.0 paid.
    const draftHalf = { user_id: id, start_date: '2026-10-15', kind: 'HALF' };
    const preview = await req(admin, 'leaves/preview', 'POST', draftHalf);
    assert.equal(preview.body.leave.paid_days, 0.25);
    assert.equal(preview.body.leave.unpaid_days, 0.25);
    assert.equal(preview.body.leave.deduction_estimate.total_paise, 25000);
    assert.equal((await req(admin, 'leaves/admin', 'POST', draftHalf)).status, 200);
    await record('2026-10-16'); // No paid credit remains.
    assert.equal((await req(id, 'short-days', 'POST', draft('2026-11-03'))).status, 200);
    const report = row(id);
    assert.equal(report.approved_short_day_count, 4);
    assert.equal(report.short_day_paid_days, 0.25);
    assert.equal(report.short_day_unpaid_days, 0.5);
    assert.equal(report.paid_leave_days, 1.5);
    assert.equal(report.unpaid_leave_days, 0.75);
    assert.equal(report.deduction_paise, 75000);
    assert.deepEqual(policy.balances(id, '2026-10-31').short_day, { paid_days: 0.25, unpaid_days: 0.5 });
    assert.equal(row(id, '2026-11').deduction_paise, 0);
  });

  await t.test('late explanation approval and full-day marking record decisions without changing punches', async () => {
    const id = add(), other = add();
    const punch = db.prepare('INSERT INTO events(user_id,type,ts,day) VALUES(?,?,?,?)');
    db.prepare("UPDATE users SET shift_start='16:00' WHERE id=?").run(id);
    for (const day of ['2026-10-06', '2026-10-07']) {
      punch.run(id, 'IN', Date.parse(day+'T16:19:00+05:30'), day);
      punch.run(id, 'OUT', Date.parse(day+'T20:19:00+05:30'), day);
    }
    const reportUrl = 'reports/my-attendance?start=2026-10-06&end=2026-10-07';
    const before = (await req(id, reportUrl)).body.rows;
    assert.equal(before[0].late, true);
    const explanation = { day: '2026-10-06', reason: 'Train delayed', user_id: other };
    assert.equal((await req(other, 'reports/late-explanations', 'POST', explanation)).status, 409);
    assert.equal((await req(id, 'reports/late-explanations', 'POST', explanation)).status, 201);
    assert.equal((await req(id, 'reports/late-explanations', 'POST', explanation)).status, 409);
    assert.equal((await req(other, 'reports/late-explanations/pending')).status, 403);
    const pending = (await req(admin, 'reports/late-explanations/pending')).body.requests;
    const request = pending.find(r => r.user_id === id);
    assert.ok(request);
    const approve = 'reports/late-explanations/'+request.id+'/approve';
    assert.equal((await req(id, approve, 'POST', {})).status, 403);
    assert.equal((await req(admin, approve, 'POST', {})).status, 200);
    assert.equal((await req(admin, approve, 'POST', {})).status, 409);
    assert.equal((await req(id, 'reports/late-explanations', 'POST', { day:'2026-10-07', reason:'Traffic' })).status, 201);
    assert.equal((await req(admin, 'attendance/admin/full-day', 'POST', { day:'2026-10-07', user_id:id })).status, 200);
    const after = (await req(id, reportUrl)).body.rows;
    assert.equal(after[0].lateExplanation.status, 'APPROVED');
    assert.equal(after[0].late, false);
    assert.equal(after[0].short, true);
    assert.equal(after[1].fullDayOverride, true);
    assert.equal(after[1].short, false);
    assert.equal(after[1].lateExplanation.resolution, 'FULL_DAY');
    assert.deepEqual(after.map(r => r.workedMinutes), before.map(r => r.workedMinutes));
    assert.equal((await req(other, reportUrl + '&user_id=' + id)).body.rows[0].lateExplanation, null);
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
  await t.test('Short Day requires advance approval and enforces 120 minutes per date',async()=>{
    const id=add(),other=add();salary(id);
    const draft=(date,minutes,start_time='16:00')=>({date,start_time,minutes,reason:'Synthetic'});
    assert.equal((await req(null,'short-days')).status,401);assert.equal((await req(id,'short-days/pending')).status,403);
    assert.equal((await req(id,'short-days?user_id='+other)).status,403);assert.equal((await req(admin,'short-days','POST',draft('2026-11-03',60))).status,403);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-01',60))).status,400);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-07',60))).status,400);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-03',121))).status,400);
    const first=await req(id,'short-days','POST',draft('2026-11-03',80));assert.equal(first.status,200);
    const second=await req(id,'short-days','POST',draft('2026-11-04',40));assert.equal(second.status,200);
    assert.equal((await req(id,'short-days','POST',draft('2026-11-03',41,'18:00'))).status,409);
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
    const races=await Promise.all([req(other,'short-days','POST',draft('2026-11-03',80)),req(other,'short-days','POST',draft('2026-11-03',80,'18:00'))]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  });
});
