/* Admin monthly salary worksheet. All monetary calculations come from the server. */
(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', minimumFractionDigits:0, maximumFractionDigits:2 }).format(value / 100) : '—';
  const days = n => `${n} ${n === 1 ? 'day' : 'days'}`;
  const date = iso => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'Unknown';
  const range = (from, to) => from === to ? date(from) : `${date(from)} – ${date(to)}`;

  function calculation(row) {
    return `<div class="salary-calculation">
      ${row.review_reasons.length ? `<div class="salary-review"><strong>Review before payment</strong><ul>${row.review_reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></div>` : ''}
      <p>Employment this month: ${esc(range(row.employed_from, row.employed_to))} · ${days(row.employed_calendar_days)}.</p>
      <h3>Salary rates</h3>
      ${row.rate_lines.length ? row.rate_lines.map(line => `<p>${esc(range(line.from, line.to))} · ${days(line.calendar_days)}<br>Monthly gross ${money(line.monthly_gross_paise)} ÷ 30 = ${money(line.monthly_gross_paise / 30)} per day</p>`).join('') : '<p>Add the applicable salary in Admin → Employees.</p>'}
      <h3>Approved unpaid leave deduction</h3>
      ${row.deduction_lines.map(line => `<p>${money(line.monthly_gross_paise)} ÷ 30 × ${days(line.unpaid_days)} unpaid<br><span class="salary-muted">${line.dates.map(date).map(esc).join(', ')}</span></p>`).join('')}
      <p><strong>${money(row.deduction_paise)}</strong>${row.deduction_paise === null ? ' · Cannot calculate the complete deduction until missing records are resolved.' : row.unpaid_leave_days ? ' · Total rounded once to the nearest paise.' : ' · No approved unpaid leave this month.'}</p>
      ${row.status === 'CALCULATED' ? `<p class="salary-equation">${money(row.monthly_gross_paise)} gross − ${money(row.deduction_paise)} leave deduction = <strong>${money(row.salary_to_pay_paise)}</strong></p>` : row.full_month_reference_after_leave_paise !== null ? `<p class="salary-equation">Full-month reference: ${money(row.monthly_gross_paise)} − ${money(row.deduction_paise)} = <strong>${money(row.full_month_reference_after_leave_paise)}</strong><br><span class="salary-muted">Before any part-month adjustment. For review only; excluded from the salary-to-pay total.</span></p>` : '<p class="salary-muted">Daily-rate calculations are shown above. No prorated monthly gross is assumed; salary to pay needs review.</p>'}
      ${row.pending_requests ? `<p>${row.pending_requests} pending leave request(s) are not deducted.</p>` : ''}
      ${row.approved_leaves.length ? `<details><summary>Approved leave records (${row.approved_leaves.length})</summary><div class="table-wrap"><table><thead><tr><th>Dates</th><th>Paid days</th><th>Unpaid days</th></tr></thead><tbody>${row.approved_leaves.map(leave => `<tr><td>${esc(range(leave.start_date, leave.end_date))}</td><td>${leave.paid_days}</td><td>${leave.unpaid_days}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
      <p class="salary-muted">Daily rates are displayed rounded. Deductions use exact salary amounts and half-day units, then round once for the month. Only leave on the 1st–12th, from October 2026, is unpaid.</p>
    </div>`;
  }

  function reportHtml(report) {
    const total = report.totals;
    return `<p class="salary-scope">${esc(report.scope)}</p>
      ${report.period_state !== 'ENDED' ? `<p class="salary-notice">${report.period_state === 'IN_PROGRESS' ? 'This month is still in progress.' : 'This is a future-month projection.'} Salaries and approved leave may change.</p>` : ''}
      ${total.review ? `<p class="salary-review" role="status">${total.review} employee(s) need review and are excluded from the calculated total. Open their calculation below.</p>` : ''}
      ${total.pending_requests ? `<p class="salary-notice">${total.pending_requests} pending leave request(s) are not deducted. Review approvals before paying.</p>` : ''}
      <div class="cards salary-stats">
        <div class="card stat"><div class="label">${total.review ? 'Salary to pay · calculated subtotal' : 'Salary to pay'}</div><div class="value small">${total.calculated ? money(total.salary_to_pay_paise) : '—'}</div><div class="salary-muted">${total.calculated} of ${total.employees} employees calculated</div></div>
        <div class="card stat"><div class="label">Leave deductions · calculated employees</div><div class="value small">${total.calculated ? money(total.deduction_paise) : '—'}</div></div>
        <div class="card stat"><div class="label">Needs review</div><div class="value small">${total.review}</div></div>
      </div>
      ${report.rows.length ? `<div class="table-wrap salary-table-wrap"><table class="salary-table"><thead><tr><th>Employee</th><th>Monthly gross</th><th>Unpaid leave</th><th>Deduction</th><th>Salary to pay</th><th></th></tr></thead><tbody>
        ${report.rows.map(row => `<tr><td><strong>${esc(row.name)}</strong>${row.emp_code ? `<div class="salary-muted">${esc(row.emp_code)}</div>` : ''}${row.pending_requests ? `<div class="salary-muted">${row.pending_requests} pending leave request(s)</div>` : ''}</td>
          <td>${row.monthly_gross_paise === null ? 'Review rates' : money(row.monthly_gross_paise)}</td><td>${days(row.unpaid_leave_days)}</td><td>${money(row.deduction_paise)}</td>
          <td>${row.status === 'CALCULATED' ? `<strong>${money(row.salary_to_pay_paise)}</strong>` : '<span class="badge b-pending">Needs review</span>'}</td>
          <td><button class="btn btn-ghost btn-sm" data-salary-detail="${row.id}" aria-controls="salaryDetail${row.id}" aria-expanded="false">${row.status === 'CALCULATED' ? 'View calculation' : 'Review calculation'}</button></td></tr>
          <tr id="salaryDetail${row.id}" hidden><td colspan="6">${calculation(row)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No employees were employed during this month.</div>'}
      <p class="salary-muted">Calculated from current salary history and approved leave. Request-time deduction estimates may differ. Refresh after changing salaries or approvals. This page does not record payments.</p>`;
  }

  function csv(report) {
    const cell = value => { let text = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    const amount = value => value === null ? '' : (value / 100).toFixed(2);
    const rows = [['Month','Employee','Code','Monthly gross INR','Approved paid leave days','Approved unpaid leave days','Leave deduction INR','Salary to pay before other adjustments INR','Full-month reference after leave INR - review only','Status','Review notes','Pending leave requests']];
    report.rows.forEach(row => rows.push([report.month,row.name,row.emp_code,amount(row.monthly_gross_paise),row.paid_leave_days,row.unpaid_leave_days,amount(row.deduction_paise),amount(row.salary_to_pay_paise),amount(row.full_month_reference_after_leave_paise),row.status,row.review_reasons.join(' '),row.pending_requests]));
    return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  }

  async function mount(root, { api, onManage }) {
    root.innerHTML = `<div class="toolbar salary-controls"><div class="field"><label for="salaryMonth">Salary month</label><input type="month" id="salaryMonth"></div><button class="btn btn-primary" id="salaryRefresh">Calculate</button><button class="btn btn-ghost" id="salaryCsv" disabled>Download CSV</button><button class="btn btn-ghost" id="salaryManage">Manage salaries</button></div><p id="salaryStatus" role="status" aria-live="polite"></p><div id="salaryReport"></div>`;
    const $ = selector => root.querySelector(selector); let report = null, version = 0;
    async function load() {
      const current = ++version, month = $('#salaryMonth').value;
      report = null; $('#salaryCsv').disabled = true; $('#salaryRefresh').disabled = true;
      $('#salaryReport').innerHTML = ''; $('#salaryStatus').textContent = 'Calculating salaries…';
      try {
        const result = await api.get('/salaries' + (month ? '?month=' + encodeURIComponent(month) : ''));
        if (current !== version || !root.isConnected || month !== $('#salaryMonth').value) return;
        report = result; $('#salaryMonth').value = result.month; $('#salaryReport').innerHTML = reportHtml(result);
        $('#salaryStatus').textContent = 'Calculated ' + new Date(result.calculated_ts).toLocaleString() + '. Based on approved leave only.';
        $('#salaryCsv').disabled = false;
        root.querySelectorAll('[data-salary-detail]').forEach(button => button.addEventListener('click', () => {
          const detail = $('#salaryDetail' + button.dataset.salaryDetail); detail.hidden = !detail.hidden;
          button.setAttribute('aria-expanded', String(!detail.hidden));
        }));
      } catch (error) { if (current === version && root.isConnected) $('#salaryStatus').textContent = error.message; }
      finally { if (current === version && root.isConnected) $('#salaryRefresh').disabled = false; }
    }
    $('#salaryMonth').addEventListener('change', load); $('#salaryRefresh').addEventListener('click', load);
    $('#salaryManage').addEventListener('click', onManage);
    $('#salaryCsv').addEventListener('click', () => {
      if (!report) return;
      const url = URL.createObjectURL(new Blob([csv(report)], { type:'text/csv;charset=utf-8;' }));
      const link = document.createElement('a'); link.href = url; link.download = 'salary-calculation-' + report.month + '.csv'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    await load();
  }
  window.Salaries = { mount, reportHtml, csv };
})();
