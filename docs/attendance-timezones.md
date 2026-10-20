# Attendance timezones and overnight sessions

## Diagnosis and evidence

At base commit `e3cc966f67453873117aaf8af7168ae87e0c3545`, both `GET /api/attendance/status` and `POST /api/attendance/punch` in `src/routes/attendance.js` query only `events WHERE user_id = ? AND day = attendanceToday()`. `src/time.js` defines this as the office timezone (`TZ_OFFICE`, default `Asia/Kolkata`) with a global workday cutover (`ATTENDANCE_CUTOVER_HOUR`, default 08:00). The employee's `shift_start` previously affected punctuality only; there was no employee timezone or cutover setting.

Reproduction using synthetic data: IN at 23:30 on Oct 19; attempt OUT at 09:30 Oct 20 in office time. At 08:00 the queried day becomes Oct 20, so the Oct 19 IN disappears. `summarize([])` returns OUT and `VALID.OUT` permits only IN. The frontend renders exactly the server's `allowed` actions. An OUT request is also rejected by the same date-limited backend logic. This is a day-boundary/session-ownership bug; changing browser timezone alone cannot fix it.

The old write handler independently buckets every punch by its own timestamp, and `src/db.js` re-buckets all events at every startup. Even a frontend-only workaround would split the session or lose its pairing on restart. Reports/KPIs previously supplied live elapsed time only to the office's current workday and interpreted all shift starts in office time. Frontend report times were formatted in the viewer's browser timezone, which could disagree with the reported workday.

Before editing, production `/js/app.js` SHA-256 matched the base checkout (`a74b9ff3db98fc3e40079b85d05b0755a1d81834b3c36715bf85bd12e460fabe`). Production health responded successfully. The portal required sign-in; no authenticated production employee profile or punch history was available. This identifies and reproduces the code defect consistent with the report, rather than asserting that Gurpreet's private timestamps, location, actual timezone or shift were verified.

## Session and reporting behavior

- Find the employee's latest persisted event independently of the current date. An unfinished IN/BREAK keeps its original workday, with OUT/break actions available even after midnight, cutover, month end or multiple dates. Do not expire it into a new IN.
- Validate action, ordering and insertion in one immediate SQLite transaction. Duplicate IN/OUT clicks are rejected; events use server-generated epoch milliseconds, never client-provided timestamps or dates.
- IN starts the current configured workday; subsequent break and OUT events retain that workday. A closed overnight session remains visible through its clock-out workday; the next IN starts the new configured day.
- Store the day's timezone, cutover and expected shift at its first write. Profile changes first snapshot unsnapshotted existing days and are blocked while a session is open. Historical punches, workday labels, IDs and UTC instants are not migrated or re-bucketed. Existing unsnapshotted days retain office-time interpretation.
- Attendance totals use elapsed UTC milliseconds, excluding breaks. All overnight hours belong to the original IN workday, including at month/year boundaries; they are not split into separate calendar-day totals. Holidays/leave/working-weekend dates continue to refer to those local workday labels.
- Open sessions up to 24 hours receive live elapsed totals across cutover in status, timesheets, reports and KPIs. Older open sessions remain closable and visibly require review; their unrecorded tail is excluded from totals until an OUT or correction is recorded. No automatic clock-out or fabricated hours are written.
- Calendar/report punctuality uses the recorded timezone and shift, including shift starts before cutover. Local dates use wall-clock boundaries, not subtracting elapsed hours through DST. Nonexistent/repeated local correction times are rejected; a schedule at an ambiguous DST time is flagged in the report and excluded from automatic KPI punctuality until reviewed. Live punches remain unambiguous UTC instants, including the repeated fall-back hour.
- Admin live state and absence checks use each employee's applicable workday. A remote day is not auto-flagged before it closes locally. The existing once-daily office scheduler is retained, so remote absence flagging can occur at the next scheduled check after their local closure.
- UI times include the actual calendar date and explicit timezone. Status refreshes every 30 seconds while the Clock page is open. Performance colors, blue Half Day cells and the reversible late-normal override remain intact.

## Optional employee configuration

Employees → Edit provides **Attendance timezone** (an IANA name), **Workday starts at hour** (0–23) and the existing **Shift start**. Blank timezone/cutover retain the office defaults. Shift start is interpreted in that timezone; choose a cutover before the shift starts. A local morning shift can use cutover 0 when appropriate. Confirm the actual work schedule with the employee; do not infer it from a name, browser timezone or IP address.

No special configuration is required to retain Clock Out for Gurpreet's unfinished session. To report her workdays and punctuality in a different timezone, an administrator should confirm her actual timezone and expected shift, close/correct any open session, then configure the profile. No production profile was changed as part of this fix.

## Compatibility with attendance corrections

Builds on merged PR #12, not its old branch. ADD/EDIT selection, event snapshots, same-ID updates, stale-target detection, immediate approval locking, exactly-once decision/audit/notification and neighboring-punch checks are retained. Corrections additionally save the requested UTC instant at submission and accept an explicit actual calendar date, so an OUT beyond the cutover can be edited without moving its workday. Both employee and admin editors show that date. Older requests retain legacy interpretation; unspecific or ambiguous requests still require review. Cross-workday overlaps and an IN assigned to the wrong local workday roll back atomically.

## Validation and deployment

`npm test` runs existing and new tests using temporary synthetic databases. New coverage includes the old query reproduction, same-day multiple sessions, midnight/cutover crossings, ordered overnight breaks, direct OUT from BREAK, month end, server timezone differences, IANA zones ahead/behind the office, DST spring/fall elapsed hours, duplicate clicks, stale sessions, config permissions/validation, historical settings snapshots, corrections/admin CRUD/audit, restart persistence, reports/register/KPIs, absence closure, late-normal/HALF behavior and frontend button/date/timezone rendering. Browser smoke testing uses only a local synthetic employee.

`GET /api/health` exposes the deployed Railway Git revision when `RAILWAY_GIT_COMMIT_SHA` is available. Verify this revision plus the public frontend hash after deployment; health alone does not prove the new code is deployed. Production attendance records must not be created or edited as a deployment test.

Schema changes are additive. Rolling back to the old startup code would re-bucket legitimate cross-cutover events; retain the removal of automatic re-bucketing in any rollback or forward fix. Preexisting split/invalid attendance requires separate, explicitly reviewed corrections; this release does not rewrite historical employee records.
