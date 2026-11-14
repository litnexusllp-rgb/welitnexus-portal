'use strict';

// Billing logic: totals, numbering, status, summaries and the invoice PDF.
// Money is integer minor units (cents/paise) everywhere; inputs from the UI are
// major units (e.g. 1800.50) and converted once at the edge.

const path = require('node:path');
const { PDFDocument } = require('pdfkit');
const { db } = require('../db');
const { todayStr: today, DateTime, ZONE } = require('../time');

const TERMS = { DUE_ON_RECEIPT: 0, NET_7: 7, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60 };
const CURRENCIES = { USD: { symbol: '$', locale: 'en-US' }, INR: { symbol: '₹', locale: 'en-IN' } };
const company = {
  name: 'LIT Nexus LLP',
  street: 'Cabin No. 12, First Floor, Big Bang Tower, Plot No. E279',
  city: 'Sector-75, Industrial Area, Mohali, Punjab - 160071',
};

const toMinor = (major) => {
  const n = Number(major);
  if (!Number.isFinite(n) || Math.abs(n) > 1e11)
    throw Object.assign(new Error('Amounts must be valid numbers'), { status: 400 });
  return Math.round(n * 100);
};
const fromMinor = (minor) => Math.round(minor) / 100;

function formatMoney(minor, currency = 'USD') {
  const c = CURRENCIES[currency] || CURRENCIES.USD;
  return (
    (minor < 0 ? '-' : '') +
    (currency === 'INR' ? 'INR ' : c.symbol) +
    (Math.abs(minor) / 100).toLocaleString(c.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function dueDateFor(issueDate, terms) {
  const days = TERMS[terms] ?? 30;
  return DateTime.fromISO(issueDate, { zone: ZONE }).plus({ days }).toISODate();
}

function cleanLines(lines) {
  if (!Array.isArray(lines)) throw Object.assign(new Error('Add at least one line item'), { status: 400 });
  if (lines.length > 200) throw Object.assign(new Error('Too many line items'), { status: 400 });
  return lines.map((l, i) => {
    const description = String(l.description || '')
      .trim()
      .slice(0, 500);
    const quantity = Number(l.quantity ?? 1);
    if (!description) throw Object.assign(new Error(`Line ${i + 1} needs a description`), { status: 400 });
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000)
      throw Object.assign(new Error(`Line ${i + 1} quantity must be positive`), { status: 400 });
    const unit = toMinor(l.unit_price ?? 0);
    if (unit < 0) throw Object.assign(new Error(`Line ${i + 1} price cannot be negative`), { status: 400 });
    return {
      position: i + 1,
      description,
      quantity,
      unit_price: unit,
      amount: Math.round(quantity * unit),
      source: String(l.source || '').slice(0, 80),
    };
  });
}

function totals(lines, taxRateBp) {
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const tax = Math.round((subtotal * taxRateBp) / 10000);
  return { subtotal, tax, total: subtotal + tax };
}

// Number is assigned when an invoice is first sent: INV-2026-001.
function nextNumber() {
  const year = Number(today().slice(0, 4));
  return db.transaction(() => {
    const row = db.prepare('SELECT next_no FROM int_invoice_counters WHERE year=?').get(year);
    const no = row ? row.next_no : 1;
    if (row) db.prepare('UPDATE int_invoice_counters SET next_no=? WHERE year=?').run(no + 1, year);
    else db.prepare('INSERT INTO int_invoice_counters(year,next_no) VALUES (?,?)').run(year, 2);
    return `INV-${year}-${String(no).padStart(3, '0')}`;
  })();
}

// DRAFT | SENT | OVERDUE (derived) | PAID | VOID
function displayStatus(inv, on = today()) {
  if (inv.status === 'SENT' && inv.due_date < on) return 'OVERDUE';
  return inv.status;
}

function load(id) {
  const inv = db
    .prepare(
      `SELECT i.*, c.name AS client_name, c.email AS client_email, c.billing_address AS client_address
    FROM int_invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`,
    )
    .get(id);
  if (!inv) return null;
  inv.lines = db.prepare('SELECT * FROM int_invoice_lines WHERE invoice_id=? ORDER BY position').all(id);
  inv.payments = db
    .prepare(
      'SELECT p.*, u.name AS recorded_by_name FROM int_payments p LEFT JOIN users u ON u.id=p.recorded_by WHERE invoice_id=? ORDER BY paid_on, id',
    )
    .all(id);
  inv.display_status = displayStatus(inv);
  inv.balance = inv.total - inv.paid;
  return inv;
}

// Indian fiscal year: April to March. fy=2026 means 2026-04-01 .. 2027-03-31.
function fiscalRange(fy) {
  const y =
    Number(fy) ||
    (() => {
      const t = today();
      const yr = Number(t.slice(0, 4));
      return Number(t.slice(5, 7)) >= 4 ? yr : yr - 1;
    })();
  return { fy: y, from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

function summary(fy, currency = 'USD') {
  const { from, to, fy: year } = fiscalRange(fy);
  const on = today();
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS client_name FROM int_invoices i JOIN clients c ON c.id=i.client_id
    WHERE i.currency=? AND i.status IN ('SENT','PAID') AND i.issue_date BETWEEN ? AND ?`,
    )
    .all(currency, from, to);
  const out = {
    fy: year,
    from,
    to,
    currency,
    billed: 0,
    collected: 0,
    outstanding: 0,
    overdue: 0,
    invoices: rows.length,
    open: 0,
    overdueCount: 0,
    oldestOverdueDays: 0,
    byClient: [],
  };
  const byClient = new Map();
  for (const r of rows) {
    out.billed += r.total;
    out.collected += r.paid;
    const balance = r.total - r.paid;
    if (r.status === 'SENT') {
      out.outstanding += balance;
      out.open++;
      if (r.due_date < on) {
        out.overdue += balance;
        out.overdueCount++;
        out.oldestOverdueDays = Math.max(
          out.oldestOverdueDays,
          Math.round(DateTime.fromISO(on).diff(DateTime.fromISO(r.due_date), 'days').days),
        );
      }
    }
    const c = byClient.get(r.client_id) || { client_id: r.client_id, name: r.client_name, billed: 0, collected: 0 };
    c.billed += r.total;
    c.collected += r.paid;
    byClient.set(r.client_id, c);
  }
  out.byClient = [...byClient.values()].sort((a, b) => b.billed - a.billed);
  out.collectionRate = out.billed ? Math.round((out.collected / out.billed) * 100) : null;
  return out;
}

// ---------- PDF ----------
const fontDir = path.join(__dirname, '..', '..', 'assets', 'fonts');
const logo = path.join(__dirname, '..', '..', 'public', 'img', 'Color Logo.jpg');
// Control characters PDFKit cannot render (newlines are kept).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x09\x0b-\x1f\x7f]/g;
const safe = (v) =>
  String(v ?? '')
    .replace(CONTROL_CHARS, ' ')
    .slice(0, 1000);
const niceDate = (iso) => (iso ? DateTime.fromISO(iso, { zone: ZONE }).toFormat('LLL d, yyyy') : '');
const TERM_LABEL = {
  DUE_ON_RECEIPT: 'Due on receipt',
  NET_7: 'Net 7',
  NET_15: 'Net 15',
  NET_30: 'Net 30',
  NET_45: 'Net 45',
  NET_60: 'Net 60',
};

function renderInvoicePdf(inv) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 54, right: 54, bottom: 54, left: 54 },
      info: { Title: `Invoice ${inv.number || 'Draft'}`, Author: company.name },
    });
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Body', path.join(fontDir, 'NotoSans-Regular.ttf'));
      doc.registerFont('Bold', path.join(fontDir, 'NotoSans-Bold.ttf'));
      const navy = '#0B2440',
        muted = '#5B6B7B',
        rule = '#DCE3EA';
      const L = 54,
        W = doc.page.width - 108;
      const t = (v, x, y, o = {}) =>
        doc
          .font(o.bold ? 'Bold' : 'Body')
          .fontSize(o.size || 10)
          .fillColor(o.color || navy)
          .text(safe(v), x, y, { width: o.width || W, align: o.align || 'left', lineGap: 2 });
      try {
        doc.image(logo, L, 44, { width: 150 });
      } catch (_e) {
        t(company.name, L, 50, { bold: true, size: 16 });
      }
      t('INVOICE', L, 46, { bold: true, size: 24, align: 'right' });
      t(inv.number || 'DRAFT', L, 78, { color: muted, align: 'right' });
      t(company.name, L, 110, { bold: true });
      t(`${company.street}\n${company.city}`, L, 126, { color: muted, size: 9, width: 260 });

      let y = 180;
      t('BILL TO', L, y, { bold: true, size: 8, color: muted });
      t(inv.client_name, L, y + 14, { bold: true, width: 280 });
      t(inv.bill_to || inv.client_address || '', L, y + 30, { color: muted, size: 9, width: 280 });
      const meta = [
        ['Issued', niceDate(inv.issue_date)],
        ['Due', niceDate(inv.due_date)],
        ['Terms', TERM_LABEL[inv.terms] || inv.terms],
        ['Currency', inv.currency],
      ];
      meta.forEach(([k, v], i) => {
        t(k, L + W - 220, y + i * 16, { color: muted, width: 100 });
        t(v, L + W - 120, y + i * 16, { width: 120, align: 'right' });
      });

      y = 270;
      doc
        .moveTo(L, y + 16)
        .lineTo(L + W, y + 16)
        .lineWidth(1.5)
        .strokeColor(navy)
        .stroke();
      t('DESCRIPTION', L, y, { bold: true, size: 8, color: muted });
      t('QTY', L + W - 230, y, { bold: true, size: 8, color: muted, width: 50, align: 'right' });
      t('RATE', L + W - 170, y, { bold: true, size: 8, color: muted, width: 80, align: 'right' });
      t('AMOUNT', L + W - 90, y, { bold: true, size: 8, color: muted, width: 90, align: 'right' });
      y += 26;
      for (const line of inv.lines) {
        doc.font('Body').fontSize(10);
        const h = Math.max(16, doc.heightOfString(safe(line.description), { width: W - 250 }));
        if (y + h > 660) {
          doc.addPage();
          y = 60;
        }
        t(line.description, L, y, { width: W - 250 });
        t(String(Number(line.quantity.toFixed(2))), L + W - 230, y, { width: 50, align: 'right' });
        t(formatMoney(line.unit_price, inv.currency), L + W - 170, y, { width: 80, align: 'right' });
        t(formatMoney(line.amount, inv.currency), L + W - 90, y, { width: 90, align: 'right', bold: true });
        y += h + 8;
        doc
          .moveTo(L, y - 4)
          .lineTo(L + W, y - 4)
          .lineWidth(0.5)
          .strokeColor(rule)
          .stroke();
      }
      y += 10;
      const row = (k, v, bold) => {
        t(k, L + W - 240, y, { color: bold ? navy : muted, width: 130, bold });
        t(v, L + W - 110, y, { width: 110, align: 'right', bold, size: bold ? 12 : 10 });
        y += bold ? 22 : 16;
      };
      row('Subtotal', formatMoney(inv.subtotal, inv.currency));
      if (inv.tax_rate_bp) row(`Tax (${inv.tax_rate_bp / 100}%)`, formatMoney(inv.tax, inv.currency));
      doc
        .moveTo(L + W - 240, y)
        .lineTo(L + W, y)
        .lineWidth(1.5)
        .strokeColor(navy)
        .stroke();
      y += 6;
      row('Total due', formatMoney(inv.total, inv.currency), true);
      if (inv.paid) {
        row('Paid', formatMoney(inv.paid, inv.currency));
        row('Balance', formatMoney(inv.total - inv.paid, inv.currency), true);
      }
      if (inv.notes) {
        y += 20;
        t('NOTES', L, y, { bold: true, size: 8, color: muted });
        t(inv.notes, L, y + 14, { size: 9, color: muted });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  TERMS,
  CURRENCIES,
  toMinor,
  fromMinor,
  formatMoney,
  dueDateFor,
  cleanLines,
  totals,
  nextNumber,
  displayStatus,
  load,
  summary,
  fiscalRange,
  renderInvoicePdf,
};
