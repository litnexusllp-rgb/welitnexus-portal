'use strict';

// Emails a data backup on a schedule (weekly + monthly). Completely off unless
// SMTP is configured, so the portal runs unchanged without it. The email carries
// Excel-openable CSVs (employees, attendance, leaves, tasks, clients, invoices)
// plus the raw .db file for a full-fidelity restore.
//
// SMTP env (Gmail app-password friendly):
//   SMTP_HOST, SMTP_PORT (default 465), SMTP_USER, SMTP_PASS,
//   BACKUP_EMAIL_TO (recipient), BACKUP_EMAIL_FROM (default SMTP_USER),
//   BACKUP_EMAIL_HOUR (office-zone hour, default 6), BACKUP_WEEKLY_DOW (1=Mon).

const nodemailer = require('nodemailer');
const { db, DB_PATH } = require('./db');
const { now, DateTime, ZONE } = require('./time');

const cfg = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  to: process.env.BACKUP_EMAIL_TO || '',
  from: process.env.BACKUP_EMAIL_FROM || process.env.SMTP_USER || '',
});
const enabled = () => { const c = cfg(); return !!(c.host && c.user && c.pass && c.to); };

// --- CSV building (formula-injection safe) ---
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const rowsToCsv = (header, rows) => [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
const dt = (ts) => (ts ? DateTime.fromMillis(ts).setZone(ZONE).toFormat('yyyy-LL-dd HH:mm') : '');

// Build one CSV per business table. Returns [{ filename, content }].
function buildCsvAttachments() {
  const out = [];
  out.push({ filename: 'employees.csv', content: rowsToCsv(
    ['Code', 'Name', 'Email', 'Role', 'Department', 'Title', 'Phone', 'Shift start', 'Leave balance', 'Active'],
    db.prepare(`SELECT emp_code, name, email, role, department, title, phone, shift_start, leave_balance, active FROM users ORDER BY active DESC, name COLLATE NOCASE`).all()
      .map((u) => [u.emp_code, u.name, u.email, u.role, u.department, u.title, u.phone, u.shift_start, u.leave_balance, u.active ? 'Yes' : 'No'])) });

  out.push({ filename: 'attendance.csv', content: rowsToCsv(
    ['Employee', 'Type', 'Time', 'Attendance day', 'Device'],
    db.prepare(`SELECT u.name, e.type, e.ts, e.day, e.device FROM events e JOIN users u ON u.id = e.user_id ORDER BY e.ts, e.id`).all()
      .map((e) => [e.name, e.type, dt(e.ts), e.day, e.device])) });

  out.push({ filename: 'leaves.csv', content: rowsToCsv(
    ['Employee', 'Start', 'End', 'Type', 'Days', 'Status', 'Reason', 'Decided by'],
    db.prepare(`SELECT u.name, l.start_date, l.end_date, l.kind, l.days, l.status, l.reason, du.name AS decided_by
                FROM leaves l JOIN users u ON u.id = l.user_id LEFT JOIN users du ON du.id = l.decided_by
                ORDER BY l.start_date DESC`).all()
      .map((l) => [l.name, l.start_date, l.end_date, l.kind, l.days, l.status, l.reason, l.decided_by || ''])) });

  out.push({ filename: 'tasks.csv', content: rowsToCsv(
    ['Title', 'Assignee', 'Client', 'Priority', 'Status', 'Due', 'Created'],
    db.prepare(`SELECT t.title, a.name AS assignee, c.name AS client, t.priority, t.status, t.due_date, t.created_ts
                FROM tasks t JOIN users a ON a.id = t.assignee_id LEFT JOIN clients c ON c.id = t.client_id
                ORDER BY t.created_ts DESC`).all()
      .map((t) => [t.title, t.assignee, t.client || '', t.priority, t.status, t.due_date, dt(t.created_ts)])) });

  out.push({ filename: 'clients.csv', content: rowsToCsv(
    ['Name', 'Code', 'Business type', 'Stage', 'Email', 'Parent', 'Active'],
    db.prepare(`SELECT c.name, c.code, c.business_type, c.stage, c.email, p.name AS parent, c.active
                FROM clients c LEFT JOIN clients p ON p.id = c.parent_id ORDER BY c.name COLLATE NOCASE`).all()
      .map((c) => [c.name, c.code, c.business_type, c.stage, c.email, c.parent || '', c.active ? 'Yes' : 'No'])) });

  out.push({ filename: 'invoices.csv', content: rowsToCsv(
    ['Number', 'Client', 'Amount', 'Currency', 'Invoice date', 'Due date', 'Status'],
    db.prepare(`SELECT i.number, c.name AS client, i.amount, i.currency, i.invoice_date, i.due_date, i.status
                FROM invoices i JOIN clients c ON c.id = i.client_id ORDER BY i.invoice_date DESC, i.id DESC`).all()
      .map((i) => [i.number, i.client, i.amount, i.currency, i.invoice_date, i.due_date, i.status])) });

  return out;
}

// Send the backup email now. kind is a label ("Weekly" | "Monthly" | "Test").
async function sendBackup(kind = 'Manual', toOverride) {
  const c = cfg();
  const to = toOverride || c.to;
  if (!c.host || !c.user || !c.pass) return { ok: false, error: 'SMTP not configured', message: 'Set SMTP_HOST, SMTP_USER and SMTP_PASS (and BACKUP_EMAIL_TO) on the server.' };
  if (!to) return { ok: false, error: 'no recipient', message: 'Set BACKUP_EMAIL_TO to the address that should receive backups.' };

  const stamp = now().toFormat('yyyy-LL-dd');
  const attachments = buildCsvAttachments();
  attachments.push({ filename: `litnexus-portal-${stamp}.db`, content: db.serialize() }); // full-fidelity restore file

  const transporter = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass },
  });
  try {
    await transporter.sendMail({
      from: c.from, to,
      subject: `LIT Nexus portal backup — ${kind} (${stamp})`,
      text: `Attached is your ${kind.toLowerCase()} LIT Nexus data backup for ${stamp}.\n\n`
        + `CSV files (open in Excel): employees, attendance, leaves, tasks, clients, invoices.\n`
        + `The .db file is the full database for a complete restore if ever needed.`,
      attachments,
    });
    return { ok: true, to, files: attachments.length, message: `Backup emailed to ${to}.` };
  } catch (e) {
    return { ok: false, error: e.message, message: 'Email send failed — check the SMTP settings (host/port/user/app password).' };
  }
}

