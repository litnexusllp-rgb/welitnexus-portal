'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { reportWindow, buildReport, renderReport, pendingReason } = require('../src/eodReport');
const { createApi } = require('../src/eodApi');
const { configFromEnv, createScheduler } = require('../src/eodScheduler');
const ts = x => Date.parse(x);
const cutoff = ts('2026-09-18T03:00:00+05:30');
const window = reportWindow(cutoff);
const base = { gid: '1', name: 'Example', assignee: { gid: '10', name: 'Alice', email: 'alice@example.test' }, created_at: '2026-09-01T00:00:00Z', modified_at: '2026-09-17T15:00:00Z', num_subtasks: 0 };
const observations = { startedAt: cutoff, finishedAt: cutoff + 2000, projects: ['LIT Tasks'], warnings: [] };
const config = { enabled: true, channel: 'C123', projects: ['123'], userMap: { '10': 'U123' }, asanaToken: 'test', slackToken: 'test' };
const quiet = { info() {}, error() {} };

test('Slack read endpoints receive channel and pagination arguments in the URL', async () => {
  const api = createApi(config, async (url, options) => {
    const u = new URL(url);
    let body = { ok: true };
    if (u.hostname === 'slack.com') {
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      if (u.pathname.endsWith('/conversations.info')) {
        assert.equal(u.searchParams.get('channel'), config.channel);
        body.channel = { is_member: true, name: 'eod-reports' };
      }
      if (u.pathname.endsWith('/users.list')) {
        assert.equal(u.searchParams.get('limit'), '200');
        body = u.searchParams.has('cursor')
          ? { ok: true, members: [{ id: 'U456', profile: { email: 'new@example.test' } }] }
          : { ok: true, members: [], response_metadata: { next_cursor: 'page+2=' } };
        if (u.searchParams.has('cursor')) assert.equal(u.searchParams.get('cursor'), 'page+2=');
      }
    }
    return new Response(JSON.stringify(body));
  });
  assert.deepEqual(await api.check(), { ok: true, channel: 'eod-reports' });
  const result = await api.resolveUsers([{ assignee: { gid: '20', email: 'new@example.test' } }]);
  assert.equal(result.map['20'], 'U456');
});

test('03:00 IST workday boundary includes overnight work and excludes exact cutoff', () => {
  assert.equal(reportWindow(cutoff - 1).day, '2026-09-16');
  assert.equal(window.day, '2026-09-17');
  assert.equal(window.end - window.start, 86400000);
  assert.equal(window.sendAt, cutoff + 15 * 60000);
  const report = buildReport([
    { ...base, completed: true, completed_at: '2026-09-18T02:59:59+05:30' },
    { ...base, gid: '2', completed: true, completed_at: '2026-09-18T03:00:00+05:30' },
    { ...base, gid: '3', completed: true, completed_at: new Date(window.start).toISOString() },
    { ...base, gid: '4', completed: false, created_at: '2026-09-18T03:10:00+05:30' },
  ], window, observations, config.userMap);
  assert.equal(report.completed, 2);
  assert.equal(report.pending, 1);
});

test('pending categories, actor attribution, reasons and safe mentions', () => {
  const report = buildReport([
    { ...base, completed: false, due_on: '2026-09-17', notes: 'Blocker: Awaiting approval' },
    { ...base, gid: '2', completed: false, due_on: '2026-09-16', name: '<!channel> title' },
    { ...base, gid: '3', completed: false, assignee: null },
    { ...base, gid: '4', completed: true, completed_at: '2026-09-18T02:00:00+05:30', completed_by: { gid: '20', name: 'Manager' } },
  ], window, observations, config.userMap);
  const alice = report.groups[0];
  assert.equal(alice.due.length, 1); assert.equal(alice.overdue.length, 1);
  assert.equal(alice.due[0].reason, 'Awaiting approval');
  assert.equal(alice.overdue[0].reason, 'Reason not provided');
  const text = renderReport(report).join('\n');
  assert.match(text, /<@U123>/); assert.match(text, /marked complete by Manager/);
  assert.ok(!text.includes('<!channel>')); assert.match(text, /Projects: LIT Tasks/);
  assert.equal(pendingReason({ ...base, modified_at: new Date(cutoff + 1000).toISOString(), notes: 'Blocker: Later' }, cutoff), 'Reason not provided at cutoff');
});

test('report chunks include all tasks and stay below Slack size limit', () => {
  const tasks = Array.from({ length: 70 }, (_, i) => ({ ...base, gid: String(i + 1), name: 'Long task '.repeat(45), completed: false }));
  const messages = renderReport(buildReport(tasks, window, observations, config.userMap));
  assert.ok(messages.every(m => m.length <= 3500));
  for (const task of tasks) assert.ok(messages.some(m => m.includes(`/0/0/${task.gid}|`)));
});

