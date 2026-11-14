'use strict';

// Admin console: billing and invoices (OWNER and BILLING admins).

const express = require('express');
const nodemailer = require('nodemailer');
const { db } = require('../db');
const asyncRoute = require('../asyncRoute');
const { todayStr } = require('../time');
const { requireBilling, audit } = require('../v2/roles');
const B = require('../v2/billing');

const router = express.Router();
router.use(requireBilling);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const idOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('Invalid id');
  return n;
};
const isoDay = (v, field) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw bad(`${field} must be a date (yyyy-mm-dd)`);
  return String(v);
};

function serialize(inv) {
  if (!inv) return inv;
  const out = { ...inv };
  for (const k of ['subtotal', 'tax', 'total', 'paid', 'balance']) out[k] = B.fromMinor(inv[k] ?? 0);
  if (inv.lines)
    out.lines = inv.lines.map((l) => ({ ...l, unit_price: B.fromMinor(l.unit_price), amount: B.fromMinor(l.amount) }));
  if (inv.payments) out.payments = inv.payments.map((p) => ({ ...p, amount: B.fromMinor(p.amount) }));
  out.tax_rate = inv.tax_rate_bp / 100;
  return out;
}

function readInvoiceBody(body, existing = {}) {
  const client_id = idOf(body.client_id ?? existing.client_id);
  const client = db.prepare('SELECT id, active FROM clients WHERE id=?').get(client_id);
  if (!client || !client.active) throw bad('Choose an active client');
  const currency = String(body.currency ?? existing.currency ?? 'USD').toUpperCase();
  if (!B.CURRENCIES[currency]) throw bad('Currency must be USD or INR');
  const terms = String(body.terms ?? existing.terms ?? 'NET_30').toUpperCase();
  if (!(terms in B.TERMS)) throw bad('Unknown payment terms');
  const issue_date = isoDay(body.issue_date ?? existing.issue_date ?? todayStr(), 'Issue date');
  const due_date = body.due_date ? isoDay(body.due_date, 'Due date') : B.dueDateFor(issue_date, terms);
  if (due_date < issue_date) throw bad('Due date cannot be before the issue date');
  const taxRate = Number(body.tax_rate ?? (existing.tax_rate_bp ?? 0) / 100);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 50) throw bad('Tax rate must be between 0 and 50%');
  const lines = B.cleanLines(body.lines ?? existing.lines);
  const tax_rate_bp = Math.round(taxRate * 100);
  return {
    client_id,
    currency,
    terms,
    issue_date,
    due_date,
    tax_rate_bp,
    lines,
    notes: String(body.notes ?? existing.notes ?? '').slice(0, 2000),
    bill_to: String(body.bill_to ?? existing.bill_to ?? '').slice(0, 1000),
    reminders: (body.reminders ?? existing.reminders ?? true) ? 1 : 0,
    ...B.totals(lines, tax_rate_bp),
  };
}

function writeLines(invoiceId, lines) {
  db.prepare('DELETE FROM int_invoice_lines WHERE invoice_id=?').run(invoiceId);
  const ins = db.prepare(
    'INSERT INTO int_invoice_lines(invoice_id, position, description, quantity, unit_price, amount, source) VALUES (?,?,?,?,?,?,?)',
  );
  for (const l of lines) ins.run(invoiceId, l.position, l.description, l.quantity, l.unit_price, l.amount, l.source);
}

const mustLoad = (id) => {
  const inv = B.load(id);
  if (!inv) throw bad('Invoice not found', 404);
  return inv;
};

router.get('/clients', (_req, res) => {
  res.json({
    clients: db
      .prepare(
        "SELECT id, name, code, email, billing_address FROM clients WHERE active=1 AND approval='APPROVED' AND parent_id IS NULL ORDER BY name COLLATE NOCASE",
      )
      .all(),
  });
});

router.get('/summary', (req, res) => {
  const currency = String(req.query.currency || 'USD').toUpperCase();
  if (!B.CURRENCIES[currency]) return res.status(400).json({ error: 'Currency must be USD or INR' });
  const s = B.summary(req.query.fy, currency);
  for (const k of ['billed', 'collected', 'outstanding', 'overdue']) s[k] = B.fromMinor(s[k]);
  s.byClient = s.byClient.map((c) => ({ ...c, billed: B.fromMinor(c.billed), collected: B.fromMinor(c.collected) }));
  res.json(s);
});

