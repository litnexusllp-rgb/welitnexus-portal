'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const modalSource = source.slice(source.indexOf('  const PUNCH_LABEL ='), source.indexOf('  async function renderClock()'));
const approvalSource = source.slice(source.indexOf('  function punchApprovalTable('), source.indexOf('  function wireLeaveApprovals()'));
const settle = () => new Promise(resolve => setImmediate(resolve));
function element(value = '') {
  return { value, disabled:false, hidden:false, isConnected:true, textContent:'', dataset:{}, listeners:{},
    addEventListener(name, fn) { this.listeners[name] = fn; } };
}
function harness(get) {
  const elements = Object.fromEntries(['prDay','prOperation','prOriginal','prOriginalField','prType','prTime','prReason','prError','mCancel','mSend'].map(k=>[k,element()]));
  const posts = [], toasts = []; let closed = 0;
  const c = { $, modal, todayISO:()=> '2026-06-01', esc:s=>String(s), toast:(...args)=>toasts.push(args),
    closeModal:()=>{closed++;}, api:{get,post:async (url,payload)=>{posts.push({url,payload});}}, document:{} };
  function $(id) { return elements[id.slice(1)]; }
  function modal() { elements.prDay.value='2026-06-01'; elements.prOperation.value='EDIT'; elements.prType.value='IN'; elements.mSend.disabled=true; }
  vm.createContext(c); vm.runInContext(modalSource,c);
  vm.runInContext('loadMyPunchRequests = () => {};',c);
  c.openPunchRequestModal();
  return {c,e:elements,posts,toasts,get closed(){return closed;}};
}
test('employee selects the exact recorded break and submits an EDIT with target ID', async () => {
  const h=harness(async()=>({events:[{id:1,type:'BREAK_START',time:'10:00'},{id:2,type:'BREAK_START',time:'12:00'},{id:3,type:'OUT',time:'15:10'}]}));
  await settle();
  assert.equal(h.e.prOriginal.value,'3'); assert.equal(h.e.prType.disabled,true);
  h.e.prOriginal.value='2'; h.e.prOriginal.listeners.change(); h.e.prTime.value='11:50';
  await h.e.mSend.listeners.click();
  assert.equal(h.posts[0].payload.operation,'EDIT'); assert.equal(h.posts[0].payload.target_event_id,2);
  assert.equal(h.posts[0].payload.type,'BREAK_START'); assert.equal(h.posts[0].payload.time,'11:50'); assert.equal(h.closed,1);
  assert.equal(h.c.punchRequestAction({operation:'EDIT',original_time:'15:10'}),'Correct 15:10 →');
});
test('missing punches use ADD without any target ID', async () => {
  const h=harness(async()=>({events:[]})); await settle();
  assert.equal(h.e.prOperation.value,'ADD'); assert.equal(h.e.prType.disabled,false); assert.equal(h.e.prOriginalField.hidden,true);
  h.e.prType.value='OUT'; h.e.prTime.value='15:10'; await h.e.mSend.listeners.click();
  assert.equal(h.posts[0].payload.operation,'ADD'); assert.equal(h.posts[0].payload.target_event_id,undefined);
});
test('failed event loading disables submission and displays the server error', async () => {
  const h=harness(async()=>{throw Error('Unable to load punches');}); await settle();
  assert.equal(h.e.mSend.disabled,true); assert.equal(h.e.prError.textContent,'Unable to load punches');
  await h.e.mSend.listeners.click(); assert.equal(h.posts.length,0);
});
test('out-of-order day responses cannot submit the previous day’s event', async () => {
  const pending=[]; const h=harness(()=>new Promise(resolve=>pending.push(resolve)));
  h.e.prDay.value='2026-06-02'; const loading=h.e.prDay.listeners.change();
  pending[1]({events:[{id:22,type:'OUT',time:'15:10'}]}); await loading;
  pending[0]({events:[{id:11,type:'OUT',time:'15:00'}]}); await settle();
  assert.equal(h.e.prOriginal.value,'22'); h.e.prTime.value='14:10'; await h.e.mSend.listeners.click();
  assert.equal(h.posts[0].payload.day,'2026-06-02'); assert.equal(h.posts[0].payload.target_event_id,22);
});
test('submission failures retain the modal and reason; double submission is blocked', async () => {
  const h=harness(async()=>({events:[{id:3,type:'OUT',time:'15:10'}]})); await settle();
  h.e.prReason.value='Left early'; h.e.prTime.value='14:10'; let reject, calls=0;
  h.c.api.post=()=>{calls++;return new Promise((_resolve,r)=>{reject=r;});};
  const sending=h.e.mSend.listeners.click(); await h.e.mSend.listeners.click(); assert.equal(calls,1);
  reject(Error('Original punch not found')); await sending;
  assert.equal(h.closed,0); assert.equal(h.e.prReason.value,'Left early'); assert.equal(h.e.prError.textContent,'Original punch not found');
  assert.equal(h.e.mSend.disabled,false); assert.equal(h.e.prTime.value,'14:10');
});
test('admin approval keeps actionable validation errors and prevents duplicate clicks', async () => {
  const approve=element(), reject=element(); approve.dataset.preqApprove='1'; reject.dataset.preqReject='1';
  const buttons=[approve,reject]; for(const b of buttons)b.closest=()=>({querySelectorAll:()=>buttons});
  const toasts=[]; let fail, calls=0, navigations=0;
  const c={document:{querySelectorAll:()=>buttons,querySelector:()=>({dataset:{view:'dashboard'}})},
    api:{post:()=>{calls++;return new Promise((_resolve,r)=>{fail=r;});}},toast:m=>toasts.push(m),navigate:()=>{navigations++;}};
  vm.createContext(c);vm.runInContext(approvalSource,c);c.wirePunchApprovals();
  const sending=approve.listeners.click();await reject.listeners.click();assert.equal(calls,1);
  fail(Error('The original punch changed or was deleted. Cancel this request and submit a new correction.'));await sending;
  assert.match(toasts[0],/original punch changed/);assert.equal(navigations,0);assert.equal(approve.disabled,false);assert.equal(reject.disabled,false);
  c.api.post=async()=>({});await approve.listeners.click();assert.equal(navigations,1);assert.match(toasts[1],/attendance updated/);
});
