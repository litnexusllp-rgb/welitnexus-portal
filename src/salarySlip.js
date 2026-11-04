'use strict';

const path = require('node:path');
const { PDFDocument } = require('pdfkit');
const { DateTime, ZONE } = require('./time');
const { slipEligibility } = require('./employeeSalary');

const fontDir = path.join(__dirname, '..', 'assets', 'fonts');
const logo = path.join(__dirname, '..', 'public', 'img', 'Color Logo.jpg');
// Company letterhead in LIT_Nexus_Staff_Policy_Final.pdf, supplied by the owner.
const company = {
  name: 'LIT Nexus LLP',
  street: 'Cabin No. 12, First Floor, Big Bang Tower, Plot No. E279',
  city: 'Sector-75, Industrial Area, Mohali, Punjab - 160071',
};
const money = value => Number.isSafeInteger(value) ? 'INR ' + (value / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Not recorded';
const safeText = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\u2010-\u2015]/g, '-').slice(0, 240) || 'Not recorded';
const dayCount = value => `${value} ${value === 1 ? 'day' : 'days'}`;
const date = iso => DateTime.fromISO(iso, { zone: ZONE }).toFormat('d LLL yyyy');

// Generated in memory and sent only through an authenticated route. No public
// files, payroll writes, payment claims or invented tax/bank details.
function renderSalarySlip(report, row) {
  const reason = slipEligibility(report, row);
  if (reason) throw Object.assign(new Error(reason), { status: 409 });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, right: 48, bottom: 48, left: 48 }, bufferPages: true,
      info: { Title: `Salary slip - ${report.month}`, Author: company.name, CreationDate: new Date(report.calculated_ts) } });
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Body', path.join(fontDir, 'NotoSans-Regular.ttf'));
      doc.registerFont('Bold', path.join(fontDir, 'NotoSans-Bold.ttf'));
      const navy = '#0B243C', teal = '#078575', muted = '#526477', line = '#DCE5EC';
      const width = doc.page.width - 96;
      let y = 48;
      function text(value, x, top, options = {}) {
        doc.font(options.bold ? 'Bold' : 'Body').fontSize(options.size || 10).fillColor(options.color || navy)
          .text(String(value), x, top, { width: options.width || width, ...options });
      }
      function ensureSpace(height) {
        if (y + height <= 740) return;
        doc.addPage();
        doc.image(logo, 30, 17, { width: 145 });
        text('Salary slip - ' + report.month, 285, 40, { size: 11, bold: true, width: width - 237, align: 'right' });
        y = 78;
      }
      function paragraph(value, options = {}) {
        doc.font(options.bold ? 'Bold' : 'Body').fontSize(options.size || 10);
        const height = doc.heightOfString(value, { width, lineGap: 3 });
        ensureSpace(height + 8);
        text(value, 48, y, { ...options, lineGap: 3 }); y += height + 8;
      }
      function grid(left, right) {
        const fieldWidth = (width - 28) / 2;
        doc.font('Body').fontSize(11);
        const values = [safeText(left[1]), safeText(right[1])];
        const height = Math.max(...values.map(value => doc.heightOfString(value, { width: fieldWidth, lineGap: 2 })));
        ensureSpace(height + 30);
        [left, right].forEach((field, index) => {
          const x = 48 + index * (fieldWidth + 28);
          text(field[0].toUpperCase(), x, y, { width: fieldWidth, size: 8, color: muted, bold: true });
          text(values[index], x, y + 17, { width: fieldWidth, size: 11, lineGap: 2 });
        });
        y += height + 27;
      }
      function amountRow(label, amount, total = false) {
        ensureSpace(42);
        if (total) doc.roundedRect(48, y - 3, width, 40, 6).fill('#EAF5F2');
        text(label, total ? 60 : 48, y + 7, { width: width * 0.61, bold: total, size: total ? 12 : 10 });
        text(amount, 48 + width * 0.61, y + 7, { width: width * 0.39 - (total ? 12 : 0), align: 'right', bold: total, size: total ? 13 : 11, color: total ? teal : navy });
        if (!total) doc.moveTo(48, y + 34).lineTo(48 + width, y + 34).strokeColor(line).lineWidth(0.6).stroke();
        y += total ? 43 : 38;
      }

      doc.image(logo, 17, 13, { width: 235 });
      text('Salary slip', 320, 43, { size: 21, bold: true, width: doc.page.width - 368, align: 'right' });
      const month = DateTime.fromISO(report.month + '-01').toFormat('LLLL yyyy');
      text(month, 320, 76, { size: 12, bold: true, width: doc.page.width - 368, align: 'right' });
      text(company.name, 48, 104, { size: 9, bold: true, width: 225 });
      text(`Reference: ${report.month}/${row.id}`, 320, 104, { width: doc.page.width - 368, align: 'right', size: 9, color: muted });
      text(company.street, 48, 119, { size: 8.5, color: muted });
      text(company.city, 48, 132, { size: 8.5, color: muted });
      doc.moveTo(48, 157).lineTo(48 + width, 157).strokeColor(line).stroke();
      y = 175;
      grid(['Employee', row.name], ['Employee code', row.emp_code]);
      grid(['Department', row.department], ['Title', row.title]);
      grid(['Employment this month', `${date(row.employed_from)} - ${date(row.employed_to)}`], ['Calculation', row.status === 'REVIEWED' ? 'Confirmed by admin' : 'Calculated from recorded sources']);
      paragraph('Salary summary', { size: 13, bold: true });
      amountRow('Monthly gross salary', money(row.monthly_gross_paise));
      amountRow(`Approved unpaid leave (${dayCount(row.unpaid_leave_days)})`, row.deduction_paise === null ? 'Not recorded' : '- ' + money(row.deduction_paise));
      if (row.status === 'REVIEWED' && Number.isSafeInteger(row.monthly_gross_paise) && Number.isSafeInteger(row.deduction_paise)) {
        const adjustment = row.salary_to_pay_paise - (row.monthly_gross_paise - row.deduction_paise);
        amountRow('Admin-confirmed adjustment', money(adjustment));
      }
      amountRow('Salary to pay', money(row.salary_to_pay_paise), true);
      y += 12;
      paragraph(`Calendar basis: ${report.divisor} days in ${month}. Approved paid leave: ${dayCount(row.paid_leave_days)}. Short Day charge: ${row.short_day_paid_days || 0} paid days and ${row.short_day_unpaid_days || 0} unpaid days.`, { color: muted, size: 9 });
      if (row.deduction_lines.length) {
        paragraph('Leave deduction calculation', { size: 11, bold: true });
        for (const item of row.deduction_lines) {
          paragraph(`${money(item.monthly_gross_paise)} / ${report.divisor} calendar days x ${dayCount(item.unpaid_days)} unpaid\nLeave dates: ${item.date_details ? item.date_details.map(d => `${date(d.date)} (${d.unpaid_days} day; ${d.reasons.includes('SHORT_DAY') ? 'additional Short Day' : d.reasons.includes('FIRST_TWELVE') ? '1st-12th' : d.reasons.includes('MONTHLY_LIMIT') ? 'monthly paid limit' : 'annual entitlement'})`).join(', ') : item.dates.map(date).join(', ')}`, { size: 9, color: muted });
        }
      }
      paragraph('Leave policy: the 1st-12th is unpaid. Outside it, regular paid leave is limited to 1.5 scheduled days per month; unused monthly allowance does not accumulate. Flexi and birthday/anniversary have separate annual entitlements. Each approved Short Day after the first in a month charges 0.25 day. Only scheduled working time is charged; weekends and full holidays are excluded, and half holidays have 0.5 working day.', { size:8, color:muted });
      paragraph('Amounts are based on recorded monthly gross salary and approved unpaid leave. Tax, bonuses and other payroll adjustments are not recorded in this calculation. This slip does not confirm payment.', { size: 8, color: muted });
      const generated = DateTime.fromMillis(report.calculated_ts, { zone: ZONE }).toFormat('d LLL yyyy, HH:mm ZZZZ');
      paragraph('Generated ' + generated + (row.review?.reviewed_ts ? ' | Salary confirmed ' + DateTime.fromMillis(row.review.reviewed_ts, { zone: ZONE }).toFormat('d LLL yyyy') : ''), { size: 8, color: muted });
      const pages = doc.bufferedPageRange();
      for (let page = pages.start; page < pages.start + pages.count; page++) {
        doc.switchToPage(page);
        text(`${company.name} | ${report.month} | Page ${page + 1} of ${pages.count}`, 48, 775, { size: 8, color: muted, align: 'center' });
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}

module.exports = { renderSalarySlip };
