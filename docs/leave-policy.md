# Leave categories and October reset

Effective 1 October 2026, the portal grants a fresh 20-day entitlement every
1 October for the year ending 30 September: 18 regular paid days, 1 Flexi day,
and 1 shared birthday/anniversary day. Unused credit expires at the next reset.
The owner explicitly confirmed the October anniversary and full 20-day reset;
these override the supplied staff PDF's calendar-year/monthly-accrual wording.
There is no additional 1.5-day monthly credit on top of the 18 regular days.

Employees select Regular, Flexi, Birthday or Anniversary separately from
Full/Half duration. Flexi is allowed only on dates after the 15th and requires
no reason. Birthday and anniversary draw from the same single-day pool.
Managers continue to review requests before approval. This change does not
add automated enforcement of the PDF's other advance-notice, consecutive-day,
short-day or bonus provisions.

## Payment and balances

- The owner clarified that the 1st through the 12th, inclusive, are **unpaid**,
  following the staff PDF. Those days do not deduct from paid entitlement.
- A request spanning the 12th is split into paid/unpaid days. A request spanning
  1 October charges each paid day to its own leave year. Half days count as 0.5.
- Existing calendar-day counting is retained, including weekends. The portal
  labels unpaid leave for payroll review; it does not calculate a currency
  deduction or change payroll payments/scheduled hours.
- Approved paid leave reduces remaining credit. Pending paid requests reserve
  available credit without reducing the confirmed remaining balance. Rejection
  and cancellation release reservations. Unpaid requests need no paid balance.
- The server computes treatment and credit availability; client-supplied
  payment status, day counts or balance cannot override it. Both employee and
  direct-admin recording paths use the same calculation and checks.
- Employee Dashboard and Leaves show the three personal pools, pending credit,
  available credit and reset date. Admins see their own pools plus team totals.

## Existing data and reset audit

Schema changes are additive: a category column and `leave_balance_resets`
table. Existing untyped requests remain regular leave. Their dates, duration,
reason, approval and identifiers remain intact. Actual dates from 1 October
2026 determine the new paid/unpaid treatment; earlier leave does not spend the
new October entitlement. Historical requests are not cancelled or deleted.

Balances are rebuilt from approved records in the applicable leave year. This
deducts approved paid leave since 1 October rather than blindly setting the
current total to 20 and discarding October usage. Approved future leave within
the year is included. Old overdrawn history is visible as a negative pool;
new paid requests cannot exceed available category credit.

A unique reset marker per employee/year preserves the previous cached total
and new entitlement. Repeated reads/restarts never grant extra credit. Totals
refresh at startup and when balance-bearing screens/APIs are read, including
at the next October boundary without a server restart. The old
`users.leave_balance` field is a compatibility cache; employee profile edits
cannot override calculated entitlement. Existing profile details remain editable.

## Verification and rollback

`test/leave-policy.test.js` uses a temporary synthetic database and test clock
to cover date boundaries, category quotas, reservations, cancellations,
duplicate approvals, access control, forged payloads, admin recording, October
renewal, January continuity and restart persistence. Full browser checks use
the real frontend/API with local synthetic accounts.

No production attendance or leave requests are created as deployment tests.
Deployment may initialize the owner-authorized October reset/cache/audit data.
Do not roll back to the old balance-decrementing handlers after live leave
decisions; they cannot account for the new pools or unpaid days. Retain the
additive columns/audit records and use a forward fix or an explicitly reviewed
database restore if a financial rollback is needed.
