'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

test('employee salary self-service and PDF slips enforce ownership and review status', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-own-salary-'));
  process.env.DB_PATH = path.join(dir, 'synthetic.db'); process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'synthetic-self-service'; process.env.TZ_OFFICE = 'Asia/Kolkata';
  const { Settings } = require('luxon'), originalNow = Settings.now; Settings.now = () => Date.parse('2026-11-02T12:00:00+05:30');
  const { db } = require('../src/db'), auth = require('../src/auth');
  const { saveSalary } = require('../src/salaryDeduction'), { buildSalaries } = require('../src/salaries');
  const { employeeSalaryReport } = require('../src/employeeSalary');
  const add = (name, role='EMPLOYEE', join='2026-01-01') => Number(db.prepare("INSERT INTO users(name,email,password_hash,role,join_date,emp_code,title,department,created_ts) VALUES(?,?,'x',?,?,?,'Staff Accountant','Accounts',0)").run(name,name+'@example.test',role,join,'QA-'+name).lastInsertRowid);
  const admin=add('Admin','ADMIN'), employee=add('Alice'), other=add('Bob');
  const salary = (id, amount='31000') => saveSalary(id,{ monthly_gross:amount, effective_from:'2026-01-01' },admin);
  salary(employee); salary(other,'78234.56');
  const leave = (id, day, status='APPROVED', kind='FULL') => Number(db.prepare("INSERT INTO leaves(user_id,start_date,end_date,kind,status,category,reason,days,created_ts) VALUES(?,?,?, ?,?,'REGULAR','Private leave',?,0)").run(id,day,day,kind,status,kind==='HALF'?0.5:1).lastInsertRowid);
  leave(employee,'2026-10-07','APPROVED','HALF');leave(employee,'2026-10-20');
  const express=require('express'), app=express();app.use(express.json(),require('cookie-parser')(),auth.loadUser);app.use('/api/salaries',require('../src/routes/salaries'));
  const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  t.after(async()=>{Settings.now=originalNow;await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const cookie=id=>auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  const request=(actor,route,method='GET',body,session)=>fetch(`http://127.0.0.1:${server.address().port}/api/salaries${route}`,{method,headers:{'content-type':'application/json',...(actor?{cookie:session||cookie(actor)}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const report=(id=employee,month='2026-10')=>employeeSalaryReport(db,id,month);
  const before=()=>JSON.stringify({users:db.prepare('SELECT * FROM users').all(),rates:db.prepare('SELECT * FROM employee_salary_rates').all(),leaves:db.prepare('SELECT * FROM leaves').all(),reviews:db.prepare('SELECT * FROM salary_month_reviews').all(),events:db.prepare('SELECT * FROM salary_month_review_events').all()});

  await t.test('employee receives only their own calculation, totals and download URL',async()=>{
    const response=await request(employee,'/mine?month=2026-10'),data=await response.json();
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(data.rows.length,1);assert.equal(data.rows[0].id,employee);assert.equal(data.totals.employees,1);
    assert.equal(data.rows[0].divisor,31);assert.equal(data.rows[0].deduction_paise,50000);assert.equal(data.rows[0].salary_to_pay_paise,3050000);
    assert.equal(data.rows[0].paid_leave_days,1);assert.equal(data.rows[0].salary_slip.available,true);
    assert.equal(data.rows[0].salary_slip.url,'/api/salaries/mine/slip?month=2026-10');
    assert.doesNotMatch(JSON.stringify(data),/Bob|7823456|source_fingerprint|expected_revision|reviewed_by|reviewer_name|input_snapshot/);
    assert.equal((await request(employee,'/')).status,403);assert.equal((await request(employee,`/${other}/slip?month=2026-10`)).status,403);
    const ownOther=await (await request(other,'/mine?month=2026-10')).json();assert.equal(ownOther.rows[0].name,'Bob');assert.equal(ownOther.rows[0].monthly_gross_paise,7823456);
  });
  await t.test('forged IDs, malformed dates and employee write attempts cannot change scope or records',async()=>{
    const snapshot=before();
    for(const route of ['/mine?month=2026-10&user_id='+other,'/mine/slip?month=2026-10&id='+other,'/mine?month=2026-13','/mine?month=2026-00','/mine?month[]=2026-10','/mine?month=bad','/mine/slip'])assert.equal((await request(employee,route)).status,400,route);
    for(const suffix of ['/review','/review/reopen'])assert.equal((await request(employee,`/${employee}${suffix}`,'POST',{month:'2026-10',amount:'1',note:'forged'})).status,403);
    assert.equal((await request(null,'/mine?month=2026-10')).status,401);assert.equal((await request(null,'/mine/slip?month=2026-10')).status,401);
    assert.equal((await request(admin,'/mine?month=2026-10')).status,403);assert.equal(before(),snapshot);
  });
  await t.test('download is a private PDF attachment, with the same arithmetic and no writes',async()=>{
    const snapshot=before(),response=await request(employee,'/mine/slip?month=2026-10');
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('content-disposition'),`attachment; filename="salary-slip-2026-10-${employee}.pdf"`);
    const pdf=Buffer.from(await response.arrayBuffer());assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>5000);assert.ok(pdf.length<200000);
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1);assert.equal(before(),snapshot);
    assert.equal((await request(admin,`/${employee}/slip?month=2026-10`)).status,200);
  });
  await t.test('current/future projections, pending leave and missing salary cannot produce a final slip',async()=>{
    for(const month of ['2026-11','2026-12']){assert.equal(report(employee,month).rows[0].salary_slip.available,false);assert.equal((await request(employee,'/mine/slip?month='+month)).status,409);}
    assert.equal((await request(employee,'/mine/slip?month=2025-12')).status,404);assert.equal(report(employee,'2025-12').rows.length,0);
    const pending=leave(employee,'2026-10-09','PENDING');assert.equal(report().rows[0].salary_slip.available,false);assert.equal((await request(employee,'/mine/slip?month=2026-10')).status,409);
    db.prepare("UPDATE leaves SET status='REJECTED' WHERE id=?").run(pending);assert.equal(report().rows[0].salary_slip.available,true);
    const missing=add('Missing');assert.equal(report(missing).rows[0].salary_to_pay_paise,null);assert.equal((await request(missing,'/mine/slip?month=2026-10')).status,409);
    const zero=add('Zero');salary(zero,'0');assert.equal(report(zero).rows[0].salary_to_pay_paise,0);assert.equal((await request(zero,'/mine/slip?month=2026-10')).status,200);
  });
  await t.test('reviewed amounts are visible without internal notes; stale/reopened confirmations disable downloads',async()=>{
    const partial=add('Partial','EMPLOYEE','2026-10-05');salary(partial);
    const confirm=async()=>{
      const row=buildSalaries(db,'2026-10',partial).rows[0];
      const response=await request(admin,`/${partial}/review`,'POST',{month:'2026-10',amount:'25000.42',note:'Internal admin note: do not expose this text',source_fingerprint:row.source_fingerprint,expected_revision:row.review?.revision||0});assert.equal(response.status,200);
    };
    assert.equal(report(partial).rows[0].salary_slip.available,false);await confirm();
    let own=report(partial);assert.equal(own.rows[0].salary_to_pay_paise,2500042);assert.equal(own.rows[0].salary_slip.available,true);
    assert.doesNotMatch(JSON.stringify(own),/Internal admin|do not expose|reviewer_name|reviewed_by|revision|note|source_fingerprint/);
    assert.equal((await request(partial,'/mine/slip?month=2026-10')).status,200);
    const revision=buildSalaries(db,'2026-10',partial).rows[0].review.revision;
    assert.equal((await request(admin,`/${partial}/review/reopen`,'POST',{month:'2026-10',expected_revision:revision})).status,200);
    assert.equal((await request(partial,'/mine/slip?month=2026-10')).status,409);await confirm();salary(partial,'32000');
    own=report(partial);assert.equal(own.rows[0].salary_to_pay_paise,null);assert.equal(own.rows[0].review,null);assert.equal((await request(partial,'/mine/slip?month=2026-10')).status,409);
  });
  await t.test('inactive and revoked sessions cannot download salary records',async()=>{
    const session=cookie(other);db.prepare('UPDATE users SET active=0 WHERE id=?').run(other);
    assert.equal((await request(other,'/mine?month=2026-10','GET',null,session)).status,401);
    db.prepare('UPDATE users SET active=1,session_version=session_version+1 WHERE id=?').run(other);
    assert.equal((await request(other,'/mine/slip?month=2026-10','GET',null,session)).status,401);
  });
  await t.test('PDF throttling is per authenticated account and cannot consume another employee limit',async()=>{
    const limited=add('Limited');salary(limited);
    for(let i=0;i<30;i++)assert.equal((await request(limited,'/mine/slip?month=2026-11')).status,409);
    assert.equal((await request(limited,'/mine/slip?month=2026-10')).status,429);
    assert.equal((await request(other,'/mine/slip?month=2026-10')).status,200);
  });
  await t.test('employee view is escaped and read-only, with server-provided slip availability',()=>{
    const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/salaries.js'),'utf8'),context);
    const data=report();data.rows[0].name='<img onerror=x>';const html=context.window.Salaries.reportHtml(data,{readOnly:true});
    assert.match(html,/Download salary slip \(PDF\)/);assert.match(html,/31 calendar days/);assert.match(html,/₹30,500/);assert.doesNotMatch(html,/<form|data-salary-form|Confirm salary|Reopen review|Edit review|<img|undefined/);
    const provisional=context.window.Salaries.reportHtml(report(employee,'2026-11'),{readOnly:true});assert.match(provisional,/month has ended/);assert.doesNotMatch(provisional,/download>/);
  });
});
