# Leave policy and payroll

Source: the owner's three-page **LIT_Nexus_Staff_Policy_Final.pdf**, read in full,
including letterhead, leave, Short Day, Fun Friday and bonus provisions. The
owner's clarifications on 2 November 2026 take precedence where noted below.
The calculation rules apply from 1 October 2026; prior dates retain legacy paid
treatment. Existing requests, decisions, reasons and saved quotes are preserved.

## Paid and unpaid time

- Annual ceilings reset every **1 October**: 18 regular + 1 Flexi + 1 shared
  birthday/anniversary day. No annual carryover. The October reset supersedes
  the PDF's calendar-year reset.
- Regular paid leave has a **strict 1.5 scheduled-day limit in each month**.
  Unused monthly credit does not accumulate or become usable in another month.
  Further regular leave is unpaid, even if an annual remaining balance is shown.
  This supersedes the earlier implementation's unrestricted 18-day annual grant
  and the PDF's accumulation wording.
- Flexi and special entitlements are separate from the monthly regular limit.
  Flexi is only after the 15th and needs no reason. Birthday and anniversary share
  one day. Requests exceeding those special paid category entitlements must be
  submitted as regular leave, where excess time can be unpaid.
- **The 1st–12th inclusive is unpaid for every category**, regardless of available
  paid credit. Unpaid time does not use paid credit.
- **Only scheduled working time is charged.** Saturday/Sunday are non-working
  unless published in Working days. Full holidays are excluded; a half holiday
  has 0.5 working day. Full-day requests charge that day's working portion;
  half-day requests charge up to 0.5 scheduled day, including on half holidays.
  A full holiday remains non-working even if a working-weekend override exists.
- The monthly cap replaces the former **3+ consecutive-day deduction**. A
  three-working-day regular block is 1.5 paid / 1.5 unpaid outside the 1st–12th,
  rather than three unpaid days. Split requests cannot bypass the cap.
- Approved requests allocate credit first, ordered by leave date then ID.
  Pending requests then reserve remaining credit in that order. Rejection and
  cancellation release reservations. This ordering is deterministic; adding an
  earlier approved request can change later requests' paid/unpaid allocation.
- Cross-month requests use each month's own allowance and calendar divisor;
  cross-October requests use each leave year's own category entitlements.

`src/leaveCalculation.js` is the shared ledger for balances, previews and monthly
salary reports. `leaves.days` still records requested calendar duration for
historical compatibility; `paid_days`, `unpaid_days`, `non_working_days` and
`date_lines` distinguish scheduled treatment. A request entirely on non-working
dates is labelled NON_WORKING, costs no credit and creates no deduction.

## Requests and management checks

Apply at least three days ahead unless an emergency applies. Three or more
planned scheduled leave days need at least 20 days' notice (the PDF also
recommends one month); only health emergencies bypass that longer notice.
The form records NONE / HEALTH / OTHER emergency classification. The server
validates it and enforces notice for employee requests and previews. Admins
can record historical absences and decide legacy/auto-flagged requests.

Managers should respond within one business day. Pending records display the
next business-date deadline and overdue status, using the published calendar.
Leave adjoining non-working dates carries a specific approval warning and may
be refused. All full/half-day requests still require management approval.

Dates, scheduled time, decisions and paid/unpaid treatment must be checked
before payroll. Employees can inspect calculations and ask management to
correct attendance or leave errors. Management's existing review-confirmation
workflow records an explanation for exceptions without rewriting leave sources.

## Short Day

The employee workspace provides separate Short Day requests for 1–120 minutes,
with a **120-minute monthly allowance**. Pending requests reserve time; approved
requests consume it; rejection/cancellation releases reservations. No regular,
Flexi or special leave credit is consumed and no salary penalty is created.

Management must approve before the requested start timestamp. Expired pending
requests can be rejected, not backdated into advance approval. Start times are
stored with their timezone and absolute timestamp; nonexistent/ambiguous DST
times are rejected. Non-working dates, overlapping Short Day intervals and
full/half-day leave conflicts are rejected. Requests crossing midnight must be
split by date. Existing attendance punches are not edited or fabricated.

The authenticated `/api/short-days` routes return an employee's own requests;
admins can inspect an employee or the pending team queue and approve/reject.
Balances and decisions use immediate transactions to prevent exceeding the
allowance through concurrent requests. Approved minutes appear separately in
salary calculations/slips. A short attendance flag alone is not a deduction.

## Other provisions reviewed

Fun Friday is twice monthly, approved/coordinated, 40–90 minutes excluding
breaks, with client commitments protected. This guidance is visible in the
workspace; it is not a payroll adjustment.

The policy lists punctuality, attendance, deadlines, client appreciation, extra
effort, learning, quality, ownership, teamwork and process improvement as bonus
considerations. The Bonus Email is due before 6 PM on the last working day;
recipients are announced after processing and amounts remain private. These
requirements are shown in policy guidance. The PDF supplies no bonus formula,
so no bonus amount or attendance penalty is invented or added to salary.

## Data and verification

Migrations add emergency classification and a separate Short Day table. Existing
leave dates, statuses, reasons, IDs and request-time quotes are never rewritten.
Derived compatibility balances are rebuilt from the ledger; reset markers retain
the original cached value. Salary review fingerprints include the policy version,
relevant leave-year sources, working calendar and Short Day records. Affected old
confirmations become stale and must be checked and reconfirmed.

Tests cover shared calculations, monthly limits, separate categories, pending
reservations, notice exceptions, calendar boundaries/holidays, exact month lengths,
review invalidation, source preservation, Short Day permissions/limits/advance
approval and concurrent requests. Browser/PDF checks use synthetic records only.
