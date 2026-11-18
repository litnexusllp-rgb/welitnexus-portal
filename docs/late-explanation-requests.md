# Automatic late clock-in explanation requests

A qualifying late clock-in automatically creates one request per employee and
attendance workday. The employee receives an in-app notification and sees an
**Add explanation** prompt on Dashboard and Clock. Their own comments are then
submitted to the existing admin review queue, with an admin notification.

Open **Employees → Requests** to review comments or inspect **Late request
history**. **Mark as normal** excuses lateness, records the deciding admin and
time, and retains the employee's comments. Original punches and worked hours
are preserved. Full-day, leave and Short Day decisions that already resolve an
explanation also record their resolution against its generated request.

The history report has date and employee filters and a CSV export. Counts use
attendance dates, not the time the request was generated or processed:

- **Generated:** unique employee/workday requests, retained after decisions.
- **Comments submitted:** generated requests with an employee-authored response.
- **Processed:** generated requests with a recorded admin decision.
- **Awaiting employee / awaiting review:** requests still requiring a response or
  decision under current attendance rules.
- **No longer required:** unprocessed requests whose attendance was corrected or
  exempted, or whose employee is no longer active. These remain in generated
  counts and are not presented as admin-processed decisions.

One request can count as generated, submitted and processed; those are lifecycle
counts, not mutually exclusive buckets. A decision made before comments arrive
counts as processed without being counted as submitted. Repeated decisions do
not replace the original processing timestamp. Restoring automatic late status
does not erase the original processing history or issue a duplicate request.

## Eligibility and rollout

The attendance report owns shift, grace-period, timezone snapshot and late
classification. Requests reuse it and exclude admins, inactive employees,
non-working days, holidays, approved leave, approved Short Days and days already
marked normal. Only the first clock-in determines lateness; later clock-ins or
breaks do not generate duplicate prompts. The server clock is authoritative.

Requests and notifications are recorded in the same transaction as validated
attendance mutations. A unique employee/workday constraint also protects against
concurrent writes and repeated reconciliation. An additive
`late_explanation_requests` table retains the original first-in, scheduled start,
timezone and lateness snapshot alongside generation and processing metadata.
Employee comments stay in `late_explanations`; generated prompts are never
stored as an employee-authored reason.

The background worker reconciles each active employee's current workday at
startup and every minute, covering people who already clocked in on the rollout
day. No bulk historical backfill runs. Existing manual explanation submission
continues to work; it creates a linked request if the day qualifies and does not
already have one. Corrected historical punches can also generate a qualifying
request. Existing decisions and previous employee comments are preserved.

Authenticated employees can read only their own outstanding requests. The
history endpoint requires the existing admin guard; optional employee filters
never grant employee access to another person's records. Existing legacy manual
explanations remain in the review queue, but are not retroactively counted as
newly generated requests.

## Validation

`npm test`, `npm run lint`, and `npm run format:check`. Integration coverage uses
synthetic databases for generation, grace boundaries, duplicate prevention,
notifications, employee isolation, comments, normal/full-day decisions, retained
counts, corrected punches, working-calendar exemptions and remote overnight
shifts. A local browser preview also exercises employee submission through admin
normal-day processing and verifies retained history.
