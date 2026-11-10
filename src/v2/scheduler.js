'use strict';

// Portal v2 background jobs (run inside the existing background worker):
//  * hourly: invoice payment reminders (only when SMTP is configured)
//  * every 15 minutes: refresh ICS calendar links
//  * hourly: purge expired sign-in challenges and OAuth states

function startV2Scheduler() {
  const { db } = require('../db');
  let running = false;
  async function tick(kind) {
    if (running) return;
    running = true;
    try {
      if (kind === 'hourly') {
        db.prepare('DELETE FROM int_admin_challenges WHERE expires_ts < ?').run(Date.now());
        db.prepare('DELETE FROM int_oauth_states WHERE expires_ts < ?').run(Date.now());
        const hour = Number(require('../time').now().toFormat('H'));
        if (hour === Number(process.env.INVOICE_REMINDER_HOUR || 10)) await require('../routes/billing').sendDueReminders();
      } else {
        await require('./calendar').refreshAllIcs();
      }
    } catch (e) { console.error('v2 scheduler:', e.message); } finally { running = false; }
  }
  const a = setInterval(() => tick('hourly'), 60 * 60 * 1000);
  const b = setInterval(() => tick('ics'), 15 * 60 * 1000);
  a.unref(); b.unref();
  return () => { clearInterval(a); clearInterval(b); };
}

module.exports = { startV2Scheduler };
