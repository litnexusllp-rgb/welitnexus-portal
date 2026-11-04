'use strict';

const { DateTime, ZONE } = require('./time');
const { createApi } = require('./eodApi');

const ACTIONS = {
  IN: 'clocked in',
  BREAK_START: 'started a break',
  BREAK_END: 'resumed work',
  OUT: 'clocked out',
};
function config(env = process.env) {
  if (env.SLACK_ATTENDANCE_ALERTS === 'off' || !env.SLACK_BOT_TOKEN || !/^[CG][A-Z0-9]+$/.test(env.SLACK_ATTENDANCE_CHANNEL || '')) return null;
  return { slackToken: env.SLACK_BOT_TOKEN, channel: env.SLACK_ATTENDANCE_CHANNEL };
}

function queueAttendanceAlert(db, id, name, type, ts, env = process.env) {
  if (!config(env)) return;
  db.prepare('INSERT INTO attendance_slack_alerts (event_id,employee_name,type,event_ts,next_ts) VALUES (?,?,?,?,?)')
    .run(id, name, type, ts, ts);
}

function message(alert) {
  const name = alert.employee_name.replace(/[\r\n\t]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const when = DateTime.fromMillis(alert.event_ts, { zone: ZONE }).toFormat('d LLL yyyy, h:mm a ZZZZ');
  return `${name} ${ACTIONS[alert.type]} · ${when}`;
}

function createDelivery(db, api, { clock = Date.now, log = console } = {}) {
  const next = db.prepare("SELECT event_id FROM attendance_slack_alerts WHERE status='PENDING' AND next_ts<=? ORDER BY next_ts,event_id LIMIT 1");
  const claim = db.prepare("UPDATE attendance_slack_alerts SET status='SENDING',attempts=attempts+1 WHERE event_id=? AND status='PENDING' RETURNING *");
  const sent = db.prepare("UPDATE attendance_slack_alerts SET status='SENT',slack_ts=?,last_error=NULL WHERE event_id=?");
  const fail = db.prepare('UPDATE attendance_slack_alerts SET status=?,next_ts=?,last_error=? WHERE event_id=?');
  let verifyAfter = 0;
  let verified = false;

  return async function deliverNext() {
    if (clock() >= verifyAfter) {
      try {
        const identity = await api.checkBot();
        if (!verified) log.info('[Attendance Slack] Authenticated Slack bot user', identity.botUserId);
        verified = true;
        verifyAfter = clock() + 5 * 60_000;
      } catch (error) {
        verified = false;
        verifyAfter = clock() + 60_000;
        log.warn('[Attendance Slack] Bot check failed:', error.message);
      }
    }
    if (!verified) return;
    const eligible = next.get(clock());
    if (!eligible) return;
    const alert = claim.get(eligible.event_id);
    if (!alert) return;
    try {
      const response = await api.post(message(alert));
      if (!response.ts) throw Object.assign(new Error('Slack did not return a message timestamp.'), { ambiguous: true });
      sent.run(response.ts, alert.event_id);
    } catch (error) {
      const review = error.ambiguous || alert.attempts >= 4;
      fail.run(review ? 'REVIEW' : 'PENDING', clock() + 60_000 * 2 ** (alert.attempts - 1), error.message, alert.event_id);
      log.warn('[Attendance Slack] Delivery', review ? 'needs review' : 'will retry', error.message);
    }
  };
}

function startAttendanceAlerts(db) {
  const settings = config();
  if (!settings) return async () => {};
  // The background scheduler owns the SQLite worker lock. An interrupted
  // write might already exist in Slack, so never replay it automatically.
  db.prepare("UPDATE attendance_slack_alerts SET status='REVIEW',last_error='Interrupted Slack delivery' WHERE status='SENDING'").run();
  const deliverNext = createDelivery(db, createApi(settings));
  let stopped = false, timer, running;
  function tick() {
    running = deliverNext().catch(error => console.error('[Attendance Slack] Worker error:', error.message)).finally(() => {
      if (!stopped) timer = setTimeout(tick, 1500);
    });
  }
  tick();
  return async () => { stopped = true; clearTimeout(timer); await running; };
}

module.exports = { config, queueAttendanceAlert, createDelivery, startAttendanceAlerts };
