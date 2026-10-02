'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
test('Asana collection and private operations dashboard',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ems-ops-'));process.env.DB_PATH=path.join(dir,'test.db');process.env.JWT_SECRET='test-only';process.env.ASANA_TOKEN='test-only';process.env.ASANA_PROJECT_GID='1215327082632826';process.env.EOD_ENABLED='false';
 const {db}=require('../src/db');const realFetch=global.fetch;
 t.after(()=>{global.fetch=realFetch;db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const fresh=()=>{delete require.cache[require.resolve('../src/asana')];return require('../src/asana');};
 await t.test('fully paginates beyond 2,000 and shares concurrent reads',async()=>{
  let calls=0;global.fetch=async url=>{calls++;const p=Number(new URL(url).searchParams.get('offset')||0);assert.ok(url.includes('completed_since='));return {ok:true,json:async()=>({data:Array.from({length:p<21?100:1},(_,i)=>({gid:String(p*100+i)})),next_page:p<21?{offset:String(p+1)}:null})};};
  const a=fresh();const [one,two]=await Promise.all([a.allTasks(),a.allTasks()]);assert.equal(one.length,2101);assert.strictEqual(one,two);assert.equal(calls,22);await a.allTasks();assert.equal(calls,22);assert.ok(a.syncStatus().lastSuccessAt);
 });
 await t.test('failure never caches partial data and respects rate-limit cooldown',async()=>{
  let calls=0;global.fetch=async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '120'},json:async()=>({errors:[{message:'rate limited'}]})};};
  const a=fresh();await assert.rejects(a.allTasks(),/rate limited/);await assert.rejects(a.allTasks(),/rate limited/);assert.equal(calls,1);assert.equal(a.syncStatus().lastSuccessAt,null);assert.ok(a.syncStatus().retryAt>Date.now()+110000);
 });
 await t.test('repeated pagination tokens fail visibly instead of silently truncating',async()=>{
  global.fetch=async()=>({ok:true,json:async()=>({data:[{gid:'1'}],next_page:{offset:'again'}})});const a=fresh();await assert.rejects(a.allTasks(),/repeated/);assert.equal(a.syncStatus().lastSuccessAt,null);
 });
 global.fetch=realFetch;
 const asana=fresh();const {now}=require('../src/time');
 asana.enabled=()=>true;asana.syncStatus=()=>({project:'1215327082632826',lastSuccessAt:Date.now()});
 asana.allTasks=async()=>[
  {gid:'1',name:'Overdue',completed:false,due_on:now().minus({days:1}).toISODate(),assignee:{name:'Person'}},
  {gid:'2',name:'No date or owner',completed:false},
  {gid:'3',name:'Due today',completed:false,due_on:now().toISODate(),assignee:{name:'Person'}},
  {gid:'4',name:'Completed',completed:true}
 ];
 const auth=require('../src/auth');const add=(name,role)=>Number(db.prepare('INSERT INTO users(name,email,password_hash,role,created_ts) VALUES(?,?,?,?,0)').run(name,name+'@example.test','x',role).lastInsertRowid);
 const admin=add('Admin','ADMIN'),emp=add('Person','EMPLOYEE');const cookie=id=>auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
 db.prepare("INSERT INTO achievements(user_id,date,title,created_ts) VALUES(?,'2025-01-01','Old pending',0)").run(emp);
 db.prepare("INSERT INTO leaves(user_id,start_date,end_date,days,created_ts) VALUES(?,'2025-01-01','2025-01-01',1,0)").run(emp);
 db.prepare("INSERT INTO punch_requests(user_id,day,type,time,created_ts) VALUES(?,'2025-01-01','IN','16:00',0)").run(emp);
 const express=require('express');const app=express();app.use(require('cookie-parser')(),auth.loadUser);app.use('/api/operations',require('../src/routes/operations'));const server=app.listen(0,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});t.after(()=>new Promise(r=>server.close(r)));
 const req=async(session=cookie(admin))=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/operations`,{headers:{cookie:session}});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
 await t.test('admin-only aggregation retains old approvals and sends no Slack messages',async()=>{
  assert.equal((await req('')).status,401);assert.equal((await req(cookie(emp))).status,403);const r=await req();assert.equal(r.cache,'no-store');assert.equal(r.body.approvals.length,3);assert.deepEqual(r.body.asana.counts,{pending:3,overdue:1,dueToday:1,unassigned:1,missingDue:1});assert.equal(r.body.slack.eodEnabled,false);assert.equal(r.body.slack.newAlertsEnabled,false);assert.equal(r.body.bonuses[0].lastMonth,null);
 });
 await t.test('Asana failure preserves portal approvals with unknown counts',async()=>{
  asana.allTasks=async()=>{throw Error('offline');};const r=await req();assert.equal(r.status,200);assert.equal(r.body.approvals.length,3);assert.equal(r.body.asana.state,'error');assert.equal(r.body.asana.counts,null);assert.equal(r.body.asana.tasks,null);
 });
 await t.test('unapproved project scope is not fetched',async()=>{
  asana.syncStatus=()=>({project:'999'});let called=false;asana.allTasks=async()=>{called=true;return [];};const r=await req();assert.equal(called,false);assert.equal(r.body.asana.state,'error');
 });
});
