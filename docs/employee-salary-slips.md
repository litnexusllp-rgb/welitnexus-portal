# Employee salary calculations and slips

Employees open **Employees -> Salary calculations**, select a month and see their own monthly gross, calendar-day divisor, salary rates, paid/unpaid leave, date-specific leave deductions and calculated or admin-confirmed salary to pay. Their performance calendar and salary month stay synchronized. They can download their own calculation as CSV and, when eligible, select **Download salary slip (PDF)**.

The salary view is read-only. It has no team selector, salary-history editor, review form, confirm/reopen action or admin notes. Missing source values remain unknown. An unresolved review shows **Needs review** rather than an invented payable amount. Admins keep the selected/team worksheet and confirmation controls, with a PDF-slip link for eligible rows.

## Slip availability

PDF slips are available when the month has ended, the salary row is calculated or has a current admin confirmation, and no pending leave request overlaps the month. Current and future month calculations remain visible as projections. Missing salary, uncertain/partial employment, invalid/overlapping leave or changing rates need the existing admin review where applicable. Reopened/stale confirmations and pending leave block the download, including when records change after a page was loaded. A deliberate zero salary is valid.

Slips use the existing colour LIT Nexus logo and the company name/address from the owner-supplied staff-policy letterhead: LIT Nexus LLP, Cabin No. 12, First Floor, Big Bang Tower, Plot No. E279, Sector-75, Industrial Area, Mohali, Punjab - 160071. Slips include the employee name/code, department/title, month, employment period, monthly gross, unpaid leave deduction, a visible admin-confirmed adjustment where known, salary to pay, calendar-day arithmetic, per-date unpaid units and deduction reasons, approved Short Day minutes and the generation date. They explain the mandatory unpaid period, strict monthly regular allowance, separate special entitlements and working-calendar exclusions. Unrecorded values are labelled, not assumed to be zero. Tax, bonuses, bank details and unrecorded payroll components are not fabricated. A slip reflects the portal's salary calculation and does not certify payment. It is generated from current recorded sources; it is not an immutable payroll payment record. Existing confirmations and salary/leave sources are not modified by viewing or downloading.

## Server access boundaries

- `GET /api/salaries/mine?month=YYYY-MM`: authenticated employee only. The source queries are scoped to `req.user.id`, and only `month` is accepted as a query selection. No client-supplied target ID is used. Totals describe that employee only. Confirmation notes, reviewer identities, fingerprints and revision/write tokens are omitted; stale confirmation amounts are not exposed as current pay.
- `GET /api/salaries/mine/slip?month=YYYY-MM`: authenticated employee's eligible PDF attachment only. Month is required. Eligibility is rechecked on every request.
- `GET /api/salaries/:id/slip?month=YYYY-MM`: admin-only equivalent for a selected employee. It does not grant an employee access to this path, even for their own ID.
- Team calculations and all salary mutation endpoints remain admin-only. Active-account and session-version checks apply to all routes.

Responses use `Cache-Control: no-store`. PDFs are built in memory, never saved under public static paths, and use fixed attachment filenames. Download errors stay inside the portal and show the returned reason. PDF generation has a per-authenticated-user limit of 30 requests per 15 minutes. Noto Sans fonts and their SIL Open Font License are bundled for rendering and are subset into each PDF.

`test/employee-salary.test.js` verifies ownership, forged IDs, malformed months, authentication/session revocation, privacy, read-only behavior, PDF headers, zero/missing salaries, pending/current/future cases and confirmed/stale/reopened reviews. Synthetic browser checks cover actual downloads and errors, month synchronization, admin confirmations and mobile layout. Four representative PDFs are rendered and visually reviewed outside the application source folder.