// Daily tick at BACKUP_EMAIL_HOUR: send Weekly on the chosen weekday and Monthly
// on the 1st (both can fire on the same day).
function startBackupScheduler() {
  if (!enabled()) { console.log('Backup email: disabled (SMTP not configured).'); return; }
  const hour = Math.min(23, Math.max(0, Number(process.env.BACKUP_EMAIL_HOUR ?? 6)));
  const weeklyDow = Math.min(7, Math.max(1, Number(process.env.BACKUP_WEEKLY_DOW ?? 1))); // 1=Mon..7=Sun
  const scheduleNext = () => {
    const n = now();
    let next = n.set({ hour, minute: 0, second: 0, millisecond: 0 });
    if (next <= n) next = next.plus({ days: 1 });
    setTimeout(async () => {
      try {
        const d = now();
        if (d.weekday === weeklyDow) { const r = await sendBackup('Weekly'); console.log('Backup email (weekly):', JSON.stringify(r)); }
        if (d.day === 1) { const r = await sendBackup('Monthly'); console.log('Backup email (monthly):', JSON.stringify(r)); }
      } catch (e) { console.error('Backup email run failed:', e.message); }
      scheduleNext();
    }, next.toMillis() - n.toMillis()).unref();
    console.log(`Backup email scheduled for ${next.toFormat('yyyy-LL-dd HH:mm')} (${ZONE}); weekly on day ${weeklyDow}, monthly on the 1st.`);
  };
  scheduleNext();
}

module.exports = { sendBackup, startBackupScheduler, enabled, buildCsvAttachments };
