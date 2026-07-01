'use strict';

// SQLite persistence for the WeLitNexus portal.
// One file on disk (better-sqlite3, same engine as the Slack attendance bot).
// Tables: users, events, leaves, holidays, tasks.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'portal.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON'); // enforce the FK constraints declared below

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  emp_code      TEXT    DEFAULT '',       -- employee code / ID (optional, unique if set)
  role          TEXT    NOT NULL DEFAULT 'EMPLOYEE',   -- ADMIN | EMPLOYEE
  department    TEXT    DEFAULT '',
  title         TEXT    DEFAULT '',
  phone         TEXT    DEFAULT '',
  leave_balance REAL    NOT NULL DEFAULT 18,
  active        INTEGER NOT NULL DEFAULT 1,
  created_ts    INTEGER NOT NULL
);

-- Punch log: one row per clock action, mirrors the Slack bot's event model.
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type    TEXT    NOT NULL,            -- IN | OUT | BREAK_START | BREAK_END
  ts      INTEGER NOT NULL,            -- epoch milliseconds
  day     TEXT    NOT NULL,            -- yyyy-LL-dd in office timezone
  note    TEXT    DEFAULT '',
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_events_user_day ON events(user_id, day);
CREATE INDEX IF NOT EXISTS idx_events_day      ON events(day);

CREATE TABLE IF NOT EXISTS leaves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  start_date  TEXT    NOT NULL,        -- yyyy-LL-dd
  end_date    TEXT    NOT NULL,        -- yyyy-LL-dd
  kind        TEXT    NOT NULL DEFAULT 'FULL',   -- FULL | HALF
  reason      TEXT    DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED | CANCELLED
  days        REAL    NOT NULL DEFAULT 1,
  decided_by  INTEGER,
  decided_ts  INTEGER,
  admin_note  TEXT    DEFAULT '',
  created_ts  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_leaves_user   ON leaves(user_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leaves(status);

CREATE TABLE IF NOT EXISTS holidays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL UNIQUE, -- yyyy-LL-dd
  name        TEXT    NOT NULL,
  type        TEXT    DEFAULT 'PUBLIC', -- PUBLIC | OPTIONAL | COMPANY
  created_by  INTEGER,
  created_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);

-- Weekend dates the firm treats as working (e.g. the 1st Saturday). Overrides
-- the default Sat/Sun = weekend rule in attendance reports.
CREATE TABLE IF NOT EXISTS working_days (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL UNIQUE, -- yyyy-LL-dd
  note        TEXT    DEFAULT '',
  created_by  INTEGER,
  created_ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_working_days_date ON working_days(date);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  description   TEXT    DEFAULT '',
  assignee_id   INTEGER NOT NULL,
  assigned_by   INTEGER NOT NULL,
  priority      TEXT    NOT NULL DEFAULT 'MEDIUM', -- LOW | MEDIUM | HIGH
  status        TEXT    NOT NULL DEFAULT 'TODO',   -- TODO | IN_PROGRESS | DONE
  due_date      TEXT    DEFAULT '',
  client_id     INTEGER,                -- optional: which client this is for
  recurring_id  INTEGER,                -- set if auto-generated from a schedule
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);

-- The firm's client list — a permanent client database.
CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  code          TEXT    DEFAULT '',      -- short code / acronym
  business_type TEXT    DEFAULT '',      -- free text: what kind of business
  stage         TEXT    NOT NULL DEFAULT 'PROSPECT', -- PROSPECT | INTERVIEWED | SIGNED
  notes         TEXT    DEFAULT '',
  approval      TEXT    NOT NULL DEFAULT 'APPROVED', -- APPROVED | PENDING | REJECTED
  created_by    INTEGER,                 -- who proposed/created it
  parent_id     INTEGER,                 -- a sub-client/file under a parent client
  active        INTEGER NOT NULL DEFAULT 1,
  created_ts    INTEGER NOT NULL
);

