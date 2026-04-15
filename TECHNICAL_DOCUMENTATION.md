# EduPay System - Technical Documentation

Version: 2.0 (implementation-aligned)
Last updated: 2026-04-15
Runtime: Node.js + Express + PostgreSQL

## 1. Executive Summary

EduPay is a monolithic school payroll and staff management platform with role-based access for:

- `admin`
- `hr`
- `accountant`
- `teacher`

The application serves a static multi-page frontend from the same Express process that provides REST APIs.

Primary capabilities:

- Authentication with JWT and MFA challenge flow
- User lifecycle management for all roles
- Teacher payroll processing and approval workflow
- Leave and salary advance request workflow
- PDF/Excel report generation
- In-app notifications and audit logging

## 2. Current Architecture

```text
Browser (public/*.html + public/js/*.js)
  -> /api/* (JSON over HTTP)
Express server (server/server.js)
  -> Middleware (JWT + RBAC + audit helper)
  -> Route modules (auth, admin, hr, accountant, teacher)
  -> PostgreSQL via pg Pool (server/database.js)
```

Routing and page entry points:

- `/` -> `public/index.html`
- `/admin` -> `public/admin.html`
- `/hr` -> `public/hr.html`
- `/accountant` -> `public/accountant.html`
- `/teacher-portal` -> `public/teacher.html`

API namespaces:

- `/api/auth`
- `/api/admin`
- `/api/hr`
- `/api/accountant`
- `/api/teacher`

## 3. Technology Stack

Runtime and server:

- Node.js `>=20.0.0`
- Express `^4.18.2`
- CORS `^2.8.5`
- dotenv `^16.6.1`

Data layer:

- PostgreSQL (DigitalOcean managed in production)
- pg `^8.19.0`

Security and auth:

- jsonwebtoken `^9.0.2`
- bcryptjs `^2.4.3`
- otplib `^12.0.1`

Document exports:

- pdfkit `^0.13.0`
- exceljs `^4.4.0`

Email integration:

- nodemailer `^6.10.1`

Frontend:

- Plain HTML/CSS/JavaScript (no framework, no bundler)

## 4. Repository Structure

```text
.
|- .do/app.yaml                     # DigitalOcean App Platform spec
|- .env / .env.example              # Environment settings
|- data/                            # Local data artifacts (if any)
|- public/
|  |- index.html                    # Login + MFA UI
|  |- admin.html                    # Admin dashboard
|  |- hr.html                       # HR dashboard
|  |- accountant.html               # Accountant dashboard
|  |- teacher.html                  # Teacher portal
|  |- css/styles.css                # Shared styles
|  |- js/app.js                     # Shared client helpers
|  |- js/admin.js                   # Admin client logic
|  |- js/hr.js                      # HR client logic
|  |- js/accountant.js              # Accountant client logic
|  `- js/teacher.js                 # Teacher client logic
|- server/
|  |- server.js                     # App bootstrap and route mounting
|  |- database.js                   # DB connection, schema creation, seeding, migrations
|  |- middleware.js                 # JWT auth, role guards, audit helper
|  |- services/email.js             # SMTP email sending helpers
|  `- routes/
|     |- auth.js
|     |- admin.js
|     |- hr.js
|     |- accountant.js
|     `- teacher.js
|- README.md
`- TECHNICAL_DOCUMENTATION.md
```

## 5. Configuration and Environment Variables

Required or commonly used variables (from code and `.env.example`):

- `DATABASE_URL`
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` (fallback if `DATABASE_URL` is absent)
- `JWT_SECRET`
- `PORT`
- `BASE_URL` (used when generating password setup links)
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`
- `MFA_TOKEN_TTL_MINUTES` (default: `10`)
- `MFA_MAX_ATTEMPTS` (default: `5`)

## 6. Authentication, MFA, and Authorization

### 6.1 JWT

- Access tokens include: `id`, `username`, `role`, `full_name`
- Access token TTL: `8h`
- Header format: `Authorization: Bearer <token>`

### 6.2 Login Flow

`POST /api/auth/login` behavior:

1. Validates username/password.
2. Rejects inactive accounts.
3. For teachers with incomplete initial password setup, blocks login.
4. If MFA disabled for user, returns JWT directly.
5. If MFA enabled, returns MFA challenge payload.

### 6.3 MFA Flow

