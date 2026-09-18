'use strict';

const { randomUUID } = require('crypto');
const { createApi } = require('./eodApi');
const { reportWindow, buildReport, renderReport } = require('./eodReport');

function configFromEnv(env = process.env) {
  const config = { enabled: env.EOD_ENABLED === 'true', asanaToken: env.ASANA_TOKEN, slackToken: env.SLACK_BOT_TOKEN,
    channel: env.SLACK_EOD_CHANNEL || '', projects: (env.ASANA_EOD_PROJECT_GIDS || '').split(',').map(s => s.trim()).filter(Boolean), userMap: {} };
  try { config.userMap = JSON.parse(env.ASANA_SLACK_USER_MAP || '{}'); } catch (_) { config.error = 'ASANA_SLACK_USER_MAP must be a JSON object'; }
  if (!config.userMap || Array.isArray(config.userMap) || typeof config.userMap !== 'object' || Object.entries(config.userMap).some(([k, v]) => !/^\d+$/.test(k) || !/^[UW][A-Z0-9]+$/.test(v))) config.error = 'Invalid Asana to Slack mapping';
  if (!config.asanaToken || !config.slackToken || !/^C[A-Z0-9]+$/.test(config.channel) || !config.projects.length || config.projects.some(p => !/^\d+$/.test(p))) config.error = 'Set ASANA_TOKEN, SLACK_BOT_TOKEN, SLACK_EOD_CHANNEL and ASANA_EOD_PROJECT_GIDS';
  return config;
}

