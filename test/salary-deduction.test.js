'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('private gross salary and leave deduction estimates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-salary-'));
  process.env.DB_PATH = path.join(dir,'synthetic.db'); process.env.NODE_ENV='test'; process.env.JWT_SECRET='synthetic-salary-secret'; process.env.TZ_OFFICE='Asia/Kolkata';
  const { Settings } = require('luxon'), originalNow=Settings.now;
  Settings.now=()=>Date.parse('2026-10-23T10:00:00+05:30');
  const { db }=require('../src/db'), auth=require('../src/auth');
  const { estimateDeduction, saveSalary, validateSalary }=require('../src/salaryDeduction');
  let seq=0;
  const add=(role='EMPLOYEE')=>db.prepare("INSERT INTO users(name,email,password_hash,role,join_date,created_ts) VALUES(?,?,?,?,'2026-01-01',0)").run('Synthetic '+(++seq),`salary${seq}@example.test`,auth.hashPassword('synthetic123'),role).lastInsertRowid;
  const admin=add('ADMIN');
  const user=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const express=require('express'), app=express(); app.use(express.json(),require('cookie-parser')(),auth.loadUser);
  app.use('/api/users',require('../src/routes/directory')); app.use('/api/auth',require('../src/routes/auth')); app.use('/api/leaves',require('../src/routes/leaves')); app.use('/api/attendance',require('../src/routes/attendance'));
  app.use((err,_req,res,_next)=>res.status(500).json({error:'Synthetic database failure'}));
  const server=app.listen(0,'127.0.0.1'); await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});
  t.after(async()=>{Settings.now=originalNow;await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(id,url,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`,{method,headers:{...(id?{cookie:`${auth.COOKIE}=${auth.issueToken(user(id))}`} : {}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
  const salary=(monthly_gross,effective_from='2026-10-01')=>({monthly_gross,effective_from,currency:'INR'});
  const leave=(start_date='2026-11-05',extra={})=>({start_date,end_date:start_date,kind:'FULL',category:'REGULAR',reason:'Synthetic request',...extra});

  await t.test('full and half days use gross / 30, independent of month length',()=>{
    const id=add();saveSalary(id,salary('30000'),admin);
    assert.equal(estimateDeduction(id,leave()).total_paise,100000);
    assert.equal(estimateDeduction(id,leave('2026-11-05',{kind:'HALF'})).total_paise,50000);
    assert.equal(estimateDeduction(id,leave('2027-02-05')).total_paise,100000);
    assert.equal(estimateDeduction(id,leave('2028-02-05')).total_paise,100000);
    assert.equal(estimateDeduction(id,leave('2026-12-05')).total_paise,100000);
    const q=estimateDeduction(id,leave('2026-11-11',{end_date:'2026-11-14'}));assert.equal(q.unpaid_days,2);assert.equal(q.total_paise,200000);
  });
  await t.test('boundaries, paid requests and zero salaries are explicit',()=>{
    const id=add();saveSalary(id,salary('30000'),admin);
    for(const date of ['2026-11-01','2026-11-12']) assert.equal(estimateDeduction(id,leave(date)).total_paise,100000);
    for(const date of ['2026-11-13','2026-09-05']) assert.equal(estimateDeduction(id,leave(date)).total_paise,0);
    const zero=add();saveSalary(zero,salary('0'),admin);const q=estimateDeduction(zero,leave());assert.equal(q.status,'AVAILABLE');assert.equal(q.total_paise,0);
  });
  await t.test('effective salary dates and cross-month ranges use applicable recorded rates',()=>{
    const id=add();saveSalary(id,salary('30000'),admin);saveSalary(id,salary('60000','2026-11-01'),admin);saveSalary(id,salary('90000','2026-11-06'),admin);
    assert.equal(estimateDeduction(id,leave('2026-10-05')).total_paise,100000);
    const q=estimateDeduction(id,leave('2026-11-05',{end_date:'2026-11-06'}));assert.equal(q.total_paise,500000);assert.equal(q.items.length,2);
    const crossing=estimateDeduction(id,leave('2026-10-12',{end_date:'2026-11-02'}));assert.equal(crossing.unpaid_days,3);assert.equal(crossing.total_paise,500000);
  });
  await t.test('round once per request using integer paise and half-day units',()=>{
    const id=add();saveSalary(id,salary('1000.01'),admin);
    assert.equal(estimateDeduction(id,leave('2026-11-01',{end_date:'2026-11-03'})).total_paise,10000);
    assert.equal(estimateDeduction(id,leave('2026-11-01',{kind:'HALF'})).total_paise,1667);
    assert.equal(validateSalary(salary('12345.67')).monthly_gross_paise,1234567);
  });
  await t.test('missing or partly missing salary is unavailable, not a zero estimate',()=>{
    const id=add();let q=estimateDeduction(id,leave());assert.equal(q.status,'MISSING_SALARY');assert.equal(q.total_paise,null);
    saveSalary(id,salary('30000','2026-11-06'),admin);q=estimateDeduction(id,leave('2026-11-05',{end_date:'2026-11-06'}));assert.equal(q.status,'MISSING_SALARY');assert.equal(q.total_paise,null);assert.deepEqual(q.missing_salary_dates,['2026-11-05']);
    q=estimateDeduction(id,leave('2026-11-13'));assert.equal(q.status,'AVAILABLE');assert.equal(q.total_paise,0);
  });
  await t.test('admin salary entry is validated and leaves profile unchanged on failure',async()=>{
    const id=add();
    const invalid=[salary('-1'),salary('1.001'),salary('NaN'),salary('Infinity'),salary('1e6'),salary(''),salary('100000000'),salary('100','2026-02-30'),salary('100',''),{...salary('100'),currency:'USD'},null];
    for(const input of invalid){const r=await request(admin,`users/${id}`,'PUT',{phone:'must-not-save',salary:input});assert.equal(r.status,400,JSON.stringify(input));assert.equal(user(id).phone,'');}
    let r=await request(admin,`users/${id}`,'PUT',{phone:'123',salary:salary('30000.50')});assert.equal(r.status,200);assert.equal(user(id).phone,'123');
    const history=(await request(admin,`users/${id}/salary`)).body;assert.equal(history.latest.monthly_gross_paise,3000050);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM salary_rate_changes WHERE user_id=?').get(id).n,1);
    await request(admin,`users/${id}`,'PUT',{salary:salary('30000.50')});assert.equal(db.prepare('SELECT COUNT(*) n FROM salary_rate_changes WHERE user_id=?').get(id).n,1);
  });
  await t.test('profile and salary create/update are atomic on database failure',async()=>{
    const id=add();
    db.exec(`CREATE TRIGGER fail_salary_insert BEFORE INSERT ON employee_salary_rates BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
    const r=await request(admin,`users/${id}`,'PUT',{phone:'must-roll-back',salary:salary('30000')});assert.equal(r.status,500);assert.equal(user(id).phone,'');
    const created=await request(admin,'users','POST',{name:'Atomic New',email:'atomic@example.test',password:'synthetic123',salary:salary('30000')});assert.equal(created.status,500);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email='atomic@example.test'").get().n,0);
    db.exec('DROP TRIGGER fail_salary_insert');
  });
  await t.test('new employee can have salary set in the same transaction',async()=>{
    const r=await request(admin,'users','POST',{name:'New Synthetic',email:'new-salary@example.test',password:'synthetic123',salary:salary('40000')});assert.equal(r.status,200);
    assert.equal((await request(admin,`users/${r.body.user.id}/salary`)).body.current.monthly_gross_paise,4000000);
    assert.equal(Object.hasOwn(r.body.user,'salary'),false);
  });
  await t.test('salary history is audited and saved request estimates do not change',async()=>{
    const id=add();saveSalary(id,salary('30000'),admin);
    let r=await request(id,'leaves','POST',leave());assert.equal(r.status,200);const lid=r.body.leave.id;assert.equal(r.body.leave.deduction_estimate.total_paise,100000);assert.equal(Object.hasOwn(r.body.leave,'deduction_quote_json'),false);
    const snapshot=db.prepare('SELECT deduction_quote_json FROM leaves WHERE id=?').get(lid).deduction_quote_json;
    await request(admin,`users/${id}`,'PUT',{salary:salary('60000')});
    r=await request(id,'leaves/preview','POST',leave());assert.equal(r.body.leave.deduction_estimate.total_paise,200000);
    r=await request(id,'leaves/mine');assert.equal(r.body.leaves.find(l=>l.id===lid).deduction_estimate.total_paise,100000);
    r=await request(admin,`leaves/${lid}/decide`,'POST',{decision:'APPROVED'});assert.equal(r.status,200);assert.equal(r.body.leave.deduction_estimate.total_paise,100000);
    assert.equal(db.prepare('SELECT deduction_quote_json FROM leaves WHERE id=?').get(lid).deduction_quote_json,snapshot);
    const audit=db.prepare('SELECT * FROM salary_rate_changes WHERE user_id=? ORDER BY id').all(id);assert.equal(audit.length,2);assert.equal(JSON.parse(audit[1].before_json).monthly_gross_paise,3000000);
  });
  await t.test('employee salary is never disclosed in shared directory, auth or attendance data',async()=>{
    const id=add(),other=add();saveSalary(id,salary('31415.92'),admin);saveSalary(other,salary('27182.81'),admin);
    for(const url of ['users','auth/me','attendance/status']){const r=await request(id,url);assert.equal(r.status,200);assert.doesNotMatch(JSON.stringify(r.body),/3141592|2718281|monthly_gross|employee_salary|salary_rate/);}
    const login=await request(null,'auth/login','POST',{email:user(id).email,password:'synthetic123'});assert.equal(login.status,200);assert.doesNotMatch(JSON.stringify(login.body),/monthly_gross|3141592|salary_rate/);
    assert.equal((await request(null,`users/${id}/salary`)).status,401);
    assert.equal((await request(id,`users/${id}/salary`)).status,403);
    assert.equal((await request(id,`users/${other}/salary`)).status,403);
    assert.equal((await request(id,'leaves/preview','POST',leave('2026-11-05',{user_id:other}))).status,403);
    const preview=await request(id,'leaves/preview','POST',leave());assert.equal(preview.body.leave.deduction_estimate.items[0].monthly_gross_paise,3141592);
    assert.equal((await request(id,`users/${other}`,'PUT',{salary:salary('1')})).status,403);
    await request(id,'users/me','PUT',{salary:salary('1')});assert.equal(estimateDeduction(id,leave()).items[0].monthly_gross_paise,3141592);
  });
  await t.test('client monetary payloads are ignored; missing salary does not block leave',async()=>{
    const id=add();saveSalary(id,salary('30000'),admin);
    const r=await request(id,'leaves','POST',leave('2026-11-08',{monthly_gross:1,deduction_quote_json:'{"total_paise":1}',deduction_estimate:{total_paise:1},paid_days:1}));assert.equal(r.status,200);assert.equal(r.body.leave.deduction_estimate.total_paise,100000);assert.equal(r.body.balances.balance,20);
    const missing=add();const q=await request(missing,'leaves','POST',leave());assert.equal(q.status,200);assert.equal(q.body.leave.deduction_estimate.status,'MISSING_SALARY');
  });
  await t.test('admin-recorded leave saves the same estimate; legacy rows remain unpriced',async()=>{
    const id=add();saveSalary(id,salary('30000'),admin);
    const r=await request(admin,'leaves/admin','POST',leave('2026-10-06',{user_id:id,kind:'HALF'}));assert.equal(r.status,200);assert.equal(r.body.leave.deduction_estimate.total_paise,50000);
    db.prepare("INSERT INTO leaves(user_id,start_date,end_date,kind,reason,status,days,created_ts) VALUES(?,'2026-10-07','2026-10-07','FULL','Legacy','APPROVED',1,0)").run(id);
    const history=(await request(id,'leaves/mine')).body.leaves;assert.equal(history.find(l=>l.reason==='Legacy').deduction_estimate,null);
  });
  await t.test('salary history and request snapshots survive restart',()=>{
    const id=add();saveSalary(id,salary('30000'),admin);
    const original=db.prepare('SELECT * FROM employee_salary_rates WHERE user_id=?').all(id);
    const result=require('node:child_process').spawnSync(process.execPath,['-e',"const {db}=require('./src/db');console.log(JSON.stringify(db.prepare('SELECT * FROM employee_salary_rates WHERE user_id=?').all(Number(process.argv[1]))));db.close();",String(id)],{cwd:path.join(__dirname,'..'),env:process.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),original);
    assert.equal(db.pragma('table_info(users)').some(c=>/salary|gross/.test(c.name)),false);
  });
});
