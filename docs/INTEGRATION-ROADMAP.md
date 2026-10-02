# Portal, Asana and Slack: implementation review

Reviewed 2 October 2026. Phase 1 authorized: admin-only portal dashboard. No new Slack messages, task writes, automatic approvals or payments. Cancelled EOD automation remains off; this release does not change its configuration.

## What is implemented

- `src/routes/operations.js`: admin-only `GET /api/operations`, no-store responses. Collects pending achievements, leave requests and punch corrections across all months, oldest first. Joins active employees to non-void bonus history. Reads LIT Tasks only (project 1215327082632826); other project configuration returns a scope error.
- `public/js/app.js`: `#/operations`, admin sidebar link, task filters (overdue, due today, missing owner/date, all pending), approval links, bonus rotation and EOD flag. Refreshes while open every minute. Asana observation time is explicit. External failure preserves portal queues and shows unknown task counts.
- `src/asana.js`: shared in-flight request, five-minute cache, 15-second timeout per request, explicit completed_since, full offset pagination, duplicate task ID deduplication, repeated-token detection, visible safety-limit errors and Retry-After backoff. Cache updates only after a complete successful read. The prior 20-page/2,000-task silent truncation is removed. Date-only pending checks use office timezone.
- Existing Asana reads remain read-only. Existing EOD sender and configuration are untouched. Existing approval screens remain responsible for decisions.
- Coverage: Asana project-member tasks only; subtasks not directly in LIT Tasks are not recursively included in this dashboard. Categories can overlap (e.g. a task can have neither owner nor due date).
- The dashboard refreshes only while open. There is no new unattended worker in Phase 1.

## Evidence and remaining weaknesses

Read-only project inspection returned 1,804 tasks: 1,717 completed and 87 pending. A fully paginated project-task query (completed since 25 September plus incomplete tasks) returned 228 records and all 87 pending tasks. At observation, 27 pending tasks had date-only deadlines before 2 October, 7 had no date and 6 had no owner. These numbers are observations, not a transactional snapshot or performance judgment.

1. `src/asana.js` still permits name matching as a fallback for existing personal task/KPI views. Duplicate names or changed emails can misattribute work. Operations shows the Asana assignee directly and does not infer a portal identity. Before task writes or Slack mentions, replace fallback matching with verified IDs.
2. `src/routes/kpi.js` falls back to local portal tasks when Asana errors. This can make a broken connection look like a change in output. A later change should return an explicit unavailable state, preserving attendance independently.
3. Local task completion statistics use `updated_ts`; editing a completed task may move its reporting date. Add a real completion timestamp and immutable completion history before using these figures for decisions.
4. Asana KPI completion dates currently use UTC date slicing. Define business-day semantics explicitly: the old EOD window used 03:00 IST, whereas attendance uses a separately configured shift boundary. Keep these independent; do not silently change historic scoring.
5. `src/recurring.js` creates local portal tasks, while Asana is the operational task source. A recurrence should have one owner. Avoid independently generating the same work in both systems.
6. The portal already has a durable EOD delivery ledger, lease, retry handling and ambiguous-send protection. Reuse the approach for future notifications; do not reactivate EOD as a shortcut.
7. This audit inspected connector access and source code, not all live Railway credentials/scopes. Connector access does not grant the deployed service the same permissions. A Slack channel search for “admin” found no match; this does not establish that no private admin channel exists.

## Next integrations, in priority order

### 1. Verified employee identity registry

Add `integration_identities(portal_user_id, provider, external_id, verified_at, verified_by)` with unique `(provider,external_id)` and `(portal_user_id,provider)` constraints. Match exact email to suggest links; an admin confirms mismatches. Store Asana GIDs and Slack user IDs, not display-name guesses. Show unresolved accounts explicitly. This is a prerequisite for task writes, targeted messages and employee-level comparisons.

### 2. Owner-recorded blockers and revised ETA

Add `task_followups(id, asana_task_gid, assignee_gid, reason_code, reason_text, revised_eta, recorded_by, created_at, resolved_at)`. Suggested reasons: waiting for client, dependency, access missing, capacity, other. Record original due date separately; a revised ETA is not automatically a changed Asana deadline.

