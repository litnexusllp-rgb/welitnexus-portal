# Attendance correction approvals

An attendance day is a shift day in the office timezone, including the next
calendar day's times before the attendance cutover (08:00 by default).

Employees choose **Correct a recorded punch** and select the original event,
or **Add a missed punch**. Correcting a punch changes only its timestamp. It
keeps the event ID, employee, event type, shift day, device and original note.
The employee's reason and the admin's decision/note remain on the request.

Submission records `operation`, `target_event_id` and an `original_event`
snapshot. An EDIT must refer to the signed-in employee's event on the selected
day with the selected type. The employee event-list endpoint ignores user IDs
and returns only the signed-in user's punches, with office-zone times.

Approval takes a SQLite immediate transaction before reading the request and
checking its pending status. It checks the original event still matches its
snapshot, updates that event (or inserts for ADD), and validates the entire
day's sequence. A correction must remain strictly between its neighboring
punches. Failed validation rolls back the event, decision, audit and notification.
Repeat/competing approvals return 409 and cannot apply or notify twice.

`punch_request_changes` holds one row per approved request: the event ID,
before/after JSON (before is NULL for an addition), deciding admin and timestamp.
The record retains the event ID even if a separate admin action later deletes
the event. Reports and KPIs continue to derive time from the corrected event
stream, so no duplicate interval or separate payroll adjustment is introduced.

The startup migration adds nullable columns and the audit table without
rewriting attendance or deleting requests. Requests from older clients capture
a unique matching event and its snapshot at submission. Already-pending legacy
requests lack that original snapshot: approval updates a unique same-user,
same-day, same-type event, or inserts when none exists. Multiple matching
events return 409 with instructions to cancel and resubmit using an explicit
target. Historical before/after values cannot be reconstructed for decisions
made before this feature.

Regression tests use temporary SQLite databases and local HTTP servers only.
They cover OUT/IN/break edits, multiple breaks, missing punches, invalid order,
equal timestamps, overnight shifts, stale/deleted targets, authorization,
rejection/cancellation, repeated approvals, migration persistence, reporting
totals and frontend selection/error handling. Run with Node 20: `npm ci`,
then `npm test`.