Challenge endpoints:

- `POST /api/auth/verify-mfa`
- `POST /api/auth/resend-mfa`

Stored challenge state (users table):

- `mfa_pending_token_hash`
- `mfa_pending_code_hash`
- `mfa_pending_expires_at`
- `mfa_pending_attempts`

Method selection rules:

- Uses authenticator app only when `mfa_method='authenticator'` and `mfa_secret` exists.
- Otherwise uses email OTP flow.

Important implementation detail:

- Email-based MFA OTPs are inserted into `admin_mfa_codes` for retrieval in admin MFA portal.

### 6.4 RBAC Matrix

- `/api/auth/*`: public or token-required depending on route
- `/api/admin/*`: `admin`
- `/api/hr/*`: `hr`, `admin`
- `/api/accountant/*`: `accountant`, `admin`
- `/api/teacher/*`: `teacher`

## 7. Data Model (PostgreSQL)

Schema is created and incrementally migrated by `initDatabase()` in `server/database.js`.

### 7.1 Core Tables

- `users`
  - Auth principal for all roles
  - Includes MFA, account status, first-time password setup state
  - Role constraint supports: `admin`, `accountant`, `teacher`, `hr`

- `teachers`
  - Teacher employment and payment profile
  - Includes payroll halt state (`payroll_halted`, reason, actor, timestamp)
  - Includes payment method fields for bank/mobile money

- `accountants`
  - Accountant profile linked to `users`

- `salary_structures`
  - Salary scale keyed by `salary_scale`
  - Stores allowances and deductions percentages/amounts

- `payroll`
  - Payroll run header per month/year
  - Status lifecycle: `draft`, `processed`, `approved`, `paid`

- `payroll_items`
  - Per-teacher payroll computation snapshot
  - Includes `advance_deduction`
  - Payment status: `Paid` or `Pending`

### 7.2 Workflow and Support Tables

- `leave_requests`
  - Status: `Pending`, `Approved`, `Rejected`

- `advance_requests`
  - Status: `Pending`, `Approved`, `Rejected`, `Deducted`
  - Tracks `approved_by`, `approved_at`, `deducted_payroll_id`, `deducted_at`

- `notifications`
  - In-app notifications per user

- `audit_log`
  - System action trail

- `system_config`
  - Runtime key-value config (school name, currency, etc.)

- `admin_mfa_codes`
  - Temporary OTP visibility for admin MFA portal

### 7.3 Seeded Defaults

- Default admin user:
  - username: `admin`
  - password: `admin123`
  - role: `admin`
  - MFA disabled for backward compatibility

- Salary scales `Scale_1` to `Scale_5`
- System config keys:
  - `payroll_period`
  - `currency`
  - `school_name`
  - `tax_enabled`
  - `nssf_percentage`

## 8. Payroll and Financial Logic

### 8.1 Payroll Calculation Formula

For each eligible teacher:

- `gross = basic + housing + transport + medical + other_allowance`
- `tax_amount = basic * tax_percentage / 100`
- `nssf_amount = basic * nssf_percentage / 100`
- `advance_deduction = sum(approved, not-yet-deducted advances)`
- `total_deductions = tax + nssf + loan + advance + other_deduction`
- `net = gross - total_deductions`

### 8.2 Eligibility

Teacher is included in processing when:

- `teachers.is_active = 1`
- `teachers.payroll_halted != 1`

### 8.3 Reprocessing Rule

When processing payroll for a month/year that already has a non-final run:

- Existing deducted advances for that run are reverted to `Approved`
- Existing payroll items are deleted
- Existing payroll header is deleted
- New processed payroll is generated

Finalized payroll (`approved` or `paid`) cannot be reprocessed.

### 8.4 Status Transitions

Payroll:

- `processed` (accountant)
- `approved` (hr only)
- `paid` (when all payroll_items are marked `Paid`)

Advance request:

- `Pending` -> `Approved` or `Rejected`
- `Approved` -> `Deducted` when payroll consumes advance

## 9. API Reference

All responses are JSON except file download endpoints.
Errors return at least `{ "error": "..." }`.

### 9.1 Auth API (`/api/auth`)

- `POST /login`
- `POST /verify-mfa`
- `POST /resend-mfa`
- `POST /setup-password/validate`
- `POST /setup-password/complete`
- `POST /change-password` (token required)

