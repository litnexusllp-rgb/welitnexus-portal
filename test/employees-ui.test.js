'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const workspace = source.slice(source.indexOf('  let myPerfMonth ='), source.indexOf('  async function loadMyPerf()'));
function harness(admin) {
  const elements = {}, calls = [], salaries = [];
  let html = '';
  function element(id) {
    return elements[id] ||= { innerHTML: '', value: '', dataset: {}, isConnected: true, listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; }, querySelectorAll() { return []; } };
  }
  const me = { id: 1, name: 'Admin', role: admin ? 'ADMIN' : 'EMPLOYEE', active: 1 };
  const users = [me, { id: 2, name: '<Employee Two>', role: 'EMPLOYEE', active: 1, email: 'two@example.test' }, { id: 3, name: 'Former', role: 'EMPLOYEE', active: 0 }];
  const esc = value => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const c = { VIEWS: {}, ME: me, isAdmin: () => admin, thisMonthISO: () => '2026-12', employeeSection: 'employeePerformance', esc, cap: value => value, fmtDate: value => value || '—', exitTag: () => '',
    setMain(title, sub, body) { html = body; element('employeesRoot'); },
    $: selector => element(selector.slice(1)), document: { getElementById: () => null },
    api: { get: async url => { calls.push(url); return { users }; } },
    window: { Salaries: { mount: async (root, options) => salaries.push(options) } },
    loadMyPerf: async () => calls.push('performance'), loadEmployeeLeaveDetails: async () => calls.push('leave'),
    loadEmployees: records => calls.push(['manage', records]), mountTeamLeaves: () => calls.push('team'),
    openEmployeeModal() {}, openMyProfile() {}, openPasswordModal() {}, openApplyLeave() {} };
  vm.createContext(c); vm.runInContext(workspace, c);
  return { c, calls, salaries, elements, get html() { return elements.employeesRoot?.innerHTML || html; } };
}

test('Employees keeps all sections on one page, with role-specific actions and selected salary', async () => {
  for (const admin of [true, false]) {
    const h = harness(admin); await h.c.VIEWS.employees();
    const order = ['employeePerformance', 'employeeLeaves', ...(admin ? ['employeeSalary'] : []), 'employeePersonal'];
    assert.ok(order.every((id, i) => i === 0 || h.html.indexOf(`id="${id}"`) > h.html.indexOf(`id="${order[i - 1]}"`)));
    if (admin) {
      assert.ok(h.html.includes('Mark leave')); assert.ok(!h.html.includes('Apply for leave'));
      assert.equal(h.elements.perfUser.value, '2'); assert.equal(h.salaries[0].userId, 2); assert.equal(h.salaries[0].month, '2026-12');
      assert.ok(h.calls.includes('team')); assert.ok(h.elements.employeeProfile.innerHTML.includes('&lt;Employee Two&gt;'));
      h.elements.perfUser.value = '3'; await h.elements.perfUser.listeners.change({ target: h.elements.perfUser });
      assert.equal(h.salaries.at(-1).userId, 3); assert.ok(h.elements.employeeProfile.innerHTML.includes('Former'));
      await h.elements.employeeSalaryScope.listeners.click(); assert.equal(h.salaries.at(-1).userId, null);
      h.salaries.at(-1).onMonthChange('2027-02'); assert.equal(h.elements.perfMonth.value, '2027-02');
    } else {
      assert.ok(h.html.includes('Apply for leave')); assert.ok(!h.html.includes('employeeSalary'));
      assert.ok(!h.html.includes('Manage all employees')); assert.ok(!h.html.includes('perfUser')); assert.equal(h.salaries.length, 0);
      assert.ok(!h.calls.includes('/users/manage')); assert.ok(!h.calls.includes('team'));
    }
  }
});

test('performance ignores responses for an earlier employee or month and a detached page', async () => {
  const performance = source.slice(source.indexOf('  async function loadMyPerf()'), source.indexOf('  // Month grid:'));
  const pending = [], rendered = [], host = { innerHTML: '', isConnected: true }, cards = { innerHTML: '' };
  const c = { performanceVersion: 0, myPerfMonth: '2026-12', myPerfUserId: '2', isAdmin: () => true,
    $: selector => selector === '#myCal' ? host : cards, api: { get: () => new Promise(resolve => pending.push(resolve)) },
    renderMyCalendar: report => rendered.push(report.marker), statCard: () => '', esc: String, Date };
  vm.createContext(c); vm.runInContext(performance, c);
  const first = c.loadMyPerf(); c.myPerfUserId = '3'; const second = c.loadMyPerf();
  pending[2]({ rows: [] }); pending[3]({ marker: 'current' }); await second;
  pending[0]({ rows: [] }); pending[1]({ marker: 'stale employee' }); await first;
  assert.deepEqual(rendered, ['current']);
  const third = c.loadMyPerf(); c.myPerfMonth = '2027-02'; pending[4]({ rows: [] }); pending[5]({ marker: 'stale month' }); await third;
  const fourth = c.loadMyPerf(); host.isConnected = false; pending[6]({ rows: [] }); pending[7]({ marker: 'detached' }); await fourth;
  assert.deepEqual(rendered, ['current']);
});
