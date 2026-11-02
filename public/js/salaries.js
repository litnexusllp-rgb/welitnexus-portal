/* Monthly salary worksheet and employee self-service. All monetary calculations come from the server. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(value / 100) : '—';
  const days = n => `${n} ${n === 1 ? 'day' : 'days'}`;
  const date = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'Unknown';
  const range = (from, to) => from === to ? date(from) : `${date(from)} – ${date(to)}`;

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
      <p>Employment this month: ${esc(range(row.employed_from, row.employed_to))} · ${days(row.employed_calendar_days)}.</p>
      <h3>Salary rates</h3>
      ${row.rate_lines.length ? row.rate_lines.map(line => `<p>${esc(range(line.from, line.to))} · ${days(line.calendar_days)}<br>Monthly gross ${money(line.monthly_gross_paise)} ÷ ${row.divisor} = ${money(line.monthly_gross_paise / row.divisor)} per day</p>`).join('') : (readOnly ? '<p>Ask an admin to record your salary for this month.</p>' : '<p>Add the applicable salary in Employees → Personal information.</p>')}
      <h3>Approved unpaid leave deduction</h3>
      ${row.deduction_lines.map(line => `<p>${money(line.monthly_gross_paise)} ÷ ${row.divisor} × ${days(line.unpaid_days)} unpaid<br><span class="salary-muted">${line.dates.map(date).map(esc).join(', ')}</span></p>`).join('')}
      <p><strong>${money(row.deduction_paise)}</strong>${row.deduction_paise === null ? ' · Cannot calculate the complete deduction until missing records are resolved.' : row.unpaid_leave_days ? ' · Total rounded once to the nearest paise.' : ' · No approved unpaid leave this month.'}</p>
      ${automatic ? `<p class="salary-equation">Automatic calculation: ${money(row.monthly_gross_paise)} gross − ${money(row.deduction_paise)} leave deduction = <strong>${money(row.calculated_salary_to_pay_paise ?? row.salary_to_pay_paise)}</strong></p>` : row.full_month_reference_after_leave_paise !== null ? `<p class="salary-equation">Full-month reference: ${money(row.monthly_gross_paise)} − ${money(row.deduction_paise)} = <strong>${money(row.full_month_reference_after_leave_paise)}</strong><br><span class="salary-muted">Before any part-month adjustment. ${confirmed ? 'The confirmed amount above is used in the total.' : 'For review only; excluded from the salary-to-pay total.'}</span></p>` : '<p class="salary-muted">No prorated monthly gross is assumed. Use the available calculations above to review the final amount.</p>'}
      ${row.pending_requests ? `<p>${row.pending_requests} pending leave request(s) are not deducted.</p>` : ''}
      ${row.approved_leaves.length ? `<details><summary>Approved leave records (${row.approved_leaves.length})</summary><div class="table-wrap"><table><thead><tr><th>Dates</th><th>Paid days</th><th>Unpaid days</th></tr></thead><tbody>${row.approved_leaves.map(leave => `<tr><td>${esc(range(leave.start_date, leave.end_date))}</td><td>${leave.paid_days}</td><td>${leave.unpaid_days}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
      <p class="salary-muted">Daily rates are displayed rounded. Deductions use exact salary amounts and half-day units, then round once for the month. Only leave on the 1st–12th, from October 2026, is unpaid.</p>
    </div>`;
  }

  function employeeReportHtml(report) {
    const row = report.rows[0];
    if (!row) return '<p class="empty">No employment records for this month. Choose another month or contact an admin.</p>';
    const ready = row.status === 'CALCULATED' || row.status === 'REVIEWED';
    return `<h4>Salary calculation for ${esc(row.name)}</h4><p class="salary-scope">${esc(report.scope)} Daily rate: monthly gross ÷ ${report.divisor} calendar days in ${esc(report.month)}.</p>
      ${report.period_state !== 'ENDED' ? `<p class="salary-notice">${report.period_state === 'IN_PROGRESS' ? 'This month is still in progress.' : 'This is a future-month projection.'} The calculation may change.</p>` : ''}
      <div class="cards salary-stats">
        <div class="card stat"><div class="label">Monthly gross</div><div class="value small">${money(row.monthly_gross_paise)}</div></div>
        <div class="card stat"><div class="label">Approved unpaid leave</div><div class="value small">${days(row.unpaid_leave_days)}</div></div>
        <div class="card stat"><div class="label">Your salary to pay</div><div class="value small">${ready ? money(row.salary_to_pay_paise) : 'Needs review'}</div>${row.status === 'REVIEWED' ? '<div class="salary-muted">Confirmed by admin</div>' : ''}</div>
      </div>
      <div class="salary-slip-download">${row.salary_slip?.available ? `<a class="btn btn-primary" href="${esc(row.salary_slip.url)}" data-salary-slip="${row.id}" download>Download salary slip (PDF)</a>` : `<p class="salary-muted">${esc(row.salary_slip?.reason || 'Contact an admin to complete this month’s salary review.')}</p>`}</div>
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
      <div class="cards salary-stats">
        <div class="card stat"><div class="label">${total.review ? 'Salary to pay · calculated subtotal' : 'Salary to pay'}</div><div class="value small">${(total.included ?? total.calculated) ? money(total.salary_to_pay_paise) : '—'}</div><div class="salary-muted">${total.calculated} calculated · ${total.reviewed || 0} reviewed · ${total.review} need review</div></div>
        <div class="card stat"><div class="label">Leave deductions · automatic rows</div><div class="value small">${total.calculated ? money(total.deduction_paise) : '—'}</div><div class="salary-muted">Confirmed amounts already include leave deductions.</div></div>
        <div class="card stat"><div class="label">Needs review</div><div class="value small">${total.review}</div></div>
      </div>
      ${report.rows.length ? `<div class="table-wrap salary-table-wrap"><table class="salary-table"><thead><tr><th>Employee</th><th>Monthly gross</th><th>Unpaid leave</th><th>Deduction</th><th>Salary to pay</th><th></th></tr></thead><tbody>
        ${report.rows.map(row => `<tr><td><strong>${esc(row.name)}</strong>${row.emp_code ? `<div class="salary-muted">${esc(row.emp_code)}</div>` : ''}${row.pending_requests ? `<div class="salary-muted">${row.pending_requests} pending leave request(s)</div>` : ''}</td>
          <td>${row.monthly_gross_paise === null ? 'Review rates' : money(row.monthly_gross_paise)}</td><td>${days(row.unpaid_leave_days)}</td><td>${money(row.deduction_paise)}</td>
          <td>${row.status !== 'REVIEW' ? `<strong>${money(row.salary_to_pay_paise)}</strong>${row.status === 'REVIEWED' ? '<div><span class="badge b-approved">Reviewed</span></div>' : ''}` : '<span class="badge b-pending">Needs review</span>'}</td>
          <td><button class="btn btn-ghost btn-sm" data-salary-detail="${row.id}" aria-controls="salaryDetail${row.id}" aria-expanded="false">${row.status === 'CALCULATED' ? 'View calculation' : row.status === 'REVIEWED' ? 'Edit review' : 'Resolve review'}</button>${row.salary_slip?.available ? `<a class="btn btn-ghost btn-sm" href="${esc(row.salary_slip.url)}" data-salary-slip="${row.id}" download>Salary slip (PDF)</a>` : ''}</td></tr>
          <tr id="salaryDetail${row.id}" hidden><td colspan="6">${calculation(row)}</td></tr>`).join('')}
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

  async function mount(root, { api, onManage, month: initialMonth = '', userId = null, onMonthChange, readOnly = false }) {
    root.innerHTML = `<div class="toolbar salary-controls"><div class="field"><label for="salaryMonth">Salary month</label><input type="month" id="salaryMonth"></div><button class="btn btn-primary" id="salaryRefresh">Calculate</button><button class="btn btn-ghost" id="salaryCsv" disabled>Download CSV</button>${readOnly ? '' : '<button class="btn btn-ghost" id="salaryManage">Manage salaries</button>'}</div><p id="salaryStatus" role="status" aria-live="polite"></p><div id="salaryReport"></div>`;
    const $ = selector => root.querySelector(selector); let report = null, version = 0, selectedMonth = initialMonth;
    $('#salaryMonth').value = initialMonth;
    async function load(openId = null) {
      if (typeof openId !== 'number') openId = null;
      const current = ++version, month = $('#salaryMonth').value;
      report = null; $('#salaryCsv').disabled = true; $('#salaryRefresh').disabled = true;
      $('#salaryReport').innerHTML = ''; $('#salaryStatus').textContent = 'Calculating salaries…';
      try {
        let result = await api.get((readOnly ? '/salaries/mine' : '/salaries') + (month ? '?month=' + encodeURIComponent(month) : ''));
        if (userId !== null) result = scopeReport(result, userId);
        if (current !== version || !root.isConnected || month !== $('#salaryMonth').value) return;
        report = result; selectedMonth = result.month; $('#salaryMonth').value = result.month; $('#salaryReport').innerHTML = reportHtml(result, { readOnly });
        $('#salaryStatus').textContent = 'Calculated ' + new Date(result.calculated_ts).toLocaleString() + '. Based on approved leave only.';
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
      finally { if (current === version && root.isConnected) $('#salaryRefresh').disabled = false; }
    }
    $('#salaryMonth').addEventListener('change', () => {
      const month = $('#salaryMonth').value;
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { $('#salaryMonth').value = selectedMonth; return; }
      selectedMonth = month; onMonthChange?.(month); return load();
    }); $('#salaryRefresh').addEventListener('click', load);
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