### 9.2 Admin API (`/api/admin`)

User management:

- `GET /users`
- `POST /users`
- `PUT /users/:id`
- `DELETE /users/:id`
- `POST /users/:id/reset-password`
- `POST /users/:id/toggle-status`

HR management:

- `GET /hr`
- `POST /hr`
- `PUT /hr/:id`
- `DELETE /hr/:id`

Accountant management:

- `GET /accountants`
- `POST /accountants`
- `PUT /accountants/:id`
- `DELETE /accountants/:id`

Admin management:

- `GET /admins`
- `POST /admins`
- `PUT /admins/:id`
- `DELETE /admins/:id`

System and visibility:

- `GET /config`
- `PUT /config`
- `GET /audit-log`
- `GET /reports/payroll-summary`
- `GET /backup`
- `GET /stats`
- `GET /mfa-codes`

### 9.3 HR API (`/api/hr`)

Teacher lifecycle:

- `GET /teachers`
- `POST /teachers`
- `PUT /teachers/:id`
- `DELETE /teachers/:id`

Salary structures:

- `GET /salary-structures`
- `POST /salary-structures`
- `DELETE /salary-structures/:id`

Leave and advances:

- `GET /leave`
- `PUT /leave/:id/status`
- `GET /advances`
- `PUT /advances/:id/status`

Payroll approval and reporting:

- `POST /payroll/:id/approve`
- `GET /reports/payroll-summary`
- `GET /stats`

### 9.4 Accountant API (`/api/accountant`)

Teacher payroll controls:

- `GET /teachers`
- `PUT /teachers/:id/payroll-halt`

Payroll processing:

- `GET /payroll`
- `POST /payroll/process`
- `GET /payroll/:id/items`
- `PUT /payroll-items/:id/payment-status`

Reports and exports:

- `GET /reports/monthly`
- `GET /reports/export/excel/:payrollId`
- `GET /reports/export/pdf/:payrollId`

Payslip and stats:

- `GET /payslip/:payrollItemId/pdf`
- `GET /stats`

### 9.5 Teacher API (`/api/teacher`)

Profile and salary visibility:

- `GET /profile`
- `PUT /profile`
- `GET /payslips`
- `GET /payslip/:id/pdf`
- `GET /salary-history`

Notifications:

- `GET /notifications`
- `PUT /notifications/:id/read`
- `PUT /notifications/read-all`

Leave and advances:

- `GET /leave`
- `POST /leave`
- `GET /advances`
- `POST /advances`

## 10. Frontend Implementation

### 10.1 Shared Client Module (`public/js/app.js`)

Responsibilities:

- token/user storage in `localStorage`
  - `edupay_token`
  - `edupay_user`
- `apiRequest()` wrapper with auth header injection
- download handling for PDF/XLSX responses
- common UI helpers (toast, modal, section switching)
- session timeout handling (default inactivity timeout: 15 minutes)

### 10.2 Page Modules

- `index.html`
  - login and MFA challenge UI
  - redirects by role

- `admin.js`
  - manages users, admins, HR, accountants
  - configuration, backup, audit logs, MFA portal

- `hr.js`
  - teacher management
  - salary structure management
  - leave and advance approval
  - payroll approval

- `accountant.js`
  - payroll processing and reprocessing
  - payroll halt/resume for teachers
  - payment status updates
  - report export

- `teacher.js`
  - profile updates including payment destination
  - payslip/history access
  - leave and advance submissions
  - notifications

## 11. Notifications and Audit

Notifications are created automatically for key lifecycle events, including:

- advance approved/rejected
- payroll approved by HR
- salary payment marked paid

Audit log events are written via `logAudit()` across role routes for actions such as:

- login
- user creation/updates/deletion
- payroll processing/approval
- request approvals

## 12. Reporting and Export Outputs

Accountant exports:

- Payroll PDF (landscape summary table)
- Payroll Excel workbook (detail rows and totals)
- Individual payslip PDF

Teacher export:

- Personal payslip PDF (restricted to own records)

Admin backup export:

- JSON snapshot containing selected tables

## 13. Deployment Notes (DigitalOcean App Platform)

Defined in `.do/app.yaml`:

- Service name: `edupay-system`
- Runtime: `node-js`
- Build command: `npm install --production`
- Run command: `npm start`
- Health check path: `/`
- Managed PostgreSQL database (engine `PG`, version `16`)