function createScheduler({ db, config, api = createApi(config), clock = Date.now, log = console }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eod_state (id INTEGER PRIMARY KEY CHECK(id=1), enabled_since INTEGER NOT NULL, lease_owner TEXT, lease_until INTEGER DEFAULT 0, last_error TEXT, last_attempt INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS eod_reports (day TEXT PRIMARY KEY, channel TEXT NOT NULL, captured_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL, messages_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready', error TEXT);
    CREATE TABLE IF NOT EXISTS eod_deliveries (day TEXT NOT NULL, part INTEGER NOT NULL, state TEXT NOT NULL, slack_ts TEXT, attempted_at INTEGER NOT NULL, error TEXT, PRIMARY KEY(day, part));
  `);
  let busy = false;
  const owner = randomUUID();
  const row = day => db.prepare('SELECT * FROM eod_reports WHERE day=?').get(day);
  const delivery = (day, part) => db.prepare('SELECT * FROM eod_deliveries WHERE day=? AND part=?').get(day, part);
  const ownLease = () => {
    const r = db.prepare('SELECT lease_owner, lease_until FROM eod_state WHERE id=1').get();
    if (r?.lease_owner !== owner || r.lease_until < clock()) throw new Error('EOD lease lost');
  };

  function activate() {
    if (config.enabled && !config.error) db.prepare('INSERT OR IGNORE INTO eod_state(id,enabled_since) VALUES(1,?)').run(clock());
  }

  async function capture(window) {
    if (row(window.day)) return;
    const startedAt = clock();
    const { tasks, projects } = await api.collect(window);
    const { map, warnings } = await api.resolveUsers(tasks);
    const report = buildReport(tasks, window, { startedAt, finishedAt: clock(), projects, warnings }, map);
    const messages = renderReport(report);
    ownLease();
    db.prepare('INSERT OR IGNORE INTO eod_reports(day,channel,captured_at,snapshot_json,messages_json) VALUES(?,?,?,?,?)')
      .run(window.day, config.channel, clock(), JSON.stringify(report), JSON.stringify(messages));
    log.info(`[EOD] Saved ${window.day}: ${report.completed} completed, ${report.pending} pending`);
  }

  async function publish(window) {
    const report = row(window.day);
    if (!report || ['sent', 'needs_review'].includes(report.status)) return;
    // Never redirect a saved report to a newly configured destination.
    if (report.channel !== config.channel) throw new Error('EOD channel changed since capture');
    const messages = JSON.parse(report.messages_json);
    let rootTs = delivery(window.day, 0)?.slack_ts;
    for (let part = 0; part < messages.length; part++) {
      ownLease();
      const previous = delivery(window.day, part);
      if (previous?.state === 'sent') { if (part === 0) rootTs = previous.slack_ts; continue; }
      if (previous && ['sending', 'unknown'].includes(previous.state)) {
        // A timeout/crash after Slack accepted a post cannot be safely retried.
        // Stop and expose it for administrator reconciliation instead of duplicating mentions.
        db.prepare("UPDATE eod_reports SET status='needs_review',error=? WHERE day=?").run(`Delivery part ${part} needs review in Slack`, window.day);
        return;
      }
      if (previous && clock() - previous.attempted_at < 5 * 60000) return;
      db.prepare("INSERT INTO eod_deliveries(day,part,state,attempted_at) VALUES(?,?,'sending',?) ON CONFLICT(day,part) DO UPDATE SET state='sending',attempted_at=excluded.attempted_at,error=NULL").run(window.day, part, clock());
      try {
        const result = await api.post(messages[part] + `\n_EOD ${window.day} · ${part + 1}/${messages.length}_`, part ? rootTs : null);
        if (!result.ts) throw Object.assign(new Error('Slack did not return a message timestamp'), { ambiguous: true });
        ownLease();
        db.prepare("UPDATE eod_deliveries SET state='sent',slack_ts=?,error=NULL WHERE day=? AND part=?").run(result.ts, window.day, part);
        if (part === 0) rootTs = result.ts;
      } catch (e) {
        ownLease();
        const state = e.ambiguous ? 'unknown' : 'failed';
        db.prepare('UPDATE eod_deliveries SET state=?,error=? WHERE day=? AND part=?').run(state, e.message, window.day, part);
        db.prepare('UPDATE eod_reports SET status=?,error=? WHERE day=?').run(e.ambiguous ? 'needs_review' : 'retrying', e.message, window.day);
        throw e;
      }
      await api.wait(1100); // Slack permits approximately one message per second per channel.
    }
    db.prepare("UPDATE eod_reports SET status='sent',error=NULL WHERE day=?").run(window.day);
    log.info(`[EOD] Delivered ${window.day} to configured Slack channel`);
  }

  async function tick() {
    if (busy || !config.enabled || config.error) return;
    activate();
    const w = reportWindow(clock());
    const state = db.prepare('SELECT * FROM eod_state WHERE id=1').get();
    if (w.end < state.enabled_since) return; // Start with next cutoff; no unsolicited historical backfill.
    if (state.last_error && clock() - state.last_attempt < 5 * 60000) return;
    const acquired = db.prepare('UPDATE eod_state SET lease_owner=?,lease_until=? WHERE id=1 AND lease_until<?').run(owner, clock() + 120000, clock());
    if (!acquired.changes) return;
    busy = true;
    const keepLease = setInterval(() => {
      try { db.prepare('UPDATE eod_state SET lease_until=? WHERE id=1 AND lease_owner=?').run(clock() + 120000, owner); } catch (_) { /* next ownership check stops work */ }
    }, 15000);
    keepLease.unref();
    try {
      db.prepare('UPDATE eod_state SET last_attempt=? WHERE id=1').run(clock());
      await capture(w);
      if (clock() >= w.sendAt) await publish(w);
      db.prepare('UPDATE eod_state SET last_error=NULL WHERE id=1').run();
    } catch (e) {
      db.prepare('UPDATE eod_state SET last_error=? WHERE id=1').run(e.message);
      log.error('[EOD] ' + e.message);
    }
    finally {
      clearInterval(keepLease);
      db.prepare('UPDATE eod_state SET lease_until=0,lease_owner=NULL WHERE id=1 AND lease_owner=?').run(owner);
      busy = false;
    }
  }

  function status() {
    const state = db.prepare('SELECT enabled_since,last_error,last_attempt FROM eod_state WHERE id=1').get();
    return { enabled: config.enabled, configured: !config.error, configurationError: config.error || null, timezone: 'Asia/Kolkata', captureTime: '03:00', sendTime: '03:15',
      channel: config.channel, projects: config.projects, enabledSince: state?.enabled_since || null,
      lastError: state?.last_error || null, lastAttempt: state?.last_attempt || null,
      reports: db.prepare('SELECT day,status,captured_at,error FROM eod_reports ORDER BY day DESC LIMIT 14').all() };
  }

  function start() {
    activate();
    if (!config.enabled || config.error) { log.info('[EOD] Disabled or missing configuration'); return; }
    tick();
    const timer = setInterval(tick, 30000); timer.unref();
    log.info('[EOD] Daily capture 03:00 IST; Slack delivery 03:15 IST');
    return timer;
  }
  const check = async () => { if (config.error) throw new Error(config.error); return api.check(); };
  const preview = async () => {
    if (config.error) throw new Error(config.error);
    const w = reportWindow(clock()); const startedAt = clock();
    const { tasks, projects } = await api.collect(w);
    const { map, warnings } = await api.resolveUsers(tasks);
    const report = buildReport(tasks, w, { startedAt, finishedAt: clock(), projects, warnings }, map);
    return { preview: true, message: 'Live read only; not sent, not an historical cutoff snapshot.', report, messages: renderReport(report) };
  };
  return { start, tick, status, check, preview, activate };
}

let singleton;
function getScheduler() {
  if (!singleton) singleton = createScheduler({ db: require('./db').db, config: configFromEnv() });
  return singleton;
}
module.exports = { configFromEnv, createScheduler, getScheduler };
