# Repository review — 24 October 2026

Reviewed base: `fda3da66427b1a55b4a7c74d12a754a7295254a3` (upstream main at review start).
Concurrent update incorporated: `d63f2e335513468eb7d0005bbab3e6530749fdca` (monthly salary review confirmations). Its schema additions remain inside the serialized initialization transaction; new salary route parameters receive the same validation.

Scope: all backend modules and route families, frontend request/rendering patterns,
package and lock manifests, deployment configuration, backup script, and existing tests.
This is a source review with isolated regression tests, not a production load test,
penetration test, or proof that the production ingress configuration matches its assumptions.
No production database was opened or business records changed.

## Findings and fixes

| Priority | Evidence before change | Files and resulting behavior |
| --- | --- | --- |
| P1 | Runtime authentication and password changes call synchronous bcrypt on the HTTP thread; many requests can stall the portal. | `src/passwords.js`, `src/routes/auth.js`, `src/routes/directory.js`, `src/bootstrap.js`: two worker threads and a 32-entry waiting queue, overload returns 503. Hashing completes before write transactions. Login and self-service changes recheck session versions after awaits; admin writes recheck the actor's permissions. Existing hashes remain valid. |
| P1 | `server.js` starts every scheduler for every HTTP instance; most lack cancellation or ownership. Startup also recalculates every employee's balance synchronously. | `src/server.js`, `src/backgroundWorker.js`, `src/schedulerLock.js`, scheduler modules, `src/shutdown.js`: importing the app does not listen/bootstrap/start timers; explicit startup launches a separate worker. A reserved SQLite lock on a separate companion file grants one scheduler owner per shared DB path. Standbys retry every second. Shutdown cancels timers, drains active asynchronous jobs and HTTP, then closes SQLite; existing ten-second deadline remains. Worker failure makes health return 503. |
| P1 | Schema setup outside the legacy column ledger can interleave between processes; achievement schema changes occur when a route is loaded. | `src/db.js`, `src/routes/achievements.js`: serialize the whole schema setup in an immediate transaction, including the achievement column. Roll back and close the connection on failure. Existing ledger and definitions are preserved. |
| P1 | API validators often coerce objects/arrays to strings, accept impossible dates or string booleans, and allow unbounded report date loops. | `src/requestValidation.js`, `src/server.js`, route modules: shared body/query type, calendar date, bounded range/list/depth and field validation, positive safe route IDs, month validation. New passwords reject bcrypt's silent 72-byte truncation. Tasks/recurrences validate active assignees and approved clients; invalid recurrence edits and reorder IDs return 400. Bulk imports validate before any writes and create clients inside the import transaction. Domain-specific leave, salary and attendance validation remains in place. |
| P1 | `trust proxy=1` is unconditional and the write limiter disables every configuration validation; IPv6 addresses get independent budgets. | `src/proxyConfig.js`, `src/rateLimitKey.js`, authentication route and server: direct access ignores forwarded headers; Railway retains one trusted ingress hop; explicit CIDRs/hops are configurable and blanket `true` is rejected. Both limiters group IPv6 by /56 and normalize IPv4-mapped addresses. Library validation remains enabled. |
| P1 | Several Express 4 async handlers can reject without forwarding the error, leaving requests hanging or producing unhandled rejections. | `src/asyncRoute.js`, all async route handlers: rejected promises reach the JSON error handler. Malformed JSON returns 400 without logging request bodies or exposing server errors. |
| P2 | Balance refreshes on admin GET routes repeat long synchronous per-user loops. | `src/leavePolicy.js`, leave/directory/KPI routes: yield between independent user transactions. The startup-wide pass runs in the scheduler worker. |
| P2 | Manual email backups synchronously serialize the whole DB; temporary downloads can collide and leave files behind. | `src/backupMailer.js`, `src/routes/backup.js`: incremental asynchronous SQLite backup to task-specific temporary directories; Nodemailer streams the snapshot; cleanup after send/download or failure. Bearer backup tokens support constant-time comparison; legacy query tokens remain compatible. CSV attachment construction is still synchronous (see limits). |
| P2 | Recurring/absence code reads before acquiring a write lock; birthday deduplication and notification writes are separate; demo seeding can run against production. | `src/recurring.js`, `src/autoAbsence.js`, `src/birthdays.js`, `src/seed.js`: immediate transactions protect read/check/write sequences, corrupt recurring templates are skipped with an error, import generation failures are logged, and production demo seeding is rejected. Seed output no longer prints passwords. |