Operational notes:

- App reads DB credentials from `DATABASE_URL` or PG fallback vars
- `PORT` is environment-driven
- For managed Postgres with SSL mode in URL, code strips conflicting URL `sslmode` query params and applies pg SSL config programmatically

## 14. Security Design Notes

Implemented controls:

- bcrypt password hashing
- JWT-based API protection
- Role-based route guards
- MFA challenge flow with expiration and attempt limits
- account activation/deactivation controls
- audit trail for sensitive actions

Current risks and hardening opportunities:

- Default JWT fallback secret exists in code; production must always set strong `JWT_SECRET`
- No documented refresh token strategy (single access token model)
- No explicit rate-limiting middleware on auth endpoints
- MFA OTP currently exposed to admins via portal by design; ensure strict admin access controls and monitoring

## 15. Operational Runbook

Local start:

```bash
npm install
npm start
```

Server startup does:

1. Initialize DB connection
2. Create/migrate tables
3. Seed defaults
4. Start Express listener

Primary troubleshooting checks:

- Verify DB env vars are present in startup logs
- Confirm SMTP vars when password setup/MFA email features are expected
- Check `audit_log` and server console for failed route operations

## 16. Known Gaps and Consistency Notes

- `README.md` currently references SQLite/sql.js, while actual implementation is PostgreSQL (`pg` and `server/database.js`).
- Password setup APIs expect a setup page (`/setup-password.html`) link, but that page is not present in current `public/` directory.
- `sendMfaOtpEmail()` exists in `server/services/email.js`, but current MFA implementation routes OTP visibility through admin MFA portal (`admin_mfa_codes`) rather than direct email sending.

## 17. Data and Business Rules Summary

- Teacher usernames and accountant usernames may be auto-generated and deduplicated.
- Teacher and accountant deletions are designed to cascade to linked user account removal through route logic.
- User deletion route explicitly clears dependent references (notifications, payroll approver links, advance approver links, audit links) before deletion.
- Only HR can approve a processed payroll (`POST /api/hr/payroll/:id/approve`).
- Payroll is automatically marked `paid` when all payroll items in a payroll run are marked `Paid`.

## 18. Suggested Next Documentation Improvements

- Add sequence diagrams for login/MFA and payroll lifecycle.
- Add OpenAPI spec (YAML/JSON) generated from current routes.
- Add explicit examples for each endpoint request/response body and status codes.
- Add runbooks for database restore and disaster recovery.

**Response includes:** `employee_id`, `username`, `default_password`

---

#### Accountant Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/accountants` | List all accountants |
| POST | `/accountants` | Add accountant (default password: `accountant123`) |
| PUT | `/accountants/:id` | Update accountant |
| DELETE | `/accountants/:id` | Delete accountant and linked user |

---

#### Admin Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/admins` | List admin users |
| POST | `/admins` | Create new admin account |
| PUT | `/admins/:id` | Update admin profile |
| DELETE | `/admins/:id` | Remove admin (cannot self-delete) |

---

#### Salary Structures

| Method | Endpoint | Description |
|---|---|---|
| GET | `/salary-structures` | List all scales ordered by name |
| POST | `/salary-structures` | Create or update a scale (upsert on `salary_scale`) |
| DELETE | `/salary-structures/:id` | Delete a scale |

---

#### System Configuration

| Method | Endpoint | Description |
|---|---|---|
| GET | `/config` | Returns all config as a key-value object |
| PUT | `/config` | Upsert any number of keys; body is `{ key: value, ... }` |

---

#### Other Admin Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/stats` | Dashboard counters (users, teachers, payrolls) |
| GET | `/audit-log` | Last 200 audit log entries |
| GET | `/reports/payroll-summary` | All payroll runs with teacher count |
| GET | `/backup` | Download full JSON backup of all data |

---

### 7.3 Accountant Routes

Base path: `/api/accountant`  
🔒 Requires role `accountant` or `admin`.

#### Teacher Records

| Method | Endpoint | Description |
|---|---|---|
| GET | `/teachers` | Active teachers with salary structure joined |

---

#### Payroll