router.get('/invoices', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.client_id) {
    where.push('i.client_id=?');
    args.push(idOf(req.query.client_id));
  }
  if (req.query.currency) {
    where.push('i.currency=?');
    args.push(String(req.query.currency).toUpperCase());
  }
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS client_name FROM int_invoices i JOIN clients c ON c.id=i.client_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.issue_date DESC, i.id DESC LIMIT 1000`,
    )
    .all(...args)
    .map((r) => ({ ...r, display_status: B.displayStatus(r), balance: r.total - r.paid }));
  const status = String(req.query.status || '').toUpperCase();
  res.json({ invoices: rows.filter((r) => !status || r.display_status === status).map(serialize) });
});

router.post('/invoices', (req, res) => {
  const v = readInvoiceBody(req.body);
  const now = Date.now();
  const id = db
    .transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO int_invoices(client_id, currency, issue_date, due_date, terms, tax_rate_bp, notes, bill_to, reminders, subtotal, tax, total, created_by, created_ts, updated_ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          v.client_id,
          v.currency,
          v.issue_date,
          v.due_date,
          v.terms,
          v.tax_rate_bp,
          v.notes,
          v.bill_to,
          v.reminders,
          v.subtotal,
          v.tax,
          v.total,
          req.user.id,
          now,
          now,
        );
      writeLines(info.lastInsertRowid, v.lines);
      return info.lastInsertRowid;
    })
    .immediate();
  audit(req, 'invoice.created', `invoice:${id}`, { total: v.total, currency: v.currency });
  res.json({ invoice: serialize(B.load(id)) });
});

router.get('/invoices/:id', (req, res) => res.json({ invoice: serialize(mustLoad(idOf(req.params.id))) }));

router.put('/invoices/:id', (req, res) => {
  const inv = mustLoad(idOf(req.params.id));
  if (inv.status !== 'DRAFT')
    throw bad('Only draft invoices can be edited. Void it and create a new one instead.', 409);
  const v = readInvoiceBody(req.body, inv);
  db.transaction(() => {
    db.prepare(
      `UPDATE int_invoices SET client_id=?, currency=?, issue_date=?, due_date=?, terms=?, tax_rate_bp=?, notes=?, bill_to=?, reminders=?, subtotal=?, tax=?, total=?, updated_ts=? WHERE id=?`,
    ).run(
      v.client_id,
      v.currency,
      v.issue_date,
      v.due_date,
      v.terms,
      v.tax_rate_bp,
      v.notes,
      v.bill_to,
      v.reminders,
      v.subtotal,
      v.tax,
      v.total,
      Date.now(),
      inv.id,
    );
    writeLines(inv.id, v.lines);
  }).immediate();
  audit(req, 'invoice.updated', `invoice:${inv.id}`, { total: v.total });
  res.json({ invoice: serialize(B.load(inv.id)) });
});

router.delete('/invoices/:id', (req, res) => {
  const inv = mustLoad(idOf(req.params.id));
  if (inv.status !== 'DRAFT') throw bad('Sent invoices are kept for your records. Void it instead.', 409);
  db.transaction(() => {
    db.prepare('DELETE FROM int_invoice_lines WHERE invoice_id=?').run(inv.id);
    db.prepare('DELETE FROM int_invoices WHERE id=?').run(inv.id);
  }).immediate();
  audit(req, 'invoice.draft_deleted', `invoice:${inv.id}`);
  res.json({ ok: true });
});

router.get(
  '/invoices/:id/pdf',
  asyncRoute(async (req, res) => {
    const inv = mustLoad(idOf(req.params.id));
    const pdf = await B.renderInvoicePdf(inv);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${inv.number || 'draft-invoice-' + inv.id}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  }),
);

function mailer() {
  const host = process.env.SMTP_HOST,
    user = process.env.SMTP_USER,
    pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    transport: nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } }),
    from: process.env.BILLING_EMAIL_FROM || process.env.BACKUP_EMAIL_FROM || user,
  };
}

async function emailInvoice(inv, subjectPrefix = 'Invoice') {
  const m = mailer();
  if (!m || !inv.client_email)
    return {
      emailed: false,
      reason: !m ? 'Email (SMTP) is not configured' : 'This client has no email address on file',
    };
  const pdf = await B.renderInvoicePdf(inv);
  await m.transport.sendMail({
    from: m.from,
    to: inv.client_email,
    replyTo: process.env.BILLING_REPLY_TO || undefined,
    subject: `${subjectPrefix} ${inv.number} from LIT Nexus LLP — ${B.formatMoney(inv.total - inv.paid, inv.currency)} due ${inv.due_date}`,
    text: `Hello ${inv.client_name},\n\nPlease find invoice ${inv.number} attached. Amount due: ${B.formatMoney(inv.total - inv.paid, inv.currency)}, due ${inv.due_date}.\n\n${inv.notes || ''}\n\nThank you,\nLIT Nexus LLP`,
    attachments: [{ filename: `${inv.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  return { emailed: true, to: inv.client_email };
}

