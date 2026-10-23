'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const flow = source.slice(source.indexOf('  // Confirm both end-of-day updates'), source.indexOf("  $('#myProfileBtn').addEventListener"));
function harness(role = 'EMPLOYEE', post = async () => ({})) {
  let elements = {}, html = '', open = false, loggedOut = 0;
  const calls = [], errors = [];
  const button = () => ({ checked: false, disabled: false, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } });
  const logout = button();
  const context = {
    ME: { role }, clockTimer: 1, dashTimers: [2, 3], clearInterval() {},
    stopNotifications() {}, stopFridayReminder() {}, showLogin() { loggedOut++; },
    toast: (...args) => errors.push(args), closeModal() { open = false; },
    $: selector => selector === '#logoutBtn' ? logout : elements[selector.slice(1)],
    modal(markup) {
      html = markup; open = true;
      elements = Object.fromEntries(['signOutCheck', 'signOutCancel', 'signOutContinue'].map(id => [id, button()]));
      elements.signOutContinue.disabled = true;
    },
    api: { post: async url => { calls.push(url); return post(); } }
  };
  vm.createContext(context); vm.runInContext(flow, context);
  return {
    context, calls, errors,
    get html() { return html; }, get open() { return open; }, get loggedOut() { return loggedOut; },
    start: () => logout.listeners.click(),
    tick(value = true) { elements.signOutCheck.checked = value; elements.signOutCheck.listeners.change(); },
    next: () => elements.signOutContinue.listeners.click(),
    cancel: () => elements.signOutCancel.listeners.click(),
    get disabled() { return elements.signOutContinue.disabled; }
  };
}
test('both roles must tick two separate confirmations before a single sign-out request', async () => {
  for (const role of ['EMPLOYEE', 'ADMIN']) {
    const h = harness(role); h.start();
    assert.match(h.html, /1 of 2/); assert.match(h.html, /updated management on all pending files/);
    assert.equal(h.disabled, true); await h.next(); assert.deepEqual(h.calls, []);
    h.tick(); assert.equal(h.disabled, false); h.tick(false); assert.equal(h.disabled, true);
    h.tick(); await h.next();
    assert.match(h.html, /2 of 2/); assert.match(h.html, /updated my timesheet/);
    assert.equal(h.disabled, true); await h.next(); assert.deepEqual(h.calls, []);
    h.tick(); await h.next();
    assert.deepEqual(h.calls, ['/auth/logout']); assert.equal(h.loggedOut, 1);
    assert.equal(h.open, false); assert.equal(h.context.ME, null);
  }
});
test('cancelling either popup keeps the session and restarts with unchecked confirmations', async () => {
  for (const step of [0, 1]) {
    const h = harness(); h.start();
    if (step) { h.tick(); await h.next(); }
    h.tick(); h.cancel();
    assert.equal(h.open, false); assert.deepEqual(h.calls, []); assert.equal(h.loggedOut, 0);
    h.start(); assert.match(h.html, /1 of 2/); assert.equal(h.disabled, true);
    await h.next(); assert.deepEqual(h.calls, []);
  }
});
test('failed sign-out preserves the session and allows retry without duplicate requests in flight', async () => {
  let reject;
  const h = harness('EMPLOYEE', () => new Promise((_resolve, fail) => { reject = fail; }));
  h.start(); h.tick(); await h.next(); h.tick();
  const sending = h.next(); await h.next();
  assert.equal(h.calls.length, 1); assert.equal(h.disabled, true); assert.equal(h.loggedOut, 0);
  reject(new Error('Connection lost')); await sending;
  assert.equal(h.loggedOut, 0); assert.ok(h.context.ME); assert.equal(h.disabled, false);
  assert.deepEqual(h.errors, [['Connection lost', true]]);
  h.context.api.post = async url => h.calls.push(url);
  await h.next(); assert.equal(h.loggedOut, 1); assert.equal(h.calls.length, 2);
});