| Method | Endpoint | Description |
|---|---|---|
| GET | `/payroll` | All payroll runs with teacher count and processor names |
| POST | `/payroll/process` | Process payroll for a month/year (see §8) |
| GET | `/payroll/:id/items` | All payroll line items for a run |
| POST | `/payroll/:id/approve` | Approve payroll; fires notifications to teachers |
| PUT | `/payroll-items/:id/payment-status` | Mark individual item `Paid` or `Pending` |

**POST /payroll/process request body:**
```json
{ "month": 3, "year": 2026 }
```

---

#### Reports & Exports

| Method | Endpoint | Description |
|---|---|---|
| GET | `/reports/monthly?month=3&year=2026` | Filter payrolls by period |
| GET | `/reports/export/excel/:payrollId` | Download `.xlsx` payroll report |
| GET | `/reports/export/pdf/:payrollId` | Download A4 landscape PDF payroll report |
| GET | `/payslip/:payrollItemId/pdf` | Download individual teacher payslip PDF |

---

#### Stats

| Method | Endpoint | Description |
|---|---|---|
| GET | `/stats` | Teacher count, pending payrolls, total paid amount |

---

### 7.4 Teacher Routes

Base path: `/api/teacher`  
🔒 Requires role `teacher`.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/profile` | Own profile with salary structure breakdown |
| PUT | `/profile` | Update own phone and email |
| GET | `/payslips` | All approved/paid payslips for the logged-in teacher |
| GET | `/payslip/:id/pdf` | Download own payslip PDF (ownership-enforced) |
| GET | `/notifications` | Unread notifications |
| POST | `/notifications/:id/read` | Mark a notification as read |

---

## 8. Payroll Processing Logic

Triggered by `POST /api/accountant/payroll/process`. The operation runs inside a **PostgreSQL transaction**; it rolls back entirely if any step fails.

### Steps

1. **Validation** — Confirms `month` and `year` are provided. Checks if a payroll already exists for that period; if it does and is `approved` or `paid`, processing is blocked.
2. **Load teachers** — Fetches all teachers where `is_active = 1`, joined with their salary structure.
3. **Begin transaction**
4. **Remove existing draft** — If a `draft`/`processed` payroll exists for that period, it and its items are deleted before recreating (allows re-processing corrections).
5. **Create payroll header** — Inserts a new `payroll` record with `status = 'processed'`.
6. **Calculate per-teacher** — For each teacher:
   ```
   gross = basic + housing + transport + medical + other_allowance
   tax   = basic × (tax_percentage / 100)
   nssf  = basic × (nssf_percentage / 100)
   total_deductions = tax + nssf + loan_deduction + other_deduction
   net   = gross - total_deductions
   ```
   Values are **snapshots** — changes to salary structures after processing do not affect this run.
7. **Insert payroll items** — One `payroll_items` row per teacher.
8. **Update totals** — Sets `total_gross`, `total_deductions`, `total_net` on the payroll header.
9. **Commit transaction**
10. **Audit log** — Records the action with teacher count.

### Approval Flow

```
processed  →  approved  →  paid (auto when all items marked Paid)
```

- `POST /payroll/:id/approve` sets status to `approved` and fires a notification to each teacher's account.
- Marking individual items `Paid` via `PUT /payroll-items/:id/payment-status` triggers an auto-check: if all items in the payroll are `Paid`, the payroll header is automatically set to `paid`.

---

## 9. Salary Structures & Calculations

### Default Scales (seeded on first boot)

| Scale | Basic (UGX) | Housing | Transport | Medical | Tax % | NSSF % |
|---|---|---|---|---|---|---|
| Scale_1 | 800,000 | 100,000 | 50,000 | 30,000 | 10 | 5 |
| Scale_2 | 1,200,000 | 150,000 | 80,000 | 50,000 | 15 | 5 |
| Scale_3 | 1,800,000 | 200,000 | 100,000 | 80,000 | 20 | 5 |
| Scale_4 | 2,500,000 | 300,000 | 150,000 | 100,000 | 25 | 5 |
| Scale_5 | 3,500,000 | 400,000 | 200,000 | 150,000 | 30 | 5 |

Tax and NSSF are always computed on **basic salary only**, not gross salary.

---

## 10. Report Generation

### Excel (`.xlsx`) — `GET /api/accountant/reports/export/excel/:payrollId`
Generated using **ExcelJS**:
- Row 1: Merged title with period and status
- Row 3: Header row styled with the brand red (`#DC2626`) background and white bold text
- Data rows: Employee ID, Name, Scale, all earnings columns, all deduction columns, Net Salary, Payment Status
- Column width auto-set to 15 units

