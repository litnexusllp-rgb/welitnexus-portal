# Employees workspace

**Employees** is the menu entry for the former employee management area, My performance, Leaves and salary worksheet. It is one scrolling page with jump buttons:

1. **Performance** — monthly KPI cards, attendance calendar and existing punch corrections.
2. **Leaves** — current leave-year entitlements, remaining balances, approved paid days, pending reservations, taken paid/unpaid days through today, approved upcoming days and complete dated request history. Admins also have selected-employee approvals, mark-leave, absence checks and an expandable team overview.
3. **Salary calculations** — below leave history, for admins. The selected employee is expanded by default. The worksheet can switch to all employees and export CSV. Its month stays synchronized with the performance month, including calendar previous/next buttons. Existing review/confirmation controls remain available.
4. **Personal information** — selected employee details, edit actions and an expandable admin employee/access table. Add, enable/disable and password reset actions remain available. Employees can edit their own permitted basic details only.

Admins select active or inactive employees, or an admin account for performance/profile review. Admin accounts do not receive personal leave or participate in the employee salary worksheet. Employees see their own performance, leave and personal information; the workspace does not grant access to team salary records or management endpoints. Admin now contains backup and Asana settings.

Existing `#/myperf`, `#/leaves` and admin `#/salaries` links resolve to Employees and scroll to the relevant section, so bookmarks, dashboard links and stored notifications still work. Modified clicks, refresh, browser back/forward and server permissions retain their behavior.

Salary daily rates use actual calendar days in the applicable month, including leap years. Existing request-time quotes are retained; old fixed-30-day salary confirmations need review under the new calculation version. See [salary calculations](salaries.md) and [leave estimates](salary-deduction.md).

The leave history endpoint now returns balances, current leave-year activity and the complete employee history. Historical entries are not truncated at 100 records. Taken days exclude future dates, rejected/cancelled requests and dates outside the current October–September leave year; pending includes paid and unpaid requests, while paid balance reservations remain separately labelled.
