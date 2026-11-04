'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const dashboard=fs.readFileSync(path.join(__dirname,'../public/js/dashboard-announcement.js'),'utf8');
async function render(admin, failWork = false, asanaEnabled = true) {
 const requests = [];
 const details = { isConnected: true, addEventListener(_name, load) { this.load = load; }, removeEventListener() {} };
 const root = { innerHTML: '', isConnected: true, removeAttribute() {}, querySelector: () => details };
 const read = async endpoint => {
  requests.push(endpoint);
  if (endpoint === '/operations/dashboard-approvals') return { late: 2, leave: 3, punch: 4 };
  if (endpoint === '/attendance/today') return { people: [{ state: 'IN' }, { state: 'BREAK' }] };
  if (endpoint === '/attendance/status') return { state: 'BREAK', workedMinutes: 120, breakMinutes: 20 };
  if (endpoint === '/announcements') return { announcements: [{ title: 'Important notice', pinned: 1 }] };
  if (endpoint === '/asana/status') return { enabled: asanaEnabled };
  if (failWork) throw Error('offline');
  const tasks = [4, 2, 1, 3].map(n => asanaEnabled ? { name: 'Task ' + n, due_on: '2099-01-0' + n } : { title: 'Task ' + n, due_date: '2099-01-0' + n });
  return { tasks };
 };
 const context = { window: {} };
 vm.createContext(context); vm.runInContext(dashboard, context);
 let openedTeam = 0;
 await context.window.Dashboard.render(root, { admin, read, openTeam: () => openedTeam++ });
 return { html: root.innerHTML, requests, expand: () => { details.open = true; details.load(); return openedTeam; } };
}
test('admin dashboard uses compact approval counts and defers live attendance details', async () => {
 const r = await render(true);
 assert.ok(r.html.indexOf('Needs attention') < r.html.indexOf('Team today'));
 assert.match(r.html, /<strong>2<\/strong><span>Late explanations/);
 assert.match(r.html, /<strong>3<\/strong><span>Leave requests/);
 assert.match(r.html, /<strong>4<\/strong><span>Punch corrections/);
 assert.deepEqual(r.requests, ['/operations/dashboard-approvals', '/attendance/today']);
 assert.equal(r.expand(), 1);
});
test('staff dashboard shows clock status, the next three tasks and one pinned notice', async () => {
 for (const asana of [true, false]) {
  const r = await render(false, false, asana);
  assert.match(r.html, /On break/);
  assert.match(r.html, /Open Clock/);
  assert.match(r.html, /Pinned notice/);
  assert.ok(r.html.indexOf('Task 1') < r.html.indexOf('Task 3'));
  assert.doesNotMatch(r.html, /Task 4|Needs attention|Leave balance/);
  assert.ok(r.requests.includes(asana ? '/asana/my-tasks' : '/tasks/mine'));
  assert.ok(!r.requests.includes(asana ? '/tasks/mine' : '/asana/my-tasks'));
 }
});
test('employee workspace loads secondary team leave views when opened', async () => {
 const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
 const view=source.slice(source.indexOf('  function mountTeamLeaves()'),source.indexOf('  async function refreshEmployeeLeaveData()'));
 const loads=[],actions=[];
 const team = { open: false, addEventListener(event, handler) { this[event] = handler; } };
 const c={$:s=>s === '#employeeTeamLeave' ? team : {addEventListener:()=>actions.push(s)},openMarkLeaveModal(){},loadOnLeave:()=>loads.push('upcoming'),loadLeaveSummary:()=>loads.push('balances')};
 vm.createContext(c);vm.runInContext(view,c);c.mountTeamLeaves();
 assert.deepEqual(loads,[]);assert.deepEqual(actions,['#markLeaveBtn','#flagAbsBtn']);
 team.open = true; team.toggle();
 assert.deepEqual(loads,['upcoming','balances']);
});
test('failed staff task read is shown as unavailable',async()=>{
 const r=await render(false,true);assert.ok(r.html.includes('Tasks are unavailable'));assert.ok(!r.html.includes('no open tasks'));
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
