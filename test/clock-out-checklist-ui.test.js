'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const flow = source.slice(source.indexOf('  function confirmClockOut(status)'), source.indexOf('  async function punch(type)'));
function harness(allowed = ['OUT', 'BREAK_START']) {
  let elements, html, closed = 0;
  const punches = [];
  const c = {
    $: s => elements[s.slice(1)],
    modal(s) {
      html = s;
      elements = Object.fromEntries([...s.matchAll(/id="(co\w+)"/g)].map(([_, id]) => [id, {
        checked: false, disabled: id === 'coConfirm', listeners: {},
        addEventListener(event, callback) { this.listeners[event] = callback; }
      }]));
    },
    closeModal: () => { closed++; }, punch: type => punches.push(type)
  };
  vm.createContext(c); vm.runInContext(flow, c);
  const open = () => c.confirmClockOut({ allowed }); open();
  return { open, punches, get html() { return html; }, get closed() { return closed; },
    get disabled() { return elements.coConfirm.disabled; },
    tick(id, checked = true) { elements[id].checked = checked; elements[id].listeners.change(); },
    click(id) { elements[id].listeners.click(); }
  };
}
test('clock-out requires both ticks from a working shift and from a break', () => {
  for (const allowed of [['OUT', 'BREAK_START'], ['BREAK_END', 'OUT']]) {
    const h = harness(allowed);
    assert.match(h.html, /updated management on all pending files/); assert.match(h.html, /updated my timesheet/);
    assert.equal(h.disabled, true); h.click('coConfirm'); assert.deepEqual(h.punches, []);
    h.tick('coFiles'); assert.equal(h.disabled, true); h.click('coConfirm'); assert.deepEqual(h.punches, []);
    h.tick('coFiles', false); h.tick('coTimesheet'); assert.equal(h.disabled, true);
    h.tick('coFiles'); assert.equal(h.disabled, false);
    h.tick('coTimesheet', false); assert.equal(h.disabled, true);
    h.tick('coTimesheet'); h.click('coConfirm'); h.click('coConfirm');
    assert.deepEqual(h.punches, ['OUT']); assert.equal(h.closed, 1);
  }
});
test('cancel does not punch and a new clock-out attempt requires fresh ticks', () => {
  const h = harness(); h.tick('coFiles'); h.tick('coTimesheet'); h.click('coCancel');
  assert.deepEqual(h.punches, []); h.open(); assert.equal(h.disabled, true);
  h.click('coConfirm'); assert.deepEqual(h.punches, []);
});
test('Start Break still works without making clock-out confirmations', () => {
  const h = harness(); h.click('coBreak'); assert.deepEqual(h.punches, ['BREAK_START']);
  const onBreak = harness(['BREAK_END', 'OUT']); assert.doesNotMatch(onBreak.html, /id="coBreak"/);
});
