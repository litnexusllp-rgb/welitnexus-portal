'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

test('monthly salary worksheet uses approved leave and keeps review calculations separate', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-payroll-'));
  process.env.DB_PATH = path.join(dir, 'synthetic.db'); process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'synthetic-payroll-only'; process.env.TZ_OFFICE = 'Asia/Kolkata';
  const { Settings } = require('luxon'), originalNow = Settings.now;
  Settings.now = () => Date.parse('2026-10-24T00:05:00+05:30');
  const { db } = require('../src/db'), auth = require('../src/auth');
  const { buildSalaries } = require('../src/salaries');
  const { saveSalary } = require('../src/salaryDeduction');
  let seq = 0;
  const add = (extra = {}) => Number(db.prepare(`INSERT INTO users(name,email,password_hash,role,join_date,exit_date,active,created_ts) VALUES(@name,@email,'synthetic',@role,@join_date,@exit_date,@active,0)`).run({ name:'Synthetic '+(++seq), email:`pay${seq}@example.test`, role:'EMPLOYEE', join_date:'2026-01-01', exit_date:'', active:1, ...extra }).lastInsertRowid);
  const admin = add({ role:'ADMIN' }), employee = add();
  const salary = (id, amount='30000', effective='2026-01-01') => saveSalary(id, { monthly_gross:amount, effective_from:effective }, admin);
  const leave = (id, start='2026-11-05', extra={}) => db.prepare(`INSERT INTO leaves(user_id,start_date,end_date,kind,category,status,days,reason,created_ts,deduction_quote_json) VALUES(@user_id,@start_date,@end_date,@kind,'REGULAR',@status,1,'Synthetic',0,@quote)`).run({ user_id:id, start_date:start, end_date:start, kind:'FULL', status:'APPROVED', quote:null, ...extra }).lastInsertRowid;
  const row = (id, month='2026-11') => buildSalaries(db, month).rows.find(row => row.id === id);
  const express = require('express'), app = express(); app.use(express.json(), require('cookie-parser')(), auth.loadUser); app.use('/api/salaries', require('../src/routes/salaries'));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r,j) => { server.once('listening',r); server.once('error',j); });
  t.after(async () => { Settings.now=originalNow; await new Promise(r => server.close(r)); db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  const request = (id, suffix='', method='GET') => fetch(`http://127.0.0.1:${server.address().port}/api/salaries${suffix}`, { method, headers:id ? { cookie:auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id)) } : {} });

  await t.test('mixed approved leave determines gross minus deduction; pending and rejected do not deduct', () => {
    salary(employee,'42000'); leave(employee,'2026-11-11',{ end_date:'2026-11-13' });
    leave(employee,'2026-11-07',{ status:'PENDING' }); leave(employee,'2026-11-08',{ status:'REJECTED' }); leave(employee,'2026-11-09',{ status:'CANCELLED' });
    const r=row(employee); assert.equal(r.monthly_gross_paise,4200000); assert.equal(r.paid_leave_days,1); assert.equal(r.unpaid_leave_days,2);
    assert.equal(r.deduction_paise,280000); assert.equal(r.salary_to_pay_paise,3920000); assert.equal(r.pending_requests,1); assert.equal(r.status,'CALCULATED');
    assert.equal(r.approved_leaves.length,1); assert.equal(buildSalaries(db,'2026-11').rows.some(r=>r.id===admin),false);
  });
  await t.test('full-month salary remains monthly gross in 28-, 29-, 30- and 31-day months', () => {
    const id=add(); salary(id);
    for(const month of ['2027-02','2028-02','2026-11','2026-12']) {
      leave(id,month+'-12'); leave(id,month+'-13');
      const r=row(id,month); assert.equal(r.monthly_gross_paise,3000000); assert.equal(r.unpaid_leave_days,1); assert.equal(r.deduction_paise,100000); assert.equal(r.salary_to_pay_paise,2900000);
    }
  });
  await t.test('half-day fractions round once for the whole employee month, not per request', () => {
    const id=add(); salary(id,'1000.01'); leave(id,'2026-11-01',{ kind:'HALF' }); leave(id,'2026-11-02',{ kind:'HALF' });
    const r=row(id); assert.equal(r.unpaid_leave_days,1); assert.equal(r.deduction_paise,3333); assert.equal(r.salary_to_pay_paise,96668);
  });
  await t.test('cross-month leave clips to selected dates and follows October policy effective date', () => {
    const id=add(); salary(id); leave(id,'2026-09-30',{ end_date:'2026-10-13' });
    assert.equal(row(id,'2026-09').unpaid_leave_days,0); const oct=row(id,'2026-10'); assert.equal(oct.unpaid_leave_days,12); assert.equal(oct.paid_leave_days,1); assert.equal(oct.deduction_paise,1200000);
    const half=add(); salary(half); leave(half,'2026-09-30',{ kind:'HALF',end_date:'2026-10-02' });
    assert.equal(row(half,'2026-10').approved_leaves.length,0); assert.equal(row(half,'2026-10').unpaid_leave_days,0);
  });
  await t.test('salary changes preserve date-specific calculations but require monthly gross review', () => {
    const id=add(); salary(id); salary(id,'60000','2026-11-10'); salary(id,'90000','2026-12-01');
    leave(id,'2026-11-05'); leave(id,'2026-11-11'); const r=row(id);
    assert.equal(r.deduction_paise,300000); assert.equal(r.rate_lines.length,2); assert.equal(r.monthly_gross_paise,null); assert.equal(r.salary_to_pay_paise,null); assert.equal(r.status,'REVIEW');
    assert.match(r.review_reasons.join(' '),/changed/); assert.deepEqual(r.deduction_lines.map(l=>l.monthly_gross_paise),[3000000,6000000]);
    assert.equal(row(id,'2026-12').salary_to_pay_paise,9000000);
  });
  await t.test('part-month join/exit rows show full-month reference and working, not assumed proration', () => {
    const id=add({ join_date:'2026-10-05' }); salary(id,'42000','2026-10-05'); leave(id,'2026-10-06');
    const r=row(id,'2026-10'); assert.equal(r.employed_calendar_days,27); assert.equal(r.rate_lines[0].calendar_days,27); assert.equal(r.deduction_paise,140000);
    assert.equal(r.full_month_reference_after_leave_paise,4060000); assert.equal(r.salary_to_pay_paise,null); assert.equal(r.status,'REVIEW');
    const leaving=add({ active:0, exit_date:'2026-11-15' }); salary(leaving); leave(leaving);
    assert.equal(row(leaving).employed_calendar_days,15); assert.equal(row(leaving).status,'REVIEW'); assert.equal(row(leaving,'2026-12'),undefined);
    const past=add({ active:0, exit_date:'2026-08-31' }); assert.equal(row(past),undefined);
    const future=add({ join_date:'2027-01-01' }); assert.equal(row(future),undefined);
  });
  await t.test('missing salary, zero salary and uncertain employment are distinct', () => {
    const missing=add(); leave(missing); let r=row(missing); assert.equal(r.monthly_gross_paise,null); assert.equal(r.deduction_paise,null); assert.equal(r.salary_to_pay_paise,null);
    salary(missing,'30000','2026-11-06'); leave(missing,'2026-11-07'); r=row(missing); assert.equal(r.deduction_paise,null); assert.equal(r.deduction_lines.length,1);
    const zero=add(); salary(zero,'0'); leave(zero); assert.equal(row(zero).status,'CALCULATED'); assert.equal(row(zero).salary_to_pay_paise,0);
    const unknown=add({ join_date:'' }); salary(unknown); assert.equal(row(unknown).status,'REVIEW'); assert.equal(row(unknown).full_month_reference_after_leave_paise,3000000);
    const inactive=add({ active:0 }); salary(inactive); assert.equal(row(inactive).status,'REVIEW');
  });
  await t.test('overlaps and invalid or outside-employment approved leave are flagged without duplicate deduction', () => {
    const id=add(); salary(id); leave(id); leave(id); const r=row(id);
    assert.equal(r.status,'REVIEW'); assert.equal(r.unpaid_leave_days,1); assert.equal(r.deduction_paise,100000); assert.equal(r.full_month_reference_after_leave_paise,2900000);
    const bad=add(); salary(bad); leave(bad,'2026-11-02',{ end_date:'2026-11-01' }); assert.equal(row(bad).deduction_paise,null); assert.equal(row(bad).status,'REVIEW');
    const outside=add({ join_date:'2026-11-10' }); salary(outside); leave(outside,'2026-11-05'); assert.equal(row(outside).deduction_paise,0); assert.match(row(outside).review_reasons.join(' '),/outside/);
  });
  await t.test('worksheet recalculates effective rates without modifying source rows, quotes or cached balances', () => {
    const id=add(); salary(id); const lid=leave(id,'2026-11-05',{ quote:'{"total_paise":100000}' }); salary(id,'60000');
    const before={users:db.prepare('SELECT * FROM users').all(),leaves:db.prepare('SELECT * FROM leaves').all(),salary:db.prepare('SELECT * FROM employee_salary_rates').all(),audit:db.prepare('SELECT * FROM salary_rate_changes').all(),resets:db.prepare('SELECT * FROM leave_balance_resets').all()};
    const r=row(id); assert.equal(r.deduction_paise,200000); assert.equal(r.salary_to_pay_paise,5800000); buildSalaries(db,'2026-10');
    const after={users:db.prepare('SELECT * FROM users').all(),leaves:db.prepare('SELECT * FROM leaves').all(),salary:db.prepare('SELECT * FROM employee_salary_rates').all(),audit:db.prepare('SELECT * FROM salary_rate_changes').all(),resets:db.prepare('SELECT * FROM leave_balance_resets').all()}; assert.deepEqual(after,before);
    assert.equal(db.prepare('SELECT deduction_quote_json FROM leaves WHERE id=?').get(lid).deduction_quote_json,'{"total_paise":100000}');
  });
  await t.test('review rows are excluded from totals; only calculated rows determine the payable subtotal', () => {
    const report=buildSalaries(db,'2026-11'),ready=report.rows.filter(r=>r.status==='CALCULATED');
    assert.equal(report.totals.salary_to_pay_paise,ready.reduce((n,r)=>n+r.salary_to_pay_paise,0)); assert.equal(report.totals.calculated,ready.length); assert.equal(report.totals.review,report.rows.length-ready.length);
    assert.equal(report.period_state,'UPCOMING'); assert.equal(buildSalaries(db).period_state,'IN_PROGRESS'); assert.equal(buildSalaries(db,'2026-09').period_state,'ENDED');
  });
  await t.test('salary report is admin-only, no-store, strictly validates month and has no payment writes', async () => {
    assert.equal((await request()).status,401); assert.equal((await request(employee)).status,403); assert.equal((await request(employee,'?month=2026-11&user_id='+admin)).status,403);
    for(const suffix of ['?month=2026-13','?month=2026-00','?month=bad','?month=2026-11-01','?month[]=2026-11']) assert.equal((await request(admin,suffix)).status,400,suffix);
    const response=await request(admin); assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store'); assert.equal((await response.json()).month,'2026-10');
    assert.equal((await request(admin,'','POST')).status,404);
  });
  await t.test('HTML and CSV preserve review status, calculations and safe text without inventing payable values', () => {
    const id=add({ name:'=HYPERLINK("https://example.test") <img onerror=x>', join_date:'2026-11-15' }); salary(id);
    const context={window:{}}; vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/salaries.js'),'utf8'),context);
    const report=buildSalaries(db,'2026-11'),html=context.window.Salaries.reportHtml(report),csv=context.window.Salaries.csv(report);
    assert.match(html,/calculated subtotal/); assert.match(html,/Review before payment/); assert.match(html,/Full-month reference/); assert.match(html,/excluded from the salary-to-pay total/); assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
    const line=csv.split('\r\n').find(line=>line.includes('HYPERLINK')),cells=[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m=>m[1].replace(/""/g,'"'));
    assert.ok(cells[1].startsWith("'=HYPERLINK")); assert.equal(cells[7],''); assert.equal(cells[8],'30000.00'); assert.equal(cells[9],'REVIEW');
    assert.match(html,/2026|2027/); assert.ok(csv.startsWith('\uFEFF'));
  });
});

