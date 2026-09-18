'use strict';

const { DateTime } = require('luxon');
const ZONE = 'Asia/Kolkata';
const escape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '¦');
const plain = (s, max = 350) => escape(String(s || '').replace(/[\r\n]+/g, ' ').slice(0, max));

function reportWindow(now) {
  const local = DateTime.fromMillis(now, { zone: ZONE });
  let end = local.startOf('day').plus({ hours: 3 });
  if (local < end) end = end.minus({ days: 1 });
  const start = end.minus({ days: 1 });
  return { day: start.toISODate(), start: start.toMillis(), end: end.toMillis(), sendAt: end.plus({ minutes: 15 }).toMillis() };
}

function pendingReason(task, cutoff) {
  // Never interpret arbitrary prose as a blocker, or backdate edited notes.
  if (Date.parse(task.modified_at) > cutoff) return 'Reason not provided at cutoff';
  const fields = (task.custom_fields || []).filter(f => /^(blocker|blocker reason|pending reason|reason for delay)$/i.test(f.name || ''));
  for (const field of fields) {
    const value = field.display_value || field.text_value;
    if (value && String(value).trim()) return String(value).trim();
  }
  const match = String(task.notes || '').match(/^(?:blocker|pending reason|reason for delay)\s*:\s*(.+)$/im);
  return match ? match[1].trim() : 'Reason not provided';
}

function buildReport(tasks, window, observations, userMap) {
  const groups = new Map();
  let changedAfterCutoff = 0;
  for (const t of tasks) {
    if (Date.parse(t.created_at) >= window.end) continue;
    const doneAt = Date.parse(t.completed_at);
    const done = t.completed && doneAt >= window.start && doneAt < window.end;
    const pending = !t.completed || doneAt >= window.end;
    if (!done && !pending) continue;
    if (Date.parse(t.modified_at) > window.end) changedAfterCutoff++;
    const a = t.assignee;
    const key = a ? a.gid : 'unassigned';
    if (!groups.has(key)) groups.set(key, { key, name: a?.name || 'Unassigned', slack: userMap[key] || null, completed: [], due: [], overdue: [], other: [] });
    const group = groups.get(key);
    const dueDay = t.due_on || (t.due_at ? DateTime.fromISO(t.due_at).setZone(ZONE).toISODate() : null);
    const item = { gid: t.gid, name: t.name || '(untitled)', due: dueDay, completedAt: t.completed_at, actor: t.completed_by?.name || null,
      actorDiffers: !!(t.completed_by && t.completed_by.gid !== a?.gid), reason: pending ? pendingReason(t, window.end) : null,
      completedAfterCutoff: !!(pending && t.completed), projects: t.projectNames || [] };
    if (done) group.completed.push(item);
    else if (dueDay && dueDay < window.day) group.overdue.push(item);
    else if (dueDay === window.day || (t.due_at && Date.parse(t.due_at) < window.end)) group.due.push(item);
    else group.other.push(item);
  }
  const list = [...groups.values()].sort((a, b) => (a.key === 'unassigned') - (b.key === 'unassigned') || a.name.localeCompare(b.name));
  for (const g of list) for (const k of ['completed', 'due', 'overdue', 'other']) g[k].sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.name.localeCompare(b.name));
  return { window, observations, groups: list, changedAfterCutoff, completed: list.reduce((n, g) => n + g.completed.length, 0), pending: list.reduce((n, g) => n + g.due.length + g.overdue.length + g.other.length, 0) };
}

function renderReport(report) {
  const fmt = ms => DateTime.fromMillis(ms, { zone: ZONE }).toFormat('dd LLL yyyy HH:mm');
  const { window: w, observations: o } = report;
  const warnings = [...(o.warnings || [])];
  if (o.startedAt - w.end > 120000) warnings.push('Late collection: pending statuses reflect the observation time, not a guaranteed 03:00 snapshot.');
  if (report.changedAfterCutoff) warnings.push(`${report.changedAfterCutoff} task(s) changed after cutoff; assignees/due dates or reopened states may reflect later edits.`);
  const unmapped = report.groups.filter(g => g.key !== 'unassigned' && !g.slack).map(g => g.name);
  if (unmapped.length) warnings.push(`Slack tag unavailable for: ${unmapped.join(', ')}.`);
  const header = `*Asana EOD — ${w.day}*\n${fmt(w.start)} → ${fmt(w.end)} IST (end exclusive)\n*${report.completed} completed · ${report.pending} pending*\nProjects: ${o.projects.map(p => plain(p)).join(', ')}\nObserved: ${fmt(o.startedAt)}–${fmt(o.finishedAt)} IST. Asana reads are not an atomic historical snapshot.`;
  const messages = [header + (warnings.length ? '\n' + warnings.map(x => `⚠️ ${plain(x, 700)}`).join('\n') : '')];
  for (const g of report.groups) {
    const title = `*${g.slack ? `<@${g.slack}>` : plain(g.name)} — ${g.completed.length} completed · ${g.due.length + g.overdue.length + g.other.length} pending*`;
    const lines = [];
    for (const [key, label] of [['completed', '✅ Completed'], ['due', '🔴 Due this workday — pending'], ['overdue', '⚠️ Overdue — pending'], ['other', '⏳ Other pending']]) {
      if (!g[key].length) continue;
      lines.push(`*${label} (${g[key].length})*`);
      for (const t of g[key]) {
        let line = `• <https://app.asana.com/0/0/${encodeURIComponent(t.gid)}|${plain(t.name)}> — due ${plain(t.due || 'not set')}`;
        if (key === 'completed') {
          line += ` · completed ${DateTime.fromISO(t.completedAt).setZone(ZONE).toFormat('HH:mm')} IST`;
          if (t.actorDiffers) line += ` · marked complete by ${plain(t.actor)}`;
        } else {
          line += ` · ${plain(t.reason)}`;
          if (t.completedAfterCutoff) line += ' · marked complete after cutoff';
        }
        lines.push(line);
      }
    }
    if (g.due.length + g.overdue.length) lines.push('Please reply with the blocker and revised ETA for outstanding due/overdue tasks.');
    let chunk = title;
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 3500) { messages.push(chunk); chunk = `*${plain(g.name)} — continued*`; }
      chunk += '\n' + line;
    }
    messages.push(chunk);
  }
  return messages;
}

module.exports = { ZONE, reportWindow, pendingReason, buildReport, renderReport };