### PDF Payroll Report — `GET /api/accountant/reports/export/pdf/:payrollId`
Generated using **PDFKit** in A4 landscape:
- Title and summary centred in brand red
- Table with alternating row colours (`#F9F9F9` / `#FFFFFF`)
- Auto page-break at y > 550

### PDF Payslip — `GET /api/accountant/payslip/:payrollItemId/pdf` and `GET /api/teacher/payslip/:id/pdf`
Generated using **PDFKit** in A4 portrait:
- Red header bar with school name (from `system_config`)
- Employee details block
- Earnings section (Basic, Housing, Transport, Medical, Other)
- Gross Salary subtotal
- Deductions section (PAYE, NSSF, Loan, Other)
- Net Salary highlighted box with currency from `system_config`
- Footer: "This is a computer-generated payslip. No signature required."

---

## 11. Notification System

Notifications are stored in the `notifications` table and displayed in the frontend.

**Events that generate notifications:**

| Trigger | Recipient | Message |
|---|---|---|
| Payroll approved (`POST /payroll/:id/approve`) | Each teacher in the run | "Your salary for MM/YYYY has been processed. Net amount: X" |
| Payment marked Paid (`PUT /payroll-items/:id/payment-status`) | The affected teacher | "Your salary payment has been marked as Paid." |

