# EduPay System — Technical Documentation

**Version:** 1.0.0  
**Stack:** Node.js · Express · PostgreSQL  
**Deployed on:** DigitalOcean App Platform  
**Repository:** https://github.com/balirwaalvin/EduPay-System

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Project Structure](#3-project-structure)
4. [Technology Stack](#4-technology-stack)
5. [Database Schema](#5-database-schema)
6. [Authentication & Authorization](#6-authentication--authorization)
7. [API Reference](#7-api-reference)
   - [Auth Routes](#71-auth-routes)
   - [Admin Routes](#72-admin-routes)
   - [Accountant Routes](#73-accountant-routes)
   - [Teacher Routes](#74-teacher-routes)
8. [Payroll Processing Logic](#8-payroll-processing-logic)
9. [Salary Structures & Calculations](#9-salary-structures--calculations)
10. [Report Generation](#10-report-generation)
11. [Notification System](#11-notification-system)
12. [Audit Logging](#12-audit-logging)
13. [Frontend Pages](#13-frontend-pages)
14. [Environment Variables](#14-environment-variables)
15. [Deployment — DigitalOcean App Platform](#15-deployment--digitalocean-app-platform)
16. [Default Seed Data](#16-default-seed-data)
17. [Security Considerations](#17-security-considerations)

---

## 1. System Overview

EduPay is a web-based school payroll management system. It provides role-based access for three types of users: **Admin**, **Accountant**, and **Teacher**.

| Role | Primary Responsibilities |
|---|---|
| Admin | Manage users, teachers, accountants, salary structures, system configuration |
| Accountant | Process & approve payroll, export reports (Excel/PDF), generate payslips |
| Teacher | View personal profile, salary breakdown, payslip history |

---

## 2. Architecture

```
Browser (HTML/CSS/JS)
        │
        │  HTTP / REST JSON
        ▼
Express.js Web Server (Node.js)
        │
        ├── Static file server  →  public/
        ├── /api/auth           →  server/routes/auth.js
        ├── /api/admin          →  server/routes/admin.js
        ├── /api/accountant     →  server/routes/accountant.js
        └── /api/teacher        →  server/routes/teacher.js
                │
                ▼
        server/middleware.js (JWT verification, role enforcement, audit logging)
                │
                ▼
        server/database.js (pg Pool, table creation, seeding)
                │
                ▼
        PostgreSQL (DigitalOcean Managed Database)
```

The system is a **monolithic Node.js application**: the same Express process serves both the static frontend files and the REST API. There is no build step — the frontend is plain HTML, CSS, and vanilla JavaScript.

---

## 3. Project Structure

```
EduPay System/
├── .do/
│   └── app.yaml              # DigitalOcean App Platform deployment spec
├── public/                   # Frontend (static files served by Express)
│   ├── index.html            # Login page
│   ├── admin.html            # Admin dashboard
│   ├── accountant.html       # Accountant dashboard
│   ├── teacher.html          # Teacher portal
│   ├── favicon.svg           # Brand favicon (red/dark EP monogram)
│   ├── css/
│   │   └── styles.css        # Global stylesheet (CSS variables, all components)
│   └── js/
│       ├── app.js            # Shared utilities (auth, API helpers, notifications)
│       ├── admin.js          # Admin dashboard logic
│       ├── accountant.js     # Accountant dashboard logic
│       └── teacher.js        # Teacher portal logic
├── server/
│   ├── server.js             # Express app entry point
│   ├── database.js           # PostgreSQL pool, table creation, seeding
│   ├── middleware.js         # JWT auth, role guard, audit log helper
│   └── routes/
│       ├── auth.js           # /api/auth — login, change-password
│       ├── admin.js          # /api/admin — users, teachers, payroll reports, config
│       ├── accountant.js     # /api/accountant — payroll, exports, payslips
│       └── teacher.js        # /api/teacher — profile, payslips
├── .env.example              # Template for local environment variables
├── .gitignore
├── package.json
└── TECHNICAL_DOCUMENTATION.md
```

---

## 4. Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | ≥ 20.0.0 |
| Web framework | Express | ^4.18.2 |
| Database | PostgreSQL | 16 (managed) |
| Database driver | pg (node-postgres) | ^8.19.0 |
| Authentication | jsonwebtoken | ^9.0.2 |
| Password hashing | bcryptjs | ^2.4.3 |
| PDF generation | pdfkit | ^0.13.0 |
| Excel generation | exceljs | ^4.4.0 |
| Environment config | dotenv | ^16.6.1 |
| CORS | cors | ^2.8.5 |
| Frontend | Vanilla HTML/CSS/JS | — |
| Hosting | DigitalOcean App Platform | — |

---

## 5. Database Schema

All tables are created automatically on first startup via `initDatabase()` in `server/database.js`.

### `users`
The single authentication table for all roles.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| username | TEXT UNIQUE | Login identifier |
| password | TEXT | bcrypt hash (cost factor 10) |
| role | TEXT | `admin`, `accountant`, or `teacher` |
| full_name | TEXT | |
| email | TEXT | Optional |
| phone | TEXT | Optional |
| is_active | INTEGER | 1 = active, 0 = deactivated |
| must_change_password | INTEGER | 1 = forces password change on first login |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### `teachers`
Profile and employment details for teacher employees.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INTEGER FK → users.id | Links to login account |
| employee_id | TEXT UNIQUE | Auto-generated: `TCH0001`, `TCH0002`, … |
| full_name | TEXT | |
| email, phone | TEXT | |
| position | TEXT | Job title |
| salary_scale | TEXT | FK to `salary_structures.salary_scale` |
| date_joined | TEXT | ISO date string |
| is_active | INTEGER | 1 = active |
| created_at / updated_at | TIMESTAMP | |

### `accountants`
Profile and employment details for accountant employees.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INTEGER FK → users.id | |
| employee_id | TEXT UNIQUE | Auto-generated: `ACC0001`, `ACC0002`, … |
| full_name | TEXT | |
| email, phone | TEXT | |
| department | TEXT | |
| date_joined | TEXT | |
| is_active | INTEGER | |

### `salary_structures`
Defines pay scales and component amounts applied during payroll processing.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| salary_scale | TEXT | `Scale_1` … `Scale_5` (unique name) |
| basic_salary | NUMERIC | Base pay in UGX |
| housing_allowance | NUMERIC | |
| transport_allowance | NUMERIC | |
| medical_allowance | NUMERIC | |
| other_allowance | NUMERIC | |
| tax_percentage | NUMERIC | PAYE tax applied to basic salary |
| nssf_percentage | NUMERIC | NSSF contribution (default 5%) |
| loan_deduction | NUMERIC | Fixed monthly loan deduction |
| other_deduction | NUMERIC | Any other fixed deduction |

### `payroll`
One record per pay period (month + year). Acts as the header for payroll runs.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| month | INTEGER | 1–12 |
| year | INTEGER | e.g. 2026 |
| status | TEXT | `draft` → `processed` → `approved` → `paid` |
| total_gross | NUMERIC | Sum of all gross salaries |
| total_deductions | NUMERIC | |
| total_net | NUMERIC | |
| processed_by | INTEGER FK → users.id | |
| approved_by | INTEGER FK → users.id | |

### `payroll_items`
One record per teacher per payroll run. Stores the computed salary breakdown.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| payroll_id | INTEGER FK → payroll.id | |
| teacher_id | INTEGER FK → teachers.id | |
| basic_salary … other_allowance | NUMERIC | Snapshot of earnings at processing time |
| gross_salary | NUMERIC | Sum of all earnings |
| tax_amount | NUMERIC | Computed from `basic_salary × tax_percentage / 100` |
| nssf_amount | NUMERIC | Computed from `basic_salary × nssf_percentage / 100` |
| loan_deduction / other_deduction | NUMERIC | Fixed deductions |
| total_deductions | NUMERIC | `tax + nssf + loan + other` |
| net_salary | NUMERIC | `gross - total_deductions` |
| payment_status | TEXT | `Pending` or `Paid` |

### `notifications`
In-app notifications delivered to individual users.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INTEGER FK → users.id | Recipient |
| title | TEXT | Short heading |
| message | TEXT | Full notification body |
| is_read | INTEGER | 0 = unread, 1 = read |
| created_at | TIMESTAMP | |

### `audit_log`
Immutable record of all significant system actions.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| user_id | INTEGER FK → users.id | Actor (nullable for system events) |
| username | TEXT | Denormalised for readability |
| action | TEXT | e.g. `LOGIN`, `PROCESS_PAYROLL`, `CREATE_USER` |
| details | TEXT | Human-readable description |
| ip_address | TEXT | Request origin IP |
| created_at | TIMESTAMP | |

### `system_config`
Key-value store for runtime configuration.

| Key | Default Value | Description |
|---|---|---|
| payroll_period | `monthly` | |
| currency | `UGX` | Displayed on payslips |
| school_name | `EduPay School` | Displayed on payslips and PDF headers |
| tax_enabled | `true` | |
| nssf_percentage | `5` | Global NSSF default |

---

## 6. Authentication & Authorization

### JWT Token Flow

1. Client sends `POST /api/auth/login` with `{ username, password }`.
2. Server verifies credentials against `users` table (bcrypt compare).
3. On success, a JWT is signed with the payload `{ id, username, role, full_name }` and an 8-hour expiry.
4. Token is returned to the client and stored in `localStorage`.
5. All subsequent API calls include the header: `Authorization: Bearer <token>`.

### Middleware

**`authenticateToken(req, res, next)`** — defined in `server/middleware.js`:
- Extracts the Bearer token from the `Authorization` header.
- Verifies it using `JWT_SECRET`.
- Attaches the decoded payload to `req.user`.
- Returns `401` if no token; `403` if invalid or expired.

**`authorizeRoles(...roles)`** — role guard factory:
- Returns a middleware that checks `req.user.role` against the allowed roles array.
- Returns `403` if the role is not permitted.

### Route Protection Summary

| Route prefix | Roles allowed |
|---|---|
| `/api/auth/*` | Public (no token required) |
| `/api/admin/*` | `admin` only |
| `/api/accountant/*` | `accountant`, `admin` |
| `/api/teacher/*` | `teacher` only |

---

## 7. API Reference

All API endpoints return JSON. Error responses always include `{ "error": "message" }`.

### 7.1 Auth Routes

Base path: `/api/auth`

#### `POST /api/auth/login`
Authenticate a user and receive a JWT.

**Request body:**
```json
{ "username": "admin", "password": "admin123" }
```

**Response `200`:**
```json
{
  "token": "<jwt>",
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin",
    "full_name": "System Administrator",
    "email": "admin@edupay.com",
    "must_change_password": 0
  }
}
```

**Error codes:** `400` missing fields · `401` wrong credentials · `403` account deactivated

---

#### `POST /api/auth/change-password`
🔒 Requires valid JWT (any role).

**Request body:**
```json
{ "current_password": "old", "new_password": "newpass123" }
```

**Response `200`:** `{ "message": "Password changed successfully." }`

---

### 7.2 Admin Routes

Base path: `/api/admin`  
🔒 All routes require role `admin`.

#### User Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/users` | List all users (excludes password) |
| POST | `/users` | Create user; auto-creates teacher/accountant record if role matches |
| PUT | `/users/:id` | Update name, email, phone, role |
| DELETE | `/users/:id` | Delete user and linked teacher/accountant record |
| POST | `/users/:id/reset-password` | Force-reset a user's password (`must_change_password` = 1) |
| POST | `/users/:id/toggle-status` | Activate or deactivate account |

**POST /users request body:**
```json
{
  "username": "john.doe",
  "password": "pass123",
  "role": "teacher",
  "full_name": "John Doe",
  "email": "john@school.com",
  "phone": "+256700000000"
}
```

---

#### Teacher Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/teachers` | List all teachers with linked account status |
| POST | `/teachers` | Add teacher; auto-creates user account (default password: `teacher123`) |
| PUT | `/teachers/:id` | Update teacher and sync user record |
| DELETE | `/teachers/:id` | Delete teacher and linked user account |

**POST /teachers request body:**
```json
{
  "full_name": "Jane Smith",
  "email": "jane@school.com",
  "phone": "+256700000001",
  "position": "Mathematics Teacher",
  "salary_scale": "Scale_2",
  "date_joined": "2025-01-15",
  "username": "jane.smith"   // optional; auto-generated from full_name if omitted
}
```

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
