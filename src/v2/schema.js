'use strict';

// Portal v2 tables. ADDITIVE ONLY: every table here is new and prefixed `int_`.
// Nothing in this file alters, renames or deletes an existing table or column,
// so the attendance, leave, salary, task and client history already in the
// database is never touched. Safe to run on every start (IF NOT EXISTS).
//
// Note: legacy `invoices` / `invoice_items` tables from an earlier version may
// still exist in production. They are deliberately left alone; v2 billing uses
// its own `int_invoices*` tables.

const TABLES = `
-- Admin console access level. Partners are OWNER (full). BILLING admins can
-- only use clients, invoices and billing reports. Everyone else is EMPLOYEE.
CREATE TABLE IF NOT EXISTS int_user_roles (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  level       TEXT NOT NULL CHECK(level IN ('OWNER','BILLING')),
  granted_by  INTEGER REFERENCES users(id),
  granted_ts  INTEGER NOT NULL
);

-- Two-step verification (TOTP, RFC 6238) for the admin console.
CREATE TABLE IF NOT EXISTS int_admin_totp (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  secret_enc    TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  backup_codes  TEXT NOT NULL DEFAULT '[]',   -- JSON array of sha256 hashes
  last_step     INTEGER NOT NULL DEFAULT 0,   -- replay protection
  created_ts    INTEGER NOT NULL,
  enabled_ts    INTEGER
);

-- Pending step-1 sign-ins waiting for their 6-digit code.
CREATE TABLE IF NOT EXISTS int_admin_challenges (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_ts  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

-- Wrong 2-step codes per account, so starting a new sign-in does not reset
-- the count. Rows older than the lockout window are ignored and cleared.
CREATE TABLE IF NOT EXISTS int_admin_code_failures (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_int_admin_code_failures ON int_admin_code_failures(user_id, ts);

-- Everything sensitive an admin or an integration does.
CREATE TABLE IF NOT EXISTS int_audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '{}',
  ip         TEXT NOT NULL DEFAULT '',
  ts         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_int_audit_ts ON int_audit_log(ts);

-- Billing. Amounts are integer minor units (cents / paise).
CREATE TABLE IF NOT EXISTS int_invoice_counters (
  year     INTEGER PRIMARY KEY,
  next_no  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS int_invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT UNIQUE,                      -- assigned when first sent
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SENT','PAID','VOID')),
  currency      TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','INR')),
  issue_date    TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  terms         TEXT NOT NULL DEFAULT 'NET_30',
  tax_rate_bp   INTEGER NOT NULL DEFAULT 0,       -- basis points, 1800 = 18%
  notes         TEXT NOT NULL DEFAULT '',
  bill_to       TEXT NOT NULL DEFAULT '',
  reminders     INTEGER NOT NULL DEFAULT 1,
  subtotal      INTEGER NOT NULL DEFAULT 0,
  tax           INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  paid          INTEGER NOT NULL DEFAULT 0,
  sent_ts       INTEGER,
  last_reminder_ts INTEGER,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_int_invoices_client ON int_invoices(client_id);
CREATE TABLE IF NOT EXISTS int_invoice_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES int_invoices(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity    REAL NOT NULL,
  unit_price  INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  source      TEXT NOT NULL DEFAULT ''            -- e.g. task:12, asana:123
);
CREATE TABLE IF NOT EXISTS int_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES int_invoices(id),
  amount      INTEGER NOT NULL CHECK(amount > 0),
  paid_on     TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT '',
  reference   TEXT NOT NULL DEFAULT '',
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_ts INTEGER NOT NULL
);

-- OAuth tokens (Google, Microsoft, Slack user tokens), encrypted at rest.
CREATE TABLE IF NOT EXISTS int_oauth_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL,
  account_email TEXT NOT NULL DEFAULT '',
  data_enc      TEXT NOT NULL,
  updated_ts    INTEGER NOT NULL,
  UNIQUE(user_id, provider, account_email)
);

-- Slack messaging cache. The Messages feature was removed; the table is kept
-- so existing data is untouched, and nothing writes to it any more.
CREATE TABLE IF NOT EXISTS int_messages (
  channel_id  TEXT NOT NULL,
  ts          TEXT NOT NULL,
  thread_ts   TEXT,
  slack_user  TEXT NOT NULL DEFAULT '',
  user_id     INTEGER,
  text        TEXT NOT NULL DEFAULT '',
  files_json  TEXT NOT NULL DEFAULT '[]',
  edited      INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  received_ts INTEGER NOT NULL,
  PRIMARY KEY(channel_id, ts)
);
CREATE TABLE IF NOT EXISTS int_slack_users (
  slack_user  TEXT PRIMARY KEY,
  user_id     INTEGER,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  updated_ts  INTEGER NOT NULL
);
-- No longer used since Messages was removed; kept so existing data is untouched.
CREATE TABLE IF NOT EXISTS int_channel_links (
  channel_id        TEXT PRIMARY KEY,
  asana_project_gid TEXT NOT NULL DEFAULT '',
  client_id         INTEGER REFERENCES clients(id),
  updated_ts        INTEGER NOT NULL
);

-- AI usage (cost and daily limits). No longer written since the AI assistant
-- was removed; kept so existing data is untouched.
CREATE TABLE IF NOT EXISTS int_ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  action        TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ts            INTEGER NOT NULL
);

-- Unified calendar.
CREATE TABLE IF NOT EXISTS int_calendar_sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK(kind IN ('GOOGLE','MICROSOFT','ICS')),
  label         TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#2F6FB5',
  visible       INTEGER NOT NULL DEFAULT 1,
  token_id      INTEGER REFERENCES int_oauth_tokens(id),
  remote_id     TEXT NOT NULL DEFAULT '',        -- calendar id at the provider
  ics_url_enc   TEXT,
  client_id     INTEGER REFERENCES clients(id),
  read_only     INTEGER NOT NULL DEFAULT 0,
  last_sync_ts  INTEGER,
  last_error    TEXT NOT NULL DEFAULT '',
  created_ts    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS int_calendar_events_cache (
  source_id   INTEGER NOT NULL REFERENCES int_calendar_sources(id) ON DELETE CASCADE,
  uid         TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  all_day     INTEGER NOT NULL DEFAULT 0,
  location    TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  busy        INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(source_id, uid, start_ts)
);
CREATE INDEX IF NOT EXISTS idx_int_cal_range ON int_calendar_events_cache(start_ts, end_ts);

-- OAuth "state" values for the calendar connect flow (CSRF protection).
CREATE TABLE IF NOT EXISTS int_oauth_states (
  state       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  verifier    TEXT NOT NULL DEFAULT '',
  expires_ts  INTEGER NOT NULL
);

-- Small key/value settings editable from the admin console (no secrets here).
CREATE TABLE IF NOT EXISTS int_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_by  INTEGER,
  updated_ts  INTEGER NOT NULL
);
`;

function ensure(db) {
  db.transaction(() => {
    db.exec(TABLES);
  }).immediate();
}

module.exports = { ensure, TABLES };