test('Asana pagination, cross-project deduplication and old-parent subtasks', async () => {
  const seen = [];
  const fetchStub = async url => {
    const u = new URL(url); seen.push(u);
    let body;
    if (u.pathname.includes('/projects/')) body = { data: { name: 'Project' } };
    else if (u.pathname.endsWith('/subtasks')) body = { data: [{ ...base, gid: 'child', completed: false }] };
    else if (u.searchParams.get('offset')) body = { data: [{ ...base, gid: 'second' }] };
    else body = { data: [{ ...base, gid: 'parent', completed: true, completed_at: '2026-01-01T00:00:00Z', num_subtasks: 1 }], next_page: { offset: 'next' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const api = createApi({ ...config, projects: ['123', '456'] }, fetchStub);
  const result = await api.collect(window);
  assert.deepEqual(result.tasks.map(t => t.gid), ['parent', 'second', 'child']);
  assert.equal(result.tasks[0].projectNames.length, 2);
  assert.ok(seen.every(u => !u.searchParams.has('completed_since')));
});

test('Slack mapping uses exact email, never ambiguous names', async () => {
  const api = createApi({ ...config, userMap: {} }, async () => new Response(JSON.stringify({ ok: true, members: [
    { id: 'UOTHER', profile: { email: 'other@example.test', real_name: 'Alice' } },
    { id: 'UMATCH', profile: { email: 'alice@example.test' } },
  ] })), async () => {});
  const resolved = await api.resolveUsers([base]);
  assert.deepEqual(resolved.map, { '10': 'UMATCH' });
});

test('Slack ambiguous post is not retried; 429 honors retry-after', async () => {
  let calls = 0;
  const api = createApi(config, async () => { calls++; throw new Error('timeout'); }, async () => {});
  await assert.rejects(api.post('test'), e => e.ambiguous);
  assert.equal(calls, 1);
  const waits = []; calls = 0;
  const limited = createApi(config, async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : new Response('{"ok":true,"ts":"1"}'), async ms => waits.push(ms));
  await limited.post('test'); assert.deepEqual(waits, [2000]);
});

function fixture() {
  const db = new Database(':memory:');
  let now = cutoff - 60000; let captures = 0; const posted = [];
  const api = { collect: async () => { captures++; return { tasks: [{ ...base, completed: false }], projects: ['LIT Tasks'] }; }, resolveUsers: async () => ({ map: config.userMap, warnings: [] }),
    post: async (text, root) => { posted.push({ text, root }); return { ts: String(posted.length) }; }, wait: async () => {} };
  const make = () => createScheduler({ db, config, api, clock: () => now, log: quiet });
  const scheduler = make(); scheduler.activate();
  return { db, scheduler, api, posted, make, time: t => { now = t; }, captures: () => captures };
}

test('capture then restart delivers saved snapshot once after 03:15', async () => {
  const f = fixture();
  await f.scheduler.tick(); assert.equal(f.captures(), 0);
  f.time(cutoff); await f.scheduler.tick(); assert.equal(f.captures(), 1); assert.equal(f.posted.length, 0);
  f.time(cutoff + 15 * 60000); await f.make().tick();
  assert.equal(f.captures(), 1); assert.equal(f.posted.length, 2); assert.equal(f.posted[1].root, '1');
  await f.make().tick(); assert.equal(f.posted.length, 2);
  assert.equal(f.scheduler.status().reports[0].status, 'sent'); f.db.close();
});

test('late capture is disclosed and failed collection never produces an empty success', async () => {
  const f = fixture(); f.time(cutoff + 3600000);
  f.api.collect = async () => { throw new Error('unavailable'); };
  await f.scheduler.tick(); assert.equal(f.posted.length, 0); assert.equal(f.scheduler.status().reports.length, 0);
  f.api.collect = async () => ({ tasks: [base], projects: ['LIT Tasks'] });
  f.time(cutoff + 3900000);
  await f.scheduler.tick(); assert.match(f.posted[0].text, /Late collection/); f.db.close();
});

test('uncertain delivery stops for review instead of posting duplicate mentions', async () => {
  const f = fixture(); f.time(cutoff + 15 * 60000);
  let calls = 0; f.api.post = async () => { calls++; throw Object.assign(new Error('unknown'), { ambiguous: true }); };
  await f.scheduler.tick(); await f.make().tick();
  assert.equal(calls, 1); assert.equal(f.scheduler.status().reports[0].status, 'needs_review'); f.db.close();
});

test('a crash while sending also stops, and overlapping workers share a lease', async () => {
  const f = fixture(); f.time(cutoff); await f.scheduler.tick();
  f.db.prepare("INSERT INTO eod_deliveries(day,part,state,attempted_at) VALUES(?,0,'sending',?)").run(window.day, cutoff);
  f.time(cutoff + 15 * 60000); await f.make().tick(); assert.equal(f.posted.length, 0);
  assert.equal(f.scheduler.status().reports[0].status, 'needs_review'); f.db.close();
  const g = fixture(); g.time(cutoff);
  let finish; g.api.collect = () => new Promise(resolve => { finish = resolve; });
  const first = g.scheduler.tick(); await g.make().tick();
  finish({ tasks: [], projects: [] }); await first;
  assert.equal(g.scheduler.status().reports.length, 1); g.db.close();
});

test('config validates identities and defaults to disabled', () => {
  assert.equal(configFromEnv({}).enabled, false);
  assert.ok(configFromEnv({ ASANA_SLACK_USER_MAP: '{"1":"<!channel>"}' }).error);
});
