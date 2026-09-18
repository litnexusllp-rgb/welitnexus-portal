# Cloud Asana EOD reports

The existing Railway portal process captures Asana data each day at 03:00 Asia/Kolkata and starts posting at 03:15. Code deploys from GitHub. Neither Codex nor a personal computer needs to be running. Do not turn the web service into a Railway cron service: the portal must stay running. Keep Railway Serverless disabled, one replica, and DB_PATH on the existing persistent volume.

## Railway variables

- `EOD_ENABLED=true` enables scheduling. Omit or set false to pause.
- `ASANA_TOKEN` and `SLACK_BOT_TOKEN`: reuse the existing integration credentials; never commit them.
- `ASANA_EOD_PROJECT_GIDS`: comma-separated Asana project IDs.
- `SLACK_EOD_CHANNEL`: destination public channel ID.
- `ASANA_SLACK_USER_MAP`: JSON object mapping Asana user IDs to confirmed Slack user IDs. Store this in Railway variables, not the public repository. Missing identities are resolved by exact email only; ambiguous/unavailable matches appear by name with a warning.

The Slack bot needs `chat:write`, membership in the destination channel, and `channels:read` for the connection check. Optional `users:read` and `users:read.email` support email matching. Existing permissions must be verified before enabling; do not broaden them silently. Invite the bot to the destination channel if it is not already a member.

## Behavior

Workday D runs from D 03:00 inclusive until D+1 03:00 exclusive in India time, independent of server timezone. It includes tasks marked complete overnight, and reports who owns each task and who marked it complete when different. Completion timestamps do not prove who performed the work.

Projects are fully paginated and task IDs deduplicated. Completed parents are read too so open subtasks beneath them are not omitted. A failed project or subtask fetch aborts capture and retries later; failure never becomes a misleading zero-task report. Snapshot collection is a sequence of reads, not an atomic historical Asana snapshot. Actual observation times, delayed collection, and post-cutoff edits are disclosed. Reopened tasks and changed assignees/dates cannot always be reconstructed.

Pending tasks are grouped into due that workday, overdue, and future/no-date. Reasons come only from explicitly named blocker/pending-reason custom fields or a `Blocker:`, `Pending reason:`, or `Reason for delay:` line in the task description. Later-edited reasons are not backdated. Missing reasons are reported as missing, never inferred. Free-form comments are not interpreted as blocker evidence.

Reports are saved in SQLite before sending. One root summary and per-person thread replies include real Slack mentions; content is escaped to prevent task descriptions from injecting mentions. Long groups are split without omitting tasks. No report is backfilled on first activation; the first report is for the next 03:00 cutoff. A restart after an eligible cutoff captures late and clearly labels the report. Once saved, snapshots are immutable. A database lease prevents overlapping workers; delivery records prevent resending acknowledged parts. A timeout or crash during a Slack write stops that report with `needs_review` instead of risking duplicate posts. There is no claim of exactly-once network delivery.

## Verify and monitor (signed-in portal admins only)

- `GET /api/eod/status`: configuration readiness, activation time, recent report state and last collection/delivery error. No credentials returned.
- `GET /api/eod/check`: read-only Asana project access and Slack bot/channel membership check.
- `GET /api/eod/preview`: live read-only preview, explicitly labelled as current observations rather than historical cutoff data. Does not save or send.
- Railway logs: lines prefixed `[EOD]` show capture, send, or errors without task details or credentials.

If a report says `needs_review`, inspect Slack using the visible `EOD YYYY-MM-DD · part/total` markers before changing any delivery state. Reconcile the matching Slack timestamp in `eod_deliveries` as `sent`, or reset to `failed` only after confirming that part was not posted. Set report status back to `ready` after reconciliation. The scheduler retries only the most recent workday, so older failures require operator handling; do not delete delivery rows or rerun old reports blindly.

Local Codex automation `asana-eod-report-to-slack` must remain paused to prevent duplicate reporting. GitHub Actions runs tests only; Railway runs the time-sensitive schedule and persists its state.
