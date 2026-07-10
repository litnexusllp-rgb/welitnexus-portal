'use strict';

// Turns recurring_tasks templates into real tasks.
// Runs at server boot and on a timer. For each active template, while its
// next_due falls within the lead window (today + lead_days), it creates the
// task instance (unless one already exists) and advances next_due to the next
// period. A hard cap prevents runaway backfill if the server was off for long.

const { db } = require('./db');
const { now, DateTime, ZONE } = require('./time');

const MAX_PER_RUN = 24; // safety cap per template per run

function advance(dateStr, frequency, step) {
  const d = DateTime.fromISO(dateStr, { zone: ZONE });
  const n = Math.max(1, step || 1);
  switch (frequency) {
    case 'DAILY':     return d.plus({ days: n }).toFormat('yyyy-LL-dd');
    case 'WEEKLY':    return d.plus({ weeks: n }).toFormat('yyyy-LL-dd');
    case 'QUARTERLY': return d.plus({ months: 3 * n }).toFormat('yyyy-LL-dd');
    case 'YEARLY':    return d.plus({ years: n }).toFormat('yyyy-LL-dd');
    case 'MONTHLY':
    default:          return d.plus({ months: n }).toFormat('yyyy-LL-dd');
  }
}

const activeTemplates = db.prepare(`SELECT * FROM recurring_tasks WHERE active = 1`);
const existsInstance = db.prepare(
  `SELECT 1 FROM tasks WHERE recurring_id = ? AND due_date = ? LIMIT 1`
);
const insertTask = db.prepare(
  `INSERT INTO tasks (title, description, assignee_id, assigned_by, priority, status, due_date, client_id, recurring_id, created_ts, updated_ts)
   VALUES (@title, @description, @assignee_id, @assigned_by, @priority, 'TODO', @due_date, @client_id, @recurring_id, @ts, @ts)`
);
const advanceTemplate = db.prepare(
  `UPDATE recurring_tasks SET next_due = ?, last_run_ts = ? WHERE id = ?`
);
const insertChecklistItem = db.prepare(
  `INSERT INTO task_checklist (task_id, text, position) VALUES (?, ?, ?)`
);

// Copy a template's checklist (stored as JSON) onto a freshly created task.
function copyChecklist(checklistJson, taskId) {
  if (!checklistJson) return;
  let items = [];
  try { items = JSON.parse(checklistJson); } catch (_e) { return; }
  if (Array.isArray(items)) items.forEach((text, i) => insertChecklistItem.run(taskId, String(text), i));
}

// Generate any due instances. Returns the number of tasks created.
function generateDueTasks() {
  const today = now().toFormat('yyyy-LL-dd');
  let created = 0;

  const run = db.transaction(() => {
    for (const t of activeTemplates.all()) {
      let nextDue = t.next_due;
      let guard = 0;
      // Create instances whose due date is within today + lead_days.
      while (guard < MAX_PER_RUN) {
        const triggerOn = DateTime.fromISO(nextDue, { zone: ZONE }).minus({ days: t.lead_days || 0 }).toFormat('yyyy-LL-dd');
        if (triggerOn > today) break; // not time to create this one yet
        if (!existsInstance.get(t.id, nextDue)) {
          const info = insertTask.run({
            title: t.title,
            description: t.description,
            assignee_id: t.assignee_id,
            assigned_by: t.created_by,
            priority: t.priority,
            due_date: nextDue,
            client_id: t.client_id,
            recurring_id: t.id,
            ts: now().toMillis(),
          });
          copyChecklist(t.checklist_json, info.lastInsertRowid);
          created++;
        }
        nextDue = advance(nextDue, t.frequency, t.step);
        guard++;
      }
      if (nextDue !== t.next_due) advanceTemplate.run(nextDue, now().toMillis(), t.id);
    }
  });
  run();
  if (created) console.log(`Recurring: generated ${created} task(s).`);
  return created;
}

// Boot the generator: run once now, then every 6 hours.
function startRecurringScheduler() {
  try { generateDueTasks(); } catch (e) { console.error('Recurring generate failed:', e.message); }
  setInterval(() => {
    try { generateDueTasks(); } catch (e) { console.error('Recurring generate failed:', e.message); }
  }, 6 * 60 * 60 * 1000).unref();
}

module.exports = { generateDueTasks, startRecurringScheduler, advance };
