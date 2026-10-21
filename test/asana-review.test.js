'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {reviewTask,options,createReview}=require('../src/asanaReview');
const at=Date.parse('2026-10-21T12:00:00Z');
const opt=options({date:'2026-10-21',minAge:6},at);
const task={gid:'1',name:'Review',created_at:'2026-10-14T12:00:00Z',modified_at:'2026-10-21T09:00:00Z',completed:false,due_on:'2026-10-21',due_at:null,assignee:{gid:'2',name:'Staff'},tags:[]};
const change=(id,when,oldDue,newDue,extra={})=>({gid:String(id),created_at:when,resource_subtype:'due_date_changed',created_by:{name:'Editor'},old_dates:{due_on:oldDue,due_at:null},new_dates:{due_on:newDue,due_at:null},...extra});
test('calendar age includes six days and office-midnight boundaries; rejects invalid/future dates',()=>{
 assert.equal(reviewTask({...task,created_at:'2026-10-15T18:29:59Z'},[],opt).age,6);
 assert.equal(reviewTask({...task,created_at:'2026-10-15T18:30:00Z'},[],opt),null);
 for(const x of [{date:'2026-02-30'},{date:'2026-10-22'},{date:'bad'},{minAge:-1},{minAge:1.5}])assert.throws(()=>options(x,at));
});
test('structured due changes deduplicate and classify relative to each change day',()=>{
 const a=change(1,'2026-10-19T08:00:00Z','2026-10-18','2026-10-19');
 const b=change(2,'2026-10-20T08:00:00Z','2026-10-19','2026-10-23');
 const startOnly=change(3,'2026-10-21T08:00:00Z','2026-10-23','2026-10-23');
 const r=reviewTask(task,[a,b,a,startOnly],opt);assert.equal(r.changes,2);assert.equal(r.postponements,2);assert.equal(r.history[0].category,'Due today');assert.equal(r.history[1].category,'Due in future');assert.equal(r.history[2].changed,false);
});
test('initial setting, clearing, incomplete records and older window activity are distinguished',()=>{
 const r=reviewTask(task,[change(1,'2026-10-14T08:00:00Z','2026-10-13','2026-10-14'),change(2,'2026-10-15T08:00:00Z',null,'2026-10-18'),change(3,'2026-10-16T08:00:00Z','2026-10-18',null),change(4,'2026-10-17T08:00:00Z',null,null,{old_dates:undefined,new_dates:undefined,text:'changed to today'})],opt);
 assert.equal(r.changes,2);assert.equal(r.postponements,0);assert.equal(r.unknownChanges,1);assert.equal(r.history.at(-1).category,'Date details unavailable');
});
test('historical due and completion rewind, without claiming historical assignee',()=>{
 const historical=options({date:'2026-10-18',minAge:0},at);
 const t={...task,completed:true,completed_at:'2026-10-20T10:00:00Z',due_on:'2026-10-23'};
 const stories=[change(1,'2026-10-20T09:00:00Z','2026-10-18','2026-10-23'),{gid:'2',created_at:'2026-10-20T10:00:00Z',resource_subtype:'marked_complete'}];
 const r=reviewTask(t,stories,historical);assert.equal(r.due,'2026-10-18');assert.equal(r.status,'Due today');assert.equal(r.history.length,0);
 assert.equal(reviewTask({...task,completed:false},[{gid:'3',created_at:'2026-10-20T10:00:00Z',resource_subtype:'marked_incomplete'}],historical),null);
 assert.equal(reviewTask(t,[],historical).pendingKnown,false);
});
test('failed history never becomes zero changes or fabricated past status',()=>{
 const current=reviewTask(task,[],opt,'unavailable');assert.equal(current.changes,null);assert.equal(current.pendingKnown,true);
 const past=reviewTask(task,[],options({date:'2026-10-18',minAge:0},at),'unavailable');assert.equal(past.pendingKnown,false);assert.equal(past.dueKnown,false);
});
test('timed deadlines use office timezone and same-day later times count as postponements',()=>{
 const r=reviewTask({...task,due_at:'2026-10-21T19:00:00Z'},[change(1,'2026-10-20T19:00:00Z',null,null,{old_dates:{due_at:'2026-10-21T01:00:00Z'},new_dates:{due_at:'2026-10-21T02:00:00Z'}})],opt);
 assert.equal(r.due,'2026-10-22');assert.equal(r.postponements,1);assert.equal(r.history[0].category,'Due today');
});
test('collector paginates, deduplicates, traverses completed-parent subtasks, caches and preserves reports on failure',async()=>{
 const Database=require('better-sqlite3');const db=new Database(':memory:');let fail=false,calls=0;
 const fetchImpl=async url=>{calls++;const u=new URL(url);let data,next=null;
   if(fail)return {ok:false,status:403};
   if(u.pathname.endsWith('/tasks')){if(u.searchParams.get('offset'))data=[task];else{data=[{...task,gid:'parent',completed:true,completed_at:'2026-10-01T00:00:00Z',num_subtasks:1,projects:[{name:'Project'}]},task];next={offset:'next'};}}
   else if(u.pathname.endsWith('/subtasks'))data=[{...task,gid:'child'}];
   else data=[change(1,'2026-10-19T10:00:00Z','2026-10-18','2026-10-19')];
   return {ok:true,status:200,json:async()=>({data,next_page:next})};
 };
 let clock=at;const service=createReview({db,fetchImpl,wait:async()=>{},clock:()=>clock,env:{ASANA_TOKEN:'test',ASANA_REVIEW_PROJECT_GIDS:'123'}});
 assert.equal(service.start({date:opt.date}).state,'running');assert.equal(service.start({date:opt.date}).busy,true);await service.waitForIdle();
 const r=service.read({date:opt.date});assert.equal(r.report.rows.length,2);assert.equal(r.report.scanned,3);assert.equal(r.report.rows.find(t=>t.gid==='child').parent,'Review');
 const before=calls;assert.equal(service.start({date:opt.date}).cached,true);assert.equal(calls,before);
 fail=true;clock+=300001;service.start({date:opt.date});await service.waitForIdle();const failed=service.read({date:opt.date});assert.equal(failed.job.state,'error');assert.deepEqual(failed.report,r.report);db.close();
});
test('pagination without an offset fails instead of saving an incomplete report',async()=>{
 const Database=require('better-sqlite3');const db=new Database(':memory:');
 const s=createReview({db,fetchImpl:async()=>({ok:true,json:async()=>({data:[task],next_page:{}})}),wait:async()=>{},clock:()=>at,env:{ASANA_TOKEN:'test',ASANA_REVIEW_PROJECT_GIDS:'123'}});
 s.start({date:opt.date});await s.waitForIdle();assert.equal(s.read({date:opt.date}).job.state,'error');assert.equal(s.read({date:opt.date}).report,null);db.close();
});
test('UI renders escaped evidence, counts failures as unknown, and filters repeated postponements',()=>{
 const context={window:{},console};vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/js/asana-review.js'),'utf8'),context);
 const row=reviewTask({...task,name:'<img onerror=alert(1)>'},[change(1,'2026-10-19T10:00:00Z','2026-10-18','2026-10-19'),change(2,'2026-10-20T10:00:00Z','2026-10-19','2026-10-21')],opt);
 const report={date:opt.date,timezone:opt.zone,startedAt:new Date(at).toISOString(),observedAt:new Date(at).toISOString(),rows:[row,reviewTask({...task,gid:'3',assignee:null},[],opt,'offline')],scanned:2,projects:['1'],notice:'Current owners'};
 const html=context.window.AsanaReview.reportHtml(report,{filter:'postponed'});assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('Unassigned'));assert.ok(html.includes('Editor'));assert.ok(html.includes('Due in future'));
 assert.ok(context.window.AsanaReview.reportHtml(report).includes('Activity unavailable'));
});
test('report routes reject anonymous and employees and validate dates for admins',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ems-asana-review-'));process.env.DB_PATH=path.join(dir,'test.db');process.env.JWT_SECRET='test-only';
 const {db}=require('../src/db'),auth=require('../src/auth'),express=require('express');
 const add=role=>Number(db.prepare('INSERT INTO users(name,email,password_hash,role,created_ts) VALUES(?,?,?,?,0)').run(role,role+'@test.test','x',role).lastInsertRowid);
 const admin=add('ADMIN'),employee=add('EMPLOYEE');const cookie=id=>auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
 const app=express();app.use(express.json(),require('cookie-parser')(),auth.loadUser);app.use('/api/asana-review',require('../src/routes/asanaReview'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(session='',suffix='')=>fetch('http://127.0.0.1:'+server.address().port+'/api/asana-review'+suffix,{headers:{cookie:session}});
 assert.equal((await request()).status,401);assert.equal((await request(cookie(employee))).status,403);
 const ok=await request(cookie(admin));assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');
 assert.equal((await request(cookie(admin),'?date=2026-02-30')).status,400);
 for(const session of ['',cookie(employee)])assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/asana-review/refresh',{method:'POST',headers:{cookie:session,'content-type':'application/json'},body:'{}'})).status,session?403:401);
});
