# EduPay — School Payroll System

Payroll and workforce management for schools, built with Node.js, Express and
**PostgreSQL** (Google Cloud SQL), with a dependency-free front end.

Four roles, with duties deliberately separated: an accountant processes payroll,
HR approves it, and only then can payments be recorded. Several of those rules
are enforced by database constraints, not just application code.

---

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running locally](#running-locally)
- [Database design](#database-design)
- [Roles and permissions](#roles-and-permissions)
- [Payroll calculation](#payroll-calculation)
- [Security model](#security-model)
- [Deployment](#deployment)
- [Tests](#tests)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser (vanilla HTML/CSS/JS)
    │  JSON over HTTPS, bearer token
    ▼
Express API  ──  role gates, validation, rate limiting, audit log
    │  pg connection pool
    ▼
PostgreSQL (Cloud SQL)  ──  constraints that enforce payroll invariants
```

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| API | Express 4 |
| Database | PostgreSQL 16 (`pg`) |
| Authentication | JWT + bcrypt, with token revocation |
| Two-factor | Emailed one-time codes, or TOTP via `otplib` |
| Email | Nodemailer |
| Documents | PDFKit (payslips, reports), ExcelJS (spreadsheets) |
| Front end | Vanilla HTML/CSS/JS, no build step |
| Analytics | Firebase Analytics (sign-in page only, opt-out aware) |

Zero npm vulnerabilities as of the last check.

---

## Prerequisites

- Node.js 20 or newer
- A PostgreSQL 14+ database. On Google Cloud SQL, create an instance and a
  database, plus a user with rights on it.
- The `btree_gist` extension, used by the leave-overlap constraint. It ships with
  Cloud SQL and standard Postgres distributions; the migration enables it.
- An SMTP account (optional but strongly recommended — see
  [Without email](#without-email))

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure the connection

```bash
cp .env.example .env
```

Pick one of three connection styles, described in full in `.env.example`:

| Where the app runs | Use |
|---|---|
| Cloud Run, App Engine, Cloud Functions | `INSTANCE_UNIX_SOCKET=/cloudsql/PROJECT:REGION:INSTANCE` plus `DB_USER`, `DB_PASSWORD`, `DB_NAME` |
| Your laptop | The **Cloud SQL Auth Proxy**, then a plain `DATABASE_URL` pointing at `127.0.0.1` |
| Anywhere outside Google Cloud | `DB_HOST` + `DB_SSL=true` + `DB_SSL_CA` |

The Auth Proxy is the easiest local route, because it handles TLS and IAM for you:

```bash
# Download once, from https://cloud.google.com/sql/docs/postgres/sql-proxy
./cloud-sql-proxy edupay-ug:europe-west1:edupay-db --port 5432
```

Also set `JWT_SECRET` — at least 32 characters. The server refuses to start in
production without it.

```bash
openssl rand -base64 48
```

### 3. Create the schema and seed

```bash
npm run db:setup      # migrate, then seed
```

Or separately:

```bash
npm run db:migrate           # apply pending migrations
npm run db:migrate:status    # show what is applied and what is pending
npm run db:seed              # default scales, settings, first administrator
```

Seeding is idempotent and prints the generated administrator password **once**:

```
 ──────────────────────────────────────────────────────────
  Administrator account created
  Username: admin
  Password: Rk7mQx2pVnLt4!

  This password was generated and is shown only once.
  Store it now. You must change it at first sign-in.
 ──────────────────────────────────────────────────────────
```

There are no shared default passwords anywhere in the system.

---

## Running locally

```bash
npm start          # production mode
npm run dev        # with --watch, restarts on change
```

Then open <http://localhost:3000>.

Health endpoints:

- `GET /healthz` — liveness, no dependencies touched
- `GET /readyz` — readiness; reports database connectivity, the server version,
  and whether email is configured. Point your platform's health check here.

---

## Database design

The schema does real work. Rules that would otherwise live only in application
code are constraints, which makes them race-free and impossible to bypass.

| Invariant | Enforced by |
|---|---|
| One structure per salary scale | `salary_structures.salary_scale` is the primary key |
| One payroll run per period | `UNIQUE (month, year)` on `payroll` |
| Usernames are unique | `UNIQUE` on `users.username` |
| A teacher's scale must exist | Foreign key to `salary_structures` |
| A scale in use cannot be deleted | That same key, `ON DELETE RESTRICT` |
| **Net pay is never negative** | `CHECK (net_salary >= 0)` |
| Payroll arithmetic is consistent | `CHECK (abs(net − (gross − deductions)) < 0.01)` |
| **The processor never approves their own run** | `CHECK (approved_by IS DISTINCT FROM processed_by)` |
| **Leave never overlaps** | `EXCLUDE USING gist` on teacher + date range |
| A leave end date follows its start | `CHECK (end_date >= start_date)` |
| Leave day counts cannot drift | A `GENERATED ALWAYS AS` column |
| **One open advance per teacher** | A partial unique index on open statuses |
| An advance is never over-repaid | `CHECK (amount_repaid <= amount)` |
| Payroll history survives staff deletion | `payroll_items.teacher_id` is `ON DELETE RESTRICT` |
| The audit trail survives account deletion | `audit_log.user_id` is `ON DELETE SET NULL` |

Money is `NUMERIC(14,2)` — exact decimal. Never `float`: `0.1 + 0.2 = 0.3` holds
for `NUMERIC` and does not for floating point, which matters when the figures are
filed with URA and NSSF.

### Tables

`users`, `teachers`, `accountants`, `salary_structures`, `payroll`,
`payroll_versions`, `payroll_items`, `leave_requests`, `advance_requests`,
`notifications`, `audit_log`, `system_config`, `password_resets`, `counters`,
`schema_migrations`.

Full column detail is in
[TECHNICAL_DOCUMENTATION.md](TECHNICAL_DOCUMENTATION.md#4-database-schema).

### Migrations

Files in `server/migrations/` run once each, in filename order, inside a
transaction, and are recorded in `schema_migrations` with a checksum. Editing a
migration that has already run is detected and refused — add a new one instead.

---

## Roles and permissions

| | Admin | HR | Accountant | Teacher |
|---|---|---|---|---|
| Staff accounts | ✅ | — | — | — |
| System settings | ✅ | — | — | — |
| Audit log | ✅ | — | — | — |
| Teachers | ✅ | ✅ | view | — |
| Salary structures | ✅ | ✅ | view | — |
| Process payroll | ✅ | — | ✅ | — |
| **Approve payroll** | — | ✅ | — | — |
| Record payments | ✅ | — | ✅ | — |
| Leave / advance decisions | ✅ | ✅ | — | — |
| Pause a teacher's payroll | ✅ | — | ✅ | — |
| Own payslips and requests | — | — | — | ✅ |

Payroll approval is **HR only**, including for administrators, and nobody may
approve a run they processed. The database backs this up with a check
constraint, so it holds even if the route guard were bypassed.

---

## Payroll calculation

### PAYE

Uganda's URA monthly schedule for resident individuals, applied to **gross** pay:

| Monthly chargeable income (UGX) | Tax |
|---|---|
| 0 – 235,000 | Nil |
| 235,001 – 335,000 | 10% of the excess over 235,000 |
| 335,001 – 410,000 | 10,000 + 20% of the excess over 335,000 |
| 410,001 – 10,000,000 | 25,000 + 30% of the excess over 410,000 |
| Above 10,000,000 | as above, plus 10% of the excess over 10,000,000 |

The bands live in `system_config` as JSONB and can be edited without a code
change. `taxMode` may be set to `flat` to reproduce historical figures computed
the old way, or `none` to disable PAYE.

### NSSF

5% employee (deducted) and 10% employer (tracked, not deducted). The employer
share appears on payslips as information and feeds the statutory report, so the
true cost of employment is visible.

### Order of operations

1. Basic pay is abated pro rata for approved **unpaid** leave days in the period
2. Gross = abated basic + all allowances
3. PAYE on gross, NSSF on gross, plus any fixed loan and other deductions
4. The **advance instalment** is trimmed so net pay stays above
   `minimumNetPercentage` of gross; any untaken remainder carries to the next run
5. Net = gross − total deductions

Net pay can never be negative — and now the database would reject the row even if
the calculator were wrong.

### Reprocessing

Reprocessing a period supersedes rather than destroys. The previous run is
archived to `payroll_versions` as a JSONB snapshot including its lines, its
advance repayments are reversed, its lines are flagged `superseded`, and a new
version is written. The whole operation is one transaction, so a run of any size
either lands completely or not at all.

---

## Security model

| Area | Approach |
|---|---|
| Passwords | bcrypt, cost 12. 10+ characters, three character classes, common passwords rejected |
| Account creation | An emailed single-use setup link, so no password is ever known to anyone else. Without email, a unique random temporary password shown once |
| Two-factor | Codes are **hashed** and emailed to the account owner. No one, including administrators, can read another user's code |
| Sessions | 2-hour JWTs carrying a `token_version`. A password change, reset, deactivation or sign-out revokes every existing token |
| Rate limiting | 20 sign-in attempts per IP per 15 min; 5 email-sending requests per hour; 300 API requests per minute |
| Brute force | The MFA attempt counter is **not** reset by requesting a new code |
| SQL injection | Every query is parameterised; no string interpolation of user input |
| Output escaping | All dynamic text passes through an auto-escaping template tag; the trust marker is a class instance, so a JSON payload cannot forge it |
| Headers | Helmet, with a content security policy that needs no inline-script allowance |
| CORS | Restricted to `ALLOWED_ORIGINS`; not open to all origins |
| Transport | Cloud SQL via Unix socket or the Auth Proxy, so credentials never cross a network unencrypted |
| Deletion | Refused by the database for anyone with payroll history; deactivation preserves the record |
| Audit | Every privileged action, with actor, IP and detail, surviving account deletion |

### Without email

The system runs without SMTP, but:

- new accounts get a one-time temporary password instead of a setup link
- two-factor authentication stays **off**, because a code could not be delivered
- self-service password reset does nothing

The administrator dashboard shows this under **Dashboard → System health**.

---

## Deployment

### Cloud Run (recommended)

Cloud Run connects to Cloud SQL over a Unix socket, so no IP allow-listing or
certificates are needed.

```bash
gcloud run deploy edupay \
  --source . \
  --region europe-west1 \
  --add-cloudsql-instances edupay-ug:europe-west1:edupay-db \
  --set-env-vars NODE_ENV=production \
  --set-env-vars INSTANCE_UNIX_SOCKET=/cloudsql/edupay-ug:europe-west1:edupay-db \
  --set-env-vars DB_USER=edupay,DB_NAME=edupay \
  --set-secrets DB_PASSWORD=edupay-db-password:latest \
  --set-secrets JWT_SECRET=edupay-jwt-secret:latest
```

Run migrations before or during the first deploy — from a Cloud Build step, a
one-off Cloud Run job, or your laptop through the Auth Proxy:

```bash
npm run db:migrate
```

Keep `PG_POOL_MAX` × max instances below the instance's `max_connections`.
Cloud Run scales to many instances, and the smaller Cloud SQL tiers allow
relatively few connections.

### Checklist before going live

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` set, 32+ characters (startup refuses otherwise)
- [ ] `BASE_URL` set, so email links are correct
- [ ] `ALLOWED_ORIGINS` set if the front end is on another origin
- [ ] Migrations applied — `npm run db:migrate:status` shows 0 pending
- [ ] Automated backups and point-in-time recovery enabled on the instance
- [ ] SMTP configured and a test email sent
- [ ] The seeded administrator password changed
- [ ] A second administrator created, so you cannot be locked out
- [ ] `PG_POOL_MAX` sized against the instance's connection limit

---

## Tests

```bash
npm test
```

**76 tests** run with no database at all — the PAYE bands, the payroll
calculator, leave arithmetic, advance instalments, input validation, output
escaping against real XSS payloads, and HTTP-level checks of the security
headers, authentication gate and error handling.

With a throwaway database, **143 tests** run, adding:

- **30 constraint tests** asserting the database itself refuses negative net pay,
  overlapping leave, a second open advance, self-approval of payroll, deleting a
  teacher with payroll history, and more
- **37 integration tests** covering the whole workflow end to end

```bash
createdb edupay_test
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/edupay_test npm test
```

Both database suites truncate and re-seed before running, so they are repeatable,
and refuse to run unless the database name contains `test`.

---

## API reference

All endpoints are under `/api`. Every one except the authentication routes needs
`Authorization: Bearer <token>`.

### Authentication — `/api/auth`

| Method | Path | Purpose |
|---|---|---|
| POST | `/login` | Sign in; may return an MFA challenge |
| POST | `/verify-mfa` | Complete a two-factor challenge |
| POST | `/resend-mfa` | Email a replacement code |
| POST | `/forgot-password` | Request a reset link |
| POST | `/reset-password/validate` · `/complete` | Use a reset link |
| POST | `/setup-password/validate` · `/complete` | Activate a new account |
| GET | `/me` | The current account |
| POST | `/change-password` | Change own password; returns a fresh token |
| POST | `/logout` | Revoke all tokens for the account |

### Administrator — `/api/admin`

Accounts (`/users`, `/admins`, `/hr`, `/accountants`), plus
`/users/:id/deactivate`, `/reactivate`, `/reset-password`, `/resend-setup`,
`/mfa`; `/config`, `/audit-log` (cursor-paginated) and `/audit-log/actions`,
`/mfa-status`, `/backup`, `/stats`, `/reports/payroll-summary`.

### HR — `/api/hr`

`/teachers` (with `/deactivate`, `/reactivate`, `/resend-setup`),
`/salary-structures`, `/leave/:id/status`, `/advances/:id/status`,
`/payroll/:id/approve`, `/payroll/:id/reject`, `/stats`.

### Accountant — `/api/accountant`

`/teachers`, `/teachers/:id/payroll-halt`, `/payroll`, `/payroll/process`,
`/payroll/:id/items`, `/payroll/:id/versions`, `/payroll/:id/mark-all-paid`,
`/payroll-items/:id/payment-status`, `/reports/monthly`,
`/reports/statutory/:id`, `/reports/export/{excel,pdf}/:id`,
`/payslip/:id/pdf`, `/stats`.

### Teacher — `/api/teacher`

`/profile`, `/payslips`, `/payslip/:id/pdf`, `/salary-history`, `/leave`
(+ `/:id/cancel`), `/advances` (+ `/:id/cancel`), `/stats`.

### Notifications — `/api/notifications`

`GET /`, `GET /unread-count`, `PUT /read-all`, `PUT /:id/read`. Available to
every role.

---

## Troubleshooting

**`PostgreSQL is not reachable` on startup**
Check which connection style you configured. From a laptop, the Cloud SQL Auth
Proxy must be running. On Cloud Run, the service needs
`--add-cloudsql-instances` as well as `INSTANCE_UNIX_SOCKET`.

**`ECONNREFUSED 127.0.0.1:5432`**
Nothing is listening. Start the Auth Proxy, or point `DATABASE_URL` at the right
host and port.

**`The schema has not been created`**
Run `npm run db:migrate`. The server checks this at startup rather than failing
on the first request.

**`password authentication failed`**
Cloud SQL users are per-instance. Confirm the user exists on that instance and
has been granted rights on the database — creating a database does not grant
access to it automatically.

**`JWT_SECRET must be set in production`**
Intentional. A missing secret previously fell back to a hardcoded value, which
would have signed production tokens with a public key.

**`Migration … has changed since it was applied`**
A migration file was edited after running. Restore it and add a new migration
instead — the runner compares checksums deliberately.

**`extension "btree_gist" is not available`**
Required by the leave-overlap constraint. On Cloud SQL it is available by
default; a superuser may need to run `CREATE EXTENSION btree_gist;` once.

**`remaining connection slots are reserved`**
The pool is too large for the instance tier. Lower `PG_POOL_MAX`, or raise
`max_connections` on the instance.

**Two-factor codes never arrive**
Check `GET /readyz` for `"email": "configured"`. Without SMTP, codes cannot be
sent and two-factor stays off for new accounts.

**Payments cannot be recorded**
The run needs HR approval first. This gate is deliberate.

---

## Licence

ISC
