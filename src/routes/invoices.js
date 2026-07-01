'use strict';

// Admin-only client invoicing. Invoices tie to a client; amounts feed the
// per-client income totals shown on the Clients page.

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const SELECT = `SELECT i.*, c.name AS client_name, pc.name AS client_parent_name
   FROM invoices i JOIN clients c ON c.id = i.client_id
   LEFT JOIN clients pc ON pc.id = c.parent_id`;
const listAll = db.prepare(`${SELECT} ORDER BY (i.invoice_date = '') ASC, i.invoice_date DESC, i.id DESC LIMIT 500`);
const getOne = db.prepare(`${SELECT} WHERE i.id = ?`);
const getClient = db.prepare(`SELECT id FROM clients WHERE id = ?`);
const insertInvoice = db.prepare(
  `INSERT INTO invoices (client_id, number, amount, invoice_date, status, note, created_by, created_ts)
   VALUES (@client_id, @number, @amount, @invoice_date, @status, @note, @created_by, @created_ts)`
);
const updateInvoice = db.prepare(
  `UPDATE invoices SET client_id=@client_id, number=@number, amount=@amount, invoice_date=@invoice_date, status=@status, note=@note WHERE id=@id`
);
const setStatus = db.prepare(`UPDATE invoices SET status = ? WHERE id = ?`);
const deleteInvoice = db.prepare(`DELETE FROM invoices WHERE id = ?`);
const rawGetOne = db.prepare(`SELECT * FROM invoices WHERE id = ?`);
// Per-client totals (raw, not rolled up — the frontend rolls files into parents).
const perClientTotals = db.prepare(
  `SELECT client_id,
          SUM(amount) AS invoiced,
          SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END) AS paid
     FROM invoices GROUP BY client_id`
);

function clean(body, existing) {
  return {
    client_id: Number(body.client_id ?? existing?.client_id),
    number: String(body.number ?? existing?.number ?? '').slice(0, 40),
    amount: Math.max(0, Number(body.amount ?? existing?.amount ?? 0)) || 0,
    invoice_date: String(body.invoice_date ?? existing?.invoice_date ?? ''),
    status: String(body.status ?? existing?.status ?? 'UNPAID').toUpperCase() === 'PAID' ? 'PAID' : 'UNPAID',
    note: String(body.note ?? existing?.note ?? '').slice(0, 300),
  };
}

router.get('/', requireAdmin, (_req, res) => res.json({ invoices: listAll.all() }));

router.get('/summary', requireAdmin, (_req, res) => {
  const totals = {};
  for (const r of perClientTotals.all()) totals[r.client_id] = { invoiced: r.invoiced || 0, paid: r.paid || 0 };
  res.json({ totals });
});

router.post('/', requireAdmin, (req, res) => {
  const inv = clean(req.body);
  if (!inv.client_id || !getClient.get(inv.client_id)) return res.status(400).json({ error: 'A valid client is required' });
  if (!(inv.amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });
  const info = insertInvoice.run({ ...inv, created_by: req.user.id, created_ts: now().toMillis() });
  res.json({ invoice: getOne.get(info.lastInsertRowid) });
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = rawGetOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const inv = clean(req.body, existing);
  if (!inv.client_id || !getClient.get(inv.client_id)) return res.status(400).json({ error: 'A valid client is required' });
  updateInvoice.run({ id: existing.id, ...inv });
  res.json({ invoice: getOne.get(existing.id) });
});

router.post('/:id/status', requireAdmin, (req, res) => {
  const existing = rawGetOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  setStatus.run(String(req.body.status || '').toUpperCase() === 'PAID' ? 'PAID' : 'UNPAID', existing.id);
  res.json({ invoice: getOne.get(existing.id) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  deleteInvoice.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
