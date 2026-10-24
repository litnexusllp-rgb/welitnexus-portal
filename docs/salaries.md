# Monthly salary worksheet

Admins open **Salaries**, choose a month and select **Calculate**. The page shows monthly gross, approved unpaid leave days, the leave deduction and salary to pay. Expand **View calculation** or **Resolve review** for the daily salary rates, leave dates and supporting arithmetic. **Manage salaries** opens Admin, where employee salary history and effective dates can be edited. **Download CSV** exports the selected calculation, including review notes.

The owner-confirmed scope is **monthly gross minus approved unpaid leave only**. Tax, attendance penalties, bonuses and other adjustments are excluded. The worksheet neither pays staff nor marks amounts as paid. Calculating a report never changes records. Explicit review confirmations save only a separate employee/month confirmation and audit history; salary history, attendance, leave, request-time quotes and cached balances remain unchanged. Pending/rejected/cancelled leave is not deducted. Pending requests are shown so admins can review approvals before payment.

## Calculation

- A full calendar month at one known salary rate uses the full monthly gross, including February and 31-day months.
- Approved leave on the 1st–12th, from 1 October 2026, is unpaid. Dates are clipped to the selected month and employment period; paid leave does not reduce salary.
- Each unpaid date uses the monthly gross salary effective on that date, divided by 30. Half days count as 0.5. Salary amounts are integer paise and half-day units are integers; the complete employee/month deduction is rounded once to paise.
- Calculations use current recorded effective salary history and approved leave. They may differ from request-time estimates, which remain unchanged.

## Review cases, with calculations

Mid-month joining/leaving, salary changes during the month, uncertain employment dates, missing salaries, invalid leave or overlapping approved leave require review. These rows **do not enter the salary-to-pay subtotal**. They still show known salary rates, daily-rate calculations, employed calendar days and unpaid-leave arithmetic. Where one known gross rate applies, the page also shows a **full-month reference after leave**; this is explicitly before any part-month adjustment and is not assumed to be payable. No proration rule is invented.

Duplicate approved leave dates are capped at one day for reference calculations and flagged; they are never silently charged twice. If a required salary rate or valid leave range is missing, the complete deduction remains unknown. Missing salary is distinct from an explicitly recorded zero salary. Unconfirmed review-row payable amounts stay blank in CSV, while reference amounts have their own labelled column.

Employees with known employment wholly outside the selected month are omitted. Former employees with overlapping employment are included for historical/final-month review; an inactive employee without an exit date is retained and flagged rather than silently excluded. Admin accounts are excluded. Current and future months are visibly provisional. Historical months are live calculations, not locked payroll snapshots.

The report route `/api/salaries?month=YYYY-MM` is admin-only and `Cache-Control: no-store`; employees cannot read the report or other staff salaries. The CSV is generated from the current successful report and is disabled while recalculating or after an error. Employee text is escaped in HTML and protected against spreadsheet formula injection in CSV.

## Confirming a review

1. Open **Resolve review** beside the employee. Inspect the reasons, salary rates, employment dates and leave calculations.
2. Enter **Confirmed salary to pay (INR)**, the final amount after any leave deduction, and a required **Calculation or reason** explaining the decision. An explicit zero is allowed; no proration is assumed or prefilled.
3. Select **Confirm salary**. The row becomes **Reviewed**, displays the reviewer, time and note, and joins the salary-to-pay total. Leave deductions are not subtracted from the confirmed amount again.

Use **Edit review** to update the amount/note, or **Reopen review** to exclude it from the total until confirmed again. Confirmations apply only to the selected employee and month. They do not change future salaries or mark a payment as made. Missing salary history should also be corrected through **Manage salaries** for future calculations.

Changes to the month's salary history, employment dates/status, or approved/pending leave invalidate the previous confirmation. The old value remains visible for reference, but the row returns to **Needs review** with a blank payable amount and is excluded from the total until deliberately reconfirmed. A confirmation never silently overrides changed source data, even if those changes resolve the original review reason. Future salary changes beyond the selected month do not invalidate it.

Concurrent edits are rejected using a review revision and source fingerprint; repeated identical submissions are idempotent. Confirm and reopen actions record the actor, timestamp, before/after values and source snapshot in a transaction. Automatic rows cannot be manually overridden through the review endpoint. The admin-only POST routes are `/api/salaries/:id/review` and `/api/salaries/:id/review/reopen`.

The salary-to-pay total includes automatic and confirmed rows. Gross and leave-deduction subtotals describe automatic rows only, because a confirmed final amount may reflect a manually reviewed adjustment. CSV includes confirmation state, last confirmed amount, reviewer, time and calculation note; stale/reopened values are reference-only and never appear as current payable amounts.

## Verification

`node --test test/salaries.test.js test/salary-review.test.js` covers calendar/month boundaries, half days and aggregate rounding, rate changes, partial employment, missing/zero salaries, historical inactive staff, overlaps, read-only source preservation, subtotal exclusions, API permissions, CSV/HTML safety and stale-response protection. Review tests also cover exact amounts, zero/missing salaries, validation, permissions, idempotency, conflicting edits, reopening, source invalidation, rollback, audit history and persistence. Browser verification uses a separate synthetic database, without production payroll or leave writes.
