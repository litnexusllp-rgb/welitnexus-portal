# Leave deduction estimates

Admins can enter an employee's **monthly gross salary in INR** and its effective date in **Employees → Personal information → Edit employee** (or while creating an employee). Leave salary blank when it is unknown; an explicit zero is allowed. Saving a new effective date retains earlier rates. Correcting an existing date records the before/after values in the salary audit table.

The leave form previews the calculation:

`monthly gross salary ÷ calendar days in the leave month × unpaid leave days`

The shared leave-policy ledger determines unpaid scheduled time from 1 October 2026: all working leave on the 1st–12th, and regular leave above a strict 1.5-day monthly paid limit outside that period. Flexi and special leave retain separate annual entitlements. There is no monthly accumulation or separate consecutive-day penalty. Weekends and full holidays are excluded; published working weekends count and half holidays have only 0.5 working day. Approved leave allocates credit before pending reservations. The divisor is 28, 29, 30 or 31 according to the leave date, including leap years. Each item records its calendar-month divisor. A half day counts as 0.5. Requests crossing salary changes use the salary effective on each leave date. Calculation uses integer paise and half-day units, rounding the combined request once to the nearest paise. Paid days add no salary deduction.

If any unpaid date has no applicable salary, the amount is unavailable rather than assumed to be zero. The employee may still submit the request and ask an admin to record the missing salary. No existing salary amounts are inferred or populated by the migration.

Submission saves the server-calculated estimate with the request. Employee history and admin approval lists show this estimate at request time; later salary edits or approval decisions do not silently replace it. Unpriced older requests remain unpriced. Existing fixed-30-day quotes remain unchanged and are labelled as historical estimates; new version-3 quotes use the monthly cap, scheduled working time and calendar-month days. Historical version-2 quotes are also labelled as preceding the monthly-limit policy. These amounts are estimates for payroll review; this feature does not execute payroll or salary deductions.

Salary history is stored separately from shared employee profiles. Only admins can edit salary records or read another employee's salary. Employees can also view their own monthly calculation and download eligible salary slips through the dedicated self-service routes. Employees can preview only their own leave deductions and see the salary rates used in that calculation. Other employees' salaries are excluded from directory, authentication and attendance responses. Existing administrator database backups include the new salary and audit tables.

## Verification

`node --test test/salary-deduction.test.js` covers whole/half days, monthly boundaries, effective dates, missing and zero salaries, exact rounding, validation, atomic profile writes, privacy, immutable request snapshots and restart persistence. The full suite also exercises existing leave, attendance and employee behavior. Browser checks use a separate synthetic database; no production salary, attendance or leave records are needed.