-- Recurring task templates (e.g. "Monthly bookkeeping for Client X").
-- A generator turns these into real tasks each period.
CREATE TABLE IF NOT EXISTS recurring_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  description  TEXT    DEFAULT '',
  client_id    INTEGER,
  assignee_id  INTEGER NOT NULL,
  priority     TEXT    NOT NULL DEFAULT 'MEDIUM',
  frequency    TEXT    NOT NULL DEFAULT 'MONTHLY', -- WEEKLY | MONTHLY | QUARTERLY | YEARLY
  step         INTEGER NOT NULL DEFAULT 1,         -- every N periods
  lead_days    INTEGER NOT NULL DEFAULT 7,         -- create the task this many days before due
  next_due     TEXT    NOT NULL,                   -- yyyy-LL-dd of the next instance to create
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER NOT NULL,
  created_ts   INTEGER NOT NULL,
  last_run_ts  INTEGER,
  FOREIGN KEY (assignee_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_tasks(active);

-- Self-reported wins. Employees log achievements (daily/weekly/monthly);
-- admins review and award points, which feed the monthly KPI/bonus report.
CREATE TABLE IF NOT EXISTS achievements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  date        TEXT    NOT NULL,            -- yyyy-LL-dd the achievement is for
  title       TEXT    NOT NULL,
  description TEXT    DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING | ACKNOWLEDGED | DECLINED
  points      INTEGER NOT NULL DEFAULT 0,         -- awarded by admin on review
  reviewed_by INTEGER,
  reviewed_ts INTEGER,
  created_ts  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
CREATE INDEX IF NOT EXISTS idx_achievements_date ON achievements(date);

-- Per-task checklist. A task can't be marked DONE until every item is ticked.
CREATE TABLE IF NOT EXISTS task_checklist (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL,
  text     TEXT    NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_checklist_task ON task_checklist(task_id);

-- Client invoices (admin-only). Amounts roll up to income per client.
CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    INTEGER NOT NULL,
  number       TEXT    DEFAULT '',       -- optional invoice number/reference
  amount       REAL    NOT NULL DEFAULT 0, -- total (sum of line items)
  invoice_date TEXT    DEFAULT '',        -- yyyy-LL-dd
  due_date     TEXT    DEFAULT '',
  currency     TEXT    NOT NULL DEFAULT 'USD',
  bill_to      TEXT    DEFAULT '',        -- snapshot of the client's billing address
  status       TEXT    NOT NULL DEFAULT 'UNPAID', -- UNPAID | PAID
  note         TEXT    DEFAULT '',
  created_by   INTEGER,
  created_ts   INTEGER NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);

-- Line items on an invoice (item, qty, rate; amount = qty * rate).
CREATE TABLE IF NOT EXISTS invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL,
  item        TEXT    DEFAULT '',
  description TEXT    DEFAULT '',
  quantity    REAL    NOT NULL DEFAULT 1,
  rate        REAL    NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_inv ON invoice_items(invoice_id);
`);

// --- Lightweight migrations for databases created before these columns existed.
for (const stmt of [
  `ALTER TABLE tasks ADD COLUMN client_id INTEGER`,
  `ALTER TABLE tasks ADD COLUMN recurring_id INTEGER`,
  `ALTER TABLE users ADD COLUMN emp_code TEXT DEFAULT ''`,
  `ALTER TABLE recurring_tasks ADD COLUMN checklist_json TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN business_type TEXT DEFAULT ''`,
  `ALTER TABLE clients ADD COLUMN stage TEXT NOT NULL DEFAULT 'PROSPECT'`,
  `ALTER TABLE clients ADD COLUMN approval TEXT NOT NULL DEFAULT 'APPROVED'`,
  `ALTER TABLE clients ADD COLUMN created_by INTEGER`,
  `ALTER TABLE clients ADD COLUMN parent_id INTEGER`,
  `ALTER TABLE clients ADD COLUMN billing_address TEXT DEFAULT ''`,
  `ALTER TABLE invoices ADD COLUMN due_date TEXT DEFAULT ''`,
  `ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'`,
  `ALTER TABLE invoices ADD COLUMN bill_to TEXT DEFAULT ''`,
]) {
  try { db.exec(stmt); } catch (_e) { /* column already exists — ignore */ }
}
// Index on the (possibly just-added) client_id column.
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id)`);

module.exports = { db, DB_PATH };
