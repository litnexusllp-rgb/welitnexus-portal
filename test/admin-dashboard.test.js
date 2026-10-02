'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const dashboard=fs.readFileSync(path.join(__dirname,'../public/js/dashboard-announcement.js'),'utf8');
async function render(admin,failWork=false){
 const requests=[];let root;const old={style:{},parentNode:{insertBefore(r){root=r;}}};const main={querySelector:s=>s==='#dashCards'?old:null};
 const document={body:{classList:{contains:()=>admin}},documentElement:{},querySelector:()=>({dataset:{view:'dashboard'}}),getElementById:id=>id==='main'?main:id==='dashboardControlStyles'?{}:null,createElement:()=>({innerHTML:'',isConnected:true,querySelectorAll:()=>[]})};
 const context={document,MutationObserver:class{observe(){}},setTimeout(){},console,api:{get:async p=>{requests.push(p);if(p==='/asana/admin-work'&&failWork)throw Error('offline');if(p==='/asana/status')return {enabled:true};if(p==='/asana/admin-work'||p==='/asana/my-tasks')return {tasks:[{name:'Assigned work',assignee:'Saurav',projects:['Other project'],url:'https://app.asana.com/0/0/1'}]};if(p==='/operations')return {approvals:[{kind:'Achievement'},{kind:'Leave'}],asana:{counts:{overdue:3,unassigned:2}}};if(p.startsWith('/kpi/me'))return {rows:[{tasksDone:8}]};return {};}}};vm.createContext(context);vm.runInContext(dashboard.replace('  setTimeout(renderDashboard, 0);','  globalThis.renderTest = renderDashboard;'),context);await context.renderTest();return {html:root.innerHTML,requests};
}
test('admin replaces personal performance with review actions and shared owner work',async()=>{
 const r=await render(true);assert.ok(r.html.includes('Needs your attention'));assert.ok(!r.html.includes('My performance'));assert.ok(r.html.includes('Saurav'));assert.ok(r.html.includes('Other project'));assert.ok(r.requests.includes('/asana/admin-work'));assert.ok(!r.requests.some(p=>p.startsWith('/kpi/me')));
});
test('employee keeps own performance and own Asana endpoint',async()=>{
 const r=await render(false);assert.ok(r.html.includes('My performance'));assert.ok(!r.html.includes('Needs your attention'));assert.ok(r.requests.includes('/asana/my-tasks'));assert.ok(!r.requests.includes('/asana/admin-work'));assert.ok(!r.requests.includes('/operations'));
});
test('failed admin work read is not displayed as no open work',async()=>{
 const r=await render(true,true);assert.ok(r.html.includes('Unable to load work'));assert.ok(!r.html.includes('No open work.'));
});
test('shared admin work uses verified identities across projects and rejects employee access',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ems-admin-work-'));process.env.DB_PATH=path.join(dir,'test.db');process.env.JWT_SECRET='test-only';process.env.ASANA_TOKEN='test';
 const realFetch=global.fetch;const {db}=require('../src/db');const asana=require('../src/asana');let calls=0;
 global.fetch=async url=>{calls++;const q=new URL(url).searchParams;assert.equal(q.get('workspace'),'1211961678895256');assert.equal(q.get('project'),null);const owner=q.get('assignee');assert.ok(['1211961548870023','1211961768263720'].includes(owner));const t={gid:owner,name:'Task',completed:false,assignee:{gid:owner,name:'Owner'},projects:[{name:'Outside LIT Tasks'}]};return {ok:true,json:async()=>({data:[t,{...t,gid:'other',assignee:{gid:'999'}},{...t,gid:'done',completed:true}],next_page:owner==='1211961548870023'&&!q.get('offset')?{offset:'next'}:null})};};
 const [a,b]=await Promise.all([asana.adminWork(),asana.adminWork()]);assert.equal(a.tasks.length,2);assert.deepEqual(a,b);assert.equal(calls,3);assert.equal(a.tasks[0].projects[0],'Outside LIT Tasks');await asana.adminWork();assert.equal(calls,3);global.fetch=realFetch;
 const auth=require('../src/auth');const express=require('express');const app=express();app.use(require('cookie-parser')(),auth.loadUser);app.use('/api/asana',require('../src/routes/asana'));const add=role=>Number(db.prepare('INSERT INTO users(name,email,password_hash,role,created_ts) VALUES(?,?,?,?,0)').run(role,role+'@test.test','x',role).lastInsertRowid);const admin=add('ADMIN'),emp=add('EMPLOYEE');const cookie=id=>auth.COOKIE+'='+auth.issueToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
 const server=app.listen(0,'127.0.0.1');await new Promise((r,j)=>{server.once('listening',r);server.once('error',j);});t.after(async()=>{global.fetch=realFetch;await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});});const req=async session=>fetch(`http://127.0.0.1:${server.address().port}/api/asana/admin-work`,{headers:{cookie:session}});
 assert.equal((await req('')).status,401);assert.equal((await req(cookie(emp))).status,403);const response=await req(cookie(admin));assert.equal(response.status,200);assert.equal((await response.json()).tasks.length,2);
});
