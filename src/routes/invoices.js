'use strict';

// Admin-only client invoicing with line items. Amounts feed per-client income
// and the PDF invoice. Total = sum of line items (quantity * rate).

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { now } = require('../time');

const router = express.Router();

const SELECT = `SELECT i.*, c.name AS client_name, pc.name AS client_parent_name
   FROM invoices i JOIN clients c ON c.id = i.client_id
   LEFT JOIN clients pc ON pc.id = c.parent_id`;
const listAll = db.prepare(`${SELECT} ORDER BY (i.invoice_date = '') ASC, i.invoice_date DESC, i.id DESC LIMIT 500`);
const getRow = db.prepare(`${SELECT} WHERE i.id = ?`);
const rawGetOne = db.prepare(`SELECT * FROM invoices WHERE id = ?`);
const getClient = db.prepare(`SELECT id FROM clients WHERE id = ?`);
// Find another invoice with the same (non-empty) number — for uniqueness checks.
const findByNumber = db.prepare(`SELECT id FROM invoices WHERE number = ? AND number != '' AND id != ?`);
const itemsFor = db.prepare(`SELECT id, item, description, quantity, rate FROM invoice_items WHERE invoice_id = ? ORDER BY position, id`);
const insertInvoice = db.prepare(
  `INSERT INTO invoices (client_id, number, amount, invoice_date, due_date, currency, bill_to, status, note, created_by, created_ts)
   VALUES (@client_id, @number, @amount, @invoice_date, @due_date, @currency, @bill_to, @status, @note, @created_by, @created_ts)`
);
const updateInvoice = db.prepare(
  `UPDATE invoices SET client_id=@client_id, number=@number, amount=@amount, invoice_date=@invoice_date,
   due_date=@due_date, currency=@currency, bill_to=@bill_to, status=@status, note=@note WHERE id=@id`
);
const insertItem = db.prepare(`INSERT INTO invoice_items (invoice_id, item, description, quantity, rate, position) VALUES (?, ?, ?, ?, ?, ?)`);
const deleteItems = db.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`);
const setStatus = db.prepare(`UPDATE invoices SET status = ? WHERE id = ?`);
const deleteInvoice = db.prepare(`DELETE FROM invoices WHERE id = ?`);
const perClientTotals = db.prepare(
  `SELECT client_id, SUM(amount) AS invoiced,
          SUM(CASE WHEN status = 'PAID' THEN amount ELSE 0 END) AS paid
     FROM invoices GROUP BY client_id`
);

// Normalise line items and compute the invoice total.
function parseItems(raw) {
  const items = (Array.isArray(raw) ? raw : []).map((it) => ({
    item: String(it.item || '').slice(0, 200),
    description: String(it.description || '').slice(0, 1000),
    quantity: Math.max(0, Number(it.quantity) || 0),
    rate: Math.max(0, Number(it.rate) || 0),
  })).filter((it) => it.item || it.description || it.quantity || it.rate);
  const total = items.reduce((s, it) => s + it.quantity * it.rate, 0);
  return { items, total };
}
function clean(body, existing) {
  return {
    client_id: Number(body.client_id ?? existing?.client_id),
    number: String(body.number ?? existing?.number ?? '').slice(0, 40),
    invoice_date: String(body.invoice_date ?? existing?.invoice_date ?? ''),
    due_date: String(body.due_date ?? existing?.due_date ?? ''),
    currency: String(body.currency ?? existing?.currency ?? 'USD').slice(0, 8).toUpperCase(),
    bill_to: String(body.bill_to ?? existing?.bill_to ?? '').slice(0, 500),
    status: String(body.status ?? existing?.status ?? 'UNPAID').toUpperCase() === 'PAID' ? 'PAID' : 'UNPAID',
    note: String(body.note ?? existing?.note ?? '').slice(0, 300),
  };
}
function withItems(row) {
  if (row) row.items = itemsFor.all(row.id);
  return row;
}

router.get('/', requireAdmin, (_req, res) => res.json({ invoices: listAll.all() }));
router.get('/:id', requireAdmin, (req, res) => {
  const row = getRow.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ invoice: withItems(row) });
});

router.get('/summary/totals', requireAdmin, (_req, res) => {
  const totals = {};
  for (const r of perClientTotals.all()) totals[r.client_id] = { invoiced: r.invoiced || 0, paid: r.paid || 0 };
  res.json({ totals });
});

router.post('/', requireAdmin, (req, res) => {
  const inv = clean(req.body);
  if (!inv.client_id || !getClient.get(inv.client_id)) return res.status(400).json({ error: 'A valid client is required' });
  if (inv.number && findByNumber.get(inv.number, 0)) return res.status(409).json({ error: `Invoice number "${inv.number}" is already in use` });
  const { items, total } = parseItems(req.body.items);
  if (!items.length || !(total > 0)) return res.status(400).json({ error: 'Add at least one line item with an amount' });
  const create = db.transaction(() => {
    const info = insertInvoice.run({ ...inv, amount: total, created_by: req.user.id, created_ts: now().toMillis() });
    items.forEach((it, i) => insertItem.run(info.lastInsertRowid, it.item, it.description, it.quantity, it.rate, i));
    return info.lastInsertRowid;
  });
  res.json({ invoice: withItems(getRow.get(create())) });
});

router.put('/:id', requireAdmin, (req, res) => {
  const existing = rawGetOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const inv = clean(req.body, existing);
  if (!inv.client_id || !getClient.get(inv.client_id)) return res.status(400).json({ error: 'A valid client is required' });
  if (inv.number && findByNumber.get(inv.number, existing.id)) return res.status(409).json({ error: `Invoice number "${inv.number}" is already in use` });
  const { items, total } = parseItems(req.body.items);
  if (!items.length || !(total > 0)) return res.status(400).json({ error: 'Add at least one line item with an amount' });
  const save = db.transaction(() => {
    updateInvoice.run({ id: existing.id, ...inv, amount: total });
    deleteItems.run(existing.id);
    items.forEach((it, i) => insertItem.run(existing.id, it.item, it.description, it.quantity, it.rate, i));
  });
  save();
  res.json({ invoice: withItems(getRow.get(existing.id)) });
});

router.post('/:id/status', requireAdmin, (req, res) => {
  const existing = rawGetOne.get(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  setStatus.run(String(req.body.status || '').toUpperCase() === 'PAID' ? 'PAID' : 'UNPAID', existing.id);
  res.json({ invoice: withItems(getRow.get(existing.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  deleteInvoice.run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
