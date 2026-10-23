# Leave deduction estimates

Admins can enter an employee's **monthly gross salary in INR** and its effective date in **Admin → Employees → Edit** (or while creating an employee). Leave salary blank when it is unknown; an explicit zero is allowed. Saving a new effective date retains earlier rates. Correcting an existing date records the before/after values in the salary audit table.

The leave form previews the company-confirmed calculation:

`monthly gross salary ÷ 30 × unpaid leave days`

The existing leave policy determines unpaid dates: the 1st through 12th of each month, from 1 October 2026. The divisor remains 30 in every month. A half day counts as 0.5. Requests crossing salary changes use the salary effective on each leave date. Calculation uses integer paise and half-day units, rounding the combined request once to the nearest paise. Paid days add no salary deduction.

If any unpaid date has no applicable salary, the amount is unavailable rather than assumed to be zero. The employee may still submit the request and ask an admin to record the missing salary. No existing salary amounts are inferred or populated by the migration.

Submission saves the server-calculated estimate with the request. Employee history and admin approval lists show this estimate at request time; later salary edits or approval decisions do not silently replace it. Older requests remain unpriced. These amounts are estimates for payroll review; this feature does not execute payroll or salary deductions.

Salary history is stored separately from shared employee profiles. Only admins can read or edit salary records. Employees can preview only their own leave deductions and see the salary rates used in that calculation. Other employees' salaries are excluded from directory, authentication and attendance responses. Existing administrator database backups include the new salary and audit tables.

## Verification

`node --test test/salary-deduction.test.js` covers whole/half days, monthly boundaries, effective dates, missing and zero salaries, exact rounding, validation, atomic profile writes, privacy, immutable request snapshots and restart persistence. The full suite also exercises existing leave, attendance and employee behavior. Browser checks use a separate synthetic database; no production salary, attendance or leave records are needed.
