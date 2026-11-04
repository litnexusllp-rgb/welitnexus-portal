'use strict';
const router = require('express').Router();
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const asana = require('../asana');
const { now, DateTime, ZONE } = require('../time');
const { config: attendanceSlackConfig } = require('../attendanceSlack');
const { createApi } = require('../eodApi');

router.use(requireAdmin);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/dashboard-approvals', (_req, res) => {
  res.json(db.prepare(`SELECT
    (SELECT COUNT(*) FROM late_explanations WHERE status='PENDING') AS late,
    (SELECT COUNT(*) FROM leaves WHERE status='PENDING') AS leave,
    (SELECT COUNT(*) FROM punch_requests WHERE status='PENDING') AS punch`).get());
});
router.get('/attendance-slack/check', require('../asyncRoute')(async (_req, res) => {
  const settings = attendanceSlackConfig();
  if (!settings) return res.status(503).json({ ok: false, error: 'Attendance Slack alerts are disabled or missing the Slack bot token or Attendance channel.' });
  try { res.json({ ok: true, channelId: settings.channel, ...await createApi(settings).checkBot() }); }
  catch (error) { res.status(502).json({ ok: false, error: error.message }); }
}));
router.get('/', require('../asyncRoute')(async (_req, res) => {
  const observedAt = now(); const today = observedAt.toISODate();
  // Deliberately read only: decisions continue through their existing validated routes.
  const approvals = [
    ...db.prepare("SELECT a.id,u.name,a.title,a.created_ts,'Achievement' AS kind,'achievements' AS view FROM achievements a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
    ...db.prepare("SELECT a.id,u.name,a.start_date || ' – ' || a.end_date AS title,a.created_ts,'Leave' AS kind,'leaves' AS view FROM leaves a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
    ...db.prepare("SELECT a.id,u.name,a.day || ' ' || a.time || ' ' || a.type AS title,a.created_ts,'Punch correction' AS kind,'clock' AS view FROM punch_requests a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
    ...db.prepare("SELECT a.id,u.name,a.day AS title,a.created_ts,'Late explanation' AS kind,'late-requests' AS view FROM late_explanations a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
  ].sort((a,b) => a.created_ts-b.created_ts).map(a => ({ ...a, waitingDays: Math.max(0,Math.floor((observedAt.toMillis()-a.created_ts)/86400000)) }));
  const result = { observedAt: observedAt.toISO(), timezone: ZONE, today, approvals,
    asana: { state: 'disabled', scope: 'LIT Tasks project-member tasks; subtasks only when also project members', tasks: null, counts: null },
    slack: {
      attendanceConfigured: Boolean(attendanceSlackConfig()),
      attendancePending: db.prepare("SELECT COUNT(*) AS count FROM attendance_slack_alerts WHERE status IN ('PENDING','SENDING')").get().count,
      attendanceReview: db.prepare("SELECT COUNT(*) AS count FROM attendance_slack_alerts WHERE status='REVIEW'").get().count,
      eodEnabled: process.env.EOD_ENABLED === 'true',
    },
    bonuses: db.prepare(`SELECT u.id,u.name,MAX(b.month) AS lastMonth FROM users u LEFT JOIN bonuses b ON b.user_id=u.id AND b.voided_ts IS NULL WHERE u.active=1 GROUP BY u.id ORDER BY lastMonth IS NOT NULL,lastMonth,u.name`).all() };
  if (asana.enabled()) {
    const status = asana.syncStatus();
    if (status.project !== '1215327082632826') result.asana = { ...result.asana, state: 'error', error: 'Configure ASANA_PROJECT_GID for LIT Tasks before using this dashboard.' };
    else try {
      const tasks = await asana.allTasks();
      const pending = tasks.filter(t=>!t.completed).map(t => {
        const dueAt = t.due_at ? DateTime.fromISO(t.due_at,{zone:ZONE}) : null;
        const due = dueAt?.isValid ? dueAt.toISODate() : t.due_on || '';
        return { gid:t.gid, name:t.name || '(Untitled task)', assignee:t.assignee?.name || 'Unassigned',
          unassigned: !t.assignee, due, overdue: dueAt?.isValid ? dueAt.toMillis()<observedAt.toMillis() : !!due && due<today,
          dueToday:due===today, missingDue:!due, modifiedAt:t.modified_at || null,
          // Construct links from IDs, never from untrusted task content.
          url:`https://app.asana.com/0/1215327082632826/${encodeURIComponent(t.gid)}` };
      }).sort((a,b)=>Number(b.overdue)-Number(a.overdue)||Number(b.unassigned)-Number(a.unassigned)||String(a.due||'9999').localeCompare(b.due||'9999'));
      result.asana = { ...result.asana, state:'ok', ...asana.syncStatus(), tasks:pending,
        counts:{ pending:pending.length, overdue:pending.filter(t=>t.overdue).length, dueToday:pending.filter(t=>t.dueToday).length, unassigned:pending.filter(t=>t.unassigned).length, missingDue:pending.filter(t=>t.missingDue).length } };
    } catch (_e) { result.asana = { ...result.asana, state:'error', ...asana.syncStatus(), error:'Asana data unavailable. Counts are unknown; please retry after the displayed retry time.' }; }
  }
  res.json(result);
}));
module.exports = router;
