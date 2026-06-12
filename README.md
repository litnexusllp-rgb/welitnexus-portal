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
| **Leaves** | Apply (full/half, date range), see balance, cancel pending | Approve/reject (auto-deducts balance) |
| **Tasks** | See assigned tasks, update status (To do / In progress / Done) | Assign to anyone, set priority + due date, edit, delete |
| **Holidays** | View calendar + list | Publish / remove holidays |
| **Directory** | Browse everyone's profile + contact info | (same) |
| **Admin** | — | Add/edit employees, set roles, reset passwords, enable/disable, set leave balance |
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

### Seeded logins (change these!)
| Role | Email | Password |
|------|-------|----------|
| Admin (you) | `saurav@welitnexus.com` | `Welit@2026` |
| Admin (partner) | `partner@welitnexus.com` | `Welit@2026` |
| Employee | `aanya@welitnexus.com` | `Welcome@123` |
| Employee | `rohan@welitnexus.com` | `Welcome@123` |

First thing: log in as admin → **Admin** tab → reset passwords / add your real team,
then delete the sample employees (Disable).

---

## Configuration (`.env`)

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | Listen port |
| `JWT_SECRET` | dev placeholder | **Set a long random string in production** |
| `TZ_OFFICE` | `Asia/Kolkata` | Controls what counts as "today" for clock-in |
| `DB_PATH` | `./data/portal.db` | On Railway, point at the volume: `/data/portal.db` |
| `NODE_ENV` | `development` | Set `production` to enable secure (HTTPS-only) cookies |

---

## Deploy to Railway (same as the attendance bot)

1. Push this folder to a GitHub repo.
2. New Railway project → deploy from the repo.
3. Add a **Volume** mounted at `/data`.
4. Set variables: `JWT_SECRET` (long random), `DB_PATH=/data/portal.db`,
   `NODE_ENV=production`, `TZ_OFFICE=Asia/Kolkata`.
5. Railway runs `npm start`. After first deploy, run `npm run seed` once
   (Railway shell) to create the admin account — or register people via the
   Admin tab after seeding just yourself.

The whole database is the single file at `DB_PATH`; back it up by copying that file.

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
