'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

test('salary review confirmations are scoped, audited and reopened when inputs change', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ems-salary-review-'));
  process.env.DB_PATH=path.join(dir,'synthetic.db'); process.env.NODE_ENV='test'; process.env.JWT_SECRET='synthetic-review-only'; process.env.TZ_OFFICE='Asia/Kolkata';
  const {Settings}=require('luxon'), originalNow=Settings.now; Settings.now=()=>Date.parse('2026-10-24T10:00:00+05:30');
  const {db}=require('../src/db'), auth=require('../src/auth'), {buildSalaries}=require('../src/salaries'), {saveSalary}=require('../src/salaryDeduction');
  let seq=0;
  const add=(extra={})=>Number(db.prepare("INSERT INTO users(name,email,password_hash,role,join_date,created_ts) VALUES(@name,@email,'x',@role,@join_date,0)").run({name:'Review '+(++seq),email:`review${seq}@example.test`,role:'EMPLOYEE',join_date:'2026-10-05',...extra}).lastInsertRowid);
  const admin=add({role:'ADMIN'}), admin2=add({role:'ADMIN'}), employee=add();
  const rate=(id,amount='30000',effective='2026-01-01')=>saveSalary(id,{monthly_gross:amount,effective_from:effective},admin);
  const row=(id,month='2026-10')=>buildSalaries(db,month).rows.find(row=>row.id===id);
  const payload=(id,amount='25000.25',note='Confirmed after part-month review')=>{const r=row(id);return {month:'2026-10',amount,note,source_fingerprint:r.source_fingerprint,expected_revision:r.review?.revision || 0};};
  const express=require('express'), app=express();app.use(express.json(),require('cookie-parser')(),auth.loadUser);app.use('/api/salaries',require('../src/routes/salaries'));
  const server=app.listen(0,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});
  t.after(async()=>{Settings.now=originalNow;await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(actor,id,body,reopen=false)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/salaries/${id}/review${reopen?'/reopen':''}`,{method:'POST',headers:{'content-type':'application/json',...(actor?{cookie:auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(actor))}:{})},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const events=id=>db.prepare('SELECT * FROM salary_month_review_events WHERE user_id=? ORDER BY id').all(id);

  await t.test('admins can confirm a final monthly amount without changing the underlying salary or leave',async()=>{
    rate(employee); db.prepare("INSERT INTO leaves(user_id,start_date,end_date,kind,reason,status,days,created_ts) VALUES(?,'2026-10-06','2026-10-06','HALF','Synthetic','APPROVED',0.5,0)").run(employee);
    const before={users:db.prepare('SELECT * FROM users').all(),rates:db.prepare('SELECT * FROM employee_salary_rates').all(),leaves:db.prepare('SELECT * FROM leaves').all()};
    const original=row(employee),base=buildSalaries(db,'2026-10').totals.salary_to_pay_paise;
    assert.equal(original.deduction_paise,50000);assert.equal((await request(admin,employee,payload(employee,'26500.42'))).status,200);
    const r=row(employee);assert.equal(r.status,'REVIEWED');assert.equal(r.salary_to_pay_paise,2650042);assert.equal(r.deduction_paise,50000);assert.equal(r.review.reviewer_name,'Review 1');assert.equal(r.review.revision,1);
    const totals=buildSalaries(db,'2026-10').totals;assert.equal(totals.salary_to_pay_paise,base+2650042);assert.equal(totals.reviewed,1);assert.equal(totals.included,totals.calculated+totals.reviewed);
    assert.equal(row(employee,'2026-11').status,'CALCULATED');assert.equal(row(employee,'2026-11').salary_to_pay_paise,3000000);
    assert.deepEqual({users:db.prepare('SELECT * FROM users').all(),rates:db.prepare('SELECT * FROM employee_salary_rates').all(),leaves:db.prepare('SELECT * FROM leaves').all()},before);
    assert.equal(events(employee).length,1);assert.equal(JSON.parse(events(employee)[0].after_json).amount_paise,2650042);assert.equal(events(employee)[0].changed_by,admin);
  });
  await t.test('missing source salary can be reviewed for one month, with an explicit zero also allowed',async()=>{
    const id=add();assert.equal(row(id).monthly_gross_paise,null);assert.equal((await request(admin,id,payload(id,'0','Confirmed no salary payable for this month'))).status,200);
    assert.equal(row(id).salary_to_pay_paise,0);assert.equal(row(id).status,'REVIEWED');assert.equal(db.prepare('SELECT COUNT(*) n FROM employee_salary_rates WHERE user_id=?').get(id).n,0);assert.equal(row(id,'2026-11').status,'REVIEW');
  });
  await t.test('amount, note, month, revision, target and access are validated before writes',async()=>{
    const id=add(),base=payload(id),before=events(id).length;
    for(const amount of ['',null,-1,'1.001','Infinity','1e3','100000000',{},true])assert.equal((await request(admin,id,{...base,amount})).status,400,String(amount));
    for(const patch of [{note:''},{note:' '.repeat(5)},{note:'x'.repeat(1001)},{month:'2026-13'},{month:undefined},{expected_revision:undefined},{expected_revision:-1}])assert.equal((await request(admin,id,{...base,...patch})).status,400);
    assert.equal((await request(null,id,base)).status,401);assert.equal((await request(id,id,base)).status,403);assert.equal((await request(id,id,base,true)).status,403);
    assert.equal((await request(admin,'bad',base)).status,400);assert.equal((await request(admin,99999,base)).status,404);assert.equal((await request(admin,admin,base)).status,404);
    assert.equal((await request(admin,id,{...base,source_fingerprint:'forged'})).status,409);assert.equal(events(id).length,before);
    const calculated=add({join_date:'2026-01-01'});rate(calculated);assert.equal((await request(admin,calculated,payload(calculated))).status,409);
  });
  await t.test('retries are idempotent, concurrent edits are rejected and changes preserve before/after audit',async()=>{
    const id=add();rate(id);const first=payload(id);
    const both=await Promise.all([request(admin,id,first),request(admin,id,first)]);assert.deepEqual(both.map(r=>r.status),[200,200]);assert.equal(events(id).length,1);
    const next=payload(id,'24000','Revised part-month calculation');
    const conflict=await Promise.all([request(admin,id,next),request(admin2,id,{...next,amount:'23000',note:'Different calculation'})]);assert.deepEqual(conflict.map(r=>r.status).sort(),[200,409]);assert.equal(events(id).length,2);
    assert.equal(row(id).review.revision,2);assert.equal(JSON.parse(events(id)[1].before_json).amount_paise,2500025);
  });
  await t.test('reopen excludes the confirmation and reconfirmation creates another audit event',async()=>{
    const id=add();rate(id);await request(admin,id,payload(id));
    assert.equal((await request(admin2,id,{month:'2026-10',expected_revision:1},true)).status,200);
    let r=row(id);assert.equal(r.status,'REVIEW');assert.equal(r.salary_to_pay_paise,null);assert.equal(r.review.state,'REOPENED');assert.equal(r.review.revision,2);
    assert.equal((await request(admin,id,{...payload(id),expected_revision:1})).status,409);
    await request(admin,id,payload(id,'24500','Reconfirmed after checking dates'));r=row(id);assert.equal(r.status,'REVIEWED');assert.equal(r.review.revision,3);assert.deepEqual(events(id).map(e=>e.action),['CONFIRM','REOPEN','CONFIRM']);
  });
  await t.test('changed salaries, leave and employment reopen prior confirmations and stale forms cannot save',async()=>{
    const id=add();rate(id);const old=payload(id);await request(admin,id,old);
    rate(id,'35000');assert.equal(row(id).review.state,'STALE');assert.equal(row(id).salary_to_pay_paise,null);assert.equal((await request(admin,id,old)).status,409);
    await request(admin,id,payload(id,'27000','Updated salary basis checked'));
    db.prepare("INSERT INTO leaves(user_id,start_date,end_date,kind,reason,status,days,created_ts) VALUES(?,'2026-10-08','2026-10-08','FULL','Synthetic','APPROVED',1,0)").run(id);
    assert.equal(row(id).review.state,'STALE');await request(admin,id,payload(id,'26000','Approved leave included'));
    db.prepare("UPDATE users SET join_date='2026-01-01' WHERE id=?").run(id);
    let r=row(id);assert.equal(r.calculation_status,'CALCULATED');assert.equal(r.status,'REVIEW');assert.equal(r.review.state,'STALE');assert.equal(r.salary_to_pay_paise,null);
    await request(admin,id,payload(id,'33833.33','Corrected employment dates reviewed'));r=row(id);assert.equal(r.status,'REVIEWED');
    rate(id,'40000','2026-12-01');assert.equal(row(id).status,'REVIEWED');
  });
  await t.test('audit failure rolls back the confirmation atomically',async()=>{
    const id=add();db.exec("CREATE TRIGGER fail_review_audit BEFORE INSERT ON salary_month_review_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
    assert.equal((await request(admin,id,payload(id))).status,500);assert.equal(db.prepare('SELECT * FROM salary_month_reviews WHERE user_id=?').get(id),undefined);db.exec('DROP TRIGGER fail_review_audit');
  });
  await t.test('readbacks do not change review rows; confirmations and audit persist after restart',async()=>{
    const before=db.prepare('SELECT * FROM salary_month_reviews ORDER BY user_id').all(),audit=db.prepare('SELECT * FROM salary_month_review_events ORDER BY id').all();
    buildSalaries(db,'2026-10');buildSalaries(db,'2026-10');assert.deepEqual(db.prepare('SELECT * FROM salary_month_reviews ORDER BY user_id').all(),before);assert.deepEqual(db.prepare('SELECT * FROM salary_month_review_events ORDER BY id').all(),audit);
    const child=require('node:child_process').spawnSync(process.execPath,['-e',"const {db}=require('./src/db'); const r=require('./src/salaries').buildSalaries(db,'2026-10').rows.find(r=>r.id===Number(process.argv[1]));console.log(JSON.stringify(r));db.close();",String(employee)],{cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).status,'REVIEWED');assert.equal(JSON.parse(child.stdout).salary_to_pay_paise,2650042);
  });
  await t.test('review forms, current status and CSV notes are explicit and safely escaped',async()=>{
    const id=add();await request(admin,id,payload(id,'1234.56','=SUM(1,2) <img onerror=x>'));
    const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/salaries.js'),'utf8'),context);
    const report=buildSalaries(db,'2026-10'),html=context.window.Salaries.reportHtml(report),csv=context.window.Salaries.csv(report);
    assert.match(html,/Confirmed salary to pay \(INR\)/);assert.match(html,/Calculation or reason/);assert.match(html,/Confirm salary/);assert.match(html,/Edit review/);assert.match(html,/Reopen review/);assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));
    const line=csv.split('\r\n').find(line=>line.includes('=SUM')),cells=[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m=>m[1].replace(/""/g,'"'));
    assert.equal(cells[7],'1234.56');assert.equal(cells[9],'REVIEWED');assert.equal(cells[12],'CONFIRMED');assert.ok(cells[16].startsWith("'=SUM"));
  });
});
