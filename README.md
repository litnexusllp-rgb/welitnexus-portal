# WeLitNexus Employee Portal

A self-contained employee portal for WeLitNexus / LitNexus LLP. Clock in/out,
leaves, holiday calendar, employee directory, and task assignment — for the two
partners (Admins) and the team (Employees).

Same stack as the Slack attendance bot: **Node + Express + better-sqlite3**, no
build step. Branding matches the marketing site (navy / teal / gold, Inter).

---

## Features

| Area | Employee | Admin |
|------|----------|-------|
| **Clock** | Punch In/Out, start/end breaks, live timer, 14-day timesheet | — |
| **Employees** | Own performance, attendance calendar, leave balances/history/requests, salary calculations and PDF slips, personal information | Select a person; review performance, approve leave, calculate salary, edit profiles and manage access |
| **Tasks** | See assigned tasks, update status (To do / In progress / Done) | Assign to anyone, set priority + due date, edit, delete |
| **Holidays** | View calendar + list | Publish / remove holidays |
| **Directory** | Browse everyone's profile + contact info | (same) |
| **Admin** | — | Portal backups and Asana connection settings |
| **Dashboard** | Today's status, hours, balance, open tasks | + Who's in today, pending approvals |

Roles: **ADMIN** (you + partner) and **EMPLOYEE**. Sessions are signed JWTs in an
httpOnly cookie; passwords are bcrypt-hashed.

---

## Run locally

```bash
cd welitnexus-portal
npm install
cp .env.example .env        # optional — defaults work out of the box
npm run seed                # creates admin + sample accounts (only once)
npm start                   # http://localhost:3000
```

### Local sample accounts

`npm run seed` creates local sample accounts defined in `src/seed.js`. Demo
seeding is disabled in production. Production administrator bootstrap uses
`ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables; keep real credentials
out of documentation and source control.

Manage employee accounts in **Employees -> Personal information** and disable
local sample users when they are no longer needed.

---

## Configuration (`.env`)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | Listen port |
| `JWT_SECRET` | dev placeholder | **Set a long random string in production** |
| `TZ_OFFICE` | `Asia/Kolkata` | Default attendance timezone; employee profiles can override it |
| `DB_PATH` | `./data/portal.db` | On Railway, point at the volume: `/data/portal.db` |
| `NODE_ENV` | `development` | Set `production` to enable secure (HTTPS-only) cookies |

---

## Deploy to Railway (same as the attendance bot)

1. Push this folder to a GitHub repo.
2. New Railway project → deploy from the repo.
3. Add a **Volume** mounted at `/data`.
4. Set variables: `JWT_SECRET` (long random), `DB_PATH=/data/portal.db`,
   `NODE_ENV=production`, `TZ_OFFICE=Asia/Kolkata`.
5. Railway runs `npm start`. Configure the administrator bootstrap variables
   for the initial admin account, then add employees through **Employees**.

The whole database is the single file at `DB_PATH`; back it up by copying that file.

### Removed invoicing feature

The portal no longer provides invoice creation, editing, payment status, PDFs,
income totals, or invoice API endpoints. Client management and recurring tasks
remain available. Email backups contain five CSVs plus a full database snapshot.

New databases do not create invoice tables. Existing invoice tables and records
are retained for historical recovery and remain in full database backups; this
update does not delete financial records. Invoice CSV exports are no longer sent.

---

## Project layout

```
welitnexus-portal/
├── src/
│   ├── server.js          Express app + route mounting + static serving
│   ├── db.js              SQLite schema (users, events, leaves, holidays, tasks)
│   ├── auth.js            bcrypt + JWT cookie + role middleware
│   ├── time.js            office-timezone helpers (luxon)
│   ├── seed.js            initial admins / sample data
│   └── routes/            auth, attendance, leaves, holidays, directory, tasks
└── public/
    ├── index.html         login + app shell
    ├── css/portal.css     brand styles
    └── js/
        ├── api.js         fetch wrapper
        └── app.js         single-page app (all views)
```

## Possible next steps
- Slack notifications on leave requests/approvals (reuse the attendance bot's Slack app)
- Google Sheets mirror of attendance (the bot already has `googleSheets.js`)
- Per-employee leave types (sick / casual / earned) and accrual rules
- CSV export of timesheets and leave history

Attendance timezone, overnight-session ownership, correction dates and deployment checks: [attendance timezones](docs/attendance-timezones.md).

Employee workspace navigation and access: [Employees](docs/employees.md).
