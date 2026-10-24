# SQLite startup and shutdown

The portal uses one better-sqlite3 connection with WAL, foreign keys enabled,
and an explicit 5,000 ms busy timeout. The driver already defaults to that
same timeout; the pragma makes the application setting visible and deliberate.
This does not eliminate every possible SQLITE_BUSY error (for example, lock
upgrades inside an existing read transaction may still require retrying the
whole transaction).

The legacy ADD COLUMN list in src/db.js is adopted into schema_versions.
Each entry has an ordered integer version, its SQL definition, and a timestamp.
Existing columns are detected with table_info rather than by suppressing SQL
exceptions. The full list and its ledger updates run in one immediate
transaction. Any failure propagates and rolls back the batch. Applied
migration definitions must not be edited or reordered; append new entries.
A missing column or changed definition for a recorded version stops startup.
Other existing schema setup blocks retain their explicit idempotent checks;
the ledger does not claim to version those historical blocks retroactively.

On SIGINT or SIGTERM, the HTTP server stops accepting new connections and
drains existing requests before synchronously closing SQLite and exiting.
A ten-second deadline closes remaining connections and exits with failure if
requests cannot drain. Repeated signals do not run the close sequence twice.
SQLite's normal last-connection close handles WAL cleanup; there is no forced
checkpoint while requests are active. Abrupt SIGKILL or host failure still
requires SQLite's normal crash recovery and is not a graceful shutdown.

Leave requests currently use whole days and half-days only. Both 1 and 0.5
are exactly representable in binary64, so adding/subtracting these units in
normal leave ranges does not produce decimal rounding drift. Existing REAL
columns and historical balances are preserved. If arbitrary fractional hours
are introduced later, choose integer units and perform a separately reviewed
data migration rather than rounding historical values at startup.

## Application and background lifecycle

Schema initialization now runs in one immediate transaction, serializing complete
startup migrations between connections/processes and moving the achievement-column
addition out of route construction. A failure rolls back and closes the connection.

Import `app` from `src/server.js` for HTTP tests; call and await `bootstrapAdmin()`
explicitly for fresh fixtures. `npm start` calls `start()`, which awaits bootstrap,
starts HTTP and creates the background worker. Password operations use a bounded
worker pool rather than blocking the HTTP thread. Bulk leave balance refreshes
yield between employees; the initial complete refresh runs in the scheduler worker.

The background worker holds a reserved lock in `<DB_PATH>.scheduler-lock` for its
lifetime. This is a separate SQLite file so it does not hold the business DB's
write lock. Competing workers wait; OS/SQLite locking releases ownership on worker
failure. Do not delete the companion file while any portal instance is running.
Schedulers return cancellation functions and EOD exposes `stop()`; shutdown waits
for active background work as well as HTTP before closing the main connection.
An unexpected worker exit makes `/api/health` return 503.

See `docs/reviews/2026-10-24-repository-review.md` for deployment assumptions,
configuration, limits, and the complete file/issue map.