router.post(
  '/invoices/:id/send',
  asyncRoute(async (req, res) => {
    let inv = mustLoad(idOf(req.params.id));
    if (inv.status === 'VOID' || inv.status === 'PAID') throw bad('This invoice is closed.', 409);
    if (!inv.lines.length || inv.total <= 0) throw bad('Add at least one priced line before sending.', 409);
    if (!inv.number) {
      const number = B.nextNumber();
      db.prepare(
        "UPDATE int_invoices SET number=?, status='SENT', sent_ts=?, updated_ts=? WHERE id=? AND number IS NULL",
      ).run(number, Date.now(), Date.now(), inv.id);
    }
    inv = B.load(inv.id);
    let delivery = { emailed: false, reason: 'Marked as sent only' };
    if (req.body.send_email !== false) {
      try {
        delivery = await emailInvoice(inv);
      } catch (e) {
        console.error('Invoice email failed:', e.message);
        delivery = { emailed: false, reason: 'The email could not be sent. The invoice is still marked as sent.' };
      }
    }
    audit(req, 'invoice.sent', `invoice:${inv.id}`, { number: inv.number, ...delivery });
    res.json({ invoice: serialize(inv), delivery });
  }),
);

router.post('/invoices/:id/payments', (req, res) => {
  const inv = mustLoad(idOf(req.params.id));
  if (inv.status !== 'SENT') throw bad('Payments can only be recorded on sent, unpaid invoices.', 409);
  const amount = B.toMinor(req.body.amount);
  if (amount <= 0) throw bad('Payment amount must be positive');
  if (amount > inv.total - inv.paid) throw bad('Payment is larger than the balance due');
  const paid_on = isoDay(req.body.paid_on || todayStr(), 'Payment date');
  db.transaction(() => {
    db.prepare(
      'INSERT INTO int_payments(invoice_id, amount, paid_on, method, reference, recorded_by, recorded_ts) VALUES (?,?,?,?,?,?,?)',
    ).run(
      inv.id,
      amount,
      paid_on,
      String(req.body.method || '').slice(0, 40),
      String(req.body.reference || '').slice(0, 120),
      req.user.id,
      Date.now(),
    );
    const paid = inv.paid + amount;
    db.prepare('UPDATE int_invoices SET paid=?, status=?, updated_ts=? WHERE id=?').run(
      paid,
      paid >= inv.total ? 'PAID' : 'SENT',
      Date.now(),
      inv.id,
    );
  }).immediate();
  audit(req, 'invoice.payment', `invoice:${inv.id}`, { amount });
  res.json({ invoice: serialize(B.load(inv.id)) });
});

router.post('/invoices/:id/void', (req, res) => {
  const inv = mustLoad(idOf(req.params.id));
  if (inv.status === 'DRAFT') throw bad('Delete the draft instead.', 409);
  if (inv.paid > 0) throw bad('This invoice has payments recorded and cannot be voided.', 409);
  db.prepare("UPDATE int_invoices SET status='VOID', updated_ts=? WHERE id=?").run(Date.now(), inv.id);
  audit(req, 'invoice.voided', `invoice:${inv.id}`, { number: inv.number });
  res.json({ invoice: serialize(B.load(inv.id)) });
});

// Draft line suggestions from completed portal tasks for this client.
router.get('/invoices/:id/task-lines', (req, res) => {
  const inv = mustLoad(idOf(req.params.id));
  const from = req.query.from ? isoDay(req.query.from, 'From') : `${inv.issue_date.slice(0, 7)}-01`;
  const to = req.query.to ? isoDay(req.query.to, 'To') : inv.issue_date;
  const start = Date.parse(from + 'T00:00:00Z') - 86400000,
    end = Date.parse(to + 'T23:59:59Z') + 86400000;
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.updated_ts, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.client_id IN (SELECT id FROM clients WHERE id=? OR parent_id=?) AND t.status='DONE' AND t.updated_ts BETWEEN ? AND ? ORDER BY t.updated_ts`,
    )
    .all(inv.client_id, inv.client_id, start, end);
  res.json({
    lines: rows.map((r) => ({
      description: r.title,
      quantity: 1,
      unit_price: 0,
      source: `task:${r.id}`,
      assignee: r.assignee,
    })),
  });
});

// Reminders: called by the background scheduler. 3 days before due, then weekly once overdue.
async function sendDueReminders() {
  if (!mailer()) return { sent: 0 };
  const on = todayStr();
  const soon = require('../time').DateTime.fromISO(on).plus({ days: 3 }).toISODate();
  const weekAgo = Date.now() - 7 * 86400000;
  const due = db
    .prepare(
      `SELECT id FROM int_invoices WHERE status='SENT' AND reminders=1 AND (due_date <= ?) AND (last_reminder_ts IS NULL OR last_reminder_ts < ?)`,
    )
    .all(soon, weekAgo);
  let sent = 0;
  for (const { id } of due) {
    const inv = B.load(id);
    try {
      const r = await emailInvoice(inv, inv.due_date < on ? 'Overdue reminder:' : 'Payment reminder:');
      if (r.emailed) {
        db.prepare('UPDATE int_invoices SET last_reminder_ts=? WHERE id=?').run(Date.now(), id);
        sent++;
      }
    } catch (e) {
      console.error('Reminder failed for invoice', id, e.message);
    }
  }
  return { sent };
}

module.exports = router;
module.exports.sendDueReminders = sendDueReminders;
