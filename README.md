# EduPay — School Payroll System

Payroll and workforce management for schools, built on Node.js, Express and
**Firebase (Cloud Firestore)**, with a dependency-free front end.

Four roles, with duties deliberately separated: an accountant processes payroll,
HR approves it, and only then can payments be recorded.

---

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running locally](#running-locally)
- [Firestore data model](#firestore-data-model)
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
    │  Firebase Admin SDK (service account)
    ▼
Cloud Firestore
```

Why the API sits in the middle rather than the browser talking to Firestore
directly: payroll authorisation depends on workflow state — who processed a run,
whether HR approved it, whether an advance would push net pay below its floor.
Firestore security rules cannot express that, so the published rules deny all
direct client access and every write goes through the API.

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| API | Express 4 |
| Database | Cloud Firestore (`firebase-admin`) |
| Authentication | JWT + bcrypt, with token revocation |
| Two-factor | Emailed one-time codes, or TOTP via `otplib` |
| Email | Nodemailer |
| Documents | PDFKit (payslips, reports), ExcelJS (spreadsheets) |
| Front end | Vanilla HTML/CSS/JS, no build step |
| Analytics | Firebase Analytics (login page only, opt-out aware) |

---

## Prerequisites

- Node.js 20 or newer
- A Firebase project with **Cloud Firestore enabled** (Firebase console →
  Firestore Database → Create database → production mode)
- A **service account key** for that project
- An SMTP account (optional but strongly recommended — see
  [Without email](#without-email))

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Get a service account key

The web config you see in the Firebase console (`apiKey`, `authDomain`, …) is a
**browser** artefact and cannot authenticate a server. The server needs a
service account:

> Firebase console → ⚙ Project settings → **Service accounts** →
> **Generate new private key**

Keep the downloaded JSON out of version control — `.gitignore` already covers
the usual filenames.

### 3. Configure the environment

```bash
cp .env.example .env
```

Fill in at least:

| Variable | Notes |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The service-account JSON, inline on one line |
| or `GOOGLE_APPLICATION_CREDENTIALS` | A path to the JSON file — easiest locally |
| `JWT_SECRET` | 32+ characters. `openssl rand -base64 48` |
| `SMTP_*` | For setup links, password resets and two-factor codes |

On Google Cloud (Cloud Run, App Engine, GCE) credentials are detected
automatically and no key file is needed.

### 4. Seed the database

```bash
npm run db:seed
```

This is idempotent. It creates the default salary scales, the default settings,
and one administrator — printing a generated password **once**:

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

### 5. Deploy the Firestore rules and indexes

```bash
npx firebase deploy --only firestore:rules,firestore:indexes
```

The composite indexes are required: without them, several dashboard queries
fail with `FAILED_PRECONDITION`.

---

## Running locally

```bash
npm start          # production mode
npm run dev        # with --watch, restarts on change
```

Then open <http://localhost:3000>.

Health endpoints:

- `GET /healthz` — liveness, no dependencies touched
- `GET /readyz` — readiness; reports Firestore connectivity and whether email is
  configured. Point your platform's health check here.

### Against the Firestore emulator

```bash
npx firebase emulators:start --only firestore
FIRESTORE_EMULATOR_HOST=localhost:8080 npm run db:seed
FIRESTORE_EMULATOR_HOST=localhost:8080 npm start
```

---

## Firestore data model

Firestore has no joins or unique constraints, so several collections use a
**natural document id** — which makes uniqueness a property of the database
rather than an application check that can race.

| Collection | Document id | Purpose |
|---|---|---|
| `users` | auto | Login accounts: credentials, role, two-factor state |
| `usernames` | the username | Reservation index; makes usernames unique |
| `teachers` | auto | Employment record, salary scale, payment destination |
| `accountants` | auto | Accountant profile |
| `salaryStructures` | the scale name | One structure per scale, enforced |
| `payroll` | `YYYY-MM` | One run per period, enforced |
| `payroll/{id}/versions` | version number | Archived superseded runs |
| `payrollItems` | auto | One line per employee per run version |
| `leaveRequests` | auto | Leave, with day count and paid/unpaid flag |
| `advanceRequests` | auto | Advances, with instalment schedule |
| `notifications` | auto | Per-user inbox, for every role |
| `auditLog` | auto | Privileged actions |
| `systemConfig` | the setting key | One document per setting |
| `counters` | counter name | Transactional sequences for employee ids |
| `passwordResets` | token hash | Single-use reset tokens |

### Payroll versioning

Reprocessing a period does not delete anything. The previous run is copied into
`payroll/{id}/versions/{n}` with its lines, its advance repayments are reversed,
its lines are flagged `superseded: true`, and a new version is written. Payroll
figures someone has already seen remain auditable.

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
approve a run they processed themselves. That is the control that stops one
person from both creating and releasing a payment run.

---

## Payroll calculation

### PAYE

Uganda's URA monthly schedule for resident individuals, applied to **gross**
pay:

| Monthly chargeable income (UGX) | Tax |
|---|---|
| 0 – 235,000 | Nil |
| 235,001 – 335,000 | 10% of the excess over 235,000 |
| 335,001 – 410,000 | 10,000 + 20% of the excess over 335,000 |
| 410,001 – 10,000,000 | 25,000 + 30% of the excess over 410,000 |
| Above 10,000,000 | as above, plus 10% of the excess over 10,000,000 |

The bands live in `systemConfig/taxBands` and can be edited without a code
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

Net pay can never be negative, and an advance can never consume a whole salary.

---

## Security model

| Area | Approach |
|---|---|
| Passwords | bcrypt, cost 12. 10+ characters, three character classes, common passwords rejected |
| Account creation | An emailed single-use setup link, so no password is ever known to anyone else. Without email, a unique random temporary password shown once |
| Two-factor | Codes are **hashed** and emailed to the account owner. No one, including administrators, can read another user's code |
| Sessions | 2-hour JWTs carrying a `tokenVersion`. A password change, reset, deactivation or sign-out revokes every existing token |
| Rate limiting | 20 sign-in attempts per IP per 15 min; 5 email-sending requests per hour; 300 API requests per minute |
| Brute force | The MFA attempt counter is **not** reset by requesting a new code |
| Output escaping | All dynamic text passes through an auto-escaping template tag; the trust marker is a class instance, so a JSON payload cannot forge it |
| Headers | Helmet, with a content security policy that needs no inline-script allowance |
| CORS | Restricted to `ALLOWED_ORIGINS`; not open to all origins |
| Deletion | Refused for anyone with payroll history; deactivation preserves the record |
| Audit | Every privileged action, with actor, IP and detail |
| Firestore rules | Deny-all, since all access is server-side |

### Without email

The system runs without SMTP, but:

- new accounts get a one-time temporary password instead of a setup link
- two-factor authentication stays **off**, because a code could not be delivered
- self-service password reset does nothing

The administrator dashboard shows this under **Dashboard → System health**.

---

## Deployment

Any Node host works. The container listens on `PORT`.

**Google Cloud Run** is the natural fit, since credentials are then automatic:

```bash
gcloud run deploy edupay \
  --source . \
  --region europe-west1 \
  --set-env-vars NODE_ENV=production,FIREBASE_PROJECT_ID=edupay-ug \
  --set-secrets JWT_SECRET=edupay-jwt-secret:latest
```

Elsewhere, set `FIREBASE_SERVICE_ACCOUNT` (or the base64 variant) plus the
variables in `.env.example`, and point the health check at `/readyz`.

Checklist before going live:

- [ ] `NODE_ENV=production`
- [ ] `JWT_SECRET` set, 32+ characters (startup refuses otherwise)
- [ ] `BASE_URL` set, so email links are correct
- [ ] `ALLOWED_ORIGINS` set if the front end is on another origin
- [ ] Firestore rules and indexes deployed
- [ ] SMTP configured and a test email sent
- [ ] The seeded administrator password changed
- [ ] A second administrator created, so you cannot be locked out

---

## Tests

```bash
npm test
```

76 tests covering the PAYE bands, the payroll calculator (including the net-pay
floor and unpaid-leave abatement), leave validation, advance instalments, input
validation, output escaping against real XSS payloads, and HTTP-level checks of
the security headers, authentication gate and error handling. No Firebase
credentials are needed.

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
`/mfa`; `/config`, `/audit-log` (cursor-paginated), `/mfa-status`, `/backup`,
`/stats`, `/reports/payroll-summary`.

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

**`Could not reach Firestore` on startup**
No credentials, or Firestore is not enabled. Check that one of
`FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_SERVICE_ACCOUNT_BASE64` or
`GOOGLE_APPLICATION_CREDENTIALS` is set, that the database exists in the
console, and that the service account holds **Cloud Datastore User**.

**`JWT_SECRET must be set in production`**
Intentional. A missing secret previously fell back to a hardcoded value, which
would have signed production tokens with a public key.

**`FAILED_PRECONDITION: The query requires an index`**
Deploy the indexes: `npx firebase deploy --only firestore:indexes`. The error
message also contains a direct link that creates the one index it needs.

**Two-factor codes never arrive**
Check `GET /readyz` for `"email": "configured"`. Without SMTP, codes cannot be
sent and two-factor stays off for new accounts.

**`There is no salary scale called "…"`**
A teacher references a deleted scale. Recreate it, or move the teacher to an
existing scale. Payroll refuses to run rather than silently paying zero.

**Payments cannot be recorded**
The run needs HR approval first. This gate is deliberate.

---

## Licence

ISC
