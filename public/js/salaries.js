/* Monthly salary worksheet and employee self-service. All monetary calculations come from the server. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(value / 100) : '—';
  const days = n => `${n} ${n === 1 ? 'day' : 'days'}`;
  const date = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'Unknown';
  const range = (from, to) => from === to ? date(from) : `${date(from)} – ${date(to)}`;

  const ruleLabel = code => ({ FIRST_TWELVE:'Mandatory unpaid leave: 1st–12th', MONTHLY_LIMIT:'Regular leave above the 1.5-day monthly paid limit', ANNUAL_LIMIT:'Annual category entitlement exhausted', SHORT_DAY:'Additional approved Short Day' }[code] || code);

  function salarySummary(row) {
    const entries = [
      ['Monthly salary', money(row.monthly_gross_paise)],
      ['Calendar days in month', row.divisor],
      ['Daily salary rate', row.monthly_gross_paise == null ? '—' : money(row.monthly_gross_paise / row.divisor)],
      ['Paid leave and charges', days(row.paid_leave_days)],
      ['Unpaid leave and charges', days(row.unpaid_leave_days)],
      ['Salary deduction', money(row.deduction_paise)],
    ];
    if (row.status === 'REVIEWED' && row.calculated_salary_to_pay_paise != null) {
      entries.push(['Admin adjustment', money(row.salary_to_pay_paise - row.calculated_salary_to_pay_paise)]);
    }
    return `<div class="table-wrap"><table class="salary-summary-table" aria-label="Salary calculation"><thead><tr><th scope="col">Item</th><th scope="col">Value</th></tr></thead>
      <tbody>${entries.map(([label, value]) => `<tr><th scope="row">${label}</th><td>${esc(value)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Salary to pay</th><td>${row.status === 'REVIEW' ? 'Needs review' : money(row.salary_to_pay_paise)}</td></tr></tfoot>
    </table></div>`;
  }

  function calculation(row, readOnly = false) {
    const confirmed = row.status === 'REVIEWED';
    const automatic = (row.calculation_status || row.status) === 'CALCULATED';
    return `<div class="salary-calculation">
      ${row.review && readOnly ? `<div class="salary-confirmation"><strong>Salary confirmed by admin: ${money(row.review.amount_paise)}</strong><p class="salary-muted">${esc(new Date(row.review.reviewed_ts).toLocaleDateString())}</p></div>` : row.review ? `<div class="salary-confirmation"><strong>${confirmed ? 'Confirmed salary to pay' : 'Previous confirmation'}: ${money(row.review.amount_paise)}</strong><p>${esc(row.review.note)}</p><p class="salary-muted">${esc(row.review.reviewer_name)} · ${esc(new Date(row.review.reviewed_ts).toLocaleString())}${!confirmed ? ' · Not included in the current total' : ''}</p></div>` : ''}
      ${row.review_reasons.length ? `<div class="salary-review"><strong>${confirmed ? 'Reasons reviewed' : 'Review before payment'}</strong><ul>${row.review_reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></div>` : ''}
      ${!readOnly && row.status !== 'CALCULATED' ? `<form class="salary-resolution" data-salary-form="${row.id}">
        <div class="field"><label for="salaryAmount${row.id}">Confirmed salary to pay (INR)</label><input id="salaryAmount${row.id}" name="amount" inputmode="decimal" value="${confirmed ? (row.review.amount_paise / 100).toFixed(2) : ''}" placeholder="Enter the final amount" required></div>
        <div class="field"><label for="salaryNote${row.id}">Calculation or reason</label><textarea id="salaryNote${row.id}" name="note" maxlength="1000" placeholder="Explain the amount or part-month calculation" required>${confirmed ? esc(row.review.note) : ''}</textarea></div>
        <p class="salary-muted">Enter the final amount after leave deductions for this month. Your confirmation is included in the total; it does not record a payment.</p>
        <p class="salary-form-status" role="alert"></p><div class="row-actions"><button class="btn btn-primary" type="submit">${confirmed ? 'Update confirmation' : 'Confirm salary'}</button>${row.review && row.review.state !== 'REOPENED' ? `<button class="btn btn-ghost" type="button" data-salary-reopen="${row.id}">Reopen review</button>` : ''}</div>
      </form>` : ''}
      <details class="salary-source-details">
        <summary>Dates, rates and deductions</summary>
        <p>Employment this month: ${esc(range(row.employed_from, row.employed_to))} · ${days(row.employed_calendar_days)}.</p>
        ${row.rate_lines.length ? `<div class="table-wrap"><table><thead><tr><th>Dates</th><th>Monthly salary</th><th>Daily rate</th></tr></thead><tbody>
          ${row.rate_lines.map(line => `<tr><td>${esc(range(line.from, line.to))}</td><td>${money(line.monthly_gross_paise)}</td><td>${money(line.monthly_gross_paise / row.divisor)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p>Salary rate needs review.</p>'}
        ${row.deduction_lines.length ? `<div class="table-wrap"><table><thead><tr><th>Dates</th><th>Unpaid days</th><th>Reason</th></tr></thead><tbody>
          ${row.deduction_lines.map(line => `<tr><td>${line.dates.map(date).map(esc).join(', ')}</td><td>${days(line.unpaid_days)}</td><td>${(line.reasons || []).map(ruleLabel).map(esc).join(' · ')}</td></tr>`).join('')}
        </tbody></table></div>` : '<p>No approved unpaid leave this month.</p>'}
        <p class="salary-muted">Daily rates display to the nearest paise. The portal rounds the total deduction once for the month.</p>
      </details>
      ${(row.approved_short_day_count || row.pending_short_day_minutes) ? `<p>Short Days: ${row.approved_short_day_count} approved. Charge: ${row.short_day_paid_days || 0} days from leave balance and ${row.short_day_unpaid_days || 0} unpaid.</p>` : ''}
      ${automatic ? `<p class="salary-equation">Automatic calculation: ${money(row.monthly_gross_paise)} gross − ${money(row.deduction_paise)} leave deduction = <strong>${money(row.calculated_salary_to_pay_paise ?? row.salary_to_pay_paise)}</strong></p>` : row.full_month_reference_after_leave_paise !== null ? `<p class="salary-equation">Full-month reference: ${money(row.monthly_gross_paise)} − ${money(row.deduction_paise)} = <strong>${money(row.full_month_reference_after_leave_paise)}</strong><br><span class="salary-muted">Before any part-month adjustment. ${confirmed ? 'The confirmed amount above is used in the total.' : 'For review only; excluded from the salary-to-pay total.'}</span></p>` : '<p class="salary-muted">No prorated monthly gross is assumed. Use the available calculations above to review the final amount.</p>'}
      ${row.pending_requests ? `<p>${row.pending_requests} pending leave request(s) are not deducted.</p>` : ''}
      ${row.approved_leaves.length ? `<details><summary>Approved leave records (${row.approved_leaves.length})</summary><div class="table-wrap"><table><thead><tr><th>Dates</th><th>Type</th><th>Paid days</th><th>Unpaid days</th><th>Non-working</th></tr></thead><tbody>${row.approved_leaves.map(leave => `<tr><td>${esc(range(leave.start_date, leave.end_date))}</td><td>${leave.source === 'SHORT_DAY' ? 'Short Day charge' : leave.kind === 'HALF' ? 'Half-day leave' : 'Full-day leave'}</td><td>${leave.paid_days}</td><td>${leave.unpaid_days}</td><td>${leave.non_working_days || 0}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
    </div>`;
  }

  function employeeReportHtml(report) {
    const row = report.rows[0];
    if (!row) return '<p class="empty">No employment records for this month. Choose another month or contact an admin.</p>';
    return `<p class="salary-scope">${esc(report.scope)}</p>
      ${report.period_state !== 'ENDED' ? `<p class="salary-notice">${report.period_state === 'IN_PROGRESS' ? 'This month is still in progress.' : 'This is a future-month projection.'} The calculation may change.</p>` : ''}
      <div class="salary-slip-download">${row.salary_slip?.available ? `<a class="btn btn-primary" href="${esc(row.salary_slip.url)}" data-salary-slip="${row.id}" download>Download salary slip (PDF)</a>` : `<p class="salary-muted">${esc(row.salary_slip?.reason || 'Contact an admin to complete this month’s salary review.')}</p>`}</div>
      ${salarySummary(row)}
      ${calculation(row, true)}
      <p class="salary-muted">Salary slips reflect the calculation recorded in the portal and do not confirm payment. Contact an admin if your salary or leave records need updating.</p>`;
  }

  function reportHtml(report, { readOnly = false } = {}) {
    if (readOnly) return employeeReportHtml(report);
    const total = report.totals;
    return `<p class="salary-scope">${esc(report.scope)} Daily rate: monthly gross ÷ ${report.divisor} calendar days in ${esc(report.month)}.</p>
      ${report.period_state !== 'ENDED' ? `<p class="salary-notice">${report.period_state === 'IN_PROGRESS' ? 'This month is still in progress.' : 'This is a future-month projection.'} Salaries and approved leave may change.</p>` : ''}
      ${total.review ? `<p class="salary-review" role="status">${total.review} employee(s) need review and are excluded from the total. Select Resolve review, enter the confirmed amount and add your calculation.</p>` : ''}
      ${total.pending_requests ? `<p class="salary-notice">${total.pending_requests} pending leave request(s) are not deducted. Review approvals before paying.</p>` : ''}
      ${report.rows.length > 1 ? `<p><strong>Salary to pay${total.review ? ' · calculated subtotal' : ''}: ${(total.included ?? total.calculated) ? money(total.salary_to_pay_paise) : '—'}</strong></p>` : ''}
      ${report.rows.length ? `<div class="table-wrap salary-table-wrap"><table class="salary-table"><thead><tr><th>Employee</th><th>Monthly gross</th><th>Unpaid leave</th><th>Deduction</th><th>Salary to pay</th><th></th></tr></thead><tbody>
        ${report.rows.map(row => `<tr><td><strong>${esc(row.name)}</strong>${row.emp_code ? `<div class="salary-muted">${esc(row.emp_code)}</div>` : ''}${row.pending_requests ? `<div class="salary-muted">${row.pending_requests} pending leave request(s)</div>` : ''}</td>
          <td>${row.monthly_gross_paise === null ? 'Review rates' : money(row.monthly_gross_paise)}</td><td>${days(row.unpaid_leave_days)}</td><td>${money(row.deduction_paise)}</td>
          <td>${row.status !== 'REVIEW' ? `<strong>${money(row.salary_to_pay_paise)}</strong>${row.status === 'REVIEWED' ? '<div><span class="badge b-approved">Reviewed</span></div>' : ''}` : '<span class="badge b-pending">Needs review</span>'}</td>
          <td><button class="btn btn-ghost btn-sm" data-salary-detail="${row.id}" aria-controls="salaryDetail${row.id}" aria-expanded="false">${row.status === 'CALCULATED' ? 'View calculation' : row.status === 'REVIEWED' ? 'Edit review' : 'Resolve review'}</button>${row.salary_slip?.available ? `<a class="btn btn-ghost btn-sm" href="${esc(row.salary_slip.url)}" data-salary-slip="${row.id}" download>Salary slip (PDF)</a>` : ''}</td></tr>
          <tr id="salaryDetail${row.id}" hidden><td colspan="6">${salarySummary(row)}${calculation(row)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No employees were employed during this month.</div>'}
      <p class="salary-muted">Calculated from current salary history and approved leave. Request-time deduction estimates may differ. Refresh after changing salaries or approvals. This page does not record payments.</p>`;
  }

  function csv(report) {
    const cell = value => { let text = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    const amount = value => value === null ? '' : (value / 100).toFixed(2);
    const rows = [['Month','Employee','Code','Monthly gross INR','Approved paid leave days','Approved unpaid leave days','Leave deduction INR','Salary to pay before other adjustments INR','Full-month reference after leave INR - review only','Status','Review notes','Pending leave requests','Confirmation state','Last confirmed amount INR','Confirmed by','Confirmed at','Calculation note','Calendar days in month']];
    report.rows.forEach(row => rows.push([report.month,row.name,row.emp_code,amount(row.monthly_gross_paise),row.paid_leave_days,row.unpaid_leave_days,amount(row.deduction_paise),amount(row.salary_to_pay_paise),amount(row.full_month_reference_after_leave_paise),row.status,row.review_reasons.join(' '),row.pending_requests,row.review?.state || '',row.review ? amount(row.review.amount_paise) : '',row.review?.reviewer_name || '',row.review ? new Date(row.review.reviewed_ts).toISOString() : '',row.review?.note || '',report.divisor]));
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }

  function scopeReport(report, userId) {
    const rows = report.rows.filter(row => row.id === Number(userId));
    const calculated = rows.filter(row => row.status === 'CALCULATED');
    const reviewed = rows.filter(row => row.status === 'REVIEWED'), included = [...calculated, ...reviewed];
    return { ...report, rows, totals: { employees: rows.length, calculated: calculated.length, reviewed: reviewed.length,
      included: included.length, review: rows.length - included.length,
      pending_requests: rows.reduce((n, row) => n + row.pending_requests, 0),
      gross_paise: calculated.reduce((n, row) => n + row.monthly_gross_paise, 0),
      deduction_paise: calculated.reduce((n, row) => n + row.deduction_paise, 0),
      salary_to_pay_paise: included.reduce((n, row) => n + row.salary_to_pay_paise, 0) } };
  }

  async function mount(root, { api, onManage, month: initialMonth = '', userId = null, onMonthChange, readOnly = false, embedded = false }) {
    const monthControl = embedded ? '<input type="hidden" id="salaryMonth">' : `<div class="field"><label for="salaryMonth">Salary month</label><input type="month" id="salaryMonth"></div>
      <button class="btn btn-primary" id="salaryRefresh">Calculate</button>`;
    root.innerHTML = `<div class="toolbar salary-controls">${monthControl}<button class="btn btn-ghost" id="salaryCsv" disabled>Download CSV</button>${readOnly ? '' : '<button class="btn btn-ghost" id="salaryManage">Manage salaries</button>'}</div><p id="salaryStatus" role="status" aria-live="polite"></p><div id="salaryReport"></div>`;
    const $ = selector => root.querySelector(selector);
    const refresh = $('#salaryRefresh');
    let report = null, version = 0, selectedMonth = initialMonth;
    $('#salaryMonth').value = initialMonth;
    async function load(openId = null) {
      if (typeof openId !== 'number') openId = null;
      const current = ++version, month = $('#salaryMonth').value;
      report = null; $('#salaryCsv').disabled = true; if (refresh) refresh.disabled = true;
      $('#salaryReport').innerHTML = ''; $('#salaryStatus').textContent = 'Calculating salaries…';
      try {
        let result = await api.get((readOnly ? '/salaries/mine' : '/salaries') + (month ? '?month=' + encodeURIComponent(month) : ''));
        if (userId !== null) result = scopeReport(result, userId);
        if (current !== version || !root.isConnected || month !== $('#salaryMonth').value) return;
        report = result; selectedMonth = result.month; $('#salaryMonth').value = result.month; $('#salaryReport').innerHTML = reportHtml(result, { readOnly });
        $('#salaryStatus').textContent = 'Calculated ' + new Date(result.calculated_ts).toLocaleString() + '. Approved records only.';
        $('#salaryCsv').disabled = false;
        root.querySelectorAll('[data-salary-detail]').forEach(button => button.addEventListener('click', () => {
          const detail = $('#salaryDetail' + button.dataset.salaryDetail); detail.hidden = !detail.hidden;
          button.setAttribute('aria-expanded', String(!detail.hidden));
        }));
        root.querySelectorAll('[data-salary-slip]').forEach(link => link.addEventListener('click', async event => {
          event.preventDefault(); if (link.dataset.busy === '1') return;
          link.dataset.busy = '1'; link.setAttribute('aria-disabled', 'true');
          const label = link.textContent; link.textContent = 'Preparing salary slip…';
          try {
            const response = await fetch(link.href, { credentials: 'same-origin' });
            if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Could not download the salary slip. Please try again.'); }
            if (!response.headers.get('content-type')?.startsWith('application/pdf')) throw new Error('Could not download the salary slip. Please refresh and try again.');
            const blob = await response.blob();
            if (current !== version || !root.isConnected) return;
            const url = URL.createObjectURL(blob), download = document.createElement('a');
            download.href = url; download.download = `salary-slip-${result.month}-${link.dataset.salarySlip}.pdf`; download.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (error) { if (current === version && root.isConnected) $('#salaryStatus').textContent = error.message; }
          finally { link.dataset.busy = '0'; link.removeAttribute('aria-disabled'); link.textContent = label; }
        }));
        root.querySelectorAll('[data-salary-form]').forEach(form => {
          const row = result.rows.find(row => row.id === Number(form.dataset.salaryForm));
          const status = form.querySelector('.salary-form-status');
          const setBusy = value => form.querySelectorAll('input,textarea,button').forEach(control => { control.disabled = value; });
          form.addEventListener('submit', async event => {
            event.preventDefault(); if (form.dataset.saving === '1') return;
            const payload = { month:result.month,amount:form.querySelector('[name="amount"]').value,note:form.querySelector('[name="note"]').value,
              source_fingerprint:row.source_fingerprint,expected_revision:row.review?.revision || 0 };
            form.dataset.saving = '1'; setBusy(true); $('#salaryCsv').disabled = true; status.textContent = 'Saving confirmation…';
            try {
              await api.post(`/salaries/${row.id}/review`,payload);
              if (root.isConnected && $('#salaryMonth').value === result.month) await load(row.id);
            } catch (error) { if (form.isConnected) status.textContent = error.message; }
            finally { form.dataset.saving = '0'; setBusy(false); }
          });
          form.querySelector('[data-salary-reopen]')?.addEventListener('click', async () => {
            if (form.dataset.saving === '1') return;
            form.dataset.saving = '1'; setBusy(true); $('#salaryCsv').disabled = true; status.textContent = 'Reopening review…';
            try {
              await api.post(`/salaries/${row.id}/review/reopen`,{ month:result.month,expected_revision:row.review.revision });
              if (root.isConnected && $('#salaryMonth').value === result.month) await load(row.id);
            } catch (error) { if (form.isConnected) status.textContent = error.message; }
            finally { form.dataset.saving = '0'; setBusy(false); }
          });
        });
        if (openId === null && userId !== null) openId = Number(userId);
        if (openId !== null) {
          const detail = $('#salaryDetail' + openId), button = root.querySelector(`[data-salary-detail="${openId}"]`);
          if (detail && button) { detail.hidden = false; button.setAttribute('aria-expanded','true'); }
        }
      } catch (error) { if (current === version && root.isConnected) $('#salaryStatus').textContent = error.message; }
      finally { if (refresh && current === version && root.isConnected) refresh.disabled = false; }
    }
    $('#salaryMonth').addEventListener('change', () => {
      const month = $('#salaryMonth').value;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { $('#salaryMonth').value = selectedMonth; return; }
      selectedMonth = month; onMonthChange?.(month); return load();
    }); refresh?.addEventListener('click', load);
    $('#salaryManage')?.addEventListener('click', onManage);
    $('#salaryCsv').addEventListener('click', () => {
      if (!report) return;
      const url = URL.createObjectURL(new Blob([csv(report)], { type:'text/csv;charset=utf-8;' }));
      const link = document.createElement('a'); link.href = url; link.download = 'salary-calculation-' + report.month + '.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    await load();
  }
  window.Salaries = { mount, reportHtml, employeeReportHtml, csv, scopeReport };
})();
