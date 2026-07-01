'use strict';

// Daily Slack summary of everyone's worked hours + break. Posts to a Slack
// Incoming Webhook (SLACK_WEBHOOK_URL) on an internal schedule (SLACK_SUMMARY_HOUR,
// office timezone; default 3 AM). Because the 4 PM–2 AM shift crosses midnight,
// each person's total sums the previous calendar day and the small post-midnight
// tail of the current day — i.e. the whole overnight shift that just ended.

const { db } = require('./db');
const { now, todayStr, ZONE } = require('./time');
const { summarize } = require('./compute');

const activeUsers = db.prepare(`SELECT id, name, department FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE`);
const eventsForUserDay = db.prepare(`SELECT type, ts, day FROM events WHERE user_id = ? AND day = ? ORDER BY ts, id`);

const fmt = (m) => `${Math.floor(m / 60)}h ${m % 60}m`;

// Build the summary text (mrkdwn) for the shift ending this morning.
function buildDailySummary() {
  const today = todayStr();
  const yDt = now().minus({ days: 1 });
  const yesterday = yDt.toFormat('yyyy-LL-dd');
  const nowMs = now().toMillis();

  const lines = [];
  let totalWorked = 0;
  for (const u of activeUsers.all()) {
    const y = summarize(eventsForUserDay.all(u.id, yesterday), null);
    const t = summarize(eventsForUserDay.all(u.id, today), nowMs);
    const worked = y.workedMinutes + t.workedMinutes;
    const brk = y.breakMinutes + t.breakMinutes;
    if (worked > 0 || brk > 0) {
      lines.push(`• *${u.name}* — worked *${fmt(worked)}*, break ${fmt(brk)}`);
      totalWorked += worked;
    }
  }
  const dateLabel = yDt.toFormat('ccc, dd LLL yyyy');
  const header = `:bar_chart: *Attendance summary — night of ${dateLabel}*`;
  if (!lines.length) return `${header}\n_No one clocked in._`;
  return `${header}\n${lines.join('\n')}\n_Total worked across the team: *${fmt(totalWorked)}*_`;
}

async function postToSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true, reason: 'SLACK_WEBHOOK_URL not set' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return { ok: res.ok, status: res.status };
}

async function sendDailySummary() {
  return postToSlack(buildDailySummary());
}

// Fire sendDailySummary once a day at the configured hour (office timezone).
function startSlackScheduler() {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.log('Slack daily summary: disabled (SLACK_WEBHOOK_URL not set).');
    return;
  }
  const hour = Math.min(23, Math.max(0, Number(process.env.SLACK_SUMMARY_HOUR ?? 3)));
  const scheduleNext = () => {
    const n = now();
    let next = n.set({ hour, minute: 0, second: 0, millisecond: 0 });
    if (next <= n) next = next.plus({ days: 1 });
    setTimeout(async () => {
      try { const r = await sendDailySummary(); console.log('Slack daily summary sent:', JSON.stringify(r)); }
      catch (e) { console.error('Slack daily summary failed:', e.message); }
      scheduleNext();
    }, next.toMillis() - n.toMillis()).unref();
    console.log(`Slack daily summary scheduled for ${next.toFormat('yyyy-LL-dd HH:mm')} (${ZONE}).`);
  };
  scheduleNext();
}

module.exports = { buildDailySummary, sendDailySummary, startSlackScheduler };
