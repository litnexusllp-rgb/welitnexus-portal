'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('private bonus tracking, history and corrections', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-bonuses-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.JWT_SECRET = 'bonus-test-only';
  const { db } = require('../src/db');
  const auth = require('../src/auth');
  const express = require('express');
  const app = express();
  app.use(express.json(), require('cookie-parser')(), auth.loadUser);
  app.use('/api/bonuses', require('../src/routes/bonuses'));
  const add = (name,role='EMPLOYEE',active=1) => Number(db.prepare('INSERT INTO users(name,email,password_hash,role,active,created_ts) VALUES(?,?,?,?,?,?)').run(name,name+'@example.test','test',role,active,0).lastInsertRowid);
  const admin = add('Admin','ADMIN'), a = add('A'), b = add('B'), c = add('C','EMPLOYEE',0);
  const cookie = id => auth.COOKIE + '=' + auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
  const server = app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject) => { server.once('listening',resolve); server.once('error',reject); });
  t.after(async () => { await new Promise(r => server.close(r)); db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const request = async (method='GET',body,session=cookie(admin),suffix='') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/bonuses${suffix}`, {method,headers:{cookie:session,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  };
  const payment = (ids,month='2026-01') => ({user_ids:ids,month,paid_on:'2026-02-01',note:'Reference 123'});
  await t.test('all routes deny employees and anonymous visitors',async()=>{
    for (const [session,status] of [['',401],[cookie(a),403]]) {
      for (const [method,suffix,body] of [['GET',''],['POST','',payment([a])],['POST','/1/void',{reason:'test'}]]) assert.equal((await request(method,body,session,suffix)).status,status);
    }
  });
  let first;
  await t.test('batch records one to three recipients, including historical inactive staff',async()=>{
    const result = await request('POST',payment([a,b,c])); assert.equal(result.status,201); first = result.body.ids[0];
    const list = await request(); assert.equal(list.cache,'no-store'); assert.equal(list.body.history.length,3);
    assert.equal(list.body.history[0].recorded_by,'Admin');
  });
  await t.test('duplicate batch rolls back every recipient, preventing double clicks',async()=>{
    const result = await request('POST',payment([admin,a])); assert.equal(result.status,409);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bonuses').get().n,3);
  });
  await t.test('validates dates, recipient count, IDs and notes',async()=>{
    for (const body of [payment([]),payment([a,a]),payment([a,b,c,admin]),payment([99999]),payment(['1']),payment([a],'2026-13'),payment([a],'9999-01'),{...payment([a]),paid_on:'2026-02-30'},{...payment([a]),paid_on:'9999-01-01'},{...payment([a]),note:'x'.repeat(1001)}]) assert.equal((await request('POST',body)).status,400);
    assert.equal((await request('GET',null,cookie(admin),'?month=invalid')).status,400);
  });
  await t.test('history and latest month are accurate when reviewing past periods',async()=>{
    assert.equal((await request('POST',payment([a],'2026-02'))).status,201);
    const jan=(await request('GET',null,cookie(admin),'?month=2026-01')).body;
    assert.equal(jan.employees.find(u=>u.id===a).last_bonus_month,'2026-01');
    assert.equal(jan.employees.find(u=>u.id===a).bonus_count,1);
    assert.equal(jan.employees.find(u=>u.id===admin).last_bonus_month,null);
    const feb=(await request('GET',null,cookie(admin),'?month=2026-02')).body;
    assert.equal(feb.employees.find(u=>u.id===a).last_bonus_month,'2026-02');
    assert.equal(feb.employees.find(u=>u.id===a).bonus_count,2);
  });
  await t.test('void preserves who/why, excludes counts and permits corrected entry',async()=>{
    assert.equal((await request('POST',{reason:''},cookie(admin),`/${first}/void`)).status,400);
    assert.equal((await request('POST',{reason:'Wrong month'},cookie(admin),`/${first}/void`)).status,200);
    assert.equal((await request('POST',{reason:'Again'},cookie(admin),`/${first}/void`)).status,404);
    const jan=(await request('GET',null,cookie(admin),'?month=2026-01')).body;
    assert.equal(jan.employees.find(u=>u.id===a).bonus_count,0);
    assert.equal(jan.history.find(v=>v.id===first).voided_by_name,'Admin');
    assert.equal(jan.history.find(v=>v.id===first).void_reason,'Wrong month');
    assert.equal((await request('POST',payment([a]))).status,201);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bonuses WHERE id=?').get(first).n,1);
  });
});
