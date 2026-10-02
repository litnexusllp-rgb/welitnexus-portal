'use strict';
const router = require('express').Router();
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const asana = require('../asana');
const { now, DateTime, ZONE } = require('../time');

router.use(requireAdmin);
router.get('/', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const observedAt = now(); const today = observedAt.toISODate();
  // Deliberately read only: decisions continue through their existing validated routes.
  const approvals = [
    ...db.prepare("SELECT a.id,u.name,a.title,a.created_ts,'Achievement' AS kind,'achievements' AS view FROM achievements a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
    ...db.prepare("SELECT a.id,u.name,a.start_date || ' – ' || a.end_date AS title,a.created_ts,'Leave' AS kind,'leaves' AS view FROM leaves a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
    ...db.prepare("SELECT a.id,u.name,a.day || ' ' || a.time || ' ' || a.type AS title,a.created_ts,'Punch correction' AS kind,'clock' AS view FROM punch_requests a JOIN users u ON u.id=a.user_id WHERE a.status='PENDING'").all(),
  ].sort((a,b) => a.created_ts-b.created_ts).map(a => ({ ...a, waitingDays: Math.max(0,Math.floor((observedAt.toMillis()-a.created_ts)/86400000)) }));
  const result = { observedAt: observedAt.toISO(), timezone: ZONE, today, approvals,
    asana: { state: 'disabled', scope: 'LIT Tasks project-member tasks; subtasks only when also project members', tasks: null, counts: null },
    slack: { newAlertsEnabled: false, eodEnabled: process.env.EOD_ENABLED === 'true' },
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
});
module.exports = router;
