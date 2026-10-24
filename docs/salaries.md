# Monthly salary worksheet

Admins open **Salaries**, choose a month and select **Calculate**. The page shows monthly gross, approved unpaid leave days, the leave deduction and salary to pay. Expand **View calculation** or **Review calculation** for the daily salary rates, leave dates and supporting arithmetic. **Manage salaries** opens Admin, where employee salary history and effective dates can be edited. **Download CSV** exports the selected calculation, including review notes.

The owner-confirmed scope is **monthly gross minus approved unpaid leave only**. Tax, attendance penalties, bonuses and other adjustments are excluded. This is a read-only worksheet: it neither pays staff nor marks amounts as paid, and it never changes salary, attendance, leave, request-time quotes or cached balances. Pending/rejected/cancelled leave is not deducted. Pending requests are shown so admins can review approvals before payment.

## Calculation

- A full calendar month at one known salary rate uses the full monthly gross, including February and 31-day months.
- Approved leave on the 1st–12th, from 1 October 2026, is unpaid. Dates are clipped to the selected month and employment period; paid leave does not reduce salary.
- Each unpaid date uses the monthly gross salary effective on that date, divided by 30. Half days count as 0.5. Salary amounts are integer paise and half-day units are integers; the complete employee/month deduction is rounded once to paise.
- Calculations use current recorded effective salary history and approved leave. They may differ from request-time estimates, which remain unchanged.

## Review cases, with calculations

Mid-month joining/leaving, salary changes during the month, uncertain employment dates, missing salaries, invalid leave or overlapping approved leave require review. These rows **do not enter the salary-to-pay subtotal**. They still show known salary rates, daily-rate calculations, employed calendar days and unpaid-leave arithmetic. Where one known gross rate applies, the page also shows a **full-month reference after leave**; this is explicitly before any part-month adjustment and is not assumed to be payable. No proration rule is invented.

Duplicate approved leave dates are capped at one day for reference calculations and flagged; they are never silently charged twice. If a required salary rate or valid leave range is missing, the complete deduction remains unknown. Missing salary is distinct from an explicitly recorded zero salary. Review-row payable amounts stay blank in CSV, while reference amounts have their own labelled column.

Employees with known employment wholly outside the selected month are omitted. Former employees with overlapping employment are included for historical/final-month review; an inactive employee without an exit date is retained and flagged rather than silently excluded. Admin accounts are excluded. Current and future months are visibly provisional. Historical months are live calculations, not locked payroll snapshots.

The report route `/api/salaries?month=YYYY-MM` is admin-only and `Cache-Control: no-store`; employees cannot read the report or other staff salaries. The CSV is generated from the current successful report and is disabled while recalculating or after an error. Employee text is escaped in HTML and protected against spreadsheet formula injection in CSV.

## Verification

`node --test test/salaries.test.js` covers calendar/month boundaries, half days and aggregate rounding, rate changes, partial employment, missing/zero salaries, historical inactive staff, overlaps, read-only source preservation, subtotal exclusions, API permissions, CSV/HTML safety and stale-response protection. Browser verification uses a separate synthetic database, without production payroll or leave writes.
