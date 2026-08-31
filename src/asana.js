'use strict';

// Asana is the team's real task system, so the portal reads from it instead of
// keeping a second (worse) copy. Everything here is read-only: people create and
// update tasks in Asana; the portal just shows each person their own work and
// feeds the task numbers on the KPI worksheet.
//
// Config: ASANA_TOKEN (Personal Access Token), ASANA_PROJECT_GID (the project to
// read, e.g. "LIT Tasks"). Off entirely when either is missing.
//
// Matching Asana people to portal employees is deliberately forgiving, because
// Asana accounts are often personal Gmail addresses rather than work ones:
//   1. the employee's asana_email override, if an admin set one
//   2. their portal email
//   3. their full name (case-insensitive)

const { db } = require('./db');

// ASANA_API_BASE exists so the integration can be pointed at a stub in tests;
// in normal use it stays on Asana's real API.
const API = process.env.ASANA_API_BASE || 'https://app.asana.com/api/1.0';
const CACHE_MS = 5 * 60 * 1000; // Asana rate-limits; the dashboard polls often

const cfg = () => ({
  token: process.env.ASANA_TOKEN || '',
  project: process.env.ASANA_PROJECT_GID || '',
});
const enabled = () => { const c = cfg(); return !!(c.token && c.project); };

const activeUsers = db.prepare(
  `SELECT id, name, email, asana_email FROM users WHERE active = 1`
);

let cache = { at: 0, tasks: null };

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${cfg().token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && body.errors && body.errors[0] && body.errors[0].message) || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return body;
}

// All tasks in the configured project (paginated), cached briefly.
async function allTasks(force = false) {
  if (!enabled()) return [];
  if (!force && cache.tasks && Date.now() - cache.at < CACHE_MS) return cache.tasks;
  const fields = 'name,completed,completed_at,due_on,permalink_url,assignee.name,assignee.email';
  let path = `/tasks?project=${encodeURIComponent(cfg().project)}&opt_fields=${fields}&limit=100`;
  const out = [];
  for (let page = 0; page < 20 && path; page++) { // hard cap: 2000 tasks
    const body = await apiGet(path);
    out.push(...(body.data || []));
    const next = body.next_page && body.next_page.path;
    path = next ? next.replace(/^\/api\/1\.0/, '') : null;
  }
  cache = { at: Date.now(), tasks: out };
  return out;
}

// portal user id -> [asana task], using the matching rules described above.
function indexByPortalUser(tasks) {
  const users = activeUsers.all();
  const byEmail = new Map(); const byName = new Map();
  for (const u of users) {
    if (u.asana_email) byEmail.set(String(u.asana_email).toLowerCase(), u.id);
    if (u.email) byEmail.set(String(u.email).toLowerCase(), u.id);
    if (u.name) byName.set(String(u.name).trim().toLowerCase(), u.id);
  }
  const out = {};
  const unmatched = new Map(); // asana name -> count, so admins can spot gaps
  for (const t of tasks) {
    const a = t.assignee;
    if (!a) continue;
    const uid = byEmail.get(String(a.email || '').toLowerCase())
      || byName.get(String(a.name || '').trim().toLowerCase());
    if (!uid) { unmatched.set(a.name || '(unnamed)', (unmatched.get(a.name || '(unnamed)') || 0) + 1); continue; }
    (out[uid] = out[uid] || []).push(t);
  }
  return { byUser: out, unmatched: [...unmatched.entries()].map(([name, count]) => ({ name, count })) };
}

// One person's open tasks, soonest due first (no due date last).
async function myTasks(userId) {
  const { byUser } = indexByPortalUser(await allTasks());
  return (byUser[userId] || [])
    .filter((t) => !t.completed)
    .sort((a, b) => (a.due_on ? 0 : 1) - (b.due_on ? 0 : 1) || String(a.due_on || '').localeCompare(String(b.due_on || '')))
    .map((t) => ({
      gid: t.gid, name: t.name || '(untitled)', due_on: t.due_on || '',
      url: t.permalink_url || '',
      overdue: !!(t.due_on && t.due_on < new Date().toLocaleDateString('en-CA')),
    }));
}

// Task numbers for the KPI worksheet, for the month [start, end] (yyyy-mm-dd).
// Returns { [portalUserId]: { done, onTime, open } }.
async function kpiTaskStats(start, end) {
  const { byUser } = indexByPortalUser(await allTasks());
  const stats = {};
  for (const [uid, tasks] of Object.entries(byUser)) {
    const s = { done: 0, onTime: 0, open: 0 };
    for (const t of tasks) {
      if (t.completed) {
        const day = String(t.completed_at || '').slice(0, 10);
        if (day >= start && day <= end) {
          s.done += 1;
          if (!t.due_on || day <= t.due_on) s.onTime += 1;
        }
      } else s.open += 1;
    }
    stats[Number(uid)] = s;
  }
  return stats;
}

// Admin diagnostic: is the connection working, and who isn't matching?
async function diagnose() {
  const c = cfg();
  if (!c.token) return { ok: false, step: 'token', message: 'ASANA_TOKEN is not set on the server. Add it in Railway and redeploy.' };
  if (!c.project) return { ok: false, step: 'project', message: 'ASANA_PROJECT_GID is not set. Use the number from your Asana project URL.' };
  try {
    const me = await apiGet('/users/me?opt_fields=name');
    const tasks = await allTasks(true);
    const { byUser, unmatched } = indexByPortalUser(tasks);
    const matchedUsers = Object.keys(byUser).length;
    return {
      ok: true,
      connectedAs: me.data && me.data.name,
      taskCount: tasks.length,
      matchedUsers,
      unmatched,
      message: `Connected as ${me.data && me.data.name}. Read ${tasks.length} task(s); matched ${matchedUsers} employee(s).`,
    };
  } catch (e) {
    const hint = e.status === 401 ? 'The Asana token is wrong or expired — create a new Personal Access Token and update ASANA_TOKEN.'
      : e.status === 403 ? 'That token cannot see this project. Check the token owner has access to it.'
        : e.status === 404 ? 'Project not found — check ASANA_PROJECT_GID matches the number in your Asana project URL.'
          : `Asana error: ${e.message}`;
    return { ok: false, step: 'api', error: e.message, message: hint };
  }
}

module.exports = { enabled, myTasks, kpiTaskStats, diagnose, allTasks };