Notifications are inserted fire-and-forget (errors are logged but don't fail the main request).

---

## 12. Audit Logging

Every significant action calls `logAudit(db, userId, username, action, details, ip)` which inserts a row into `audit_log`. The insert is non-blocking (errors are caught and logged to console, not propagated).

**Logged actions:**

| Action | Triggered by |
|---|---|
| `LOGIN` | Successful login |
| `CHANGE_PASSWORD` | Password change |
| `CREATE_USER` / `UPDATE_USER` / `DELETE_USER` | User management |
| `RESET_PASSWORD` / `TOGGLE_USER_STATUS` | Account management |
| `CREATE_TEACHER` / `UPDATE_TEACHER` / `DELETE_TEACHER` | Teacher management |
| `CREATE_ACCOUNTANT` / `UPDATE_ACCOUNTANT` / `DELETE_ACCOUNTANT` | Accountant management |
| `CREATE_ADMIN` / `UPDATE_ADMIN` / `DELETE_ADMIN` | Admin management |
| `PROCESS_PAYROLL` / `APPROVE_PAYROLL` | Payroll workflow |
| `UPDATE_PAYMENT_STATUS` | Payment marking |
| `UPDATE_SALARY_STRUCTURE` | Scale edits |
| `UPDATE_CONFIG` | System config changes |
| `BACKUP` | Data export download |

Admins can view the last 200 entries via `GET /api/admin/audit-log`.

---

## 13. Frontend Pages

All pages are single-file HTML and communicate with the backend exclusively via `fetch()` calls to the REST API. Authentication tokens are stored in `localStorage`.

### `public/index.html` — Login Page
- Single login form; submits to `POST /api/auth/login`.
- On success, reads `role` from the JWT response and redirects:
  - `admin` → `/admin`
  - `accountant` → `/accountant`
  - `teacher` → `/teacher-portal`
- If `must_change_password === 1`, shows a password-change modal before redirect.

### `public/admin.html` — Admin Dashboard
Tabs / sections:
- **Dashboard** — Stats cards (total users, teachers, payrolls, recent payroll)
- **Users** — CRUD table for all users; toggle active status; reset password
- **Teachers** — CRUD table; salary scale assignment
- **Accountants** — CRUD table
- **Admins** — CRUD table (cannot delete self)
- **Salary Structures** — Edit pay scale components
- **System Config** — School name, currency, NSSF%, tax toggle
- **Audit Log** — Read-only table of last 200 actions
- **Backup** — Download full JSON export

### `public/accountant.html` — Accountant Dashboard
Sections:
- **Dashboard** — Stats (active teachers, pending payrolls, total disbursed)
- **Payroll** — Process new payroll; list of all runs; approve; view items; mark payments
- **Reports** — Filter by month/year; export Excel and PDF
- **Payslips** — Per-teacher payslip PDF generation
- **Teachers** — Read-only view with salary breakdown

### `public/teacher.html` — Teacher Portal
Sections:
- **Dashboard** — Salary summary card
- **My Profile** — View and update contact details
- **My Payslips** — List of approved payslips with PDF download
- **Notifications** — Unread salary notifications

### `public/js/app.js` — Shared Utilities
- `getToken()` / `getUser()` — reads from `localStorage`
- `authFetch(url, options)` — wraps `fetch` with `Authorization` header; auto-redirects to login on 401/403
- `showNotification(message, type)` — toast messages
- `formatCurrency(amount)` — UGX formatting with locale separators

### `public/css/styles.css` — Global Stylesheet
CSS custom properties (variables):

```css
--primary:       #DC2626   /* brand red */
--primary-dark:  #B91C1C
--primary-light: #FEE2E2
--dark:          #111111
--dark-2:        #1A1A1A
--dark-3:        #2D2D2D
--white:         #FFFFFF
```

---

## 14. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Full PostgreSQL connection URI: `postgresql://user:pass@host:port/db?sslmode=require` |
| `JWT_SECRET` | ✅ | Random secret for signing JWTs. Minimum 32 characters recommended. |
| `PORT` | Auto | HTTP port. DigitalOcean injects this automatically (defaults to `3000` locally). |
| `NODE_ENV` | Optional | Set to `production` on deployment. |

For local development, copy `.env.example` to `.env` and fill in values. The `.env` file is git-ignored.

---

## 15. Deployment — DigitalOcean App Platform

### App Spec (`.do/app.yaml`)

```yaml
name: edupay-system
region: nyc

services:
  - name: web
    github:
      repo: balirwaalvin/EduPay-System
      branch: main
      deploy_on_push: true
    build_command: npm install --production
    run_command: npm start
    environment_slug: node-js
    instance_count: 1
    instance_size_slug: apps-s-1vcpu-0.5gb
    http_port: 8080
    envs:
      - key: NODE_ENV
        value: "production"
        scope: RUN_TIME
      - key: JWT_SECRET
        scope: RUN_TIME
        type: SECRET
    health_check:
      http_path: /

databases:
  - name: edupay-db
    engine: PG
    version: "16"
    size: db-s-1vcpu-1gb
    num_nodes: 1
```

### Environment Variables Setup

Both `DATABASE_URL` and `JWT_SECRET` must be set in the App Platform dashboard under:  
**App → Settings → Environment Variables**

`DATABASE_URL` is obtained from:  
**Databases → edupay-db → Connection Details → URI**

### Deployment Trigger

Every `git push` to `main` triggers an automatic rebuild and deploy (controlled by `deploy_on_push: true`).

### Zero-Downtime Note

DigitalOcean App Platform performs rolling deployments. The `health_check.http_path: /` must return `200 OK` before traffic is switched to the new instance.

---

## 16. Default Seed Data

Seeded automatically on first startup if not already present:

### Admin User

| Username | Password | Role | Notes |
|---|---|---|---|
| `admin` | `admin123` | admin | `must_change_password = 0` |

⚠️ **Change this password immediately after first deployment.**

### Salary Structures

Five default scales (Scale_1 through Scale_5) as described in §9.

### System Config

`payroll_period=monthly`, `currency=UGX`, `school_name=EduPay School`, `tax_enabled=true`, `nssf_percentage=5`

---

## 17. Security Considerations

| Area | Implementation |
|---|---|
| Password storage | bcrypt with cost factor 10 — not reversible |
| Authentication | JWT, 8-hour expiry, signed with HS256 |
| Role enforcement | Server-side middleware on every protected route |
| SQL injection | All queries use parameterised statements (`$1`, `$2`, …) — never string concatenation |
| HTTPS | Enforced by DigitalOcean App Platform (automatic TLS certificate) |
| Secrets | `JWT_SECRET` and `DATABASE_URL` stored as encrypted env vars in the platform, never in code |
| Sensitive data in backups | Backup endpoint excludes `password` column from `users` table |
| Self-deletion guard | Admin cannot delete or deactivate their own account |
| Payslip ownership | Teacher payslip PDF endpoint verifies the requested item belongs to the requesting teacher |
| Audit trail | All mutations are recorded in `audit_log` with user, action, and IP |

---

*Documentation generated March 2026 for EduPay System v1.0.0*
