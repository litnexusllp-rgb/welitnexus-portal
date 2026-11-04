'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const nav=app.slice(app.indexOf('  // ---------- navigation ----------'), app.indexOf('  function setMain('));
function harness(hash='#/myperf',admin=false){
  const listeners={},renders=[],history=[];
  const links=[...html.matchAll(/<a class="nav-item[^>]*data-view="([a-z]+)" href="([^\"]+)"/g)].map(m=>({dataset:{view:m[1]},textContent:m[1],attrs:{},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}}));
  const window={location:{hash},history:Object.fromEntries(['pushState','replaceState'].map(type=>[type,(_a,_b,url)=>{history.push(type);window.location.hash=url;}])),addEventListener:(k,v)=>listeners[k]=v};
  const c={window,document:{querySelectorAll:()=>links,querySelector:()=>links.find(l=>l.attrs['aria-current']),title:''},$ :s=>s === "#nav" ? {addEventListener:(k,v)=>listeners[k]=v,querySelectorAll:()=>[]} : null,ME:{role:admin?'ADMIN':'EMPLOYEE'},isAdmin:()=>admin,VIEWS:{...Object.fromEntries(links.map(l=>[l.dataset.view,()=>renders.push(l.dataset.view)])),myperf(){},leaves(){},salaries(){}},clockTimer:null,dashTimers:[],DASH_LIVE:null,clearInterval(){},closeModal(){}};
  vm.createContext(c);vm.runInContext(nav,c);
  return {c,links,listeners,renders,history};
}
test('each sidebar section is a native link with a distinct address',()=>{
 const h=harness();assert.equal(h.links.length,15);for(const l of h.links)assert.ok(html.includes(`href="#/${l.dataset.view}"`));
 assert.match(app,/navigate\(viewFromAddress\(\), true\)/);
});
test('deep links, refresh and history restore the requested section',()=>{
 const h=harness();h.c.navigate(h.c.viewFromAddress(),true);assert.deepEqual(h.renders,['employees']);
 h.c.navigate('calendar');assert.equal(h.c.window.location.hash,'#/calendar');assert.deepEqual(h.history,['replaceState','pushState']);
 h.c.window.location.hash='#/myperf';h.listeners.hashchange();assert.equal(h.renders.at(-1),'employees');assert.equal(h.history.length,3);
 assert.match(h.c.document.title,/employees/);
});
test('modifier and middle clicks remain native and do not change this tab',()=>{
 const h=harness();let prevented=0;
 for(const key of ['metaKey','ctrlKey','shiftKey','altKey','middle'])h.listeners.click({target:{closest:()=>h.links[0]},button:key==='middle'?1:0,[key]:true,preventDefault(){prevented++;}});
 assert.equal(prevented,0);assert.equal(h.renders.length,0);
 h.listeners.click({target:{closest:()=>h.links[0]},button:0,preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(h.renders[0],'dashboard');
});
test('unknown and admin-only routes fall back safely; signed-out links survive login',()=>{
 const h=harness('#/bonuses');h.c.navigate(h.c.viewFromAddress(),true);assert.equal(h.renders[0],'dashboard');assert.equal(h.history[0],'replaceState');
 h.c.navigate('constructor');assert.equal(h.renders.at(-1),'dashboard');
 h.c.ME=null;h.c.window.location.hash='#/myperf';h.listeners.hashchange();assert.equal(h.c.window.location.hash,'#/myperf');
 h.c.ME={role:'EMPLOYEE'};h.c.navigate(h.c.viewFromAddress(),true);assert.equal(h.renders.at(-1),'employees');
 const a=harness('#/bonuses',true);a.c.navigate(a.c.viewFromAddress(),true);assert.equal(a.renders[0],'bonuses');
 const salaries=harness('#/salaries');salaries.c.navigate(salaries.c.viewFromAddress(),true);assert.equal(salaries.renders[0],'employees');
 const adminSalaries=harness('#/salaries',true);adminSalaries.c.navigate(adminSalaries.c.viewFromAddress(),true);assert.equal(adminSalaries.renders[0],'employees');
});

test('legacy employee links select their new section and canonicalize the address',()=>{
  for(const [route,section] of [['myperf','employeePerformance'],['leaves','employeeLeaves'],['salaries','employeeSalary']]){
    const h=harness('#/'+route,true);h.c.navigate(h.c.viewFromAddress(),true);
    assert.equal(h.c.window.location.hash,'#/employees');assert.equal(h.renders[0],'employees');
    assert.equal(vm.runInContext('employeeSection',h.c),section);
  }
  assert.equal((html.match(/data-view="employees"/g)||[]).length,1);
  for(const old of ['myperf','leaves','salaries'])assert.ok(!html.includes(`data-view="${old}"`));
});