The requested WAL timeout, legacy migration error propagation and SIGINT/SIGTERM handlers
already existed in PR #23. This change extends those safeguards; it does not claim they
were missing. SQLite WAL and normal crash recovery already provide crash safety;
a graceful shutdown does not make SQLite immune to disk failures or SIGKILL.

The dependency audit also identified five affected packages (one critical, two high,
two moderate). The lockfile now resolves Express 4.22.3, body-parser 1.20.9,
proxy-addr 2.0.8, qs 6.16.1 and Nodemailer 10.2.1. Nodemailer required a direct
major-version upgrade; the existing transport API and streamed backup attachments
are covered by local mail construction tests without SMTP delivery. A fresh
`npm audit --omit=dev` reports zero known vulnerabilities at review time.

## Configuration and scaling boundaries

- `TRUST_PROXY`: unset means direct access (`false`), except Railway environments identified
  by `RAILWAY_ENVIRONMENT_ID`, which use one hop. Set trusted CIDRs explicitly when appropriate.
  A trusted ingress must overwrite/append forwarding headers, and the app must not have a
  shorter public path bypassing it. This needs infrastructure verification before deployment.
- `BACKGROUND_JOBS=off`: explicitly disable background work on an HTTP instance. Otherwise,
  one worker owns timers for the shared database; other workers wait. All processes must use
  the same canonical `DB_PATH`, companion lock file and local filesystem locking semantics.
  Independent replica disks have independent SQLite data and locks; they do not form a cluster.
- The first deployment from older code needs an orderly replacement: the old version does
  not honor the new scheduler lock. Avoid overlapping old and new scheduler owners.
- Rate-limit counters are in process memory. Multiple HTTP processes multiply the aggregate
  allowance and restarts reset counters. Use a shared store before scaling HTTP replicas.
- Normal better-sqlite3 statements, schema startup, large report calculations and CSV export
  construction remain synchronous. Bounded report ranges and isolated jobs reduce stalls;
  large datasets still need profiling, pagination/batched queries and potentially a server DB.
  A five-second busy timeout can still block the thread owning a contended connection.
- Daily mailers do not promise exactly-once external delivery or catch up missed scheduled
  times after downtime. EOD retains its existing durable delivery/reconciliation safeguards.
  SMTP outages and a forced shutdown during a send can still make delivery uncertain.
- Legacy `?token=` backup URLs remain accepted for compatibility and can enter access logs.
  Prefer `Authorization: Bearer ...`; rotate any token previously exposed in URLs.
- The source backup script remains a deployment template; environment/secret configuration,
  production ingress/load testing are separate checks.

## Validation

Final validation: 186 tests passed on Node 20.20.2 after incorporating the concurrent salary-review feature; zero failures or skipped tests.

Run the full Node 20 suite with `node --test`. Tests use temporary synthetic databases and
local HTTP servers. Added cases exercise password responsiveness and queue limits,
cross-process scheduler ownership and recovery after SIGKILL, background shutdown drainage,
proxy spoofing/rate limiting, IPv6 normalization, valid API compatibility and malformed inputs.
Actual worker standby takeover and streamed backup mail success/failure cleanup are also tested.
Existing real SIGINT/SIGTERM restart/integrity tests remain enabled. Two old tests now import
`app` and explicitly await bootstrap instead of relying on importing `server.js` to listen.

Primary references used for implementation choices:
- https://expressjs.com/en/guide/behind-proxies/
- https://nodejs.org/api/worker_threads.html
- https://www.sqlite.org/lockingv3.html
- https://github.com/dcodeIO/bcrypt.js/

Dependency security references:
- https://github.com/advisories/GHSA-27r3-jxmh-p828
- https://github.com/advisories/GHSA-6vj9-mwq6-2f5v
- https://github.com/nodemailer/nodemailer/releases/tag/v10.2.1