test('salary page ignores stale responses and disables stale exports after a month change or error', async () => {
  const elements={}; for(const id of ['salaryMonth','salaryRefresh','salaryCsv','salaryManage','salaryReport','salaryStatus']) elements['#'+id]={value:'',disabled:false,innerHTML:'',textContent:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}};
  const root={innerHTML:'',isConnected:true,querySelector:s=>elements[s],querySelectorAll:()=>[]}, pending=[];
  const context={window:{},console}; vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/salaries.js'),'utf8'),context);
  const report=month=>({month,scope:'Approved only',calculated_ts:0,period_state:'ENDED',totals:{review:0,pending_requests:0,calculated:0,employees:0},rows:[]});
  const mounted=context.window.Salaries.mount(root,{api:{get:url=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}))},onManage(){}});
  elements['#salaryMonth'].value='2026-11'; const nov=elements['#salaryMonth'].listeners.change();
  elements['#salaryMonth'].value='2026-12'; const dec=elements['#salaryMonth'].listeners.change();
  pending[2].resolve(report('2026-12')); await dec; assert.equal(elements['#salaryCsv'].disabled,false);
  pending[1].resolve(report('2026-11')); await nov; pending[0].resolve(report('2026-10')); await mounted; assert.equal(elements['#salaryMonth'].value,'2026-12');
  const failed=elements['#salaryRefresh'].listeners.click(); assert.equal(elements['#salaryCsv'].disabled,true); assert.equal(elements['#salaryReport'].innerHTML,'');
  pending[3].reject(new Error('Unavailable')); await failed; assert.equal(elements['#salaryCsv'].disabled,true); assert.equal(elements['#salaryStatus'].textContent,'Unavailable');
});