Employee UI lists only their verified assigned tasks; admin UI sees unresolved blockers. Never infer a reason from task lateness or a completion timestamp. Initially store portal followups only. Once write-back is approved, publish the explicit employee-submitted update to the task, with provenance and duplicate protection.

### 3. Leave and handover conflicts

Join approved leave intervals to assigned open Asana tasks due in that interval. Partial-day leave and holidays need their own classification. Show “coverage review needed”, task links and the current owner. Admin chooses reassignment; never automatically mark work complete or infer inability to perform from attendance. Use deterministic keys such as `leave_id:task_gid:due_date` to avoid duplicate cards.

### 4. Slack actions, after a destination is chosen

Private admin messages can offer “Open review”, “Acknowledge achievement”, and “Review handover”. Employee interactions can collect blockers/ETA. First version should deep-link to existing portal controls; later interactive decisions must call shared validated domain services, not write database rows in parallel route logic.

Introduce `src/routes/slackInteractions.js`: verify the raw-body Slack signature and timestamp, reject replay/unknown workspace, map Slack actor to an active portal identity, check their current role, and authorize the specific object. Register raw-body middleware before global JSON parsing. Acknowledge the request promptly (Slack requires within three seconds), then process through a durable job. Never trust a role or employee ID supplied by a button payload.

### 5. Asana event ingestion and reconciliation

Introduce `src/routes/asanaWebhook.js`, `src/integrations/asanaSync.js` and a database-backed worker. Subscribe only to approved LIT Tasks scope. Establish a one-time handshake, persist the webhook secret securely, verify HMAC against the exact request bytes, deduplicate events and refetch the task: webhook payloads are compact, not complete task snapshots.

Use webhooks to reduce latency, with periodic full reconciliation to repair missed deliveries, task removal/reassignment and permission changes. Set a visible coverage policy for subtasks. Never discard the last successful snapshot on an interrupted refresh; label its age clearly.

### 6. Durable job and delivery infrastructure

Suggested tables:

```sql
CREATE TABLE integration_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT
);
CREATE TABLE integration_deliveries (
  job_id INTEGER NOT NULL,
  destination TEXT NOT NULL,
  state TEXT NOT NULL,
  external_message_id TEXT,
  attempted_at INTEGER,
  PRIMARY KEY(job_id,destination)
);
```

Insert jobs within the same transaction as a portal event. Workers claim jobs with leases, honor Retry-After, use bounded backoff, and expose failures. If Slack may have accepted a message but no timestamp was received, put the send into needs-review rather than blindly retrying. Schedule jobs on Railway, not on a Mac. Feature flags default off for new outbound actions. A job retry must not duplicate an approval, task or notification.

### 7. Monthly admin review pack

Combine verified task outcomes, acknowledged achievements and prior bonus recipients. Show underlying records and data-quality warnings. Keep compensation choices manual; raw task counts and attendance hours do not establish work quality. No automatic bonus selection or payment.

## Acceptance tests for later stages

- Same-name employees cannot see or update each other's work; unverified mappings cannot trigger mentions.
- Employee cannot use an admin Slack button; deactivated/revoked roles fail at execution time.
- Bad signatures, stale requests and replayed action IDs have no effect.
- Worker restart and duplicate webhook delivery do not duplicate tasks, approvals or messages.
- API failure/partial pagination displays unknown or stale, never a healthy zero.
- A 02:59 IST completion and 03:00 IST completion fall into the explicitly configured adjacent workdays; historical scores are not silently rewritten.
- No rule posts outside the selected channel or includes private bonus/HR details in a team channel.

## Sources and infrastructure

- Asana task listing and completed_since: https://developers.asana.com/reference/gettasks
- Asana webhook verification/compact events: https://developers.asana.com/docs/webhooks-guide
- Slack interaction acknowledgement: https://docs.slack.dev/interactivity/handling-user-interaction/
- Slack request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack/
- Slack rate limits and Retry-After: https://docs.slack.dev/apis/web-api/rate-limits/

Phase 1 adds no package, subscription or external service. It runs in the existing Railway application and shares the Asana cache. Resource usage can still affect usage-based billing. Later webhooks/interactive actions require checking the deployed app's actual permissions and plan availability; do not promise a plan upgrade is unnecessary without verifying it.
