'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const clock = source.slice(source.indexOf('  async function renderClock()'),source.indexOf('  // Second confirmation for clocking out'));
const formatter = source.slice(source.indexOf('  const attendanceTime ='),source.indexOf('  // Friendly date:'));
function harness(status) {
  const card = {innerHTML:'',querySelectorAll:()=>[]}, live = {textContent:''};
  let interval, requests=0;
  const c = { $:sel=>sel==='#clockCard'?card:sel==='#liveClock'?live:null, api:{get:async()=>{requests++;return status;}},
    fmtMins:m=>String(m), esc:s=>String(s), toast:()=>{}, Date, clockTimer:null,
    clearInterval:()=>{},setInterval:fn=>{interval=fn;return 1;} };
  vm.createContext(c);vm.runInContext(clock,c);
  return {c,card,live,get interval(){return interval;},get requests(){return requests;}};
}
test('clock renders OUT for an open earlier workday and never invents IN at midnight', async()=>{
  const h=harness({state:'IN',valid:true,day:'2026-10-19',currentDay:'2026-10-20',timezone:'America/New_York',ongoing:true,workedMinutes:600,breakMinutes:30,allowed:['OUT','BREAK_START']});
  await h.c.renderClock();assert.match(h.card.innerHTML,/data-punch="OUT"/);assert.doesNotMatch(h.card.innerHTML,/data-punch="IN"/);
  assert.match(h.card.innerHTML,/2026-10-19/);assert.match(h.card.innerHTML,/America\/New_York/);assert.match(h.card.innerHTML,/ongoing session/);
  assert.equal(h.live.textContent,new Date().toLocaleTimeString([],{timeZone:'America/New_York'}));
  for(let i=0;i<30;i++)h.interval();await new Promise(r=>setImmediate(r));assert.equal(h.requests,2);
});
test('overnight BREAK exposes End Break and OUT; stale sessions visibly require review',async()=>{
  const h=harness({state:'BREAK',valid:true,day:'2026-10-19',currentDay:'2026-10-21',timezone:'Asia/Kolkata',ongoing:true,needsReview:true,workedMinutes:60,breakMinutes:15,allowed:['BREAK_END','OUT']});
  await h.c.renderClock();assert.match(h.card.innerHTML,/data-punch="BREAK_END"/);assert.match(h.card.innerHTML,/data-punch="OUT"/);
  assert.doesNotMatch(h.card.innerHTML,/data-punch="IN"/);assert.match(h.card.innerHTML,/open over 24 hours/);
});
test('attendance report formatting uses the specified workday timezone independently of the browser',()=>{
  const c={Date};vm.createContext(c);vm.runInContext(formatter,c);
  const ts=Date.parse('2026-11-01T04:20:00Z');
  const result=vm.runInContext(`attendanceTime(${ts},'America/Los_Angeles')`,c);
  const expected=new Date(ts).toLocaleString([],{timeZone:'America/Los_Angeles',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
  assert.equal(result,expected);assert.match(result,/31/);
});
